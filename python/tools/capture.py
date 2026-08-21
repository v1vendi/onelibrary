#!/usr/bin/env python3
"""Snapshot a mounted rekordbox device for offline analysis.

A capture is a self-contained directory holding everything needed to study an
export without the USB stick present:

    <out>/
      manifest.json      file tree with sizes + sha256
      schema.sql         CREATE statements from exportLibrary.db
      tables/<name>.json every row of every table
      summary.json       table names and row counts

Usage:
    python tools/capture.py /Volumes/MYUSB -o tests/corpus/baseline

Captures contain personal music metadata. ``tests/corpus/`` is gitignored.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from onelibrary.db import EXPORT_DB_RELPATH, OneLibraryDB  # noqa: E402

#: Hashing every audio file on a full USB is pointlessly slow; skip the big ones.
HASH_LIMIT = 32 * 1024 * 1024


def sha256(path: Path, limit: int = HASH_LIMIT) -> str | None:
    if path.stat().st_size > limit:
        return None
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def build_manifest(root: Path, include_audio: bool = False) -> list[dict]:
    """Inventory the device tree. Audio files are counted but not hashed."""
    audio_ext = {".mp3", ".m4a", ".wav", ".aiff", ".aif", ".flac", ".ogg"}
    entries = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.name == ".DS_Store":
            continue
        rel = p.relative_to(root)
        try:
            size = p.stat().st_size
        except OSError:
            continue
        is_audio = p.suffix.lower() in audio_ext
        entry = {"path": str(rel), "size": size, "audio": is_audio}
        if not is_audio or include_audio:
            try:
                entry["sha256"] = sha256(p)
            except OSError:
                entry["sha256"] = None
        entries.append(entry)
    return entries


def jsonable(v):
    if isinstance(v, bytes):
        return {"__blob__": v.hex(), "len": len(v)}
    return v


def stage_database(db_path: Path, workdir: Path) -> Path:
    """Copy the database *and its WAL* somewhere writable, then checkpoint.

    rekordbox leaves most of a fresh export sitting in ``exportLibrary.db-wal``
    -- in one observed capture the main file held 118 KB against a 1.1 MB WAL.
    A read-only open of the main file alone silently reports a nearly empty
    database, so the sidecars must be copied together and folded in before
    anything is read.
    """
    import shutil

    import sqlcipher3

    from onelibrary.keys import resolve_key

    workdir.mkdir(parents=True, exist_ok=True)
    staged = workdir / db_path.name
    for suffix in ("", "-wal", "-shm"):
        src = db_path.with_name(db_path.name + suffix)
        if src.exists():
            shutil.copy2(src, workdir / src.name)

    if (workdir / (db_path.name + "-wal")).exists():
        key = resolve_key(validate_against=staged)
        conn = sqlcipher3.connect(str(staged))
        conn.execute("PRAGMA key = '" + key.replace("'", "''") + "'")
        busy, logged, moved = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
        conn.close()
        print(f"    WAL checkpointed (busy={busy}, frames={logged}, moved={moved})")
    return staged


def capture(device: Path, out: Path, key: str | None = None) -> None:
    out.mkdir(parents=True, exist_ok=True)
    db_path = device / EXPORT_DB_RELPATH if device.is_dir() else device

    print(f"[*] device tree: {device}")
    manifest = build_manifest(device) if device.is_dir() else []
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"    {len(manifest)} files inventoried")

    if not db_path.exists():
        print(f"[!] no exportLibrary.db at {db_path}", file=sys.stderr)
        print("    Is this a OneLibrary device? Legacy exports have export.pdb instead.")
        return

    print(f"[*] staging {db_path}")
    staged = stage_database(db_path, out / ".staged")
    db = OneLibraryDB(staged, key)
    (out / "schema.sql").write_text(db.schema_sql())

    tdir = out / "tables"
    tdir.mkdir(exist_ok=True)
    summary = {}
    for table in db.tables():
        rows = [{k: jsonable(r[k]) for k in r.keys()} for r in db.rows(table)]
        (tdir / f"{table}.json").write_text(json.dumps(rows, indent=2, default=str))
        summary[table] = len(rows)
        print(f"    {table:40} {len(rows):>7} rows")

    (out / "summary.json").write_text(json.dumps(summary, indent=2))
    db.close()
    print(f"[+] capture written to {out}  ({len(summary)} tables)")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("device", type=Path, help="mounted device root, or exportLibrary.db")
    ap.add_argument("-o", "--out", type=Path, required=True, help="capture output directory")
    ap.add_argument("--key", help="SQLCipher passphrase override")
    args = ap.parse_args()
    if not args.device.exists():
        print(f"error: {args.device} does not exist", file=sys.stderr)
        return 1
    capture(args.device, args.out, args.key)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
