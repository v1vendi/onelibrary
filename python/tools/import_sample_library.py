#!/usr/bin/env python3
"""Package a real rekordbox export into the viewer's sample library.

The viewer is useless to anyone who does not already own a OneLibrary export,
so it ships a small device the page can load on its own. That device used to be
synthesised end to end by ``make_sample_library.py``, including the analysis --
and synthesising analysis means detecting tempo, which it got subtly wrong. A
grid at 149.80 BPM against a track actually cut at 150 looks correct for the
first bars and is three quarters of a beat out by the end of the track.

So the analysis comes from rekordbox now. This script does not write a database
or a beatgrid; it copies what rekordbox produced, byte for byte, and packages it
into the layout the page fetches. Whatever the real format is, that is what ends
up in the sample -- which is the point.

    # in rekordbox: import the audio, analyse it, put it in a playlist,
    # and export to a USB stick or SD card
    python tools/import_sample_library.py /Volumes/SAMPLE -o ../viewer/sample

It verifies before it copies, though only so far. The stored tempo is checked
against the beatgrid actually written, which catches a corrupt or mismatched
grid -- but *not* a grid that is wrong about the music. A detector that picks
the wrong tempo writes the grid at that tempo too, so the two agree perfectly
while both being wrong, which is precisely how the synthesised grids passed
unnoticed. Only comparing the grid against the audio catches that, and that is
the analysis this script exists to stop doing.

The cheap signal that does catch it is arithmetic: produced music is cut to a
whole or half BPM almost without exception, and 119.85, 149.80 and 111.95 are
not. So a tempo far from a round one is reported as a hint. It is a hint and
not a verdict, because live and acoustic material genuinely sits anywhere.
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from onelibrary import OneLibraryDB  # noqa: E402
from onelibrary.anlz import iter_sections  # noqa: E402

#: A beat entry is beat-within-bar, tempo in hundredths, and milliseconds.
BEAT = struct.Struct(">HHI")
#: Past this the page is a slow download on a phone; warn rather than refuse,
#: since what counts as too big is a judgement about the audience, not a fact.
SIZE_WARN_MB = 25.0
#: A stored tempo this far from the grid by the last beat is a real mismatch.
DRIFT_WARN_BEATS = 0.05
#: Produced music is cut to a whole or half BPM almost without exception, so a
#: tempo further than this from one is a sign the analysis missed rather than
#: that the track is unusual. A hint, not a verdict -- live and acoustic
#: material genuinely sits anywhere, which is why this only ever warns.
ROUND_BPM_TOLERANCE = 0.03


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------


def read_beatgrid(dat: Path) -> list[tuple[int, float, int]]:
    """Beats from a ``.DAT``'s PQTZ section, as (beat-in-bar, bpm, ms).

    ``iter_sections`` hands back the section with its header still attached,
    and that header declares its own length -- so the entries start at
    ``len_header`` and the beat count is the word just before them. Taking both
    from the file rather than assuming a fixed offset is what makes this read a
    real export instead of only the one this project used to write.
    """
    for tag, block in iter_sections(dat.read_bytes()):
        if tag != "PQTZ":
            continue
        header_len = struct.unpack_from(">I", block, 4)[0]
        if header_len < 16 or header_len > len(block):
            return []
        count = struct.unpack_from(">I", block, header_len - 4)[0]
        available = (len(block) - header_len) // BEAT.size
        out = []
        for i in range(min(count, available)):
            beat, tempo, ms = BEAT.unpack_from(block, header_len + i * BEAT.size)
            out.append((beat, tempo / 100.0, ms))
        return out
    return []


def grid_drift(beats: list[tuple[int, float, int]], stored_bpm: float) -> float | None:
    """How far the stored tempo has slipped from the grid, in beats.

    The grid is the truth here: it is what the player follows and what the
    waveform is drawn against. If a constant tempo is a fair description of it,
    the two agree; where they do not, this is the size of the disagreement by
    the last beat, which is where it is largest and most audible.

    Returns ``None`` for a grid too short to say anything about, and 0.0 for a
    variable-tempo grid, where a single stored tempo is not meant to match.
    """
    if len(beats) < 2 or not stored_bpm:
        return None
    if len({round(bpm, 2) for _, bpm, _ in beats}) > 1:
        return 0.0        # genuinely variable; the stored value is nominal
    span_ms = beats[-1][2] - beats[0][2]
    if span_ms <= 0:
        return None
    elapsed = len(beats) - 1
    expected_ms = elapsed * 60_000.0 / stored_bpm
    return abs(span_ms - expected_ms) / (60_000.0 / stored_bpm)


def off_round(bpm: float) -> float:
    """Distance to the nearest whole or half BPM."""
    return abs(bpm - round(bpm * 2) / 2)


# ---------------------------------------------------------------------------
# Packaging
# ---------------------------------------------------------------------------


def device_relative(p: str) -> str:
    """``/Contents/a/b.mp3`` as seen in the database -> a relative path."""
    return p.lstrip("/")


def copy_into(src: Path, dest_root: Path, rel: str) -> int:
    dest = dest_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dest)
    return dest.stat().st_size


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("device", type=Path, help="the exported device root")
    default_out = Path(__file__).resolve().parents[2] / "viewer" / "sample"
    ap.add_argument("-o", "--out", type=Path, default=default_out)
    ap.add_argument("--force", action="store_true",
                    help="package even if a beatgrid check fails")
    args = ap.parse_args()

    out: Path = args.out
    # CREDITS.md is written by hand -- it carries the attribution the licences
    # require -- so it is preserved across a re-import rather than regenerated.
    credits = out / "CREDITS.md"
    keep = credits.read_bytes() if credits.exists() else None
    if keep is None:
        print("! no CREDITS.md in the output directory.", file=sys.stderr)
        print("  Open-licensed audio needs attribution; write one before publishing.",
              file=sys.stderr)

    with OneLibraryDB(args.device) as db:
        rows = list(db.rows("content"))
        prop = next(iter(db.rows("property")), None)
        if not rows:
            print("! no tracks in that export", file=sys.stderr)
            return 1

        print(f"{len(rows)} track(s) in {args.device}")
        if prop is not None and "deviceName" in prop.keys():
            print(f"device name: {prop['deviceName']!r} "
                  "-- this ships in the sample, so keep it impersonal")
        print()

        problems = []
        plan: list[tuple[Path, str]] = []
        for r in rows:
            title = r["title"]
            bpm = (r["bpmx100"] or 0) / 100.0
            audio_rel = device_relative(r["path"])
            audio = args.device / audio_rel
            if not audio.exists():
                problems.append(f"{title}: audio missing at /{audio_rel}")
                continue
            plan.append((audio, audio_rel))

            anlz_rel = device_relative(r["analysisDataFilePath"] or "")
            dat = args.device / anlz_rel
            if not anlz_rel or not dat.exists():
                problems.append(f"{title}: no analysis file")
                print(f"  {title:<24} {bpm:>7.2f} BPM   no analysis")
                continue

            # Every ANLZ beside it -- .EXT carries the modern cues and the
            # colour waveform, and a player reads both.
            for sib in sorted(dat.parent.glob("ANLZ*")):
                plan.append((sib, str(sib.relative_to(args.device))))

            beats = read_beatgrid(dat)
            drift = grid_drift(beats, bpm)
            if not beats:
                note = "no beatgrid"
                problems.append(f"{title}: no beatgrid in {dat.name}")
            elif drift is None:
                note = f"{len(beats)} beats, too short to check"
            elif drift == 0.0:
                note = f"{len(beats)} beats, variable tempo"
            else:
                note = f"{len(beats)} beats, drifts {drift:.3f} beat"
                if drift > DRIFT_WARN_BEATS:
                    problems.append(
                        f"{title}: grid drifts {drift:.2f} beat against a stored "
                        f"{bpm:.2f} BPM -- re-analyse it in rekordbox")
            print(f"  {title:<24} {bpm:>7.2f} BPM   {note}")

            # Checked separately from the grid because it asks a different
            # question: not "do the tempo and the grid agree" -- they always
            # will when one detector wrote both -- but "is this a tempo anyone
            # actually produced at".
            slip = off_round(bpm)
            if bpm and slip > ROUND_BPM_TOLERANCE:
                problems.append(
                    f"{title}: {bpm:.2f} BPM is {slip:.2f} off the nearest half "
                    f"BPM; if it was really cut at {round(bpm * 2) / 2:g}, the "
                    "grid walks off the beat by the end of the track")

    print()
    sys.stdout.flush()
    if problems:
        for p in problems:
            print(f"! {p}", file=sys.stderr)
        if not args.force:
            print("\nNothing written. Fix the above, or pass --force.", file=sys.stderr)
            return 1
        print("\n--force given; packaging anyway.", file=sys.stderr)

    db_rel = "PIONEER/rekordbox/exportLibrary.db"
    if not (args.device / db_rel).exists():
        print(f"! no {db_rel}", file=sys.stderr)
        return 1
    plan.append((args.device / db_rel, db_rel))

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    total = 0
    for src, rel in sorted(set(plan), key=lambda x: x[1]):
        total += copy_into(src, out, rel)
    if keep is not None:
        credits.write_bytes(keep)

    # The manifest is what the page fetches: it cannot list a directory over
    # HTTP, so the file list has to be written down beside it.
    files = sorted(str(p.relative_to(out)) for p in out.rglob("*") if p.is_file())
    manifest = out / "manifest.json"
    files.append("manifest.json")
    manifest.write_text(json.dumps(sorted(files), indent=2) + "\n")

    mb = total / 1e6
    print(f"wrote {len(files)} files, {mb:.1f} MB to {out}")
    if mb > SIZE_WARN_MB:
        print(f"! that is over {SIZE_WARN_MB:.0f} MB; consider shorter tracks or a "
              "lower bitrate, since the page downloads all of it", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
