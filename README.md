---
title: Face Enrollment
emoji: 📸
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Face Enrollment — web thu thập khuôn mặt thành viên CLB

Web độc lập: thành viên tự quay mặt theo chỉ dẫn → ảnh tốt nhất và thông tin lưu ở **Neon Postgres** (không cần thẻ hay dịch vụ lưu trữ ngoài). Hệ thống điểm danh `club-attendance` kéo dữ liệu trực tiếp bằng **SYNC_TOKEN** (mục 9) hoặc admin tải ZIP.

## 1. Tổng quan
Luồng: nhập mã CLB (một lần) → nhập MSSV/họ tên → quét kiểu **Face ID**: nhìn thẳng ~2 giây rồi xoay đầu chậm theo vòng tròn (16 cung sáng dần, tối đa vài vòng), ảnh tự gán nhãn tư thế → xem lại, bỏ ảnh xấu → gửi → "Người tiếp theo" (không nhập lại mã). Thêm `?debug=1` vào URL để xem yaw/pitch/roll. Không có ô đồng ý (consent) theo yêu cầu thiết kế.

## 2. Kiến trúc
`Trình duyệt (MediaPipe đo góc mặt, chấm điểm, cắt mặt ≤320 px) → FastAPI (Render) → Neon (metadata + ảnh)`. Phần nặng chạy trong trình duyệt nên server nhẹ. Chỉ admin/sync mới đọc được ảnh.

## 3. Cấu trúc thư mục
`app/` (config, db, storage, images, security, export, routes_*), `static/` (index.html, admin.html, js/, css/), `scripts/`, `tests/`.

## 4. Chuẩn bị Neon
Neon → Project → **Connect** → chọn **Pooled connection** → copy chuỗi `postgresql://...?sslmode=require` làm `DATABASE_URL`. Bảng `enroll_members/enroll_images/enroll_blobs` tự tạo khi khởi động (không đụng bảng của club-attendance, dùng chung DB được).
Dung lượng: ảnh thu nhỏ 320 px (~15 KB), 500 người × 20 ảnh ≈ 150–200 MB, vừa Neon free (0.5 GB). Neon đầy thì cả thông tin lẫn ảnh dừng — hãy đồng bộ rồi xoá người đã xuất.

## 5. Biến môi trường
Xem `.env.example`. Bắt buộc: `DATABASE_URL`, `ADMIN_TOKEN`, `STORAGE_BACKEND=db`.
Khuyên đặt: `SYNC_TOKEN` (token chỉ-đọc để hệ thống nhận diện kéo ảnh trực tiếp, xem **mục 9**).
Tuỳ chọn: `ENROLL_CODE`, `API_ONLY`, `ALLOWED_ORIGINS`, `MIN_FRAMES`, `MAX_FRAMES`, `MAX_TOTAL_PER_MEMBER`, `ENABLE_TILT_POSES`, `RATE_LIMIT_PER_HOUR`, `SESSION_SECRET`. Thiếu hoặc còn giá trị mẫu → server dừng ngay với thông báo tiếng Việt. Tạo chuỗi bí mật: `python scripts/gen_secrets.py`.

## 6. Chạy trên máy
PowerShell:
```powershell
cd face-enrollment; python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt; copy .env.example .env   # rồi điền .env
uvicorn app.main:app --port 7865
```
cmd: `.venv\Scripts\activate.bat` thay cho dòng Activate. Git Bash: `source .venv/Scripts/activate`, `cp .env.example .env`.
Camera cần HTTPS hoặc `localhost`. Thử nhanh không cần Neon: `STORAGE_BACKEND=local` (ảnh vào `./local_store`, chỉ để thử).

## 7. Deploy (Render, hoặc Vercel + Render)
Hiệu năng gần như local vì MediaPipe chạy trong trình duyệt; server chỉ nhận ~30 ảnh nhỏ. Khác biệt: tải ảnh qua mạng, và Render free **ngủ sau 15 phút** (trang tự gọi `/healthz` để đánh thức, ~1 phút).

| Cách | Khi nào chọn |
|---|---|
| **A. Chỉ Render** (khuyên dùng) | Đơn giản, 1 link, không cần CORS |
| **B. Vercel (giao diện) + Render (API)** | Muốn trang mở tức thì; cần CORS, quản lý hai nơi |

### A. Chỉ Render
1. Đẩy thư mục lên GitHub (không đưa `.env`).
2. Render → New → **Blueprint** (`render.yaml`) hoặc Web Service → Docker. Điền: `DATABASE_URL`, `ADMIN_TOKEN`, `SYNC_TOKEN`, `ENROLL_CODE` (tuỳ chọn), `STORAGE_BACKEND=db`.
3. Mở `https://<tên>.onrender.com` (đăng ký) và `/admin`.
4. Muốn MediaPipe không phụ thuộc CDN: chạy `python scripts/download_mediapipe.py` trước khi đẩy lên GitHub (thêm `static/vendor`, ~25 MB).

### B. Vercel + Render
1. Làm bước 1–2 của cách A, thêm **`API_ONLY=1`**. Ghi lại URL Render.
2. PowerShell: `.\scripts\deploy_vercel.ps1 -Api https://face-enrollment.onrender.com`
   Git Bash: `bash scripts/deploy_vercel.sh https://face-enrollment.onrender.com`
3. Lấy URL Vercel, vào Render → Environment → đặt **`ALLOWED_ORIGINS=https://<app>.vercel.app`** (nhiều domain cách nhau dấu phẩy, không có `/` cuối) → Manual Deploy.
4. Đăng ký ở URL Vercel; quản trị ở `<URL Vercel>/admin`.
Không dùng CLI: `python scripts/build_frontend.py --api <URL Render>` rồi kéo thả thư mục `dist/` vào Vercel/Netlify.

> Script deploy chưa chạy với tài khoản Vercel/Render thật.

**Mã CLB** chỉ hỏi một lần khi vào web (nhớ trong tab). Đăng ký xong bấm "Người tiếp theo" để quét người kế tiếp.

## 8. Trang quản trị
Mở `/admin`, nhập `ADMIN_TOKEN`. Xem thống kê, danh sách (cảnh báo "thiếu ảnh" nếu < `MIN_FRAMES`), xem/xoá ảnh, tải ZIP, đánh dấu đã xuất.

## 9. Dùng SYNC_TOKEN để đồng bộ sang hệ thống nhận diện
`SYNC_TOKEN` là token **chỉ đọc**, tách khỏi `ADMIN_TOKEN`: chỉ gọi được `GET /api/admin/manifest`, `GET /api/admin/images/{id}/file` và `POST /api/admin/mark-exported`; không xoá/sửa được gì. Hệ thống nhận diện dùng nó để kéo ảnh thẳng vào model, **không cần tải ZIP rồi upload lại**; chỉ vector được lưu bên đó.

**Bước 1 — tạo và đặt token.** Tạo: `python scripts/gen_secrets.py` (hoặc bất kỳ chuỗi ngẫu nhiên ≥ 24 ký tự, khác `ADMIN_TOKEN`). Đặt biến `SYNC_TOKEN` trong `.env` (local) hoặc Render → Environment (rồi Manual Deploy). Bỏ trống/để giá trị mẫu = tắt tính năng.

**Bước 2 — chạy trong thư mục `club-attendance`** (`API_TOKEN` là `X-API-Token` của hệ thống chính):

PowerShell:
```powershell
$env:ENROLL_URL="https://<web-quet>.onrender.com"; $env:ENROLL_TOKEN="<SYNC_TOKEN>"
python tools/sync_enrollment.py --url https://<he-thong-chinh> --token <API_TOKEN> --status   # xem trước
python tools/sync_enrollment.py --url https://<he-thong-chinh> --token <API_TOKEN> --mark     # đồng bộ
```
cmd:
```
set ENROLL_URL=https://<web-quet>.onrender.com
set ENROLL_TOKEN=<SYNC_TOKEN>
python tools/sync_enrollment.py --url https://<he-thong-chinh> --token <API_TOKEN> --mark
```
Git Bash:
```bash
export ENROLL_URL=https://<web-quet>.onrender.com ENROLL_TOKEN=<SYNC_TOKEN>
python tools/sync_enrollment.py --url https://<he-thong-chinh> --token <API_TOKEN> --mark
```
Tham số: `--only MSSV` (một người), `--mode add|replace`, `--target 24`, `--augment auto|off`, `--dry-run`, `--mark` (báo web quét là đã xuất, lần sau chỉ lấy người mới). Chi tiết: `club-attendance/docs/12-sync-enrollment.md`.

Lỗi hay gặp: 401/403 → sai `SYNC_TOKEN` hoặc chưa đặt trên server; lần gọi đầu chậm → Render đang ngủ (công cụ tự thử lại). Token lộ → đổi `SYNC_TOKEN` trên Render là vô hiệu hoá ngay.

> Công cụ mới test với hai server giả (10/10), chưa chạy với Render/Neon thật.

## 10. Các cách khác để lấy dataset
1. **Nút ZIP** ở `/admin` (toàn bộ hoặc chỉ người chưa xuất). Dữ liệu lớn có thể hết RAM trình duyệt → dùng cách 2.
2. **Script**: `python scripts/download_dataset.py --url https://ten.onrender.com --token <ADMIN_TOKEN> --status pending --mark` (stream).
3. Nhập ZIP thủ công trong `club-attendance`: `python tools/import_dataset.py dataset.zip`.
Cấu trúc ZIP: `dataset/manifest.csv`, `dataset/manifest.json`, `dataset/<member_id>/<pose>_001.jpg`. Nên dùng **JPG + manifest.json**; JSON/CSV riêng không chứa ảnh.

## 11. Bảo mật & giới hạn
Ảnh không có URL công khai, chỉ trả qua server cho admin/sync. Ảnh bị mã hoá lại bằng Pillow (xoá EXIF), giới hạn dung lượng/kích thước/số ảnh (trần 60/người, xoá ảnh điểm thấp nhất), chống trùng SHA-256, giới hạn đăng ký theo IP, `ENROLL_CODE` tuỳ chọn (giới hạn 30 lần thử/giờ/IP), token tải ảnh HMAC hết hạn sau 2 giờ, CSV chống công thức độc. Giới hạn: không xác thực danh tính thật — ai có `ENROLL_CODE` (hoặc nếu bỏ trống) đều đăng ký được bằng MSSV bất kỳ; nên đặt mã và để admin đối chiếu.

## 12. Xử lý lỗi thường gặp
| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `column "member_id" ... does not exist` | Bản cũ trùng bảng `members` của club-attendance | Dùng bản mới (bảng `enroll_*`) |
| Server thoát ngay, in "Thiếu/còn giá trị mẫu" | Biến môi trường chưa điền | Điền theo mục 5 |
| `/healthz` `neon:false` | Chuỗi Neon sai hoặc DB đang thức | Dùng Pooled connection có `sslmode=require`; thử lại sau vài giây |
| Admin báo "Mã quản trị không đúng" | Dán thừa dấu cách/nháy | Dán lại |
| Không bật được camera | Chưa cấp quyền / không HTTPS | Cho phép camera ở thanh địa chỉ; dùng HTTPS |
| "Không tải được mô hình nhận diện khuôn mặt" | Trình duyệt nhúng hạn chế WASM, hoặc mạng chặn CDN | Mở bằng Chrome/Edge; hoặc `python scripts/download_mediapipe.py` để phục vụ MediaPipe từ server |
| Giao diện cũ / không đổi sau khi cập nhật | Cache trình duyệt | Ctrl+F5; chạy đúng thư mục bản mới |
| Đăng ký báo không kết nối | Render free đang ngủ | Chờ ~1 phút rồi thử lại |
| 429 | Quá số lần đăng ký/giờ/IP | Chờ hoặc tăng `RATE_LIMIT_PER_HOUR` |
| "Chưa đủ ảnh tốt" | Thiếu sáng, mặt lệch khung, quay quá nhanh | Quay lại nơi sáng hơn, giữ mặt trong khung |

## Kiểm thử đã chạy / chưa chạy
Đã chạy: `node tests/capture.test.mjs` (30 test: góc từ landmark, cung vòng tròn, mô phỏng cả buổi quét bằng camera giả), `PYTHONPATH=tests/fakepg:. python tests/test_core.py` (39 test: config, DB giả trên SQLite, ảnh, ZIP, giới hạn tốc độ, xác thực, quyền SYNC_TOKEN). **Chưa chạy**: server FastAPI end-to-end, Neon thật, Docker build, MediaPipe trên trình duyệt thật, camera điện thoại, deploy Vercel/Render thật, sync tool với server thật.
