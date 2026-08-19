"""Command line interface for inspecting OneLibrary devices."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from onelibrary.db import EXPORT_DB_RELPATH, NotEncryptedError, OneLibraryDB
from onelibrary.keys import KeyResolutionError, find_rekordbox_binaries, resolve_key


def _open(args) -> OneLibraryDB:
    return OneLibraryDB(args.device, args.key)


def cmd_inspect(args) -> int:
    """Summarise a device: where the library is and what is in it."""
    root = Path(args.device)
    if root.is_dir():
        db_path = root / EXPORT_DB_RELPATH
        legacy = root / "PIONEER" / "rekordbox" / "export.pdb"
        anlz = root / "PIONEER" / "USBANLZ"
        print(f"device:     {root}")
        print(f"OneLibrary: {'yes' if db_path.exists() else 'no'}  ({db_path.name})")
        print(f"legacy PDB: {'yes' if legacy.exists() else 'no'}  ({legacy.name})")
        if anlz.is_dir():
            n = sum(1 for _ in anlz.rglob("*.DAT"))
            print(f"ANLZ:       {n} .DAT files under PIONEER/USBANLZ")
        if not db_path.exists():
            print("\nNo OneLibrary database on this device.", file=sys.stderr)
            return 1

    db = _open(args)
    tables = db.tables()
    print(f"\ntables:     {len(tables)}")
    widest = max((len(t) for t in tables), default=0)
    for t in tables:
        n = db.row_count(t)
        if n or args.all:
            print(f"  {t.ljust(widest)}  {n:>7}")
    db.close()
    return 0


def cmd_schema(args) -> int:
    db = _open(args)
    print(db.schema_sql())
    db.close()
    return 0


def cmd_dump(args) -> int:
    db = _open(args)
    tables = [args.table] if args.table else db.tables()
    out = {}
    for t in tables:
        rows = []
        for r in db.rows(t, args.limit):
            rows.append({k: (v.hex() if isinstance(v, bytes) else v) for k, v in dict(r).items()})
        out[t] = rows
    json.dump(out, sys.stdout, indent=2, default=str)
    print()
    db.close()
    return 0


def cmd_key(args) -> int:
    """Report how the passphrase would be resolved, without printing it."""
    bins = find_rekordbox_binaries()
    print(f"rekordbox installs found: {len(bins)}")
    for b in bins:
        print(f"  {b}")
    target = None
    if args.device:
        p = Path(args.device)
        target = p / EXPORT_DB_RELPATH if p.is_dir() else p
        if not target.exists():
            target = None
    try:
        key = resolve_key(args.key, kind=args.kind, validate_against=target)
    except KeyResolutionError as exc:
        print(f"resolution failed: {exc}", file=sys.stderr)
        return 1
    status = "validated against database" if target else "unvalidated (no database given)"
    shown = key if args.show else f"{key[:8]}...{key[-4:]} ({len(key)} chars)"
    print(f"resolved key ({args.kind}): {shown}")
    print(f"status: {status}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="onelibrary", description=__doc__)
    ap.add_argument("--key", help="SQLCipher passphrase override")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("inspect", help="summarise a device")
    p.add_argument("device")
    p.add_argument("--all", action="store_true", help="include empty tables")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("schema", help="print CREATE statements")
    p.add_argument("device")
    p.set_defaults(func=cmd_schema)

    p = sub.add_parser("dump", help="dump tables as JSON")
    p.add_argument("device")
    p.add_argument("--table")
    p.add_argument("--limit", type=int)
    p.set_defaults(func=cmd_dump)

    p = sub.add_parser("key", help="show how the passphrase resolves")
    p.add_argument("device", nargs="?")
    p.add_argument("--kind", default="export", choices=["export", "master"])
    p.add_argument("--show", action="store_true", help="print the passphrase in full")
    p.set_defaults(func=cmd_key)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except (NotEncryptedError, KeyResolutionError, FileNotFoundError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
