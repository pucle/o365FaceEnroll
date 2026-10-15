"""Xuất dataset: ZIP dạng stream (không nạp cả ảnh vào RAM) + manifest.csv/json.
Cấu trúc cố định:  dataset/manifest.csv, dataset/manifest.json, dataset/<member_id>/<pose>_001.jpg ..."""
from __future__ import annotations

import csv
import io
import json
import logging
import time
import zipfile
from collections import Counter
from datetime import datetime, timezone
from typing import Iterator, List, Optional

log = logging.getLogger("export")
ROOT = "dataset"


class _Sink(io.RawIOBase):
    """Đích ghi không tua được cho ZipFile; hút (drain) dữ liệu đã ghi ra để trả về cho client ngay."""

    def __init__(self):
        self.buf: List[bytes] = []
        self.pos = 0

    def writable(self):
        return True

    def write(self, b):
        b = bytes(b)
        self.buf.append(b)
        self.pos += len(b)
        return len(b)

    def tell(self):
        return self.pos

    def flush(self):
        pass

    def drain(self) -> bytes:
        out = b"".join(self.buf)
        self.buf.clear()
        return out


def file_name(pose: str, n: int) -> str:
    return f"{pose}_{n:03d}.jpg"


def build_manifest(db, members: List[dict]) -> dict:
    out = []
    for m in members:
        imgs, cnt, files = db.list_images(m["member_id"]), Counter(), []
        for im in imgs:
            cnt[im["pose"]] += 1
            files.append({"id": im["id"], "file": f"{m['member_id']}/{file_name(im['pose'], cnt[im['pose']])}", "pose": im["pose"],
                          "quality": im["quality"], "width": im["width"], "height": im["height"], "sha256": im["sha256"]})
        out.append({**m, "collected_at": m["updated_at"], "image_count": len(files), "images": files})
    return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"), "members": out}


def manifest_csv(man: dict) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["member_id", "full_name", "group", "image_count", "status", "collected_at"])
    for m in man["members"]:
        w.writerow([_safe(m["member_id"]), _safe(m["full_name"]), _safe(m["group"] or ""), m["image_count"], m["status"], m["collected_at"]])
    return "﻿" + buf.getvalue()


def _safe(v: str) -> str:
    """Chống CSV injection khi mở bằng Excel: ô bắt đầu bằng = + - @ bị coi là công thức."""
    return "'" + v if v[:1] in ("=", "+", "-", "@") else v


def stream_zip(db, store, members: List[dict]) -> Iterator[bytes]:
    man = build_manifest(db, members)
    sink = _Sink()
    zf = zipfile.ZipFile(sink, "w", zipfile.ZIP_STORED, allowZip64=True)
    now = time.localtime()[:6]
    missing = []
    for m in man["members"]:
        for im in m["images"]:
            info = zipfile.ZipInfo(f"{ROOT}/{im['file']}", date_time=now)
            info.compress_type = zipfile.ZIP_STORED
            try:
                key = db_key(db, im["id"])
                with zf.open(info, "w", force_zip64=True) as dest:
                    for chunk in store.get_stream(key):
                        dest.write(chunk)
                        d = sink.drain()
                        if d:
                            yield d
            except Exception as e:                       # một ảnh lỗi không làm hỏng cả ZIP
                log.error("không đọc được ảnh %s: %s", im["file"], type(e).__name__)
                missing.append(im["file"])
            d = sink.drain()
            if d:
                yield d
    man["missing_files"] = missing
    zf.writestr(f"{ROOT}/manifest.json", json.dumps(man, ensure_ascii=False, indent=1))
    zf.writestr(f"{ROOT}/manifest.csv", manifest_csv(man))
    zf.close()
    d = sink.drain()
    if d:
        yield d


def db_key(db, image_id: int) -> str:
    r = db.run(lambda c: c.execute("SELECT object_key FROM enroll_images WHERE id=%s", (image_id,)).fetchone())
    if not r:
        raise KeyError(image_id)
    return r[0]
