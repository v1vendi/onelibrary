"""SQLCipher access to rekordbox databases.

Both the desktop ``master.db`` and the on-device ``exportLibrary.db`` are
SQLCipher databases using **SQLCipher 4 defaults**:

- AES-256-CBC, 4096-byte pages
- PBKDF2-HMAC-SHA512, 256,000 iterations
- per-page HMAC-SHA512

The key is supplied as a *passphrase* (``PRAGMA key = 'ascii...'``), not as a
raw hex blob (``PRAGMA key = "x'...'"``). This was confirmed empirically
against rekordbox 7 (build 2025-10-22); see ``spec/ONELIBRARY.md``.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

try:  # pragma: no cover - exercised via import failure only
    import sqlcipher3 as _sqlcipher
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "SQLCipher bindings are required. Install with: pip install sqlcipher3-wheels"
    ) from exc

#: Relative location of the OneLibrary database within a device tree.
EXPORT_DB_RELPATH = Path("PIONEER") / "rekordbox" / "exportLibrary.db"


class NotEncryptedError(RuntimeError):
    """Raised when a file is not a SQLCipher database, or the key is wrong."""


def _quote(passphrase: str) -> str:
    """Quote a passphrase for use in a ``PRAGMA key`` statement.

    PRAGMA does not accept bound parameters, so the value must be inlined.
    Single quotes are escaped by doubling, per SQL string literal rules.
    """
    return "'" + passphrase.replace("'", "''") + "'"


def open_encrypted(path: str | Path, key: str, *, read_only: bool = True):
    """Open a SQLCipher database and verify the key actually decrypts it.

    Returns a DB-API connection. Raises :class:`NotEncryptedError` if the key
    is wrong -- SQLCipher reports this lazily, so we force a read of
    ``sqlite_master`` to surface the failure here rather than at first query.
    """
    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(path)

    if read_only:
        conn = _sqlcipher.connect(f"file:{path}?mode=ro", uri=True)
    else:
        conn = _sqlcipher.connect(str(path))

    conn.execute(f"PRAGMA key = {_quote(key)}")
    try:
        conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    except Exception as exc:
        conn.close()
        raise NotEncryptedError(f"{path}: wrong key or not a SQLCipher database ({exc})") from exc
    return conn


def key_works(path: str | Path, key: str) -> bool:
    """Return True if ``key`` decrypts the database at ``path``."""
    try:
        conn = open_encrypted(path, key)
    except (NotEncryptedError, FileNotFoundError):
        return False
    conn.close()
    return True


class OneLibraryDB:
    """A decrypted OneLibrary database.

    Accepts either the ``exportLibrary.db`` file itself or the root of a
    device tree containing ``PIONEER/rekordbox/exportLibrary.db``.
    """

    def __init__(self, path: str | Path, key: str | None = None, *, read_only: bool = True):
        from onelibrary.keys import resolve_key

        path = Path(path)
        if path.is_dir():
            path = path / EXPORT_DB_RELPATH
        self.path = path
        self.key = key or resolve_key(validate_against=path if path.exists() else None)
        self.conn = open_encrypted(path, self.key, read_only=read_only)
        self.conn.row_factory = sqlite3.Row

    # -- introspection ---------------------------------------------------

    def tables(self) -> list[str]:
        rows = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
        return [r[0] for r in rows]

    def columns(self, table: str) -> list[dict]:
        """Column metadata for ``table``: name, type, notnull, default, pk."""
        rows = self.conn.execute(f'PRAGMA table_info("{table}")')
        return [
            {"name": r[1], "type": r[2], "notnull": bool(r[3]), "default": r[4], "pk": r[5]}
            for r in rows
        ]

    def foreign_keys(self, table: str) -> list[dict]:
        rows = self.conn.execute(f'PRAGMA foreign_key_list("{table}")')
        return [{"column": r[3], "references": r[2], "to": r[4]} for r in rows]

    def row_count(self, table: str) -> int:
        return self.conn.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]

    def rows(self, table: str, limit: int | None = None) -> Iterator[sqlite3.Row]:
        sql = f'SELECT * FROM "{table}"'
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        yield from self.conn.execute(sql)

    def schema_sql(self) -> str:
        """The full CREATE statements for this database, in declaration order."""
        rows = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rootpage"
        )
        return "\n".join(r[0] + ";" for r in rows)

    # -- lifecycle -------------------------------------------------------

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> OneLibraryDB:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"<OneLibraryDB {self.path}>"
