"""ANLZ analysis files -- where OneLibrary actually stores cues and beatgrids.

**rekordbox does not populate the database's ``cue`` table on export.** A test
export in which two tracks carried memory cues, hot cues and a saved loop had
zero rows in ``cue``; every one of those cues was in the ANLZ files, and only
``content.cueUpdateCount`` hinted that anything existed. A writer that fills
the ``cue`` table and stops produces a device with no cues on it.

The ``cue`` table is presumed to be written by the *player*, when a DJ saves
cues on the hardware itself. [UNKNOWN] -- untested, no hardware available.

The format is the same ANLZ used by legacy PDB exports, already documented by
crate-digger and pyrekordbox. Only the parts needed to read and write cues are
implemented here; for waveforms and phrase data, use those projects.

File layout: a ``PMAI`` header followed by length-prefixed tagged sections.

======  ====================================================
 Tag    Contents
======  ====================================================
PPTH    source file path
PVBR    VBR seek index
PQTZ    beatgrid                     (``.DAT``)
PQT2    extended beatgrid            (``.EXT``)
PWAV    waveform preview             (``.DAT``)
PWV2    waveform preview, small      (``.DAT``)
PWV3    colour waveform detail       (``.EXT``)
PWV4    colour waveform preview      (``.EXT``)
PWV5    3-band waveform              (``.EXT``)
PCOB    cue list, ``PCPT`` entries
PCO2    extended cue list, ``PCP2`` entries, with colour
PSSI    song structure / phrase analysis
======  ====================================================
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum
from pathlib import Path

#: ``loop_end_ms`` sentinel meaning "this is a plain cue, not a loop".
NO_LOOP = 0xFFFFFFFF


class CueList(IntEnum):
    """Which list a cue belongs to. The ``type`` field of PCOB/PCO2."""

    MEMORY = 0
    HOT = 1


class CueType(IntEnum):
    """The kind of marker. The per-entry ``type`` byte."""

    CUE = 1
    LOOP = 2


@dataclass
class Cue:
    """One cue point or loop.

    ``hot_slot`` is 0 for a memory cue, and 1-8 for hot cue A-H.
    """

    hot_slot: int
    cue_type: CueType
    time_ms: int
    loop_end_ms: int | None = None
    color_rgb: tuple[int, int, int] | None = None
    status: int = 0

    @property
    def is_loop(self) -> bool:
        return self.cue_type == CueType.LOOP and self.loop_end_ms is not None

    @property
    def is_memory(self) -> bool:
        return self.hot_slot == 0

    @property
    def loop_length_ms(self) -> int | None:
        if not self.is_loop:
            return None
        return self.loop_end_ms - self.time_ms

    @property
    def hot_letter(self) -> str | None:
        """``A``-``H`` for a hot cue, ``None`` for a memory cue."""
        if self.is_memory:
            return None
        return chr(ord("A") + self.hot_slot - 1)


def iter_sections(data: bytes):
    """Yield ``(tag, payload)`` for each section, payload including its header."""
    if data[:4] != b"PMAI":
        raise ValueError("not an ANLZ file (missing PMAI magic)")
    off = struct.unpack(">I", data[4:8])[0]
    while off + 12 <= len(data):
        tag = data[off : off + 4]
        if not tag.strip():
            break
        _header_len, total_len = struct.unpack(">II", data[off + 4 : off + 12])
        if total_len <= 0 or off + total_len > len(data):
            break
        yield tag.decode("latin1"), data[off : off + total_len]
        off += total_len


def _parse_pcob(block: bytes) -> tuple[CueList, list[Cue]]:
    """Parse a ``PCOB`` section: the basic cue list, no colour."""
    header_len, _total, list_type = struct.unpack(">III", block[4:16])
    cues: list[Cue] = []
    off = header_len
    while off + 4 <= len(block) and block[off : off + 4] == b"PCPT":
        _ehl, entry_len = struct.unpack(">II", block[off + 4 : off + 12])
        hot, status, _u = struct.unpack(">III", block[off + 12 : off + 24])
        cue_type = block[off + 28]
        time_ms, loop_end = struct.unpack(">II", block[off + 32 : off + 40])
        cues.append(
            Cue(
                hot_slot=hot,
                cue_type=CueType(cue_type) if cue_type in (1, 2) else CueType.CUE,
                time_ms=time_ms,
                loop_end_ms=None if loop_end == NO_LOOP else loop_end,
                status=status,
            )
        )
        off += entry_len
    return CueList(list_type) if list_type in (0, 1) else CueList.MEMORY, cues


def _parse_pco2(block: bytes) -> tuple[CueList, list[Cue]]:
    """Parse a ``PCO2`` section: the extended cue list, carrying colour."""
    header_len, _total, list_type = struct.unpack(">III", block[4:16])
    cues: list[Cue] = []
    off = header_len
    while off + 4 <= len(block) and block[off : off + 4] == b"PCP2":
        _ehl, entry_len = struct.unpack(">II", block[off + 4 : off + 12])
        (hot,) = struct.unpack(">I", block[off + 12 : off + 16])
        cue_type = block[off + 16]
        time_ms, loop_end = struct.unpack(">II", block[off + 20 : off + 28])
        rgb = tuple(block[off + 28 : off + 31])
        cues.append(
            Cue(
                hot_slot=hot,
                cue_type=CueType(cue_type) if cue_type in (1, 2) else CueType.CUE,
                time_ms=time_ms,
                loop_end_ms=None if loop_end == NO_LOOP else loop_end,
                color_rgb=rgb if len(rgb) == 3 else None,
            )
        )
        off += entry_len
    return CueList(list_type) if list_type in (0, 1) else CueList.MEMORY, cues


class AnlzFile:
    """A parsed ANLZ file.

    Prefer :meth:`cues` over reading the sections directly: a ``.DAT`` file
    carries only the hot cues old players understand (A-C), while the ``.EXT``
    sibling carries the full modern set. In one observed track the ``.DAT``
    listed 2 hot cues where the ``.EXT`` listed 3.
    """

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.data = self.path.read_bytes()
        self.sections: list[tuple[str, bytes]] = list(iter_sections(self.data))

    @property
    def tags(self) -> list[str]:
        return [t for t, _ in self.sections]

    def cues(self, extended: bool = True) -> dict[CueList, list[Cue]]:
        """Cues grouped by list. ``extended`` prefers ``PCO2`` over ``PCOB``."""
        want = "PCO2" if extended else "PCOB"
        parse = _parse_pco2 if extended else _parse_pcob
        out: dict[CueList, list[Cue]] = {CueList.MEMORY: [], CueList.HOT: []}
        found = False
        for tag, block in self.sections:
            if tag == want:
                found = True
                kind, cues = parse(block)
                out[kind].extend(cues)
        if not found and extended:
            return self.cues(extended=False)
        for cues in out.values():
            cues.sort(key=lambda c: c.time_ms)
        return out

    def all_cues(self) -> list[Cue]:
        grouped = self.cues()
        return sorted(
            grouped[CueList.MEMORY] + grouped[CueList.HOT], key=lambda c: c.time_ms
        )

    def __repr__(self) -> str:
        return f"<AnlzFile {self.path.name} tags={'+'.join(dict.fromkeys(self.tags))}>"


def cues_for_track(device_root: str | Path, analysis_path: str) -> list[Cue]:
    """Read every cue for a track, given ``content.analysisDataFilePath``.

    Reads the ``.EXT`` sibling when present, since it carries the full hot cue
    set and colours; falls back to the ``.DAT``.
    """
    dat = Path(device_root) / analysis_path.lstrip("/")
    ext = dat.with_suffix(".EXT")
    source = ext if ext.exists() else dat
    if not source.exists():
        return []
    return AnlzFile(source).all_cues()
