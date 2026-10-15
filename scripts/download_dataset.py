#!/usr/bin/env python3
"""Tải dataset về máy qua API quản trị (stream, không tốn RAM).
  python scripts/download_dataset.py --url https://ten.onrender.com --token ADMIN_TOKEN [--status pending] [--out dataset.zip] [--mark]"""
import argparse, sys, requests

ap = argparse.ArgumentParser()
ap.add_argument("--url", required=True); ap.add_argument("--token", required=True)
ap.add_argument("--status", default="all", choices=["all", "pending", "exported"]); ap.add_argument("--out", default="dataset.zip")
ap.add_argument("--mark", action="store_true", help="sau khi tải xong, đánh dấu các thành viên đã xuất")
a = ap.parse_args(); base = a.url.rstrip("/"); h = {"Authorization": "Bearer " + a.token.strip().strip("\"'")}
r = requests.get(f"{base}/api/admin/export.zip", params={"status": a.status}, headers=h, stream=True, timeout=(30, 300))
if r.status_code != 200:
    sys.exit(f"Lỗi {r.status_code}: {r.text[:200]}")
n = 0
with open(a.out, "wb") as f:
    for ch in r.iter_content(1 << 20):
        f.write(ch); n += len(ch); print(f"\r{n/1e6:.1f} MB", end="", flush=True)
print(f"\nĐã lưu {a.out}")
if a.mark:
    ms = requests.get(f"{base}/api/admin/members", params={"status": "pending", "limit": 200}, headers=h, timeout=60).json()["items"]
    requests.post(f"{base}/api/admin/mark-exported", json={"member_ids": [m["member_id"] for m in ms]}, headers=h, timeout=60).raise_for_status()
    print(f"Đã đánh dấu {len(ms)} thành viên.")
