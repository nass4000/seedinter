"""Authentication utilities for the Seedinter Flask app."""

from __future__ import annotations

import os
import secrets
from datetime import timedelta
from functools import wraps
from typing import Callable, Optional, TypeVar

from flask import Response, g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from .models import SessionToken, User, db

TCallable = TypeVar("TCallable", bound=Callable[..., Response])

_SESSION_LIFETIME = timedelta(hours=int(os.getenv("SEEDINTER_SESSION_HOURS", "12")))
_TOKEN_HEADER = "X-Session-Token"


def hash_password(password: str) -> str:
    return generate_password_hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return check_password_hash(password_hash, password)


def issue_session(user: User, lifetime: timedelta = _SESSION_LIFETIME) -> SessionToken:
    token = secrets.token_urlsafe(48)
    session = SessionToken.build(token=token, user=user, lifetime=lifetime)
    db.session.add(session)
    db.session.commit()
    return session


def get_token_from_headers() -> Optional[str]:
    token = request.headers.get(_TOKEN_HEADER)
    if token:
        return token.strip()
    return None


def get_current_session() -> Optional[SessionToken]:
    token = get_token_from_headers()
    if not token:
        return None
    session = SessionToken.query.filter_by(token=token).first()
    if not session:
        return None
    if session.is_expired():
        db.session.delete(session)
        db.session.commit()
        return None
    return session


def load_current_user() -> None:
    session = get_current_session()
    g.current_session = session
    g.current_user = session.user if session else None


def require_auth(fn: TCallable) -> TCallable:
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if getattr(g, "current_user", None) is None:
            return jsonify({"error": {"message": "Authentication required."}}), 401
        return fn(*args, **kwargs)

    return wrapper  # type: ignore[return-value]


def logout_token(token: str) -> None:
    SessionToken.query.filter_by(token=token).delete()
    db.session.commit()


__all__ = [
    "hash_password",
    "verify_password",
    "issue_session",
    "get_token_from_headers",
    "get_current_session",
    "load_current_user",
    "require_auth",
    "logout_token",
]
