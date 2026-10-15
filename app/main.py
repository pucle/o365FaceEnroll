"""Web thu thập khuôn mặt: FastAPI. Chạy:  uvicorn app.main:app --host 0.0.0.0 --port 7860"""
from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from types import SimpleNamespace

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import routes_admin, routes_public
from .config import ConfigError, load_settings
from .db import Db
from .storage import StorageError, make_store

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("main")
STATIC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")

state = SimpleNamespace(settings=None, db=None, store=None)
try:
    state.settings = load_settings()
except ConfigError as e:
    print("\n" + str(e) + "\n", file=sys.stderr)
    sys.exit(2)                       # dừng ngay, không để retry mãi
state.db = Db(state.settings)
state.store = make_store(state.settings, state.db)
try:
    state.store.check()
    log.info("Kho ảnh (%s) sẵn sàng.", state.settings.storage_backend)
except StorageError as e:
    log.error("KHO ẢNH CHƯA DÙNG ĐƯỢC: %s", e)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    state.db.close()


app = FastAPI(title="Face enrollment", lifespan=lifespan)
if state.settings.allowed_origins:
    from fastapi.middleware.cors import CORSMiddleware
    app.add_middleware(CORSMiddleware, allow_origins=state.settings.allowed_origins, allow_methods=["*"], allow_headers=["*"], max_age=600)


@app.middleware("http")
async def limit_body(request: Request, call_next):
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > state.settings.max_request_bytes:
        return JSONResponse({"detail": "Request too large"}, status_code=413)
    return await call_next(request)


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    resp = await call_next(request)
    if not request.url.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-cache"          # luôn lấy bản mới của JS/CSS sau khi nâng cấp
    return resp


@app.get("/healthz")
async def healthz():
    db_ok = await run_in_threadpool(state.db.ping)
    store_ok, why = True, ""
    try:
        await run_in_threadpool(state.store.check)
    except StorageError as e:
        store_ok, why = False, str(e)
    return JSONResponse({"ok": db_ok and store_ok, "neon": db_ok, "storage": {"ok": store_ok, "backend": state.settings.storage_backend, "detail": why}},
                        status_code=200 if (db_ok and store_ok) else 503)


app.include_router(routes_public.build(state))
app.include_router(routes_admin.build(state))


@app.get("/admin", include_in_schema=False)
def admin_page():
    if os.getenv("API_ONLY", "0") == "1":
        raise HTTPException(404, "Trang admin nằm ở frontend")
    return FileResponse(os.path.join(STATIC, "admin.html"))


if os.getenv("API_ONLY", "0") == "1":              # backend riêng (frontend host ở Vercel): không phục vụ file tĩnh
    @app.get("/", include_in_schema=False)
    def root():
        return {"service": "face-enrollment", "mode": "api-only", "health": "/healthz"}
else:
    app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")
