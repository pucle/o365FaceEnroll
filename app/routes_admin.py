"""API quản trị: mọi endpoint /api/admin/* đều yêu cầu xác thực."""
from __future__ import annotations

import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from starlette.concurrency import run_in_threadpool

from . import export
from .models import MarkExportedIn
from .routes_public import delete_objects
from .security import check_admin, check_sync_or_admin

log = logging.getLogger("admin")
FREE_BYTES = 10 * 1024 ** 3


def build(app_state) -> APIRouter:
    s, db, store = app_state.settings, app_state.db, app_state.store

    def auth(request: Request):
        check_sync_or_admin(request, s, request.method, request.url.path)

    r = APIRouter(prefix="/api/admin", dependencies=[Depends(auth)])

    @r.get("/stats")
    async def stats():
        st = await run_in_threadpool(db.stats)
        st.update(free_bytes=FREE_BYTES, min_frames=s.min_frames, backend=s.storage_backend)
        return st

    @r.get("/members")
    async def members(q: str = "", status: str = "all", limit: int = 50, offset: int = 0):
        limit = max(1, min(limit, 200))
        rows, total = await run_in_threadpool(db.list_members, q.strip(), status, limit, max(0, offset))
        for m in rows:
            m["low"] = m["image_count"] < s.min_frames
        return {"total": total, "items": rows}

    @r.get("/members/{member_id}")
    async def member(member_id: str):
        m = await run_in_threadpool(db.get_member, member_id)
        if not m:
            raise HTTPException(404, "Member not found")
        imgs = await run_in_threadpool(db.list_images, member_id)
        for im in imgs:
            im["url"] = await run_in_threadpool(store.presigned_url, im.pop("object_key"), 600)
        m["images"] = imgs
        return m

    @r.get("/images/{image_id}/file")
    async def image_file(image_id: int):
        try:
            key = await run_in_threadpool(export.db_key, db, image_id)
        except KeyError:
            raise HTTPException(404, "Image not found")
        return StreamingResponse(store.get_stream(key), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=300"})

    @r.get("/blob")
    async def blob(key: str):
        if s.storage_backend not in ("local", "db") or not key.startswith("faces/"):
            raise HTTPException(404, "Not found")
        return StreamingResponse(store.get_stream(key), media_type="image/jpeg")

    @r.delete("/images/{image_id}")
    async def del_image(image_id: int):
        key = await run_in_threadpool(db.delete_image, image_id)
        if not key:
            raise HTTPException(404, "Image not found")
        await delete_objects(store, [key])
        return {"deleted": 1}

    @r.delete("/members/{member_id}")
    async def del_member(member_id: str):
        if not await run_in_threadpool(db.member_exists, member_id):
            raise HTTPException(404, "Member not found")
        keys = await run_in_threadpool(db.delete_member, member_id)
        await delete_objects(store, keys)
        return {"deleted_images": len(keys)}

    @r.post("/members/{member_id}/clear")
    async def clear(member_id: str):
        """"Xoá hết và thu lại": xoá toàn bộ ảnh, giữ thành viên."""
        if not await run_in_threadpool(db.member_exists, member_id):
            raise HTTPException(404, "Member not found")
        keys = await run_in_threadpool(db.clear_images, member_id)
        await delete_objects(store, keys)
        return {"deleted_images": len(keys)}

    @r.post("/mark-exported")
    async def mark(body: MarkExportedIn):
        return {"updated": await run_in_threadpool(db.mark_exported, body.member_ids)}

    def pick(status: str, since: Optional[str]):
        if status not in ("pending", "exported", "all"):
            raise HTTPException(400, "status phải là pending, exported hoặc all")
        return db.export_members(status, since)

    @r.get("/manifest")
    async def manifest(status: str = "all", since: Optional[str] = None):
        ms = await run_in_threadpool(pick, status, since)
        return await run_in_threadpool(export.build_manifest, db, ms)

    @r.get("/export.zip")
    async def export_all(status: str = "all", since: Optional[str] = None):
        ms = await run_in_threadpool(pick, status, since)
        return StreamingResponse(export.stream_zip(db, store, ms), media_type="application/zip",
                                 headers={"Content-Disposition": 'attachment; filename="dataset.zip"'})

    @r.get("/export/{member_id}.zip")
    async def export_one(member_id: str):
        m = await run_in_threadpool(db.get_member, member_id)
        if not m:
            raise HTTPException(404, "Member not found")
        m = {k: m[k] for k in ("member_id", "full_name", "group", "status", "created_at", "updated_at")}
        return StreamingResponse(export.stream_zip(db, store, [m]), media_type="application/zip",
                                 headers={"Content-Disposition": f'attachment; filename="{member_id}.zip"'})

    return r
