#!/usr/bin/env python3
"""In ra các giá trị bí mật ngẫu nhiên để dán vào biến môi trường Render."""
import secrets
print("ADMIN_TOKEN=" + secrets.token_urlsafe(32))
print("SESSION_SECRET=" + secrets.token_urlsafe(32))
print("ENROLL_CODE=" + secrets.token_urlsafe(6) + "      # mã CLB: nên đặt chuỗi ngắn, dễ đọc cho thành viên, đổi tuỳ ý")
