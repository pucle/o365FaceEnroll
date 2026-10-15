"""Kiểm tra và xử lý ảnh bằng Pillow: đúng là JPEG hợp lệ, kích thước hợp lý, re-encode để bỏ EXIF/metadata."""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

from PIL import Image, UnidentifiedImageError

MAX_SIDE = 640            # ảnh lớn hơn bị thu nhỏ (client gửi ~512 px)
MIN_SIDE = 96


class BadImage(ValueError):
    pass


@dataclass
class Clean:
    data: bytes
    width: int
    height: int
    sha256: str


def clean_jpeg(raw: bytes, max_bytes: int) -> Clean:
    if not raw:
        raise BadImage("Ảnh rỗng.")
    if len(raw) > max_bytes:
        raise BadImage(f"Ảnh quá lớn (> {max_bytes // 1024} KB).")
    if not raw.startswith(b"\xff\xd8"):
        raise BadImage("Chỉ chấp nhận ảnh JPEG.")
    try:
        im = Image.open(io.BytesIO(raw))
        im.verify()                                # kiểm tra cấu trúc
        im = Image.open(io.BytesIO(raw))
        if im.format != "JPEG":
            raise BadImage("Chỉ chấp nhận ảnh JPEG.")
        im = im.convert("RGB")
    except (UnidentifiedImageError, OSError, SyntaxError) as e:
        raise BadImage("Tệp không phải ảnh hợp lệ.") from e
    w, h = im.size
    if min(w, h) < MIN_SIDE:
        raise BadImage("Ảnh quá nhỏ.")
    if max(w, h) > MAX_SIDE:
        s = MAX_SIDE / max(w, h)
        im = im.resize((round(w * s), round(h * s)), Image.LANCZOS)
        w, h = im.size
    out = io.BytesIO()
    im.save(out, "JPEG", quality=88, optimize=True)       # lưu lại từ điểm ảnh => không còn EXIF
    data = out.getvalue()
    return Clean(data, w, h, hashlib.sha256(data).hexdigest())
