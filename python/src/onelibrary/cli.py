"""Command line interface for inspecting OneLibrary and legacy devices."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from onelibrary.db import (
    EXPORT_DB_RELPATH,
    NotEncryptedError,
    OneLibraryDB,
    open_encrypted,
)
from onelibrary.keys import KeyResolutionError, find_rekordbox_binaries, resolve_key
from onelibrary.pdb import (
    EXPORT_EXT_PDB_RELPATH,
    EXPORT_PDB_RELPATH,
    PdbError,
    PdbFile,
)


def _open(args) -> OneLibraryDB | PdbFile:
    """Open whichever library the device carries.

    OneLibrary wins when a device has both, which is what a converted device
    looks like -- rekordbox leaves the legacy files in place so that older
    players can still read it. ``--legacy`` asks for those files instead.
    """
    path = Path(args.device)
    if getattr(args, "ext", False):
        return PdbFile(path, ext=True)
    if path.is_dir():
        if (path / EXPORT_DB_RELPATH).exists() and not getattr(args, "legacy", False):
            return OneLibraryDB(path, args.key)
        if (path / EXPORT_PDB_RELPATH).exists():
            return PdbFile(path)
        # Neither is there: let the OneLibrary path report the missing file.
        return OneLibraryDB(path, args.key)
    if path.suffix.lower() == ".pdb":
        return PdbFile(path)
    return OneLibraryDB(path, args.key)


def cmd_inspect(args) -> int:
    """Summarise a device: where the library is and what is in it."""
    root = Path(args.device)
    if root.is_dir():
        db_path = root / EXPORT_DB_RELPATH
        legacy = root / EXPORT_PDB_RELPATH
        legacy_ext = root / EXPORT_EXT_PDB_RELPATH
        anlz = root / "PIONEER" / "USBANLZ"
        found = [legacy.name] + ([legacy_ext.name] if legacy_ext.exists() else [])
        print(f"device:     {root}")
        print(f"OneLibrary: {'yes' if db_path.exists() else 'no'}  ({db_path.name})")
        print(f"legacy PDB: {'yes' if legacy.exists() else 'no'}  ({', '.join(found)})")
        if anlz.is_dir():
            n = sum(1 for _ in anlz.rglob("*.DAT"))
            print(f"ANLZ:       {n} .DAT files under PIONEER/USBANLZ")
        if not db_path.exists() and not legacy.exists():
            print("\nNo library of either format on this device.", file=sys.stderr)
            return 1

    lib = _open(args)
    tables = lib.tables()
    unreadable = set(tables) - set(getattr(lib, "readable_tables", lambda: tables)())
    print(f"\nreading:    {lib.path.name}")
    print(f"tables:     {len(tables)}")
    widest = max((len(t) for t in tables), default=0)
    for t in tables:
        n = lib.row_count(t)
        if n or args.all:
            note = "  (row layout unknown)" if t in unreadable else ""
            print(f"  {t.ljust(widest)}  {n:>7}{note}")
    lib.close()
    return 0


def cmd_schema(args) -> int:
    lib = _open(args)
    print(lib.schema_sql())
    lib.close()
    return 0


def cmd_dump(args) -> int:
    lib = _open(args)
    # A legacy export declares tables whose row layout nobody has worked out.
    # Naming one is an error; dumping everything simply passes over them.
    tables = [args.table] if args.table else getattr(
        lib, "readable_tables", lib.tables
    )()
    out = {}
    for t in tables:
        rows = []
        for r in lib.rows(t, args.limit):
            rows.append({k: (v.hex() if isinstance(v, bytes) else v) for k, v in dict(r).items()})
        out[t] = rows
    json.dump(out, sys.stdout, indent=2, default=str)
    print()
    lib.close()
    return 0


def cmd_apply(args) -> int:
    """Apply a change-set produced by the browser viewer."""
    import json

    changeset = json.loads(Path(args.changeset).read_text())
    if changeset.get("format") != "onelibrary-changeset":
        print(f"error: {args.changeset} is not a OneLibrary change-set", file=sys.stderr)
        return 1

    #: Editable names as the viewer reports them, mapped to their columns.
    LOOKUPS = {
        "artist": ("artist", "artist_id", "artist_id_artist"),
        "album": ("album", "album_id", "album_id"),
        "genre": ("genre", "genre_id", "genre_id"),
    }

    path = Path(args.device)
    if path.is_dir():
        path = path / EXPORT_DB_RELPATH
    if not path.exists() and (Path(args.device) / EXPORT_PDB_RELPATH).exists():
        print(
            "error: this device carries a legacy DeviceSQL library, which this tool "
            'reads but cannot write. Convert it in rekordbox first: right-click the '
            'device and choose "Convert to OneLibrary".',
            file=sys.stderr,
        )
        return 1
    key = resolve_key(args.key, validate_against=path)
    conn = open_encrypted(path, key, read_only=False)

    applied = skipped = 0
    for edit in changeset.get("edits", []):
        cid = edit["content_id"]
        for field, change in edit["fields"].items():
            expected, value = change.get("from"), change.get("to")
            if field in LOOKUPS:
                table, id_col, fk = LOOKUPS[field]
                current_name = conn.execute(
                    f'SELECT l.name FROM content c LEFT JOIN "{table}" l '
                    f"ON l.{id_col} = c.{fk} WHERE c.content_id = ?", (cid,)
                ).fetchone()
                current = current_name[0] if current_name else None
            else:
                row = conn.execute(
                    f'SELECT "{field}" FROM content WHERE content_id = ?', (cid,)
                ).fetchone()
                current = row[0] if row else None

            # Refuse to clobber a field that moved on the device since the edit.
            if not args.force and (current or None) != (expected or None):
                print(
                    f"  skip content {cid}.{field}: device has {current!r}, "
                    f"change-set expected {expected!r}",
                    file=sys.stderr,
                )
                skipped += 1
                continue

            if field in LOOKUPS:
                table, id_col, fk = LOOKUPS[field]
                new_id = None
                if value:
                    found = conn.execute(
                        f'SELECT {id_col} FROM "{table}" WHERE name = ?', (value,)
                    ).fetchone()
                    if found:
                        new_id = found[0]
                    else:
                        new_id = (
                            conn.execute(f'SELECT COALESCE(MAX({id_col}),0) FROM "{table}"')
                            .fetchone()[0] + 1
                        )
                        cols = [c[1] for c in conn.execute(f'PRAGMA table_info("{table}")')]
                        values = {id_col: new_id, "name": value}
                        if "nameForSearch" in cols:
                            values["nameForSearch"] = value.upper()
                        placeholders = ",".join("?" for _ in values)
                        conn.execute(
                            f'INSERT INTO "{table}" ({",".join(values)}) VALUES ({placeholders})',
                            tuple(values.values()),
                        )
                conn.execute(
                    f"UPDATE content SET {fk} = ? WHERE content_id = ?", (new_id, cid)
                )
            elif field == "title":
                conn.execute(
                    "UPDATE content SET title = ?, titleForSearch = ? WHERE content_id = ?",
                    (value, (value or "").upper() or None, cid),
                )
            else:
                conn.execute(
                    f'UPDATE content SET "{field}" = ? WHERE content_id = ?', (value, cid)
                )
            applied += 1

    conn.commit()
    conn.close()
    print(f"applied {applied} change{'' if applied == 1 else 's'}", end="")
    print(f", skipped {skipped}" if skipped else "")
    return 1 if skipped and not args.force else 0


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
    ap.add_argument(
        "--legacy",
        action="store_true",
        help="read export.pdb even on a device that also has a OneLibrary database",
    )
    ap.add_argument(
        "--ext",
        action="store_true",
        help="read the legacy extension database, exportExt.pdb (My Tag data)",
    )
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

    p = sub.add_parser("apply", help="apply a change-set from the browser viewer")
    p.add_argument("changeset", help="onelibrary-edits.json")
    p.add_argument("device", help="mounted device root, or exportLibrary.db")
    p.add_argument(
        "--force", action="store_true",
        help="apply even where the device no longer holds the expected value",
    )
    p.set_defaults(func=cmd_apply)

    p = sub.add_parser("key", help="show how the passphrase resolves")
    p.add_argument("device", nargs="?")
    p.add_argument("--kind", default="export", choices=["export", "master"])
    p.add_argument("--show", action="store_true", help="print the passphrase in full")
    p.set_defaults(func=cmd_key)

    args = ap.parse_args(argv)
    try:
        return args.func(args)
    except (NotEncryptedError, KeyResolutionError, FileNotFoundError, PdbError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
