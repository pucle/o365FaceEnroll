#!/usr/bin/env python3
"""Tải MediaPipe (thư viện + wasm + mô hình mặt) về static/vendor/mediapipe để trang không phụ thuộc CDN.
Chạy một lần trong thư mục face-enrollment:  python scripts/download_mediapipe.py"""
import os, sys, urllib.request

VER = "0.10.14"
BASE = f"https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@{VER}"
FILES = {
    "vision_bundle.mjs": f"{BASE}/vision_bundle.mjs",
    "wasm/vision_wasm_internal.js": f"{BASE}/wasm/vision_wasm_internal.js",
    "wasm/vision_wasm_internal.wasm": f"{BASE}/wasm/vision_wasm_internal.wasm",
    "wasm/vision_wasm_nosimd_internal.js": f"{BASE}/wasm/vision_wasm_nosimd_internal.js",
    "wasm/vision_wasm_nosimd_internal.wasm": f"{BASE}/wasm/vision_wasm_nosimd_internal.wasm",
    "face_landmarker.task": "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
}
root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "vendor", "mediapipe")
for rel, url in FILES.items():
    dst = os.path.join(root, rel); os.makedirs(os.path.dirname(dst), exist_ok=True)
    print("Tải", rel, "...", end=" ", flush=True)
    try:
        urllib.request.urlretrieve(url, dst); print(f"{os.path.getsize(dst)/1e6:.1f} MB")
    except Exception as e:
        print("LỖI:", e); sys.exit(1)
print("Xong. Khởi động lại uvicorn rồi tải lại trang (Ctrl+Shift+R).")
