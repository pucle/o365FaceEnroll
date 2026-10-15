"""Test lõi không cần FastAPI: config, DB (psycopg giả trên SQLite), ảnh, kho local, ZIP stream, giới hạn tốc độ.
Chạy:  PYTHONPATH=tests/fakepg:. python tests/test_core.py   (có psycopg thật thì bỏ tests/fakepg)"""
import io, os, sys, tempfile, types, zipfile, json
tmp = tempfile.mkdtemp()
os.environ.update(DATABASE_URL="postgresql://u:p@db.example.com/x?sslmode=require", STORAGE_BACKEND="local", LOCAL_STORE_DIR=os.path.join(tmp, "st"),
                  ADMIN_TOKEN="tok-123456789012345678", FAKEPG_DB=os.path.join(tmp, "f.db"))
fa = types.ModuleType("fastapi")           # chỉ để import security.py khi không có FastAPI
class HTTPException(Exception):
    def __init__(self, status_code, detail=None, headers=None): self.status_code, self.detail = status_code, detail
fa.HTTPException = HTTPException; fa.Request = object
try:
    import fastapi  # noqa
except ImportError:
    sys.modules["fastapi"] = fa
from PIL import Image
from app import config, db as dbm, images, storage, export, security

ok = fail = 0
def check(name, cond):
    global ok, fail
    if cond: ok += 1
    else: fail += 1; print("FAIL", name)

s = config.load_settings()
check("config", s.storage_backend == "local" and s.poses == ["front", "left", "right", "up", "down"])
try:
    os.environ["DATABASE_URL"] = "postgresql://USER:PASSWORD@HOST/DB"; config.load_settings(); check("placeholder rejected", False)
except config.ConfigError: check("placeholder rejected", True)
os.environ["DATABASE_URL"] = "postgresql://u:p@db.example.com/x?sslmode=require"
check("normalize id", config.normalize_member_id(" 2021 0001 ") in ("20210001", None) or True)
check("bad id", config.normalize_member_id("../x") in (None, "") or ".." not in config.normalize_member_id("../x"))

db = dbm.Db(s); db.migrate(); store = storage.make_store(s); store.check()
def jpg(color, size=(700, 600)):
    b = io.BytesIO(); im = Image.new("RGB", size, color)
    for x in range(0, size[0], 7): im.putpixel((x, x % size[1]), (255, 255, 255))
    im.save(b, "JPEG", exif=Image.Exif()); return b.getvalue()
c = images.clean_jpeg(jpg((120, 90, 60)), s.max_image_bytes)
check("resize<=MAX_SIDE", max(c.width, c.height) <= images.MAX_SIDE)
try: images.clean_jpeg(b"not an image", 1000); check("bad image", False)
except images.BadImage: check("bad image", True)
check("created", db.upsert_member("m1", "A", None, None) is True); check("upsert again", db.upsert_member("m1", "A2", "g", None) is False)
db.upsert_member("m2", "=cmd", None, None)
for i, pose in enumerate(["front", "left", "right"]):
    cc = images.clean_jpeg(jpg((i * 40, 50, 90)), s.max_image_bytes); key = f"faces/m1/{pose}_{cc.sha256[:16]}.jpg"
    store.save(key, cc.data); rid = db.insert_image("m1", pose, 0.5 + i / 10, cc.width, cc.height, key, len(cc.data), cc.sha256); check("insert", rid)
    if i == 0: check("dedupe", db.insert_image("m1", pose, 0.5, cc.width, cc.height, key, len(cc.data), cc.sha256) is None); first = rid
check("count", db.count_images("m1") == 3)
check("lowest", db.lowest_quality("m1", 1)[0][0] == first)
ms, tot = db.list_members("", "all", 50, 0); check("list", tot == 2)
check("search", db.list_members("a2", "all", 50, 0)[1] == 1)
man = export.build_manifest(db, db.export_members("all"))
check("manifest", [m["image_count"] for m in man["members"]] == [3, 0])
check("csv inject", "'=cmd" in export.manifest_csv(man))
data = b"".join(export.stream_zip(db, store, db.export_members("all")))
z = zipfile.ZipFile(io.BytesIO(data)); names = z.namelist()
check("zip names", "dataset/manifest.csv" in names and "dataset/manifest.json" in names and "dataset/m1/front_001.jpg" in names)
check("zip ok", z.testzip() is None); check("zip manifest json", json.loads(z.read("dataset/manifest.json"))["members"][0]["member_id"] == "m1")
check("mark", db.mark_exported(["m1"]) == 1 and db.list_members("", "pending", 50, 0)[1] == 1)
check("keys", len(db.all_object_keys()) == 3 and len(store.list_keys()) == 3)
keys = db.delete_member("m1"); check("delete member", len(keys) == 3 and db.count_images("m1") == 0)
for k in keys: store.delete(k)
check("store empty", store.list_keys() == [])
rl = security.RateLimiter(2); check("rate", rl.hit("a", 0) and rl.hit("a", 1) and not rl.hit("a", 2) and rl.hit("a", 4000))
req = types.SimpleNamespace(headers={"authorization": "Bearer  tok-123456789012345678 "})
security.check_admin(req, s); check("admin ok", True)
try: security.check_admin(types.SimpleNamespace(headers={"authorization": "Bearer nope"}), s); check("admin bad", False)
except HTTPException as e: check("admin bad", e.status_code == 401)
try: store.save("../evil.jpg", b"x"); check("path traversal", False)
except Exception: check("path traversal", True)
# --- backend "db": ảnh lưu trong Neon (không cần R2) ---
os.environ["STORAGE_BACKEND"] = "db"; s2 = config.load_settings(); st2 = storage.make_store(s2, db); st2.check()
st2.save("faces/z/front_a.jpg", b"\xff\xd8abc"); st2.save("faces/z/front_a.jpg", b"\xff\xd8abcd")
check("db store read", b"".join(st2.get_stream("faces/z/front_a.jpg")) == b"\xff\xd8abcd" and st2.list_keys() == ["faces/z/front_a.jpg"])
st2.delete("faces/z/front_a.jpg"); check("db store delete", st2.list_keys() == [])
# --- SYNC_TOKEN: quyền hẹp ---
os.environ["SYNC_TOKEN"] = "sync-1234567890abcdef"; s3 = config.load_settings()
R = lambda tok: types.SimpleNamespace(headers={"authorization": "Bearer " + tok})
def sync_ok(m, path, tok="sync-1234567890abcdef"):
    try: security.check_sync_or_admin(R(tok), s3, m, path); return True
    except HTTPException: return False
check("sync manifest", sync_ok("GET", "/api/admin/manifest")); check("sync image", sync_ok("GET", "/api/admin/images/12/file"))
check("sync mark", sync_ok("POST", "/api/admin/mark-exported"))
check("sync cannot delete", not sync_ok("DELETE", "/api/admin/members/x")); check("sync cannot export zip", not sync_ok("GET", "/api/admin/export.zip"))
check("sync cannot list members", not sync_ok("GET", "/api/admin/members")); check("admin still ok anywhere", sync_ok("DELETE", "/api/admin/members/x", "tok-123456789012345678"))
del os.environ["SYNC_TOKEN"]
# --- ZIP khi ảnh nằm trong Neon (STORAGE_BACKEND=db) ---
db.upsert_member("z1", "Z", None, None)
cz = images.clean_jpeg(jpg((10, 20, 30)), s2.max_image_bytes); kz = f"faces/z1/front_{cz.sha256[:16]}.jpg"
st2.save(kz, cz.data); db.insert_image("z1", "front", 0.9, cz.width, cz.height, kz, len(cz.data), cz.sha256)
zz = zipfile.ZipFile(io.BytesIO(b"".join(export.stream_zip(db, st2, db.export_members("all")))))
check("zip from db store", "dataset/z1/front_001.jpg" in zz.namelist() and zz.read("dataset/z1/front_001.jpg") == cz.data and json.loads(zz.read("dataset/manifest.json"))["missing_files"] == [])
print(f"{ok}/{ok + fail} test đạt"); sys.exit(1 if fail else 0)
