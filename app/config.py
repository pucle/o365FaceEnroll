"""Đọc và KIỂM TRA biến môi trường. Thiếu hoặc còn giá trị mẫu thì dừng ngay với thông báo tiếng Việt (không để pool retry mãi)."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import List
from urllib.parse import urlsplit, urlunsplit

POSES_BASE = ["front", "left", "right", "up", "down"]
POSES_TILT = ["tilt_left", "tilt_right"]
PLACEHOLDERS = ("USER:PASSWORD", "HOST", "your_account_id", "your_access_key_id", "your_secret_access_key",
                "doi-thanh-chuoi-dai-ngau-nhien", "host/db")


class ConfigError(RuntimeError):
    pass


def load_dotenv(path: str = ".env") -> None:
    """Đọc .env đơn giản (KEY=VALUE, bỏ dòng trống/chú thích). Biến đã có trong môi trường được ưu tiên."""
    if not os.path.isfile(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.split(" #")[0].strip() if not v.strip().startswith(("'", '"')) else v.strip()
        os.environ.setdefault(k.strip(), clean(v))


def clean(v: str) -> str:
    """Bỏ khoảng trắng, xuống dòng và dấu nháy (thẳng/cong) ở hai đầu: lỗi hay gặp khi dán giá trị."""
    return (v or "").strip().strip("\"'‘’“”`").strip()


def env(name: str, default: str = "") -> str:
    return clean(os.getenv(name, default))


def mask_url(url: str) -> str:
    """Che mật khẩu trong chuỗi kết nối để ghi log an toàn."""
    try:
        p = urlsplit(url)
        if p.password:
            host = p.hostname or ""
            netloc = f"{p.username}:***@{host}" + (f":{p.port}" if p.port else "")
            return urlunsplit((p.scheme, netloc, p.path, p.query, p.fragment))
    except ValueError:
        pass
    return re.sub(r":[^:@/]+@", ":***@", url)


def _placeholder(v: str) -> bool:
    return any(p.lower() in v.lower() for p in PLACEHOLDERS if p)


@dataclass
class Settings:
    database_url: str
    storage_backend: str
    r2_account_id: str
    r2_access_key_id: str
    r2_secret_access_key: str
    r2_bucket: str
    admin_token: str
    admin_user: str
    admin_password: str
    enroll_code: str
    allowed_origins: List[str]
    min_frames: int
    max_frames: int
    max_total_per_member: int
    enable_tilt: bool
    rate_limit_per_hour: int
    sync_token: str = ""
    local_store_dir: str = "./local_store"
    max_image_bytes: int = 300 * 1024
    max_images_per_request: int = 40
    max_request_bytes: int = 14 * 1024 * 1024

    @property
    def poses(self) -> List[str]:
        return POSES_BASE + (POSES_TILT if self.enable_tilt else [])


def _int(name: str, default: int, lo: int, hi: int) -> int:
    raw = env(name, str(default))
    try:
        v = int(raw)
    except ValueError:
        raise ConfigError(f"Biến {name}='{raw}' phải là số nguyên.")
    if not lo <= v <= hi:
        raise ConfigError(f"Biến {name}={v} phải nằm trong [{lo}, {hi}].")
    return v


def load_settings() -> Settings:
    load_dotenv()
    errs: List[str] = []
    db = env("DATABASE_URL")
    if not db or _placeholder(db):
        errs.append("DATABASE_URL chưa đặt hoặc còn là giá trị mẫu. Lấy chuỗi ở Neon: Dashboard → Connect → Pooled connection. "
                    "PowerShell: $env:DATABASE_URL=\"postgresql://...\"  (hoặc ghi vào file .env)")
    elif not db.startswith(("postgresql://", "postgres://")):
        errs.append("DATABASE_URL phải bắt đầu bằng postgresql:// (đang là: " + mask_url(db)[:30] + "…)")
    backend = env("STORAGE_BACKEND", "r2").lower()
    if backend not in ("r2", "db", "local"):
        errs.append("STORAGE_BACKEND phải là r2 (mặc định), db (lưu ảnh trong Neon, không cần thẻ) hoặc local (chỉ để thử trên máy).")
    r2 = {k: env(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")}
    if backend == "r2":
        for k, v in r2.items():
            if not v or _placeholder(v):
                errs.append(f"{k} chưa đặt hoặc còn là giá trị mẫu (xem hướng dẫn lấy trong .env.example).")
    token, user, pw = env("ADMIN_TOKEN"), env("ADMIN_USER"), env("ADMIN_PASSWORD")
    if _placeholder(token):
        token = ""
    if not token and not (user and pw):
        errs.append("Chưa đặt tài khoản quản trị: đặt ADMIN_TOKEN (chuỗi dài ngẫu nhiên) hoặc cả ADMIN_USER và ADMIN_PASSWORD.")
    if errs:
        raise ConfigError("Cấu hình chưa đúng:\n - " + "\n - ".join(errs))
    mn, mx = _int("MIN_FRAMES", 20, 5, 100), _int("MAX_FRAMES", 30, 5, 100)
    if mn > mx:
        raise ConfigError("MIN_FRAMES không được lớn hơn MAX_FRAMES.")
    return Settings(
        database_url=db, storage_backend=backend, r2_account_id=r2["R2_ACCOUNT_ID"], r2_access_key_id=r2["R2_ACCESS_KEY_ID"],
        r2_secret_access_key=r2["R2_SECRET_ACCESS_KEY"], r2_bucket=r2["R2_BUCKET"], admin_token=token, admin_user=user, admin_password=pw,
        enroll_code=env("ENROLL_CODE"), allowed_origins=[o.strip() for o in env("ALLOWED_ORIGINS").split(",") if o.strip()],
        min_frames=mn, max_frames=mx, max_total_per_member=_int("MAX_TOTAL_PER_MEMBER", 60, mx, 500),
        enable_tilt=env("ENABLE_TILT_POSES", "0") == "1", rate_limit_per_hour=_int("RATE_LIMIT_PER_HOUR", 10, 1, 10000),
        local_store_dir=env("LOCAL_STORE_DIR", "./local_store"), sync_token=("" if _placeholder(env("SYNC_TOKEN")) else env("SYNC_TOKEN")))


def normalize_member_id(s: str) -> str:
    """Bỏ dấu tiếng Việt, chữ thường, bỏ khoảng trắng, chỉ giữ a-z 0-9 _ -."""
    import unicodedata
    s = unicodedata.normalize("NFD", (s or "").replace("đ", "d").replace("Đ", "D"))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"\s+", "", s)
    return re.sub(r"[^a-z0-9_-]", "", s)[:40]
