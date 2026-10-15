"""Xác thực quản trị (Basic hoặc Bearer, so sánh bằng compare_digest) + rate limit theo IP trong RAM."""
from __future__ import annotations

import base64
import hmac
import re
import time
from collections import defaultdict, deque
from typing import Deque, Dict, Optional

from fastapi import HTTPException, Request

from .config import Settings, clean


def _eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def check_admin(request: Request, s: Settings) -> None:
    h = request.headers.get("authorization", "")
    scheme, _, val = h.partition(" ")
    scheme, val = scheme.lower(), val.strip()
    got_len = 0
    if scheme == "bearer" and s.admin_token:
        v = clean(val)
        got_len = len(v)
        if _eq(v, s.admin_token):
            return
    elif scheme == "basic" and s.admin_user and s.admin_password:
        try:
            u, _, p = base64.b64decode(val).decode("utf-8").partition(":")
            got_len = len(p)
            if _eq(clean(u), s.admin_user) and _eq(clean(p), s.admin_password):
                return
        except Exception:
            pass
    elif scheme == "basic" and s.admin_token:           # trình duyệt hỏi Basic: cho phép dùng ADMIN_TOKEN làm mật khẩu
        try:
            _, _, p = base64.b64decode(val).decode("utf-8").partition(":")
            got_len = len(p)
            if _eq(clean(p), s.admin_token):
                return
        except Exception:
            pass
    detail = "Unauthorized"
    if h:
        detail = f"Unauthorized: token/mật khẩu không khớp (server nhận {got_len} ký tự). Kiểm tra khoảng trắng/dấu nháy."
    raise HTTPException(401, detail, headers={"WWW-Authenticate": 'Basic realm="admin"'})


SYNC_ALLOWED = (("GET", re.compile(r"^/api/admin/manifest$")), ("GET", re.compile(r"^/api/admin/images/\d+/file$")),
                ("POST", re.compile(r"^/api/admin/mark-exported$")))


def check_sync_or_admin(request: Request, s: Settings, method: str, path: str) -> None:
    """SYNC_TOKEN chỉ mở 3 thao tác của hệ thống nhận diện: đọc manifest, đọc ảnh, đánh dấu đã xuất. Không xoá/sửa được gì khác."""
    if s.sync_token:
        h = request.headers.get("authorization", "")
        scheme, _, val = h.partition(" ")
        if scheme.lower() == "bearer" and _eq(clean(val), s.sync_token) and any(m == method and rx.match(path) for m, rx in SYNC_ALLOWED):
            return
    check_admin(request, s)


class RateLimiter:
    def __init__(self, per_hour: int):
        self.per_hour = per_hour
        self.hits: Dict[str, Deque[float]] = defaultdict(deque)

    def hit(self, ip: str, now: Optional[float] = None) -> bool:
        """True nếu còn trong hạn mức."""
        now = time.time() if now is None else now
        q = self.hits[ip]
        while q and now - q[0] > 3600:
            q.popleft()
        if len(q) >= self.per_hour:
            return False
        q.append(now)
        if len(self.hits) > 5000:                           # dọn bớt để không phình RAM
            for k in [k for k, v in self.hits.items() if not v or now - v[-1] > 3600]:
                del self.hits[k]
        return True


def client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for", "")
    return (xff.split(",")[0].strip() if xff else (request.client.host if request.client else "?")) or "?"
