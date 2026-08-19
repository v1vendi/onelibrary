"""Resolution of the SQLCipher passphrase used by rekordbox databases.

Three tiers are tried in order:

1. **Explicit** -- a passphrase passed directly, or via ``ONELIBRARY_KEY``.
2. **Extracted** -- recovered at runtime from the user's own installed
   rekordbox, then cached under ``~/.cache/onelibrary/``.
3. **Bundled** -- the community-known constants in :data:`KNOWN_KEYS`.

Extraction is preferred because it is not tied to a rekordbox version: if
AlphaTheta rotates the passphrase, tier 2 keeps working while tier 3 goes
stale. Extraction is always best-effort and never raises -- a failure simply
falls through to the next tier.

Candidates are *validated* when a database is available to test against, so a
stale bundled constant can never silently produce a confusing decrypt error.
"""

from __future__ import annotations

import base64
import os
import re
import zlib
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

#: Passphrases published by the reverse-engineering community.
#:
#: These are *fallbacks*. Both were confirmed absent from the rekordbox 7
#: binary (2025-10-22) in plaintext and under any single-byte XOR, so they
#: cannot be recovered by a naive scan of that build.
KNOWN_KEYS: dict[str, str] = {
    # Verified working against ~/Library/Pioneer/rekordbox/master.db.
    "master": "402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497",
    # Reported for PIONEER/rekordbox/exportLibrary.db. Not yet independently
    # verified here -- no OneLibrary export has been captured yet.
    "export": "r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls",
}

#: Passphrases observed so far are 64 chars of lowercase alphanumerics.
_KEY_RE = re.compile(rb"[a-z0-9]{64}")

CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "onelibrary"


class KeyResolutionError(RuntimeError):
    """No tier produced a usable passphrase."""


# ---------------------------------------------------------------------------
# Locating the installed rekordbox
# ---------------------------------------------------------------------------

_SEARCH_GLOBS = [
    "/Applications/rekordbox*/rekordbox.app/Contents/MacOS/rekordbox",
    "/Applications/rekordbox*.app/Contents/MacOS/rekordbox",
    "C:/Program Files/Pioneer/rekordbox*/rekordbox.exe",
    "C:/Program Files/AlphaTheta/rekordbox*/rekordbox.exe",
]


def find_rekordbox_binaries() -> list[Path]:
    """Locate installed rekordbox executables, newest-looking first."""
    found: list[Path] = []
    for pattern in _SEARCH_GLOBS:
        root = Path(pattern).anchor or "/"
        rel = pattern[len(root) :]
        try:
            found.extend(p for p in Path(root).glob(rel) if p.is_file())
        except (OSError, ValueError):
            continue
    return sorted(set(found), reverse=True)


# ---------------------------------------------------------------------------
# Extraction strategies
# ---------------------------------------------------------------------------


@dataclass
class Strategy:
    """One way of recovering passphrase candidates from a binary."""

    name: str
    description: str

    def candidates(self, data: bytes) -> Iterator[str]:  # pragma: no cover - abstract
        raise NotImplementedError


class PlaintextScan(Strategy):
    """Find passphrases stored unobfuscated.

    Works on older rekordbox 6 builds. Confirmed *not* to work on rekordbox 7.
    """

    def __init__(self) -> None:
        super().__init__("plaintext", "64-char alphanumeric runs stored in the clear")

    def candidates(self, data: bytes) -> Iterator[str]:
        seen: set[str] = set()
        for m in _KEY_RE.finditer(data):
            s = m.group().decode("ascii")
            if s not in seen:
                seen.add(s)
                yield s


class SingleByteXorScan(Strategy):
    """Find passphrases hidden under a single-byte XOR.

    Not enabled by default: it makes 255 passes over the binary, which is slow
    on a 260 MB executable. Enable explicitly when investigating a new build::

        extract_candidates(binary, [SingleByteXorScan()])

    A cheap XOR-delta scan (``b[i] ^ b[i+1]``, invariant under single-byte XOR)
    already established that neither known passphrase is hidden this way in
    rekordbox 7, so this exists for future builds rather than current ones.
    """

    _RUN_RE = re.compile(rb"\x01{64}")

    def __init__(self) -> None:
        super().__init__("xor8", "64-char runs obfuscated with a single-byte XOR")

    def candidates(self, data: bytes) -> Iterator[str]:
        alphabet = set(b"abcdefghijklmnopqrstuvwxyz0123456789")
        seen: set[str] = set()
        for x in range(1, 256):
            # Map "would be an alphabet char after XOR" to 0x01, else 0x00, so
            # a fixed-width run can be found with one cheap regex.
            marker = bytes(0x01 if (c ^ x) in alphabet else 0x00 for c in range(256))
            for m in self._RUN_RE.finditer(data.translate(marker)):
                s = bytes(c ^ x for c in data[m.start() : m.start() + 64]).decode("ascii")
                if s not in seen:
                    seen.add(s)
                    yield s


class Base85XorZlib(Strategy):
    """The documented multi-stage scheme: base85 -> repeating XOR -> inflate.

    Reported for rekordbox 6.x with XOR key ``657f48f84c437cc1``. Replaying it
    against rekordbox 7 fails, so the blob and/or XOR key differ per build.
    This strategy therefore sweeps *all* base85-looking blobs in the binary
    against a set of candidate XOR keys rather than assuming fixed values.
    """

    #: base85 alphabet per RFC 1924, as used by :func:`base64.b85decode`.
    _BLOB_RE = re.compile(rb"[0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]{60,200}")

    def __init__(self, xor_keys: list[bytes] | None = None) -> None:
        super().__init__("b85xorzlib", "base85 blob -> repeating XOR -> zlib inflate")
        self.xor_keys = xor_keys or [bytes.fromhex("657f48f84c437cc1")]

    def candidates(self, data: bytes) -> Iterator[str]:
        seen: set[str] = set()
        for m in self._BLOB_RE.finditer(data):
            blob = m.group()
            try:
                raw = base64.b85decode(blob)
            except Exception:
                continue
            for xk in self.xor_keys:
                x = bytes(b ^ xk[i % len(xk)] for i, b in enumerate(raw))
                try:
                    out = zlib.decompress(x).decode("utf-8", "ignore")
                except Exception:
                    continue
                for km in _KEY_RE.finditer(out.encode()):
                    s = km.group().decode("ascii")
                    if s not in seen:
                        seen.add(s)
                        yield s


#: Strategies attempted by default, cheapest first.
#: :class:`SingleByteXorScan` is excluded -- see its docstring.
STRATEGIES: list[Strategy] = [PlaintextScan(), Base85XorZlib()]


def extract_candidates(binary: str | Path, strategies: list[Strategy] | None = None) -> list[str]:
    """Yield passphrase candidates recovered from a rekordbox binary."""
    data = Path(binary).read_bytes()
    out: list[str] = []
    seen: set[str] = set()
    for strat in strategies or STRATEGIES:
        try:
            for cand in strat.candidates(data):
                if cand not in seen:
                    seen.add(cand)
                    out.append(cand)
        except Exception:
            continue
    return out


# ---------------------------------------------------------------------------
# Cache
# ---------------------------------------------------------------------------


def _cache_path(kind: str) -> Path:
    return CACHE_DIR / f"{kind}.key"


def read_cached(kind: str) -> str | None:
    p = _cache_path(kind)
    if p.is_file():
        val = p.read_text().strip()
        return val or None
    return None


def write_cached(kind: str, key: str) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    p = _cache_path(kind)
    p.write_text(key + "\n")
    p.chmod(0o600)


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def resolve_key(
    explicit: str | None = None,
    *,
    kind: str = "export",
    validate_against: str | Path | None = None,
    allow_extract: bool = True,
    allow_bundled: bool = True,
) -> str:
    """Resolve the SQLCipher passphrase for a rekordbox database.

    Args:
        explicit: A passphrase supplied by the caller. Wins over everything.
        kind: ``"export"`` for ``exportLibrary.db``, ``"master"`` for the
            desktop database. Selects the cache slot and bundled fallback.
        validate_against: If given, each candidate is tested by attempting to
            decrypt this file, and only a working passphrase is returned.
        allow_extract: Attempt runtime extraction from an installed rekordbox.
        allow_bundled: Fall back to :data:`KNOWN_KEYS`.

    Raises:
        KeyResolutionError: if no tier yielded a usable passphrase.
    """
    from onelibrary.db import key_works

    def ok(candidate: str) -> bool:
        if validate_against is None:
            return True
        return key_works(validate_against, candidate)

    # Tier 1 -- explicit.
    if explicit:
        if not ok(explicit):
            raise KeyResolutionError("the supplied key does not decrypt the database")
        return explicit

    env = os.environ.get("ONELIBRARY_KEY")
    if env:
        if not ok(env):
            raise KeyResolutionError("ONELIBRARY_KEY does not decrypt the database")
        return env

    tried: list[str] = []

    # Cache -- an already-validated extraction result.
    cached = read_cached(kind)
    if cached and ok(cached):
        return cached
    if cached:
        tried.append("cache (stale)")

    # Tier 2 -- runtime extraction from the user's own install.
    if allow_extract:
        binaries = find_rekordbox_binaries()
        if not binaries:
            tried.append("extraction (no rekordbox install found)")
        for binary in binaries:
            for cand in extract_candidates(binary):
                if ok(cand):
                    write_cached(kind, cand)
                    return cand
            tried.append(f"extraction from {binary.name}")

    # Tier 3 -- bundled constant.
    if allow_bundled:
        bundled = KNOWN_KEYS.get(kind)
        if bundled:
            if ok(bundled):
                return bundled
            tried.append("bundled constant")

    raise KeyResolutionError(
        "could not resolve a working SQLCipher key for "
        f"kind={kind!r}. Tried: {', '.join(tried) or 'nothing'}. "
        "Pass one explicitly with --key or $ONELIBRARY_KEY."
    )
