#!/usr/bin/env python3
"""Đóng gói frontend để host riêng (Vercel / Netlify / Cloudflare Pages / bất kỳ static host).
  python scripts/build_frontend.py --api https://ten-ban.onrender.com [--out dist]
Việc làm: sao chép static/ -> dist/, điền URL backend vào <meta name="api-base">, tạo vercel.json
(rewrite /admin -> admin.html, header cache hợp lý, CSP cho MediaPipe)."""
import argparse, json, os, re, shutil, sys

ap = argparse.ArgumentParser()
ap.add_argument("--api", required=True, help="URL backend, vd https://face-enrollment.onrender.com")
ap.add_argument("--out", default="dist")
a = ap.parse_args()
api = a.api.strip().rstrip("/")
if not re.match(r"^https://[\w.-]+(:\d+)?$", api):
    sys.exit("--api phải là URL https gốc, không có đường dẫn phía sau (vd https://ten.onrender.com)")
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src, out = os.path.join(root, "static"), os.path.join(root, a.out)
if os.path.isdir(out):
    shutil.rmtree(out)
shutil.copytree(src, out)
for name in ("index.html", "admin.html"):
    p = os.path.join(out, name); s = open(p, encoding="utf-8").read()
    s2 = re.sub(r'<meta name="api-base" content="[^"]*">', f'<meta name="api-base" content="{api}">', s)
    assert s2 != s or api in s, f"không thấy meta api-base trong {name}"
    open(p, "w", encoding="utf-8").write(s2)
cfg = {
    "cleanUrls": True,
    "rewrites": [{"source": "/admin", "destination": "/admin.html"}],
    "headers": [
        {"source": "/(.*)\\.html", "headers": [{"key": "Cache-Control", "value": "no-cache"}]},
        {"source": "/js/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=0, must-revalidate"}]},
        {"source": "/vendor/(.*)", "headers": [{"key": "Cache-Control", "value": "public, max-age=31536000, immutable"}]},
        {"source": "/(.*)", "headers": [{"key": "Permissions-Policy", "value": "camera=(self)"}, {"key": "X-Content-Type-Options", "value": "nosniff"}]},
    ],
}
json.dump(cfg, open(os.path.join(out, "vercel.json"), "w"), indent=2)
print(f"Đã tạo {out}\n  api-base = {api}\nBước tiếp: đặt ALLOWED_ORIGINS={'<URL frontend của bạn>'} trên backend rồi deploy thư mục này.")
if not os.path.isdir(os.path.join(out, "vendor", "mediapipe")):
    print("Gợi ý: chạy scripts/download_mediapipe.py TRƯỚC khi build để MediaPipe phục vụ cùng frontend (nhanh và không phụ thuộc CDN).")
