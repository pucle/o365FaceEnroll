"""Neon Postgres bằng psycopg 3 + pool nhỏ. Neon free tự NGỦ khi không dùng nên kết nối đầu tiên có thể chậm hoặc lỗi:
pool kiểm tra kết nối trước khi giao, và mọi thao tác được thử lại có backoff."""
from __future__ import annotations

import logging
import time
from typing import Any, Callable, List, Optional, Sequence, Tuple

from .config import Settings, mask_url

log = logging.getLogger("db")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS enroll_members (
      member_id   TEXT PRIMARY KEY,
      full_name   TEXT NOT NULL,
      group_name  TEXT,
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      status      TEXT NOT NULL DEFAULT 'pending'
    )""",
    """CREATE TABLE IF NOT EXISTS enroll_images (
      id          BIGSERIAL PRIMARY KEY,
      member_id   TEXT NOT NULL REFERENCES enroll_members(member_id) ON DELETE CASCADE,
      pose        TEXT NOT NULL,
      quality     REAL,
      width       INT,
      height      INT,
      mime        TEXT NOT NULL DEFAULT 'image/jpeg',
      object_key  TEXT NOT NULL UNIQUE,
      size_bytes  INT NOT NULL,
      sha256      TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (member_id, sha256)
    )""",
    "CREATE INDEX IF NOT EXISTS idx_enroll_images_member ON enroll_images(member_id)",
    """CREATE TABLE IF NOT EXISTS enroll_blobs (
      object_key TEXT PRIMARY KEY,
      data       BYTEA NOT NULL
    )""",
]
IMG_COLS = "id,member_id,pose,quality,width,height,object_key,size_bytes,sha256,created_at"


def iso(v: Any) -> Optional[str]:
    if v is None:
        return None
    return v.isoformat(timespec="seconds") if hasattr(v, "isoformat") else str(v)


class Db:
    def __init__(self, s: Settings, retries: int = 4):
        import psycopg
        from psycopg_pool import ConnectionPool
        self._psycopg = psycopg
        self.retries = retries
        log.info("Kết nối CSDL: %s", mask_url(s.database_url))
        self.pool = ConnectionPool(s.database_url, min_size=0, max_size=4, max_idle=120, timeout=30,
                                   kwargs={"connect_timeout": 15}, check=ConnectionPool.check_connection, open=True)
        self.migrate()

    def close(self) -> None:
        self.pool.close()

    # ---- chạy có thử lại ---------------------------------------------------------------
    def run(self, fn: Callable[[Any], Any]) -> Any:
        last: Optional[Exception] = None
        for i in range(self.retries):
            try:
                with self.pool.connection() as conn:
                    return fn(conn)
            except (self._psycopg.OperationalError, self._psycopg.InterfaceError) as e:     # gồm cả PoolTimeout (Neon đang thức dậy)
                last = e
                log.warning("CSDL chưa sẵn sàng (lần %d/%d): %s", i + 1, self.retries, type(e).__name__)
                time.sleep(1.0 * (i + 1))
            except Exception as e:
                if type(e).__name__ == "PoolTimeout":
                    last = e
                    time.sleep(1.0 * (i + 1))
                    continue
                raise
        raise RuntimeError("Không kết nối được Neon. Kiểm tra DATABASE_URL, mật khẩu, sslmode=require; Neon có thể đang thức dậy, thử lại sau vài giây.") from last

    def migrate(self) -> None:
        def go(c):
            for stmt in SCHEMA:
                c.execute(stmt)
        self.run(go)

    def ping(self) -> bool:
        try:
            return self.run(lambda c: c.execute("SELECT 1").fetchone()) is not None
        except Exception:
            return False

    # ---- thành viên ----------------------------------------------------------------------
    def upsert_member(self, member_id: str, full_name: str, group: Optional[str], notes: Optional[str]) -> bool:
        """Trả về True nếu là thành viên MỚI."""
        def go(c):
            row = c.execute("SELECT 1 FROM enroll_members WHERE member_id=%s", (member_id,)).fetchone()
            if row:
                c.execute("UPDATE enroll_members SET full_name=%s, group_name=COALESCE(%s, group_name), notes=COALESCE(%s, notes), "
                          "updated_at=now(), status='pending' WHERE member_id=%s", (full_name, group, notes, member_id))
                return False
            c.execute("INSERT INTO enroll_members(member_id, full_name, group_name, notes) VALUES(%s,%s,%s,%s)", (member_id, full_name, group, notes))
            return True
        return self.run(go)

    def member_exists(self, member_id: str) -> bool:
        return self.run(lambda c: c.execute("SELECT 1 FROM enroll_members WHERE member_id=%s", (member_id,)).fetchone()) is not None

    def get_member(self, member_id: str) -> Optional[dict]:
        r = self.run(lambda c: c.execute("SELECT member_id,full_name,group_name,notes,created_at,updated_at,status FROM enroll_members WHERE member_id=%s", (member_id,)).fetchone())
        return None if not r else {"member_id": r[0], "full_name": r[1], "group": r[2], "notes": r[3], "created_at": iso(r[4]), "updated_at": iso(r[5]), "status": r[6]}

    def list_members(self, q: str = "", status: str = "all", limit: int = 50, offset: int = 0) -> Tuple[List[dict], int]:
        where, args = [], []
        if status in ("pending", "exported"):
            where.append("m.status=%s"); args.append(status)
        if q:
            where.append("(lower(m.member_id) LIKE %s OR lower(m.full_name) LIKE %s OR lower(COALESCE(m.group_name,'')) LIKE %s)")
            like = f"%{q.lower()}%"; args += [like, like, like]
        w = (" WHERE " + " AND ".join(where)) if where else ""

        def go(c):
            total = c.execute(f"SELECT COUNT(*) FROM enroll_members m{w}", tuple(args)).fetchone()[0]
            rows = c.execute(
                "SELECT m.member_id,m.full_name,m.group_name,m.status,m.created_at,m.updated_at,"
                "(SELECT COUNT(*) FROM enroll_images f WHERE f.member_id=m.member_id) "
                f"FROM enroll_members m{w} ORDER BY m.created_at DESC, m.member_id LIMIT %s OFFSET %s", tuple(args) + (limit, offset)).fetchall()
            return total, rows
        total, rows = self.run(go)
        return [{"member_id": r[0], "full_name": r[1], "group": r[2], "status": r[3], "created_at": iso(r[4]),
                 "updated_at": iso(r[5]), "image_count": int(r[6])} for r in rows], int(total)

    def delete_member(self, member_id: str) -> List[str]:
        """Xoá thành viên + toàn bộ ảnh trong DB; trả về danh sách object_key cần xoá khỏi R2."""
        def go(c):
            keys = [r[0] for r in c.execute("SELECT object_key FROM enroll_images WHERE member_id=%s", (member_id,)).fetchall()]
            c.execute("DELETE FROM enroll_images WHERE member_id=%s", (member_id,))
            c.execute("DELETE FROM enroll_members WHERE member_id=%s", (member_id,))
            return keys
        return self.run(go)

    def clear_images(self, member_id: str) -> List[str]:
        def go(c):
            keys = [r[0] for r in c.execute("SELECT object_key FROM enroll_images WHERE member_id=%s", (member_id,)).fetchall()]
            c.execute("DELETE FROM enroll_images WHERE member_id=%s", (member_id,))
            c.execute("UPDATE enroll_members SET updated_at=now(), status='pending' WHERE member_id=%s", (member_id,))
            return keys
        return self.run(go)

    def mark_exported(self, member_ids: Sequence[str]) -> int:
        if not member_ids:
            return 0

        def go(c):
            n = 0
            for m in member_ids:
                n += c.execute("UPDATE enroll_members SET status='exported' WHERE member_id=%s", (m,)).rowcount
            return n
        return self.run(go)

    # ---- ảnh --------------------------------------------------------------------------------
    def count_images(self, member_id: str) -> int:
        return int(self.run(lambda c: c.execute("SELECT COUNT(*) FROM enroll_images WHERE member_id=%s", (member_id,)).fetchone()[0]))

    def insert_image(self, member_id: str, pose: str, quality: Optional[float], width: int, height: int,
                     object_key: str, size_bytes: int, sha256: str) -> Optional[int]:
        """None nếu ảnh trùng (cùng member_id + sha256)."""
        def go(c):
            r = c.execute("INSERT INTO enroll_images(member_id,pose,quality,width,height,object_key,size_bytes,sha256) "
                          "VALUES(%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (member_id, sha256) DO NOTHING RETURNING id",
                          (member_id, pose, quality, width, height, object_key, size_bytes, sha256)).fetchone()
            if r:
                c.execute("UPDATE enroll_members SET updated_at=now(), status='pending' WHERE member_id=%s", (member_id,))
            return None if r is None else int(r[0])
        return self.run(go)

    def list_images(self, member_id: str) -> List[dict]:
        rows = self.run(lambda c: c.execute(f"SELECT {IMG_COLS} FROM enroll_images WHERE member_id=%s ORDER BY id", (member_id,)).fetchall())
        return [self._img(r) for r in rows]

    @staticmethod
    def _img(r) -> dict:
        return {"id": int(r[0]), "member_id": r[1], "pose": r[2], "quality": None if r[3] is None else float(r[3]), "width": r[4], "height": r[5],
                "object_key": r[6], "size_bytes": int(r[7]), "sha256": r[8], "created_at": iso(r[9])}

    def lowest_quality(self, member_id: str, n: int) -> List[Tuple[int, str]]:
        rows = self.run(lambda c: c.execute("SELECT id,object_key FROM enroll_images WHERE member_id=%s "
                                            "ORDER BY COALESCE(quality,0) ASC, id ASC LIMIT %s", (member_id, n)).fetchall())
        return [(int(r[0]), r[1]) for r in rows]

    def delete_image(self, image_id: int) -> Optional[str]:
        def go(c):
            r = c.execute("SELECT object_key FROM enroll_images WHERE id=%s", (image_id,)).fetchone()
            if r:
                c.execute("DELETE FROM enroll_images WHERE id=%s", (image_id,))
            return r[0] if r else None
        return self.run(go)

    def all_object_keys(self) -> set:
        return {r[0] for r in self.run(lambda c: c.execute("SELECT object_key FROM enroll_images").fetchall())}

    def stats(self) -> dict:
        def go(c):
            m = c.execute("SELECT COUNT(*) FROM enroll_members").fetchone()[0]
            i, b = c.execute("SELECT COUNT(*), COALESCE(SUM(size_bytes),0) FROM enroll_images").fetchone()
            p = c.execute("SELECT COUNT(*) FROM enroll_members WHERE status='pending'").fetchone()[0]
            return {"members": int(m), "images": int(i), "bytes": int(b), "pending": int(p)}
        return self.run(go)

    def export_members(self, status: str = "all", since: Optional[str] = None) -> List[dict]:
        where, args = [], []
        if status in ("pending", "exported"):
            where.append("status=%s"); args.append(status)
        if since:
            where.append("updated_at>=%s"); args.append(since)
        w = (" WHERE " + " AND ".join(where)) if where else ""
        rows = self.run(lambda c: c.execute(f"SELECT member_id,full_name,group_name,status,created_at,updated_at FROM enroll_members{w} ORDER BY member_id", tuple(args)).fetchall())
        return [{"member_id": r[0], "full_name": r[1], "group": r[2], "status": r[3], "created_at": iso(r[4]), "updated_at": iso(r[5])} for r in rows]
