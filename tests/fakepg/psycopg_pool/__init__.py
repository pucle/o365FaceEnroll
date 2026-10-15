import contextlib, os, re, sqlite3, threading

_LOCK = threading.RLock()
_DB = {}


def _conn():
    path = os.environ.get("FAKEPG_DB", ":memory:")
    if path not in _DB:
        _DB[path] = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
    return _DB[path]


def _tr(sql):
    q = sql.replace("%s", "?")
    if q.lstrip().upper().startswith("CREATE TABLE"):
        q = q.replace("BIGSERIAL PRIMARY KEY", "INTEGER PRIMARY KEY AUTOINCREMENT").replace("TIMESTAMPTZ", "TEXT")
    q = re.sub(r"DEFAULT now\(\)", "DEFAULT CURRENT_TIMESTAMP", q)
    q = q.replace("now()", "CURRENT_TIMESTAMP")
    return q


def _log(sql):
    p = os.environ.get("FAKEPG_SQLLOG")
    if p:
        with open(p, "a", encoding="utf-8") as f:
            f.write(sql.strip().replace("\n", " ") + "\n@@@\n")


class _Cur:
    def __init__(self, c): self.c = c; self.rowcount = c.rowcount
    def fetchone(self): return self.c.fetchone()
    def fetchall(self): return self.c.fetchall()


class _Conn:
    def execute(self, sql, params=()):
        _log(sql)
        return _Cur(_conn().execute(_tr(sql), tuple(params)))


class ConnectionPool:
    def __init__(self, conninfo, min_size=0, max_size=4, **kw): self.closed = False
    @staticmethod
    def check_connection(conn): pass
    @contextlib.contextmanager
    def connection(self):
        with _LOCK:
            c = _conn(); c.execute("BEGIN")
            try:
                yield _Conn(); c.execute("COMMIT")
            except Exception:
                c.execute("ROLLBACK"); raise
    def close(self): self.closed = True
