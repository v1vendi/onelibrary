#!/usr/bin/env python3
"""Build a playable sample OneLibrary device from open-licensed audio.

The viewer is useless to anyone who does not already own a OneLibrary export,
which is most people: a visitor lands on a dropzone with nothing to drop. This
produces a small device tree -- database, analysis, audio -- that the page can
load on its own, so the thing can be tried before it is trusted.

Everything it emits is synthesised here, including the analysis. The library
writer deliberately stops short of that (see ``onelibrary.writer``): beatgrids
and waveforms come out of rekordbox's own analysis, and reproducing it means
tempo detection, which is not the library's job. It is this script's job.

The binary layouts are taken from a real export, byte for byte -- section
header lengths, the constants at each fixed offset, the 150-columns-a-second
waveform rate -- rather than from what the viewer happens to accept, so the
output is a real device rather than something only this project can read.

Requires ffmpeg on PATH and numpy. Neither is a dependency of the library.

    python tools/make_sample_library.py AUDIO... -o ../viewer/sample
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from onelibrary.writer import Library, Playlist, Track, write_device  # noqa: E402

SR = 44100
#: Columns a second in the detail waveforms. The `00 96` in a real PWV3/PWV5
#: header is this number, and 24279 columns over a 161.855 s track is 150.0.
COLS_PER_SEC = 150
#: The preview waveform is the whole track in a fixed 400 columns.
PREVIEW_COLS = 400
NO_LOOP = 0xFFFFFFFF


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------


def decode(path: Path) -> np.ndarray:
    """Whole file as mono float32 at :data:`SR`, via ffmpeg."""
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le",
         "-acodec", "pcm_f32le", "-ac", "1", "-ar", str(SR), "-"],
        capture_output=True, check=True,
    ).stdout
    return np.frombuffer(out, dtype="<f4")


def transcode(src: Path, dst: Path, bitrate: str = "128k") -> None:
    """Re-encode for the web. 320 kbps masters are needlessly heavy to serve."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src),
         "-codec:a", "libmp3lame", "-b:a", bitrate, str(dst)],
        check=True,
    )


# ---------------------------------------------------------------------------
# Tempo
# ---------------------------------------------------------------------------


def onset_envelope(x: np.ndarray, hop: int = 512) -> tuple[np.ndarray, float]:
    """Spectral flux: how much the spectrum brightens frame to frame.

    Beat tracking off raw amplitude follows the bass and misses percussion that
    is loud in the top end but quiet overall, so this rectifies the *increase*
    in each bin -- which is what an onset is -- rather than level.
    """
    win = 1024
    n = 1 + (len(x) - win) // hop
    frames = np.lib.stride_tricks.as_strided(
        x, shape=(n, win), strides=(x.strides[0] * hop, x.strides[0])
    )
    spec = np.abs(np.fft.rfft(frames * np.hanning(win), axis=1))
    flux = np.diff(spec, axis=0, prepend=spec[:1])
    env = np.maximum(flux, 0).sum(axis=1)
    env -= env.mean()
    return env, SR / hop


def estimate_tempo(env: np.ndarray, rate: float,
                   lo: float = 85.0, hi: float = 175.0) -> float:
    """Comb-scored autocorrelation: the tempo whose whole grid is supported.

    A bare autocorrelation peak is not the tempo. Its harmonics are peaks too,
    and often taller ones -- on the sample material the strongest lag came out
    at 79.5 BPM with 161.5 and 120.2 (x2 and x1.5) close behind, so simply
    taking the maximum inside a one-octave window picks whichever harmonic the
    window happens to admit, which is how a 159 BPM track reads as 120.

    Scoring a candidate by summing the autocorrelation at its first four beat
    multiples resolves it: the true tempo is supported at every multiple, while
    a harmonic lands between peaks at some of them and loses.
    """
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    ac = ac / (np.abs(ac).max() or 1.0)
    cands = np.arange(lo, hi, 0.05)
    best, best_score = 120.0, -np.inf
    for bpm in cands:
        lag = 60.0 * rate / bpm
        idx = (lag * np.arange(1, 5)).round().astype(int)
        idx = idx[idx < len(ac)]
        if not len(idx):
            continue
        score = ac[idx].sum()
        if score > best_score:
            best, best_score = float(bpm), score
    return best


def beat_confidence(env: np.ndarray, rate: float, bpm: float, first: float) -> float:
    """Share of the onset energy that the chosen grid actually sits on.

    A grid can be self-consistent and still be wrong about the music, so this
    compares energy at the beat positions against energy everywhere -- a value
    near 1 means the beats are where the onsets are.
    """
    period = 60.0 / bpm * rate
    n = int((len(env) - first * rate) / period)
    if n < 4:
        return 0.0
    idx = np.clip((first * rate + period * np.arange(n)).astype(int), 0, len(env) - 1)
    pos = np.maximum(env, 0)
    on = pos[idx].mean()
    return float(on / (pos.mean() or 1.0))


def estimate_phase(env: np.ndarray, rate: float, bpm: float) -> float:
    """Where the first beat falls, by scoring every offset in one beat period.

    The grid is fixed once tempo is known, so the only freedom left is its
    offset; the best one is simply the alignment whose beat positions land on
    the most onset energy.
    """
    period = 60.0 / bpm * rate
    n = int(len(env) / period)
    if n < 2:
        return 0.0
    offsets = np.linspace(0, period, 64, endpoint=False)
    idx = (offsets[:, None] + period * np.arange(n)[None, :]).astype(int)
    idx = np.clip(idx, 0, len(env) - 1)
    return float(offsets[np.argmax(env[idx].sum(axis=1))] / rate)


# ---------------------------------------------------------------------------
# Waveform columns
# ---------------------------------------------------------------------------


def band_columns(x: np.ndarray, n_cols: int) -> dict[str, np.ndarray]:
    """Per-column peak and a low/mid/high split.

    The bands are separated by FFT rather than by filtering because each column
    is summarised independently anyway -- there is no continuity to preserve
    across them, and one transform per column is cheaper than three filters
    over the whole signal.
    """
    edges = np.linspace(0, len(x), n_cols + 1).astype(int)
    peak = np.zeros(n_cols, dtype=np.float32)
    bands = np.zeros((n_cols, 3), dtype=np.float32)
    for i in range(n_cols):
        seg = x[edges[i]:edges[i + 1]]
        if not len(seg):
            continue
        peak[i] = np.abs(seg).max()
        spec = np.abs(np.fft.rfft(seg))
        freq = np.fft.rfftfreq(len(seg), 1 / SR)
        for b, (f0, f1) in enumerate(((0, 200), (200, 2000), (2000, SR / 2))):
            m = (freq >= f0) & (freq < f1)
            bands[i, b] = spec[m].sum() if m.any() else 0.0
    return {"peak": peak, "bands": bands}


def _norm(v: np.ndarray) -> np.ndarray:
    top = np.percentile(v, 99.5) if len(v) else 1.0
    return np.clip(v / top, 0, 1) if top > 0 else np.zeros_like(v)


def preview_bytes(cols: dict) -> bytes:
    """PWAV: one byte a column, height in bits 0-4 and whiteness in 5-7."""
    h = (_norm(cols["peak"]) * 31).astype(int)
    tot = cols["bands"].sum(axis=1, keepdims=True)
    frac = np.divide(cols["bands"], tot, out=np.zeros_like(cols["bands"]), where=tot > 0)
    white = (frac[:, 1:].sum(axis=1) * 7).astype(int)
    return bytes(int(a) | (int(b) << 5) for a, b in zip(h, np.clip(white, 0, 7)))


def detail_mono_bytes(cols: dict) -> bytes:
    return preview_bytes(cols)


def detail_colour_bytes(cols: dict) -> bytes:
    """PWV5: u16be a column, height in bits 2-6 and three 3-bit colour fields.

    Channel order follows the viewer's reading of a real export -- bits 15-13
    carry the band that tracks overall loudness, which is the bass.
    """
    h = (_norm(cols["peak"]) * 31).astype(int)
    tot = cols["bands"].sum(axis=1, keepdims=True)
    frac = np.divide(cols["bands"], tot, out=np.zeros_like(cols["bands"]), where=tot > 0)
    lo, mid, hi = (np.clip((frac[:, i] * 3.0) * 7, 0, 7).astype(int) for i in range(3))
    out = bytearray()
    for i in range(len(h)):
        d = (int(h[i]) << 2) | (int(hi[i]) << 7) | (int(mid[i]) << 10) | (int(lo[i]) << 13)
        out += struct.pack(">H", d & 0xFFFF)
    return bytes(out)


# ---------------------------------------------------------------------------
# ANLZ sections
# ---------------------------------------------------------------------------


def _section(tag: bytes, header_extra: bytes, body: bytes) -> bytes:
    header_len = 12 + len(header_extra)
    total = header_len + len(body)
    return tag + struct.pack(">II", header_len, total) + header_extra + body


def _pmai(sections: bytes) -> bytes:
    total = 28 + len(sections)
    tail = bytes.fromhex("00000001000100000001000000000000")
    return b"PMAI" + struct.pack(">II", 28, total) + tail + sections


def _ppth(device_path: str) -> bytes:
    raw = device_path.encode("utf-16-be") + b"\x00\x00"
    return _section(b"PPTH", struct.pack(">I", len(raw)), raw)


def _pqtz(beats: list[tuple[int, float, int]]) -> bytes:
    body = b"".join(
        struct.pack(">HHI", beat, int(round(bpm * 100)), ms) for beat, bpm, ms in beats
    )
    extra = struct.pack(">III", 0, 0x00080000, len(beats))
    return _section(b"PQTZ", extra, body)


def _pwav(data: bytes) -> bytes:
    return _section(b"PWAV", struct.pack(">II", len(data), 0x00010000), data)


def _pwv3(data: bytes) -> bytes:
    extra = struct.pack(">IIHH", 1, len(data), COLS_PER_SEC, 0)
    return _section(b"PWV3", extra, data)


def _pwv5(data: bytes) -> bytes:
    cols = len(data) // 2
    extra = struct.pack(">IIHBB", 2, cols, COLS_PER_SEC, 3, 5)
    return _section(b"PWV5", extra, data)


@dataclass
class Cue:
    hot_slot: int          # 0 = memory cue, 1..8 = hot cue A..H
    time_ms: int
    colour: tuple[int, int, int] = (0, 0, 0)


def _pcob(cues: list[Cue], list_type: int) -> bytes:
    body = b"".join(
        b"PCPT" + struct.pack(">II", 28, 56)
        + struct.pack(">II", c.hot_slot, 0)
        + bytes.fromhex("00010000") + struct.pack(">I", NO_LOOP)
        + struct.pack(">BBBB", 1, 0, 0x03, 0xE8)
        + struct.pack(">II", c.time_ms, NO_LOOP)
        + bytes(16)
        for c in cues
    )
    extra = struct.pack(">IHHI", list_type, 0, len(cues), NO_LOOP)
    return _section(b"PCOB", extra, body)


def _pco2(cues: list[Cue], list_type: int) -> bytes:
    body = b"".join(
        b"PCP2" + struct.pack(">II", 16, 88)
        + struct.pack(">I", c.hot_slot)
        + struct.pack(">BBBB", 1, 0, 0x03, 0xE8)
        + struct.pack(">II", c.time_ms, NO_LOOP)
        + bytes(c.colour) + bytes(88 - 31)
        for c in cues
    )
    extra = struct.pack(">IHH", list_type, 0, len(cues))
    return _section(b"PCO2", extra, body)


def build_dat(device_path: str, beats, preview: bytes, hot: list[Cue], mem: list[Cue]) -> bytes:
    return _pmai(
        _ppth(device_path) + _pqtz(beats) + _pwav(preview) + _pcob(hot, 1) + _pcob(mem, 0)
    )


def build_ext(device_path: str, mono: bytes, colour: bytes,
              hot: list[Cue], mem: list[Cue]) -> bytes:
    return _pmai(
        _ppth(device_path) + _pwv3(mono) + _pwv5(colour)
        + _pcob([], 1) + _pcob([], 0) + _pco2(hot, 1) + _pco2(mem, 0)
    )


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

#: rekordbox's hot cue colours, so the pads read the way a DJ expects.
CUE_COLOURS = [(230, 40, 40), (40, 190, 90), (40, 140, 230), (230, 170, 40)]


def analyse(src: Path, index: int, meta: dict, root: Path) -> Track:
    x = decode(src)
    duration = len(x) / SR
    env, rate = onset_envelope(x)
    bpm = estimate_tempo(env, rate)
    first = estimate_phase(env, rate, bpm)
    print(f"  {src.name}: {duration:6.1f}s  {bpm:6.2f} BPM  first beat {first:.3f}s")

    period = 60.0 / bpm
    n_beats = int((duration - first) / period)
    beats = [
        (i % 4 + 1, bpm, int(round((first + i * period) * 1000)))
        for i in range(max(0, n_beats))
    ]

    n_cols = int(duration * COLS_PER_SEC)
    detail = band_columns(x, n_cols)
    preview = band_columns(x, PREVIEW_COLS)

    # A memory cue on the first downbeat, and hot cues every 32 bars -- the
    # phrase length this kind of material is built in.
    downbeats = [ms for beat, _, ms in beats if beat == 1]
    mem = [Cue(0, downbeats[0])] if downbeats else []
    hot = [
        Cue(i + 1, downbeats[(i + 1) * 32], CUE_COLOURS[i % len(CUE_COLOURS)])
        for i in range(4)
        if (i + 1) * 32 < len(downbeats)
    ]

    anlz_dir = f"/PIONEER/USBANLZ/P{index:03d}/{index:08X}"
    audio_rel = f"/Contents/{meta['artist']}/{meta['album']}/{src.stem}.mp3"
    transcode(src, root / audio_rel.lstrip("/"))

    out = root / anlz_dir.lstrip("/")
    out.mkdir(parents=True, exist_ok=True)
    (out / "ANLZ0000.DAT").write_bytes(
        build_dat(audio_rel, beats, preview_bytes(preview), hot, mem)
    )
    (out / "ANLZ0000.EXT").write_bytes(
        build_ext(audio_rel, detail_mono_bytes(detail), detail_colour_bytes(detail), hot, mem)
    )

    size = (root / audio_rel.lstrip("/")).stat().st_size
    return Track(
        title=meta["title"], path=audio_rel, artist=meta["artist"], album=meta["album"],
        genre=meta.get("genre"), dj_comment=meta.get("comment"),
        rating=meta.get("rating", 0), color_id=meta.get("color_id"),
        bpmx100=int(round(bpm * 100)), length=int(duration), bitrate=128,
        file_size=size, analysis_path=f"{anlz_dir}/ANLZ0000.DAT",
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("audio", nargs="+", type=Path)
    ap.add_argument("-o", "--out", type=Path, required=True)
    ap.add_argument("--meta", type=Path, required=True,
                    help="JSON list of {title, artist, album, ...}, one per input")
    ap.add_argument("--key", default=None)
    args = ap.parse_args()

    metas = json.loads(args.meta.read_text())
    if len(metas) != len(args.audio):
        ap.error(f"{len(args.audio)} audio files but {len(metas)} metadata entries")

    root = args.out
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)

    print(f"Analysing {len(args.audio)} tracks")
    tracks = [analyse(src, i + 1, m, root) for i, (src, m) in enumerate(zip(args.audio, metas))]

    library = Library(
        tracks=tracks,
        playlists=[Playlist(name="Sample Library", tracks=tracks)],
        device_name="SAMPLE",
    )
    db = write_device(root, library, key=args.key)
    print(f"\n{db.relative_to(root)}  {db.stat().st_size / 1024:.0f} KB")

    files = sorted(
        str(p.relative_to(root)) for p in root.rglob("*") if p.is_file()
    )
    (root / "manifest.json").write_text(json.dumps(files, indent=2) + "\n")
    total = sum((root / f).stat().st_size for f in files)
    print(f"{len(files)} files, {total / 1e6:.1f} MB total -> {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
