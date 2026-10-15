"""Nơi lưu ảnh. Lớp trừu tượng ImageStore + R2ImageStore (Cloudflare R2, API tương thích S3 qua boto3).
boto3 là thư viện ĐỒNG BỘ nên mọi lệnh gọi từ route async phải đi qua run_in_threadpool (xem routes_*)."""
from __future__ import annotations

import abc
import os
from typing import Iterator, List

CHUNK = 64 * 1024


class StorageError(RuntimeError):
    pass


class ImageStore(abc.ABC):
    @abc.abstractmethod
    def save(self, key: str, data: bytes, content_type: str = "image/jpeg") -> None: ...

    @abc.abstractmethod
    def get_stream(self, key: str) -> Iterator[bytes]: ...

    @abc.abstractmethod
    def delete(self, key: str) -> None: ...

    @abc.abstractmethod
    def presigned_url(self, key: str, expires: int = 600) -> str: ...

    @abc.abstractmethod
    def list_keys(self, prefix: str = "faces/") -> List[str]: ...

    def check(self) -> None:
        """Ném StorageError nếu không dùng được (dùng cho /healthz và check_r2.py)."""


class R2ImageStore(ImageStore):
    def __init__(self, account_id: str, access_key: str, secret_key: str, bucket: str):
        try:
            import boto3
            from botocore.config import Config
        except ImportError as e:                      # pragma: no cover
            raise StorageError("Thiếu thư viện boto3: pip install boto3") from e
        self.bucket = bucket
        self.client = boto3.client(
            "s3", endpoint_url=f"https://{account_id}.r2.cloudflarestorage.com", aws_access_key_id=access_key,
            aws_secret_access_key=secret_key, region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=10, read_timeout=30))

    def check(self) -> None:
        from botocore.exceptions import ClientError
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except ClientError as e:
            code = str(e.response.get("Error", {}).get("Code", ""))
            hint = {"404": "Bucket không tồn tại (sai R2_BUCKET?)", "NoSuchBucket": "Bucket không tồn tại (sai R2_BUCKET?)",
                    "403": "Token không đủ quyền hoặc không thuộc bucket này (cần Object Read & Write)",
                    "AccessDenied": "Token không đủ quyền hoặc không thuộc bucket này (cần Object Read & Write)",
                    "SignatureDoesNotMatch": "Sai Secret Access Key hoặc Account ID",
                    "InvalidAccessKeyId": "Sai Access Key ID"}.get(code, "Lỗi R2 " + code)
            raise StorageError(hint) from e
        except Exception as e:
            raise StorageError(f"Không gọi được R2 ({type(e).__name__}). Kiểm tra R2_ACCOUNT_ID và kết nối mạng.") from e

    def save(self, key, data, content_type="image/jpeg"):
        self.client.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType=content_type)

    def get_stream(self, key):
        body = self.client.get_object(Bucket=self.bucket, Key=key)["Body"]
        try:
            for chunk in body.iter_chunks(CHUNK):
                yield chunk
        finally:
            body.close()

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def presigned_url(self, key, expires=600):
        return self.client.generate_presigned_url("get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires)

    def list_keys(self, prefix="faces/"):
        out, token = [], None
        while True:
            kw = {"Bucket": self.bucket, "Prefix": prefix}
            if token:
                kw["ContinuationToken"] = token
            r = self.client.list_objects_v2(**kw)
            out += [o["Key"] for o in r.get("Contents", [])]
            if not r.get("IsTruncated"):
                return out
            token = r.get("NextContinuationToken")


class LocalImageStore(ImageStore):
    """CHỈ để thử trên máy / chạy test. Khi deploy dùng R2 (đĩa của dịch vụ free bị xoá mỗi lần restart)."""

    def __init__(self, root: str):
        self.root = os.path.abspath(root)
        os.makedirs(self.root, exist_ok=True)

    def _p(self, key: str) -> str:
        p = os.path.abspath(os.path.join(self.root, key))
        if not p.startswith(self.root + os.sep):
            raise StorageError("key không hợp lệ")
        return p

    def save(self, key, data, content_type="image/jpeg"):
        p = self._p(key)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)

    def get_stream(self, key):
        with open(self._p(key), "rb") as f:
            while True:
                b = f.read(CHUNK)
                if not b:
                    return
                yield b

    def delete(self, key):
        try:
            os.remove(self._p(key))
        except FileNotFoundError:
            pass

    def presigned_url(self, key, expires=600):
        return "/api/admin/blob?key=" + key             # route admin có xác thực, chỉ dùng khi STORAGE_BACKEND=local

    def list_keys(self, prefix="faces/"):
        out = []
        for d, _, fs in os.walk(self.root):
            for f in fs:
                k = os.path.relpath(os.path.join(d, f), self.root).replace(os.sep, "/")
                if k.startswith(prefix):
                    out.append(k)
        return out


class DbImageStore(ImageStore):
    """Lưu ảnh ngay trong Neon (bảng enroll_blobs). Không cần dịch vụ thứ hai, không cần thẻ. Neon free chỉ 0.5 GB -> dùng ảnh nhỏ."""

    def __init__(self, db):
        self.db = db

    def check(self) -> None:
        if not self.db.ping():
            raise StorageError("Không kết nối được Neon.")

    def save(self, key, data, content_type="image/jpeg"):
        self.db.run(lambda c: c.execute(
            "INSERT INTO enroll_blobs(object_key,data) VALUES (%s,%s) ON CONFLICT (object_key) DO UPDATE SET data=EXCLUDED.data", (key, data)))

    def get_stream(self, key):
        row = self.db.run(lambda c: c.execute("SELECT data FROM enroll_blobs WHERE object_key=%s", (key,)).fetchone())
        if not row:
            raise StorageError("Không thấy ảnh: " + key)
        yield bytes(row[0])

    def delete(self, key):
        self.db.run(lambda c: c.execute("DELETE FROM enroll_blobs WHERE object_key=%s", (key,)))

    def presigned_url(self, key, expires=600):
        return "/api/admin/blob?key=" + key

    def list_keys(self, prefix="faces/"):
        rows = self.db.run(lambda c: c.execute("SELECT object_key FROM enroll_blobs WHERE object_key LIKE %s", (prefix + "%",)).fetchall())
        return [r[0] for r in rows]


def make_store(s, db=None) -> ImageStore:
    if s.storage_backend == "db":
        return DbImageStore(db)
    if s.storage_backend == "local":
        return LocalImageStore(s.local_store_dir)
    return R2ImageStore(s.r2_account_id, s.r2_access_key_id, s.r2_secret_access_key, s.r2_bucket)
