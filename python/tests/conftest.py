from __future__ import annotations

from pathlib import Path

import pytest
import sqlcipher3

TEST_KEY = "testkey" * 8  # 56 chars; length is not significant to SQLCipher


@pytest.fixture
def encrypted_db(tmp_path: Path) -> Path:
    """A small SQLCipher database standing in for a real export."""
    p = tmp_path / "exportLibrary.db"
    conn = sqlcipher3.connect(str(p))
    conn.execute(f"PRAGMA key = '{TEST_KEY}'")
    conn.execute("CREATE TABLE content (id INTEGER PRIMARY KEY, title TEXT, tempo INTEGER)")
    conn.execute("CREATE TABLE cue (id INTEGER PRIMARY KEY, content_id INTEGER, pos INTEGER)")
    conn.executemany(
        "INSERT INTO content VALUES (?,?,?)",
        [(1, "Track One", 12800), (2, "Track Two", 14000)],
    )
    conn.execute("INSERT INTO cue VALUES (1, 1, 4410)")
    conn.commit()
    conn.close()
    return p


@pytest.fixture
def device_tree(tmp_path: Path, encrypted_db: Path) -> Path:
    """A minimal device tree with the database in its canonical location."""
    root = tmp_path / "USB"
    target = root / "PIONEER" / "rekordbox"
    target.mkdir(parents=True)
    encrypted_db.rename(target / "exportLibrary.db")
    (root / "PIONEER" / "USBANLZ").mkdir()
    return root


@pytest.fixture
def corpus() -> Path:
    """Real captures, when present. Tests using this skip on a clean clone."""
    d = Path(__file__).parent / "corpus"
    entries = [p for p in d.glob("*") if p.is_dir()]
    if not entries:
        pytest.skip("no captures in tests/corpus/ (requires a real device export)")
    return d
