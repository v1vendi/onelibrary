from __future__ import annotations

import pytest

from onelibrary.keys import (
    Base85XorZlib,
    KeyResolutionError,
    PlaintextScan,
    SingleByteXorScan,
    extract_candidates,
    resolve_key,
)
from tests.conftest import TEST_KEY

REAL_SHAPE = "r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls"


def test_explicit_key_wins(encrypted_db):
    assert resolve_key(TEST_KEY, validate_against=encrypted_db) == TEST_KEY


def test_explicit_wrong_key_rejected(encrypted_db):
    with pytest.raises(KeyResolutionError):
        resolve_key("bad" * 10, validate_against=encrypted_db)


def test_env_key(encrypted_db, monkeypatch):
    monkeypatch.setenv("ONELIBRARY_KEY", TEST_KEY)
    assert resolve_key(validate_against=encrypted_db) == TEST_KEY


def test_env_wrong_key_rejected(encrypted_db, monkeypatch):
    monkeypatch.setenv("ONELIBRARY_KEY", "nope" * 10)
    with pytest.raises(KeyResolutionError):
        resolve_key(validate_against=encrypted_db)


def test_exhausted_tiers_raises(encrypted_db):
    with pytest.raises(KeyResolutionError, match="could not resolve"):
        resolve_key(
            kind="export",
            validate_against=encrypted_db,
            allow_extract=False,
            allow_bundled=True,
        )


def test_plaintext_scan_finds_planted_key():
    blob = b"\x00" * 50 + REAL_SHAPE.encode() + b"\x00" * 50
    assert REAL_SHAPE in list(PlaintextScan().candidates(blob))


def test_xor_scan_finds_obfuscated_key():
    blob = b"\x00" * 50 + bytes(c ^ 0x5A for c in REAL_SHAPE.encode()) + b"\x00" * 50
    assert REAL_SHAPE in list(SingleByteXorScan().candidates(blob))


def test_b85_xor_zlib_roundtrip():
    """The documented scheme, exercised against a blob we construct ourselves."""
    import base64
    import zlib

    xk = bytes.fromhex("657f48f84c437cc1")
    payload = zlib.compress(REAL_SHAPE.encode())
    obf = bytes(b ^ xk[i % len(xk)] for i, b in enumerate(payload))
    blob = base64.b85encode(obf)
    assert REAL_SHAPE in list(Base85XorZlib().candidates(b"\x00" * 8 + blob + b"\x00" * 8))


def test_extract_candidates_on_file(tmp_path):
    f = tmp_path / "fake-binary"
    f.write_bytes(b"junk" * 100 + REAL_SHAPE.encode() + b"junk" * 100)
    assert REAL_SHAPE in extract_candidates(f)
