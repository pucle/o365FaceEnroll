"""psycopg GIẢ chỉ để chạy test khi không cài được psycopg thật (không có PyPI). SQL chạy trên SQLite."""
class Error(Exception): pass
class OperationalError(Error): pass
class InterfaceError(Error): pass
