from __future__ import annotations

import pytest

from onelibrary.db import NotEncryptedError, OneLibraryDB, key_works, open_encrypted
from tests.conftest import TEST_KEY


def test_opens_with_correct_key(encrypted_db):
    conn = open_encrypted(encrypted_db, TEST_KEY)
    assert conn.execute("SELECT count(*) FROM content").fetchone()[0] == 2
    conn.close()


def test_wrong_key_raises_immediately(encrypted_db):
    with pytest.raises(NotEncryptedError):
        open_encrypted(encrypted_db, "wrong" * 10)


def test_key_works_predicate(encrypted_db):
    assert key_works(encrypted_db, TEST_KEY)
    assert not key_works(encrypted_db, "nope" * 10)


def test_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        open_encrypted(tmp_path / "absent.db", TEST_KEY)


def test_passphrase_with_quote_is_escaped(tmp_path):
    """A passphrase containing ' must not break out of the PRAGMA literal."""
    import sqlcipher3

    tricky = "ab'cd" + "x" * 20
    p = tmp_path / "q.db"
    conn = sqlcipher3.connect(str(p))
    conn.execute("PRAGMA key = 'ab''cdxxxxxxxxxxxxxxxxxxxx'")
    conn.execute("CREATE TABLE t (a)")
    conn.commit()
    conn.close()
    assert key_works(p, tricky)


def test_device_tree_resolution(device_tree):
    db = OneLibraryDB(device_tree, TEST_KEY)
    assert set(db.tables()) == {"content", "cue"}
    assert db.row_count("content") == 2
    db.close()


def test_introspection(encrypted_db):
    with OneLibraryDB(encrypted_db, TEST_KEY) as db:
        cols = {c["name"]: c for c in db.columns("content")}
        assert set(cols) == {"id", "title", "tempo"}
        assert cols["id"]["pk"] == 1
        assert "CREATE TABLE content" in db.schema_sql()
        assert [r["title"] for r in db.rows("content")] == ["Track One", "Track Two"]
