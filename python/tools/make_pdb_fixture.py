#!/usr/bin/env python3
"""Write the legacy fixture the browser reader is tested against.

The Python reader builds its fixture at test time, but the viewer's tests run
under plain ``node`` with nothing else installed, so its copy is committed as
bytes. Both come from ``python/tests/pdb_fixture.py``, which is the point: the
two readers are independent implementations held to one identical library, and
a disagreement between them is a bug in one of them rather than a difference
between two fixtures that drifted apart.

Regenerate after changing the fixture, and commit the result::

    python python/tools/make_pdb_fixture.py
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python"))

from tests import pdb_fixture  # noqa: E402  (needs the path set above)

# Only export.pdb: the viewer has no use for My Tag data, so its reader does
# not implement the extension database and there is nothing to test it with.
TARGETS = {
    ROOT / "viewer" / "test" / "fixtures" / "sample.pdb": pdb_fixture.sample_pdb,
}


def main() -> int:
    for path, build in TARGETS.items():
        data = build()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        print(f"wrote {path.relative_to(ROOT)} ({len(data)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
