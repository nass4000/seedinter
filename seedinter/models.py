"""Database models and helpers for Seedinter."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Optional

from flask_sqlalchemy import SQLAlchemy


db = SQLAlchemy()


class SessionToken(db.Model):
    """Stateless bearer token stored server-side for API authentication."""

    __tablename__ = "sessions"

    id = db.Column(db.Integer, primary_key=True)
    token = db.Column(db.String(255), unique=True, nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    expires_at = db.Column(db.DateTime, nullable=False)

    user = db.relationship("User", back_populates="sessions")

    def is_expired(self, reference: Optional[datetime] = None) -> bool:
        """Return True if the token has elapsed relative to *reference* (UTC now by default)."""

        ref = reference or datetime.utcnow()
        return self.expires_at <= ref

    @classmethod
    def build(cls, token: str, user: "User", lifetime: timedelta) -> "SessionToken":
        now = datetime.utcnow()
        return cls(token=token, user=user, created_at=now, expires_at=now + lifetime)


class User(db.Model):
    """Registered user allowed to access the task proxy."""

    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)

    tasks = db.relationship("TaskRecord", back_populates="created_by", cascade="all, delete-orphan")
    sessions = db.relationship("SessionToken", back_populates="user", cascade="all, delete-orphan")


class TaskRecord(db.Model):
    """Persisted copy of provider tasks enriched with local metadata."""

    __tablename__ = "tasks"

    id = db.Column(db.Integer, primary_key=True)
    external_id = db.Column(db.String(128), unique=True, nullable=False, index=True)
    provider = db.Column(db.String(40), nullable=False, index=True)
    application = db.Column(db.String(256), nullable=False)
    status = db.Column(db.String(40), nullable=False)
    status_raw = db.Column(db.String(128))
    status_url = db.Column(db.String(512))
    result_url = db.Column(db.String(512))
    arguments_json = db.Column(db.Text, nullable=False)
    result_json = db.Column(db.Text)
    logs_json = db.Column(db.Text)
    metrics_json = db.Column(db.Text)
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    created_by_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"))

    created_by = db.relationship("User", back_populates="tasks")

    def _loads(self, payload: Optional[str]) -> Any:
        if not payload:
            return None
        try:
            return json.loads(payload)
        except json.JSONDecodeError:
            return None

    def to_dict(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "id": self.external_id,
            "provider": self.provider,
            "application": self.application,
            "status": self.status,
            "status_raw": self.status_raw,
            "status_url": self.status_url,
            "result_url": self.result_url,
            "created_at": self.created_at.isoformat() + "Z",
            "updated_at": self.updated_at.isoformat() + "Z",
            "created_by": self.created_by.username if self.created_by else None,
        }
        arguments = self._loads(self.arguments_json)
        if arguments is not None:
            data["arguments"] = arguments
        result = self._loads(self.result_json)
        if result is not None:
            data["result"] = result
        logs = self._loads(self.logs_json)
        if logs is not None:
            data["logs"] = logs
        metrics = self._loads(self.metrics_json)
        if metrics is not None:
            data["metrics"] = metrics
        return data

    def update_from_payload(self, *, status: str, status_raw: Optional[str] = None, result: Any = None,
                             logs: Any = None, metrics: Any = None, status_url: Optional[str] = None,
                             result_url: Optional[str] = None) -> None:
        """Update local record fields based on the latest provider response."""

        self.status = status
        self.status_raw = status_raw
        if status_url is not None:
            self.status_url = status_url
        if result_url is not None:
            self.result_url = result_url
        if result is not None:
            self.result_json = json.dumps(result)
        if logs is not None:
            self.logs_json = json.dumps(logs)
        if metrics is not None:
            self.metrics_json = json.dumps(metrics)

    @classmethod
    def build(cls, *, external_id: str, provider: str, application: str, arguments: Any,
              status: str, created_by: Optional[User], status_url: Optional[str] = None,
              result_url: Optional[str] = None, status_raw: Optional[str] = None) -> "TaskRecord":
        return cls(
            external_id=external_id,
            provider=provider,
            application=application,
            status=status,
            status_raw=status_raw,
            status_url=status_url,
            result_url=result_url,
            arguments_json=json.dumps(arguments),
            created_by=created_by,
        )
