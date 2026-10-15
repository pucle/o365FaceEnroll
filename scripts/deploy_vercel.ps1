# Dùng:  .\scripts\deploy_vercel.ps1 -Api https://ten-ban.onrender.com
param([Parameter(Mandatory=$true)][string]$Api)
$ErrorActionPreference = "Stop"
if (-not (Test-Path "static\vendor\mediapipe\face_landmarker.task")) { python scripts/download_mediapipe.py }
python scripts/build_frontend.py --api $Api --out dist
Push-Location dist
npx --yes vercel@latest deploy --prod        # lần đầu sẽ hỏi đăng nhập + đặt tên project
Pop-Location
Write-Host "Xong. Nhớ đặt ALLOWED_ORIGINS=<URL Vercel vừa nhận> trên Render rồi Manual Deploy."
