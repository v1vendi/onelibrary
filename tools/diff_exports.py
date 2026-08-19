#!/usr/bin/env python3
"""Differential analysis between two captures.

The core reverse-engineering technique: capture a baseline, change exactly one
thing in rekordbox, re-export, capture again, and diff. Whatever moved is
where that feature lives.

    python tools/capture.py /Volumes/USB -o corpus/00-baseline
    # ... add one hot cue in rekordbox, re-export ...
    python tools/capture.py /Volumes/USB -o corpus/01-hotcue
    python tools/diff_exports.py corpus/00-baseline corpus/01-hotcue

Blob columns are diffed byte-wise so a changed field inside a packed structure
is reported by offset, which is what actually pins down binary layouts.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load(capture: Path, name: str):
    p = capture / "tables" / f"{name}.json"
    return json.loads(p.read_text()) if p.is_file() else None


def summary(capture: Path) -> dict:
    return json.loads((capture / "summary.json").read_text())


def row_key(row: dict) -> str:
    for cand in ("ID", "id", "content_id", "rowid"):
        if cand in row:
            return f"{cand}={row[cand]}"
    return json.dumps(row, sort_keys=True)[:80]


def blob_diff(a: dict, b: dict) -> str:
    """Report which byte offsets differ inside two blob values."""
    ba, bb = bytes.fromhex(a["__blob__"]), bytes.fromhex(b["__blob__"])
    if len(ba) != len(bb):
        return f"blob length {len(ba)} -> {len(bb)}"
    offs = [i for i, (x, y) in enumerate(zip(ba, bb)) if x != y]
    if not offs:
        return "blob identical"
    shown = ", ".join(f"@{o}: {ba[o]:02x}->{bb[o]:02x}" for o in offs[:12])
    more = f" (+{len(offs) - 12} more)" if len(offs) > 12 else ""
    return f"blob {len(offs)}/{len(ba)} bytes differ: {shown}{more}"


def diff_table(name: str, old: list, new: list, ignore: set[str]) -> list[str]:
    out: list[str] = []
    oidx = {row_key(r): r for r in old}
    nidx = {row_key(r): r for r in new}

    for k in nidx.keys() - oidx.keys():
        out.append(f"  + ADDED   {k}  {json.dumps(nidx[k], default=str)[:200]}")
    for k in oidx.keys() - nidx.keys():
        out.append(f"  - REMOVED {k}  {json.dumps(oidx[k], default=str)[:200]}")

    for k in sorted(oidx.keys() & nidx.keys()):
        o, n = oidx[k], nidx[k]
        for col in sorted(set(o) | set(n)):
            if col in ignore:
                continue
            ov, nv = o.get(col), n.get(col)
            if ov == nv:
                continue
            if isinstance(ov, dict) and isinstance(nv, dict) and "__blob__" in ov:
                out.append(f"  ~ {k}.{col}: {blob_diff(ov, nv)}")
            else:
                out.append(f"  ~ {k}.{col}: {ov!r} -> {nv!r}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("before", type=Path)
    ap.add_argument("after", type=Path)
    ap.add_argument(
        "--ignore",
        default="updated_at,UpdatedAt,created_at,CreatedAt,usn,USN,rb_local_usn",
        help="comma-separated columns to suppress (churn that hides real changes)",
    )
    ap.add_argument("--table", help="restrict to one table")
    args = ap.parse_args()

    ignore = {c.strip() for c in args.ignore.split(",") if c.strip()}
    sa, sb = summary(args.before), summary(args.after)

    print(f"=== {args.before.name}  ->  {args.after.name} ===\n")
    for t in sorted(set(sa) | set(sb)):
        if args.table and t != args.table:
            continue
        ca, cb = sa.get(t, 0), sb.get(t, 0)
        old, new = load(args.before, t), load(args.after, t)
        if old is None or new is None:
            print(f"{t}: present in only one capture ({ca} vs {cb})")
            continue
        lines = diff_table(t, old, new, ignore)
        if lines or ca != cb:
            print(f"{t}  [{ca} -> {cb} rows]")
            for ln in lines[:60]:
                print(ln)
            if len(lines) > 60:
                print(f"  ... {len(lines) - 60} more changes")
            print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
