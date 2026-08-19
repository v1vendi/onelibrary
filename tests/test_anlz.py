"""ANLZ cue parsing, exercised against synthetic files built here.

Fixtures are constructed rather than committed: real ANLZ files carry the
user's audio paths.
"""

from __future__ import annotations

import struct

import pytest

from onelibrary.anlz import NO_LOOP, AnlzFile, CueList, CueType, iter_sections


def build_pcpt(hot: int, cue_type: int, time_ms: int, loop_end: int = NO_LOOP) -> bytes:
    body = struct.pack(">III", hot, 0, 0)  # hot, status, unknown
    body += struct.pack(">HH", 0, 0)  # order_first, order_last
    body += bytes([cue_type, 0, 0, 0])
    body += struct.pack(">II", time_ms, loop_end)
    body += b"\x00" * 16
    return b"PCPT" + struct.pack(">II", 12, 12 + len(body)) + body


def build_pcob(list_type: int, entries: list[bytes]) -> bytes:
    """A 24-byte PCOB header: magic, lengths, list type, count, count."""
    payload = b"".join(entries)
    total = 24 + len(payload)
    header = (
        b"PCOB"
        + struct.pack(">III", 24, total, list_type)
        + b"\x00\x00"
        + struct.pack(">H", len(entries))
        + struct.pack(">I", len(entries))
    )
    assert len(header) == 24
    return header + payload


def build_anlz(*sections: bytes) -> bytes:
    return b"PMAI" + struct.pack(">II", 28, 28 + sum(map(len, sections))) + b"\x00" * 16 + b"".join(
        sections
    )


@pytest.fixture
def anlz_with_cues(tmp_path):
    hot = build_pcob(1, [build_pcpt(1, 1, 24460), build_pcpt(3, 2, 39768, 42274)])
    mem = build_pcob(0, [build_pcpt(0, 1, 0), build_pcpt(0, 1, 19363)])
    p = tmp_path / "ANLZ0000.DAT"
    p.write_bytes(build_anlz(hot, mem))
    return p


def test_rejects_non_anlz(tmp_path):
    p = tmp_path / "bad.DAT"
    p.write_bytes(b"NOPE" + b"\x00" * 64)
    with pytest.raises(ValueError, match="PMAI"):
        AnlzFile(p)


def test_section_iteration(anlz_with_cues):
    assert AnlzFile(anlz_with_cues).tags == ["PCOB", "PCOB"]


def test_parses_hot_and_memory_lists(anlz_with_cues):
    grouped = AnlzFile(anlz_with_cues).cues(extended=False)
    assert len(grouped[CueList.HOT]) == 2
    assert len(grouped[CueList.MEMORY]) == 2


def test_loop_detection(anlz_with_cues):
    cues = AnlzFile(anlz_with_cues).all_cues()
    loops = [c for c in cues if c.is_loop]
    assert len(loops) == 1
    loop = loops[0]
    assert loop.cue_type == CueType.LOOP
    assert loop.time_ms == 39768
    assert loop.loop_end_ms == 42274
    assert loop.loop_length_ms == 2506


def test_no_loop_sentinel_becomes_none(anlz_with_cues):
    plain = [c for c in AnlzFile(anlz_with_cues).all_cues() if not c.is_loop]
    assert all(c.loop_end_ms is None for c in plain)
    assert all(c.loop_length_ms is None for c in plain)


def test_hot_slot_letters(anlz_with_cues):
    by_time = {c.time_ms: c for c in AnlzFile(anlz_with_cues).all_cues()}
    assert by_time[24460].hot_letter == "A"
    assert by_time[39768].hot_letter == "C"
    assert by_time[0].hot_letter is None
    assert by_time[0].is_memory


def test_cues_sorted_by_position(anlz_with_cues):
    times = [c.time_ms for c in AnlzFile(anlz_with_cues).all_cues()]
    assert times == sorted(times)


def test_falls_back_to_pcob_when_no_pco2(anlz_with_cues):
    """Requesting extended cues on a .DAT must not silently return nothing."""
    assert len(AnlzFile(anlz_with_cues).all_cues()) == 4
