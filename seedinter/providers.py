"""Provider abstractions for task submission and polling."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

import httpx
from fal_client.client import Completed, InProgress, Queued, SyncClient

logger = logging.getLogger(__name__)


@dataclass
class TaskPayload:
    task_id: str
    application: str
    status: str
    status_raw: Optional[str] = None
    queue_position: Optional[int] = None
    logs: Optional[list[Any]] = None
    metrics: Optional[dict[str, Any]] = None
    result: Any = None
    content: Optional[dict[str, Any]] = None
    status_url: Optional[str] = None
    result_url: Optional[str] = None
    error: Optional[dict[str, Any]] = None

    def to_response(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "id": self.task_id,
            "application": self.application,
            "status": self.status,
        }
        if self.status_raw is not None:
            payload["status_raw"] = self.status_raw
        if self.queue_position is not None:
            payload["queue_position"] = self.queue_position
        if self.logs is not None:
            payload["logs"] = self.logs
        if self.metrics is not None:
            payload["metrics"] = self.metrics
        if self.result is not None:
            payload["result"] = self.result
        if self.content is not None:
            payload["content"] = self.content
        if self.status_url is not None:
            payload["status_url"] = self.status_url
        if self.result_url is not None:
            payload["result_url"] = self.result_url
        if self.error is not None:
            payload["error"] = self.error
        return payload


class ProviderError(Exception):
    def __init__(self, message: str, status_code: int = 502):
        super().__init__(message)
        self.status_code = status_code


class FalProvider:
    name = "fal"

    def __init__(self, default_application: str, timeout: int = 180):
        self.default_application = default_application
        self.timeout = timeout

    def build_client(self, api_key: Optional[str]) -> SyncClient:
        if api_key:
            return SyncClient(key=api_key, default_timeout=self.timeout)
        return SyncClient(default_timeout=self.timeout)

    def submit(self, application: str, arguments: dict[str, Any], api_key: Optional[str]) -> TaskPayload:
        client = self.build_client(api_key)
        handle = client.submit(application, arguments=arguments)
        return TaskPayload(
            task_id=handle.request_id,
            application=application,
            status="queued",
            status_raw="Queued",
            status_url=handle.status_url,
            result_url=handle.response_url,
        )

    def describe_status(
        self, application: str, task_id: str, api_key: Optional[str]
    ) -> TaskPayload:
        client = self.build_client(api_key)
        status = client.status(application, task_id, with_logs=True)
        return self._serialize_status(task_id, application, status, client=client)

    def _serialize_status(
        self,
        task_id: str,
        application: str,
        status: Any,
        *,
        client: SyncClient,
    ) -> TaskPayload:
        payload = TaskPayload(
            task_id=task_id,
            application=application,
            status="queued",
            status_raw=status.__class__.__name__,
            queue_position=None,
            logs=[],
            metrics={},
            content={},
        )

        if isinstance(status, Queued):
            payload.status = "queued"
            payload.queue_position = status.position
        elif isinstance(status, InProgress):
            payload.status = "running"
            if status.logs:
                payload.logs = status.logs
        elif isinstance(status, Completed):
            payload.status = "succeeded"
            if status.logs:
                payload.logs = status.logs
            if status.metrics:
                payload.metrics = status.metrics
            try:
                output = client.result(application, task_id)
            except httpx.HTTPStatusError as exc:  # pragma: no cover - network failure
                logger.exception("fal.ai result retrieval failed")
                detail = ""
                if exc.response is not None:
                    try:
                        detail = exc.response.text
                    except Exception:  # pragma: no cover
                        detail = ""
                payload.status = "failed"
                payload.error = {"message": detail or "Result retrieval failed."}
                return payload
            if isinstance(output, dict):
                payload.result = output
                content: dict[str, Any] = {}
                video_url = output.get("video", {}).get("url")
                if video_url:
                    content["video_url"] = video_url
                images = output.get("images")
                if isinstance(images, list):
                    image_urls: list[str] = []
                    for item in images:
                        if isinstance(item, dict) and item.get("url"):
                            image_urls.append(item["url"])
                    if image_urls:
                        content["image_urls"] = image_urls
                if content:
                    payload.content = content
            else:
                payload.result = output
        else:
            payload.status = "failed"
            payload.error = {"message": "Unknown task status."}

        return payload


def _load_json_env(var_name: str) -> dict[str, str]:
    raw = os.getenv(var_name)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        logger.warning("Invalid JSON for %s environment variable", var_name)
        return {}


class ByteDanceProvider:
    name = "bytedance"

    def __init__(
        self,
        *,
        base_url: str,
        create_path: str,
        status_path: str,
        status_method: str = "GET",
        auth_scheme: str = "Bearer",
        timeout: float = 30.0,
        extra_headers: Optional[Dict[str, str]] = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.create_path = create_path
        self.status_path = status_path
        self.status_method = status_method.upper()
        self.auth_scheme = auth_scheme
        self.timeout = timeout
        self.extra_headers = extra_headers or {}

    @classmethod
    def from_env(cls) -> "ByteDanceProvider":
        base_url = os.getenv("BYTEDANCE_API_BASE_URL", "https://open.senseengine.byteplus.com")
        create_path = os.getenv("BYTEDANCE_CREATE_PATH", "/maas/v1/tasks")
        status_path = os.getenv("BYTEDANCE_STATUS_PATH", "/maas/v1/tasks/{task_id}")
        status_method = os.getenv("BYTEDANCE_STATUS_METHOD", "GET")
        auth_scheme = os.getenv("BYTEDANCE_AUTH_SCHEME", "Bearer")
        timeout = float(os.getenv("BYTEDANCE_TIMEOUT", "30"))
        extra_headers = _load_json_env("BYTEDANCE_EXTRA_HEADERS")
        return cls(
            base_url=base_url,
            create_path=create_path,
            status_path=status_path,
            status_method=status_method,
            auth_scheme=auth_scheme,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    def _build_headers(self, api_key: Optional[str]) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        headers.update(self.extra_headers)
        if api_key:
            headers["Authorization"] = f"{self.auth_scheme} {api_key}"
        return headers

    def _build_url(self, path: str, *, task_id: Optional[str] = None, application: Optional[str] = None) -> str:
        formatted = path
        if task_id is not None:
            formatted = formatted.replace("{task_id}", task_id)
        if application is not None:
            formatted = formatted.replace("{application}", application)
        return f"{self.base_url}{formatted}"

    def submit(self, application: str, arguments: dict[str, Any], api_key: Optional[str]) -> TaskPayload:
        url = self._build_url(self.create_path, application=application)
        headers = self._build_headers(api_key)
        body = self._build_request_body(application, arguments)
        with httpx.Client(timeout=self.timeout) as client:
            response = client.post(url, json=body, headers=headers)
            self._raise_for_status(response, "Task submission")
            try:
                payload = response.json()
            except json.JSONDecodeError as exc:
                raise ProviderError("ByteDance response could not be decoded as JSON.", status_code=response.status_code) from exc
        task_id = _extract_field(payload, [
            "task_id",
            "id",
            "request_id",
            "data.task_id",
            "data.id",
            "result.task_id",
        ])
        if not task_id:
            raise ProviderError("ByteDance response did not include a task identifier.")
        status = _extract_field(payload, ["status", "data.status", "task_status"])
        status_mapped = _map_bytedance_status(status)
        status_url = _extract_field(payload, ["status_url", "data.status_url"])
        result_url = _extract_field(payload, ["result_url", "data.result_url"])
        content = _extract_field(payload, ["data.content", "content"])
        logs = _extract_field(payload, ["logs", "data.logs"])
        metrics = _extract_field(payload, ["metrics", "data.metrics"])
        return TaskPayload(
            task_id=str(task_id),
            application=application,
            status=status_mapped,
            status_raw=status,
            result=payload,
            content=content if isinstance(content, dict) else None,
            logs=logs if isinstance(logs, list) else None,
            metrics=metrics if isinstance(metrics, dict) else None,
            status_url=status_url if isinstance(status_url, str) else None,
            result_url=result_url if isinstance(result_url, str) else None,
        )

    def describe_status(self, application: str, task_id: str, api_key: Optional[str]) -> TaskPayload:
        url = self._build_url(self.status_path, task_id=task_id, application=application)
        headers = self._build_headers(api_key)
        method = self.status_method
        with httpx.Client(timeout=self.timeout) as client:
            if method == "POST":
                response = client.post(url, json={"task_id": task_id, "application": application}, headers=headers)
            else:
                response = client.get(url, headers=headers)
            self._raise_for_status(response, "Task status")
            try:
                payload = response.json()
            except json.JSONDecodeError as exc:
                raise ProviderError("ByteDance response could not be decoded as JSON.", status_code=response.status_code) from exc
        status = _extract_field(payload, ["status", "data.status", "task_status"])
        status_mapped = _map_bytedance_status(status)
        result = _extract_field(payload, ["result", "data.result", "output"])
        content = _extract_field(payload, ["data.content", "content"])
        logs = _extract_field(payload, ["logs", "data.logs"])
        metrics = _extract_field(payload, ["metrics", "data.metrics"])
        error_message = _extract_field(payload, ["error.message", "message", "data.error.message"])
        queue_position = _extract_field(payload, ["queue_position", "data.queue_position"])
        result_url = _extract_field(payload, ["result_url", "data.result_url"])
        status_url = _extract_field(payload, ["status_url", "data.status_url"])
        error = None
        if status_mapped == "failed" and error_message:
            error = {"message": error_message}
        return TaskPayload(
            task_id=task_id,
            application=application,
            status=status_mapped,
            status_raw=status,
            result=result,
            content=content if isinstance(content, dict) else None,
            logs=logs if isinstance(logs, list) else None,
            metrics=metrics if isinstance(metrics, dict) else None,
            error=error,
            queue_position=int(queue_position) if isinstance(queue_position, int) else None,
            result_url=result_url if isinstance(result_url, str) else None,
            status_url=status_url if isinstance(status_url, str) else None,
        )

    def _build_request_body(self, application: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return {"model": application, "input": arguments}

    def _raise_for_status(self, response: httpx.Response, context: str) -> None:
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = ""
            try:
                detail = response.text
            except Exception:  # pragma: no cover
                detail = ""
            message = f"{context} failed with {response.status_code}. {detail}"
            raise ProviderError(message, status_code=response.status_code) from exc


def _extract_field(data: Any, paths: list[str]) -> Any:
    for path in paths:
        value = _dig(data, path)
        if value is not None:
            return value
    return None


def _dig(data: Any, path: str) -> Any:
    current = data
    for part in path.split('.'):
        if isinstance(current, dict) and part in current:
            current = current[part]
        else:
            return None
    return current


def _map_bytedance_status(status: Any) -> str:
    if status is None:
        return "queued"
    if isinstance(status, str):
        normalized = status.strip().lower()
        mapping = {
            "queued": "queued",
            "queue": "queued",
            "pending": "queued",
            "processing": "running",
            "running": "running",
            "in_progress": "running",
            "success": "succeeded",
            "succeeded": "succeeded",
            "finished": "succeeded",
            "done": "succeeded",
            "failed": "failed",
            "error": "failed",
            "cancelled": "cancelled",
            "canceled": "cancelled",
        }
        return mapping.get(normalized, normalized)
    return "queued"


__all__ = [
    "TaskPayload",
    "ProviderError",
    "FalProvider",
    "ByteDanceProvider",
]
