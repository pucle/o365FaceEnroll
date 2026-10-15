#!/usr/bin/env bash
# Dùng:  bash scripts/deploy_vercel.sh https://ten-ban.onrender.com     (Git Bash / macOS / Linux)
set -euo pipefail
API="${1:?Thiếu URL backend, vd https://ten-ban.onrender.com}"
[ -f static/vendor/mediapipe/face_landmarker.task ] || python scripts/download_mediapipe.py
python scripts/build_frontend.py --api "$API" --out dist
(cd dist && npx --yes vercel@latest deploy --prod)
echo "Xong. Nhớ đặt ALLOWED_ORIGINS=<URL Vercel vừa nhận> trên Render rồi Manual Deploy."
