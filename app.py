from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

import httpx
from fal_client.auth import MissingCredentialsError
from flask import Flask, g, jsonify, make_response, request, send_from_directory
from sqlalchemy.exc import IntegrityError

from seedinter.auth import (
    hash_password,
    issue_session,
    load_current_user,
    logout_token,
    verify_password,
)
from seedinter.models import TaskRecord, User, db
from seedinter.providers import ByteDanceProvider, FalProvider, ProviderError, TaskPayload

APP_DEFAULT = os.getenv("FAL_APP_DEFAULT", "bytedance/seedance/v1/pro/image-to-video")
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///seedinter.sqlite3")
DEFAULT_PROVIDER_NAME = os.getenv("SEEDINTER_DEFAULT_PROVIDER", "fal")
BYTEDANCE_DEFAULT_APP = os.getenv("BYTEDANCE_DEFAULT_APPLICATION", APP_DEFAULT)
MAX_TASK_LIST = int(os.getenv("SEEDINTER_MAX_TASKS", "100"))

app = Flask(__name__, static_folder="web", static_url_path="")
app.config.update(
    SQLALCHEMY_DATABASE_URI=DATABASE_URL,
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    JSON_SORT_KEYS=False,
)

db.init_app(app)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

fal_provider = FalProvider(default_application=APP_DEFAULT)
bytedance_provider = ByteDanceProvider.from_env()
PROVIDERS = {fal_provider.name: fal_provider, bytedance_provider.name: bytedance_provider}
DEFAULT_PROVIDER = DEFAULT_PROVIDER_NAME if DEFAULT_PROVIDER_NAME in PROVIDERS else fal_provider.name


@app.before_request
def _load_session():
    load_current_user()


with app.app_context():
    db.create_all()


@app.after_request
def apply_cors(response):
    response.headers.setdefault(
        "Access-Control-Allow-Origin", request.headers.get("Origin", "*")
    )
    response.headers.setdefault(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, X-Session-Token, X-ByteDance-Key",
    )
    response.headers.setdefault("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    return response


def json_error(message: str, status_code: int = 400):
    return jsonify({"error": {"message": message}}), status_code


def ensure_authenticated():
    if getattr(g, "current_user", None) is None:
        return json_error("Authentication required.", 401)
    return None


def parse_authorization_header() -> tuple[Optional[str], Optional[str]]:
    header = request.headers.get("Authorization", "").strip()
    if not header:
        return None, None
    parts = header.split(" ", 1)
    if len(parts) != 2:
        return None, None
    return parts[0].lower(), parts[1].strip()


def _find_api_key(payload: Optional[dict[str, Any]], provider_name: Optional[str]) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    credentials = payload.get("credentials")
    if isinstance(credentials, dict):
        if provider_name and provider_name in credentials:
            nested = credentials.get(provider_name)
            if isinstance(nested, dict):
                key = nested.get("apiKey") or nested.get("api_key")
                if isinstance(key, str) and key.strip():
                    return key.strip()
        key = credentials.get("apiKey") or credentials.get("api_key")
        if isinstance(key, str) and key.strip():
            return key.strip()
    provider_options = payload.get("providerOptions")
    if isinstance(provider_options, dict) and provider_name:
        nested = provider_options.get(provider_name)
        if isinstance(nested, dict):
            key = nested.get("apiKey") or nested.get("api_key")
            if isinstance(key, str) and key.strip():
                return key.strip()
    key = payload.get("apiKey") or payload.get("api_key")
    if isinstance(key, str) and key.strip():
        return key.strip()
    return None


def extract_fal_api_key(payload: Optional[dict[str, Any]]) -> Optional[str]:
    key = _find_api_key(payload, fal_provider.name)
    if key:
        return key
    scheme, value = parse_authorization_header()
    if scheme in {"key", "bearer"} and value:
        return value
    env_key = os.getenv("FAL_KEY")
    return env_key.strip() if env_key else None


def extract_bytedance_api_key(payload: Optional[dict[str, Any]]) -> Optional[str]:
    key = _find_api_key(payload, bytedance_provider.name)
    if key:
        return key
    header_key = request.headers.get("X-ByteDance-Key")
    if isinstance(header_key, str) and header_key.strip():
        return header_key.strip()
    scheme, value = parse_authorization_header()
    if scheme in {"bearer", "token", "bytedance"} and value:
        return value
    env_key = os.getenv("BYTEDANCE_API_KEY")
    return env_key.strip() if env_key else None


def extract_provider_api_key(provider_name: str, payload: Optional[dict[str, Any]]) -> Optional[str]:
    if provider_name == fal_provider.name:
        return extract_fal_api_key(payload)
    if provider_name == bytedance_provider.name:
        return extract_bytedance_api_key(payload)
    return _find_api_key(payload, provider_name)


def resolve_application(provider_name: str, payload_application: Optional[str]) -> str:
    if isinstance(payload_application, str) and payload_application.strip():
        return payload_application.strip()
    if provider_name == fal_provider.name:
        return APP_DEFAULT
    if provider_name == bytedance_provider.name:
        return BYTEDANCE_DEFAULT_APP
    return APP_DEFAULT


def get_provider(provider_name: str):
    provider = PROVIDERS.get(provider_name)
    if not provider:
        raise KeyError(f"Unknown provider '{provider_name}'.")
    return provider


def persist_task(
    task_payload: TaskPayload,
    provider_name: str,
    application: str,
    arguments: dict[str, Any],
) -> TaskRecord:
    record = TaskRecord.query.filter_by(external_id=task_payload.task_id).first()
    if record is None:
        record = TaskRecord.build(
            external_id=task_payload.task_id,
            provider=provider_name,
            application=application,
            arguments=arguments,
            status=task_payload.status,
            created_by=g.current_user,
            status_url=task_payload.status_url,
            result_url=task_payload.result_url,
            status_raw=task_payload.status_raw,
        )
        db.session.add(record)
    record.update_from_payload(
        status=task_payload.status,
        status_raw=task_payload.status_raw,
        result=task_payload.result,
        logs=task_payload.logs,
        metrics=task_payload.metrics,
        status_url=task_payload.status_url or record.status_url,
        result_url=task_payload.result_url or record.result_url,
    )
    db.session.commit()
    return record


def build_task_response(
    task_payload: TaskPayload, provider_name: str, record: Optional[TaskRecord]
) -> dict[str, Any]:
    data = task_payload.to_response()
    data["provider"] = provider_name
    if record is not None:
        data["created_by"] = record.created_by.username if record.created_by else None
        data["created_at"] = record.created_at.isoformat() + "Z"
        data["updated_at"] = record.updated_at.isoformat() + "Z"
        if record.status_url and not data.get("status_url"):
            data["status_url"] = record.status_url
        if record.result_url and not data.get("result_url"):
            data["result_url"] = record.result_url
        try:
            arguments = json.loads(record.arguments_json)
        except json.JSONDecodeError:
            arguments = None
        if arguments is not None:
            data.setdefault("arguments", arguments)
    elif getattr(g, "current_user", None) is not None:
        data["created_by"] = g.current_user.username
    return data


def validate_arguments(provider_name: str, arguments: Any) -> Optional[tuple[Any, int]]:
    if not isinstance(arguments, dict):
        return json_error("Expected arguments object.")
    if provider_name == fal_provider.name:
        primary_args = arguments
        if isinstance(arguments.get("input"), dict):
            primary_args = arguments["input"]
        prompt = primary_args.get("prompt") if isinstance(primary_args, dict) else None
        if not prompt:
            return json_error("Expected arguments with at least a prompt field.")
    return None


@app.route("/api/auth/register", methods=["POST", "OPTIONS"])
def register():
    if request.method == "OPTIONS":
        return make_response("", 204)
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    if not username:
        return json_error("Username is required.")
    if len(username) > 80:
        return json_error("Username is too long (max 80 characters).")
    if len(password) < 8:
        return json_error("Password must be at least 8 characters long.")
    password_hash = hash_password(password)
    user = User(username=username, password_hash=password_hash)
    db.session.add(user)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        return json_error("Username is already taken.", 409)
    session = issue_session(user)
    return (
        jsonify({"token": session.token, "user": {"id": user.id, "username": user.username}}),
        201,
    )


@app.route("/api/auth/login", methods=["POST", "OPTIONS"])
def login():
    if request.method == "OPTIONS":
        return make_response("", 204)
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))
    if not username or not password:
        return json_error("Username and password are required.")
    user = User.query.filter_by(username=username).first()
    if user is None or not verify_password(password, user.password_hash):
        return json_error("Invalid username or password.", 401)
    session = issue_session(user)
    return jsonify({"token": session.token, "user": {"id": user.id, "username": user.username}})


@app.route("/api/auth/logout", methods=["POST", "OPTIONS"])
def logout():
    if request.method == "OPTIONS":
        return make_response("", 204)
    auth_error = ensure_authenticated()
    if auth_error:
        return auth_error
    token = request.headers.get("X-Session-Token")
    if token:
        logout_token(token)
    return jsonify({"ok": True})


@app.route("/api/auth/session", methods=["GET", "OPTIONS"])
def session_info():
    if request.method == "OPTIONS":
        return make_response("", 204)
    user = getattr(g, "current_user", None)
    if user is None:
        return jsonify({"user": None, "providers": list(PROVIDERS.keys()), "defaultProvider": DEFAULT_PROVIDER})
    return jsonify(
        {
            "user": {"id": user.id, "username": user.username},
            "providers": list(PROVIDERS.keys()),
            "defaultProvider": DEFAULT_PROVIDER,
        }
    )


@app.route("/api/tasks", methods=["GET", "POST", "OPTIONS"])
def tasks_collection():
    if request.method == "OPTIONS":
        return make_response("", 204)
    auth_error = ensure_authenticated()
    if auth_error:
        return auth_error
    if request.method == "GET":
        limit_raw = request.args.get("limit")
        try:
            limit = int(limit_raw) if limit_raw is not None else MAX_TASK_LIST
        except ValueError:
            limit = MAX_TASK_LIST
        limit = max(1, min(limit, MAX_TASK_LIST))
        query = TaskRecord.query.order_by(TaskRecord.created_at.desc()).limit(limit)
        tasks = [task.to_dict() for task in query.all()]
        return jsonify({"tasks": tasks})

    payload = request.get_json(silent=True) or {}
    provider_name = str(payload.get("provider") or DEFAULT_PROVIDER).strip() or DEFAULT_PROVIDER
    try:
        provider = get_provider(provider_name)
    except KeyError as exc:
        return json_error(str(exc))

    application = resolve_application(provider_name, payload.get("application"))
    arguments = payload.get("arguments") or {}
    validation_error = validate_arguments(provider_name, arguments)
    if validation_error:
        return validation_error

    api_key = extract_provider_api_key(provider_name, payload)
    try:
        submission = provider.submit(application, arguments, api_key)
    except MissingCredentialsError as exc:
        return json_error(str(exc), 401)
    except ProviderError as exc:
        logger.exception("%s provider error during submission", provider_name)
        return json_error(str(exc), exc.status_code)
    except httpx.HTTPStatusError as exc:
        logger.exception("HTTP error submitting task via %s", provider_name)
        detail = exc.response.text if exc.response is not None else ""
        return json_error(f"Provider error: {exc.response.status_code if exc.response else '???'} {detail}", 502)
    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Unexpected error submitting task via %s", provider_name)
        return json_error(f"Failed to submit task: {exc}", 502)

    try:
        record = persist_task(submission, provider_name, application, arguments)
    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Failed to persist task metadata")
        db.session.rollback()
        return json_error(f"Failed to save task metadata: {exc}", 500)

    response_data = build_task_response(submission, provider_name, record)
    return jsonify(response_data), 202


@app.route("/api/tasks/<task_id>", methods=["GET", "OPTIONS"])
def task_detail(task_id: str):
    if request.method == "OPTIONS":
        return make_response("", 204)
    auth_error = ensure_authenticated()
    if auth_error:
        return auth_error

    record = TaskRecord.query.filter_by(external_id=task_id).first()
    provider_name = request.args.get("provider") or (record.provider if record else DEFAULT_PROVIDER)
    try:
        provider = get_provider(provider_name)
    except KeyError as exc:
        return json_error(str(exc))

    application = request.args.get("application") or (record.application if record else resolve_application(provider_name, None))
    api_key = extract_provider_api_key(provider_name, None)

    try:
        status_payload = provider.describe_status(application, task_id, api_key)
    except MissingCredentialsError as exc:
        return json_error(str(exc), 401)
    except ProviderError as exc:
        logger.exception("%s provider error during status", provider_name)
        return json_error(str(exc), exc.status_code)
    except httpx.HTTPStatusError as exc:
        logger.exception("HTTP error fetching task status via %s", provider_name)
        if exc.response is not None and exc.response.status_code == 404:
            return json_error("Task not found.", 404)
        detail = exc.response.text if exc.response is not None else ""
        return json_error(f"Provider error: {exc.response.status_code if exc.response else '???'} {detail}", 502)
    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Unexpected error polling task via %s", provider_name)
        return json_error(f"Failed to query task: {exc}", 502)

    record_ref: Optional[TaskRecord] = record
    try:
        record_ref = persist_task(status_payload, provider_name, application, record.arguments_json and json.loads(record.arguments_json) if record else {})
    except Exception as exc:  # pylint: disable=broad-except
        logger.exception("Failed to update task metadata")
        db.session.rollback()
        record_ref = record

    response_data = build_task_response(status_payload, provider_name, record_ref)
    return jsonify(response_data)


@app.route("/about")
def about():
    return send_from_directory(app.static_folder, "about.html")


@app.route("/")
def root():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/<path:path>")
def static_proxy(path: str):
    return send_from_directory(app.static_folder, path)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", 5000)), debug=True)

