#!/usr/bin/env python3
"""Kiểm tra kết nối Neon + R2 và (tuỳ chọn) tìm object mồ côi.  Chạy trong thư mục face-enrollment:  python scripts/check_r2.py [--find-orphans] [--delete-orphans]"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.config import load_settings, ConfigError
from app.db import Db
from app.storage import make_store
ap = argparse.ArgumentParser(); ap.add_argument("--find-orphans", action="store_true"); ap.add_argument("--delete-orphans", action="store_true")
a = ap.parse_args()
try: s = load_settings()
except ConfigError as e: sys.exit(str(e))
db, store = Db(s), make_store(s)
print("Neon:", "OK" if db.ping() else "LỖI")
try: store.check(); print("R2/kho ảnh: OK")
except Exception as e: sys.exit(f"R2/kho ảnh LỖI: {e}")
if a.find_orphans or a.delete_orphans:
    orphans = sorted(set(store.list_keys()) - db.all_object_keys()); print(f"Object mồ côi: {len(orphans)}")
    for k in orphans[:50]: print("  ", k)
    if a.delete_orphans:
        for k in orphans: store.delete(k)
        print("Đã xoá.")
