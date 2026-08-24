#!/usr/bin/env python3
"""Build a playable sample OneLibrary device from open-licensed audio.

Analysis is synthesised here, which is the hard part and was wrong twice. Both
failures and their fixes are written up on the functions that carry them --
:func:`onset_envelope` on log compression, :func:`snap_tempo` on rounding, and
:func:`estimate_downbeat` on the bar. The short version: a grid can be built on
a tempo 0.15 BPM out and look right for the first bars, and a grid can have
every beat in the right place and still put the bar lines three beats out.

Where matching rekordbox exactly matters more than having a sample at all,
prefer ``import_sample_library.py``, which packages a real export rather than
computing anything.

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
    """Re-encode for the web. 320 kbps masters are needlessly heavy to serve.

    A source already at or under the target is copied rather than re-encoded.
    Running a 128 kbps file through the encoder again does not make it smaller,
    it just spends another generation of lossy coding on it -- and re-running
    this script is routine, so that loss would compound every time.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    target = int(bitrate.rstrip("k")) * 1000
    if src.suffix.lower() == ".mp3" and (source_bitrate(src) or 1 << 30) <= target * 1.05:
        shutil.copy2(src, dst)
        return
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(src),
         "-codec:a", "libmp3lame", "-b:a", bitrate, str(dst)],
        check=True,
    )


def source_bitrate(path: Path) -> int | None:
    """Bits a second, via ffprobe, or None if it cannot be read."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=bit_rate",
             "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, check=True).stdout.strip()
        return int(out)
    except (subprocess.CalledProcessError, ValueError, FileNotFoundError):
        return None


# ---------------------------------------------------------------------------
# Beat tracking
# ---------------------------------------------------------------------------

#: Frames a second in the onset envelope. 256 samples is 5.8 ms, fine enough
#: to place a beat well inside the ear's tolerance.
HOP = 256
WIN = 1024
FREQS = np.fft.rfftfreq(WIN, 1 / SR)


def spectrogram(x: np.ndarray) -> np.ndarray:
    n = 1 + (len(x) - WIN) // HOP
    frames = np.lib.stride_tricks.as_strided(
        x, shape=(n, WIN), strides=(x.strides[0] * HOP, x.strides[0])
    )
    return np.abs(np.fft.rfft(frames * np.hanning(WIN), axis=1))


def onset_envelope(spec: np.ndarray, lo_hz: float = 0.0,
                   hi_hz: float = SR / 2) -> np.ndarray:
    """Spectral flux over a band: how much it brightens frame to frame.

    Two details decide whether this finds the beat or the melody.

    **Magnitudes are log-compressed first.** Summing linear magnitudes lets a
    loud synth stab count for more than a kick, and the grid then gets fitted
    to the melody -- which is how one of the sample tracks ended up with a
    phase half a beat out, locked to an off-beat lead. Compression puts a quiet
    drum and a loud lead on comparable footing, which is what a listener does.
    Measured across the three sample tracks it collapsed the disagreement
    between the low, mid and high bands about where the beat sits from 0.485
    of a beat to 0.011.

    **A local mean is subtracted.** Otherwise a loud chorus outweighs a quiet
    intro and the grid is fitted to the loudest thirty seconds of the track.
    """
    sel = (FREQS >= lo_hz) & (FREQS < hi_hz)
    band = np.log1p(10.0 * spec[:, sel])
    flux = np.maximum(np.diff(band, axis=0, prepend=band[:1]), 0).sum(axis=1)
    k = int(2.0 * SR / HOP) | 1
    return np.maximum(flux - np.convolve(flux, np.ones(k) / k, mode="same"), 0)


def estimate_tempo(env: np.ndarray, rate: float,
                   lo: float = 85.0, hi: float = 175.0) -> float:
    """Comb-scored autocorrelation: the tempo whose whole grid is supported.

    A bare autocorrelation peak is not the tempo. Its harmonics are peaks too,
    and often taller ones, so taking the maximum inside a one-octave window
    picks whichever harmonic the window happens to admit -- which is how a
    159 BPM track reads as 120. Scoring a candidate by the autocorrelation at
    its first eight beat multiples resolves it: the true tempo is supported at
    every multiple, while a harmonic lands between peaks at some of them.
    """
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    ac = ac / (np.abs(ac).max() or 1.0)
    cands = np.arange(lo, hi, 0.02)
    best, best_score = 120.0, -np.inf
    for bpm in cands:
        lag = 60.0 * rate / bpm
        idx = (lag * np.arange(1, 9)).round().astype(int)
        idx = idx[idx < len(ac)]
        if not len(idx):
            continue
        score = float(ac[idx].mean())
        if score > best_score:
            best, best_score = float(bpm), score
    return best


def beat_frames(n: int, rate: float, bpm: float, phase: float) -> np.ndarray:
    period = 60.0 / bpm * rate
    count = int((n - phase) / period)
    return (phase + period * np.arange(max(count, 0))).round().astype(int)


def grid_score(env: np.ndarray, rate: float, bpm: float, phase: float,
               halo: int = 1) -> float:
    """Onset energy a grid captures, tolerant of a frame of jitter.

    The halo matters: sampling single frames makes the score jump around on
    timing error small enough to be inaudible, and the search then settles on
    whichever offset happened to hit its frames squarely.
    """
    idx = beat_frames(len(env), rate, bpm, phase)
    if len(idx) < 4:
        return -np.inf
    idx = np.clip(idx, halo, len(env) - 1 - halo)
    return float(np.stack([env[idx + d] for d in range(-halo, halo + 1)])
                 .max(axis=0).mean())


def snap_tempo(env: np.ndarray, rate: float, bpm: float) -> float:
    """Pull a near-round tempo onto the round one, if the music agrees.

    Produced music is cut to a whole or half BPM almost without exception, and
    an estimate 0.04 BPM shy of one is the search's resolution showing, not the
    track. Left alone it is ruinous: a grid at 149.96 against a track at 150
    is three quarters of a beat adrift by the end. The snap is only taken if
    the rounded tempo still explains the onsets as well, so genuinely off-grid
    material -- live, acoustic, anything not made to a click -- is left alone.
    """
    near = round(bpm * 2) / 2
    if abs(bpm - near) >= 0.6:
        return bpm
    here = grid_score(env, rate, bpm, estimate_phase(env, rate, bpm))
    there = grid_score(env, rate, near, estimate_phase(env, rate, near))
    return near if there >= here * 0.98 else bpm


def estimate_phase(env: np.ndarray, rate: float, bpm: float) -> float:
    """Where the first beat falls, in frames, by scoring every offset."""
    period = 60.0 / bpm * rate
    if int(len(env) / period) < 2:
        return 0.0
    offsets = np.arange(0, period, 0.5)
    scores = [grid_score(env, rate, bpm, o) for o in offsets]
    return float(offsets[int(np.argmax(scores))])


def music_entry_beat(env: np.ndarray, rate: float, bpm: float,
                     phase: float) -> float | None:
    """Which beat the track stops being silence on."""
    if not len(env) or env.max() <= 0:
        return None
    loud = np.flatnonzero(env > env.max() * 0.10)
    if not len(loud):
        return None
    return float((loud[0] - phase) / (60.0 / bpm * rate))


def estimate_downbeat(low: np.ndarray, rate: float, bpm: float, phase: float,
                      entry: float | None = None) -> tuple[int, float]:
    """Which of the four beats starts the bar, and how clear-cut it is.

    The grid says where the beats are; it does not say which one begins the
    bar, and nothing else here works that out -- so every bar line lands on
    whichever beat the track happened to start on. On one sample track that put
    the downbeat three beats early and swallowed a three-beat intro whole.

    The kick decides it, so this reads the low band alone. Across the full
    spectrum the melody spreads energy evenly over all four positions and the
    measurement says nothing; in the low band the same track separates its bar
    position from the rest by a factor of five.

    Returns the offset and the margin over the runner-up, which is worth
    printing: where a track is genuinely ambiguous, the margin says so.
    """
    idx = beat_frames(len(low), rate, bpm, phase)
    if len(idx) < 8:
        return 0, 0.0
    idx = np.clip(idx, 1, len(low) - 2)
    strength = np.maximum.reduce([low[idx - 1], low[idx], low[idx + 1]])
    per = np.array([strength[k::4].mean() for k in range(4)])
    order = np.argsort(per)[::-1]
    runner = per[order[1]] or 1e-12
    margin = float(per[order[0]] / runner)

    # When the kick cannot separate two positions, ask where the music comes
    # in: a track that opens with silence almost always enters on a downbeat.
    # This is only a tiebreak. It is wrong on its own -- a track whose intro is
    # three beats of something enters three beats before the bar, which is the
    # very case the kick gets right -- so it is consulted only when the kick
    # has nothing to say.
    if margin < 1.3 and entry is not None:
        want = int(round(entry)) % 4
        if want in (int(order[0]), int(order[1])):
            return want, margin
    return int(order[0]), margin


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
    spec = spectrogram(x)
    rate = SR / HOP
    env = onset_envelope(spec)
    bpm = snap_tempo(env, rate, estimate_tempo(env, rate))
    phase = estimate_phase(env, rate, bpm)
    entry = music_entry_beat(env, rate, bpm, phase)
    down, margin = estimate_downbeat(
        onset_envelope(spec, 0, 250), rate, bpm, phase, entry)
    first = phase / rate
    print(f"  {src.name}: {duration:6.1f}s  {bpm:6.2f} BPM  "
          f"first beat {first:.3f}s  downbeat +{down} (x{margin:.1f})")
    if margin < 1.3:
        print("    ! the bar position is a close call here; check it by ear")

    period = 60.0 / bpm
    n_beats = int((duration - first) / period)
    # The bar is numbered from the detected downbeat, not from whichever beat
    # the track happens to open on -- a three-beat intro is numbered 2, 3, 4
    # and the music lands on 1, which is where the bar lines belong.
    beats = [
        ((i - down) % 4 + 1, bpm, int(round((first + i * period) * 1000)))
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
