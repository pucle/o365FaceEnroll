"""Trang thu thập (công khai): chỉ GHI. Không có endpoint nào đọc ảnh của người khác."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
from typing import List, Optional

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from starlette.concurrency import run_in_threadpool

from . import images
from .config import normalize_member_id
from .models import GateIn, RegisterIn
from .security import RateLimiter, client_ip

log = logging.getLogger("public")
router = APIRouter()
_SECRET = (os.getenv("SESSION_SECRET") or base64.b64encode(os.urandom(24)).decode()).encode()
TOKEN_TTL = 2 * 3600


def make_token(member_id: str) -> str:
    exp = str(int(time.time()) + TOKEN_TTL)
    sig = hmac.new(_SECRET, f"{member_id}|{exp}".encode(), hashlib.sha256).hexdigest()[:32]
    return f"{exp}.{sig}"


def verify_token(member_id: str, tok: str) -> bool:
    try:
        exp, sig = tok.split(".", 1)
        good = hmac.new(_SECRET, f"{member_id}|{exp}".encode(), hashlib.sha256).hexdigest()[:32]
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except Exception:
        return False


def object_key(member_id: str, pose: str, sha: str) -> str:
    return f"faces/{member_id}/{pose}_{sha[:16]}.jpg"


async def delete_objects(store, keys: List[str]) -> None:
    for k in keys:
        try:
            await run_in_threadpool(store.delete, k)
        except Exception as e:              # không chặn: ghi log để check_r2.py --find-orphans xử lý sau
            log.error("không xoá được object %s: %s", k, type(e).__name__)


def build(app_state) -> APIRouter:
    s, db, store = app_state.settings, app_state.db, app_state.store
    limiter = RateLimiter(s.rate_limit_per_hour)
    gate_limiter = RateLimiter(30)          # 30 lần nhập mã/giờ/IP

    @router.get("/api/config")
    def cfg():
        small = s.storage_backend == "db"      # Neon free 0.5 GB: ảnh nhỏ hơn
        return {"poses": s.poses, "min_frames": s.min_frames, "max_frames": s.max_frames, "require_code": bool(s.enroll_code),
                "enable_tilt": s.enable_tilt, "max_side": 320 if small else 384, "jpeg_quality": 0.8 if small else 0.85}

    @router.post("/api/gate")
    async def gate(body: GateIn, request: Request):
        """Kiểm tra mã CLB MỘT lần khi vào web (phía client nhớ trong phiên). Giới hạn thử sai theo IP."""
        if not s.enroll_code:
            return {"ok": True}
        if not gate_limiter.hit(client_ip(request)):
            raise HTTPException(429, "Thử sai quá nhiều lần. Đợi một lúc rồi thử lại.")
        if not hmac.compare_digest((body.code or "").strip().encode(), s.enroll_code.encode()):
            raise HTTPException(403, "Mã CLB không đúng.")
        return {"ok": True}

    @router.post("/api/register")
    async def register(body: RegisterIn, request: Request):
        if not limiter.hit(client_ip(request)):
            raise HTTPException(429, "Bạn đăng ký quá nhiều lần trong một giờ. Thử lại sau.")
        if s.enroll_code and (body.invite_code or "").strip() != s.enroll_code:
            raise HTTPException(403, "Mã CLB không đúng.")
        mid = normalize_member_id(body.member_id)
        if not mid:
            raise HTTPException(422, "Mã thành viên không hợp lệ (chỉ chữ, số, gạch ngang/dưới).")
        name = " ".join(body.full_name.split())
        if not name:
            raise HTTPException(422, "Cần nhập họ tên.")
        created = await run_in_threadpool(db.upsert_member, mid, name, (body.group or "").strip() or None, (body.notes or "").strip() or None)
        have = await run_in_threadpool(db.count_images, mid)
        return {"member_id": mid, "created": created, "existing_images": have, "upload_token": make_token(mid)}

    @router.post("/api/members/{member_id}/images")
    async def upload(member_id: str, request: Request, files: List[UploadFile] = File(...), poses: str = Form(""),
                     qualities: str = Form(""), token: str = Form("")):
        if not verify_token(member_id, token):
            raise HTTPException(403, "Phiên đăng ký hết hạn hoặc không hợp lệ, hãy đăng ký lại.")
        if len(files) > s.max_images_per_request:
            raise HTTPException(413, f"Mỗi lần gửi tối đa {s.max_images_per_request} ảnh.")
        if not await run_in_threadpool(db.member_exists, member_id):
            raise HTTPException(404, "Chưa có thành viên này.")
        pl = [p.strip() for p in poses.split(",")] if poses else []
        ql = [q.strip() for q in qualities.split(",")] if qualities else []
        saved, dup, rejected = 0, 0, []
        for i, up in enumerate(files):
            pose = pl[i] if i < len(pl) else ""
            if pose not in s.poses:
                rejected.append({"index": i, "reason": "tư thế không hợp lệ"}); continue
            try:
                q = float(ql[i]) if i < len(ql) and ql[i] != "" else None
            except ValueError:
                q = None
            raw = await up.read(s.max_image_bytes + 1)
            try:
                c = await run_in_threadpool(images.clean_jpeg, raw, s.max_image_bytes)
            except images.BadImage as e:
                rejected.append({"index": i, "reason": str(e)}); continue
            key = object_key(member_id, pose, c.sha256)
            try:
                await run_in_threadpool(store.save, key, c.data, "image/jpeg")           # 1) R2 trước
            except Exception as e:
                log.error("R2 save lỗi: %s", type(e).__name__)
                raise HTTPException(503, "Không lưu được ảnh lên kho lưu trữ (R2). Thử lại sau.")
            try:
                rid = await run_in_threadpool(db.insert_image, member_id, pose, q, c.width, c.height, key, len(c.data), c.sha256)   # 2) DB sau
            except Exception:
                await delete_objects(store, [key])                                          # DB lỗi: dọn object vừa tải
                raise
            if rid is None:
                dup += 1                          # ảnh trùng sha256: object cùng key đã có, không xoá
            else:
                saved += 1
        total = await run_in_threadpool(db.count_images, member_id)
        if total > s.max_total_per_member:        # vượt trần: xoá ảnh điểm thấp nhất (cả R2 lẫn DB)
            extra = await run_in_threadpool(db.lowest_quality, member_id, total - s.max_total_per_member)
            keys = []
            for iid, k in extra:
                k2 = await run_in_threadpool(db.delete_image, iid)
                if k2:
                    keys.append(k2)
            await delete_objects(store, keys)
            total -= len(keys)
        return {"saved": saved, "duplicates": dup, "rejected": rejected, "total": total}

    return router
