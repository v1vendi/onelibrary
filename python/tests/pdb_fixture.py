"""Build a small but structurally real ``export.pdb`` to read back.

Real captures cannot be committed -- they carry the user's audio paths -- so
the legacy reader is exercised against a file assembled here, the same way
``test_anlz`` assembles ANLZ files. This is a fixture builder, deliberately not
a writer: it lays rows out in the simplest legal way (each row's strings placed
immediately behind it) rather than packing a heap the way rekordbox does.

The fixture is built to hit the parts of the format that are easy to get wrong:

- a table whose rows span two linked pages
- a deleted row, whose offset survives with its presence bit cleared
- a non-data page in the middle of a chain
- all three string encodings, and both the near and far name offsets

``python/tools/make_pdb_fixture.py`` writes the same bytes to
``viewer/test/fixtures/sample.pdb`` so the browser reader can be held to the
identical library.
"""

from __future__ import annotations

import struct

from onelibrary.pdb import (
    PAGE_HEADER_LEN,
    ROW_GROUP_STRIDE,
    ROWS_PER_GROUP,
    TRACK_FMT,
    ExtPageType,
    PageType,
)

PAGE_SIZE = 4096

# -- strings ---------------------------------------------------------------


def short_ascii(text: str) -> bytes:
    """The compact form: length incremented, doubled, incremented again."""
    if len(text) > 126:
        raise ValueError("too long for a short string")
    return bytes([(len(text) + 1) * 2 + 1]) + text.encode("ascii")


def long_ascii(text: str) -> bytes:
    body = text.encode("ascii")
    return b"\x40" + struct.pack("<H", len(body) + 4) + b"\x00" + body


def long_utf16(text: str) -> bytes:
    body = text.encode("utf-16-le")
    return b"\x90" + struct.pack("<H", len(body) + 4) + b"\x00" + body


# -- rows ------------------------------------------------------------------


def genre_row(id_: int, name: str) -> bytes:
    return struct.pack("<I", id_) + short_ascii(name)


def label_row(id_: int, name: str) -> bytes:
    return struct.pack("<I", id_) + short_ascii(name)


def key_row(id_: int, name: str) -> bytes:
    return struct.pack("<II", id_, id_) + short_ascii(name)


def color_row(id_: int, name: str) -> bytes:
    return b"\x00" * 5 + struct.pack("<H", id_) + b"\x00" + short_ascii(name)


def artwork_row(id_: int, path: str) -> bytes:
    return struct.pack("<I", id_) + long_ascii(path)


def artist_row(id_: int, name: str, *, far: bool = False, string=short_ascii) -> bytes:
    """An artist row, with the name reached by the near or the far offset.

    The fixed part ends at 0x0a. A near offset is the single byte at 0x09 and
    the name follows immediately; a far offset is the two bytes *at* 0x0a, so
    the name has to start after them.
    """
    if far:
        head = struct.pack("<HHIBB", 0x64, id_ * 0x20, id_, 0x03, 0x00)
        return head + struct.pack("<H", 0x0C) + string(name)
    head = struct.pack("<HHIBB", 0x60, id_ * 0x20, id_, 0x03, 0x0A)
    return head + string(name)


def album_row(id_: int, name: str, artist_id: int = 0, *, far: bool = False) -> bytes:
    """An album row. Its fixed part ends at 0x16, where the far offset sits."""
    if far:
        head = struct.pack("<HHIIIIBB", 0x84, id_ * 0x20, 0, artist_id, id_, 0, 0x03, 0x00)
        return head + struct.pack("<H", 0x18) + short_ascii(name)
    head = struct.pack("<HHIIIIBB", 0x80, id_ * 0x20, 0, artist_id, id_, 0, 0x03, 0x16)
    return head + short_ascii(name)


def playlist_tree_row(id_: int, name: str, parent_id: int = 0, *, folder: bool = False,
                      sort_order: int = 0) -> bytes:
    head = struct.pack("<I4xIII", parent_id, sort_order, id_, int(folder))
    return head + short_ascii(name)


def playlist_entry_row(entry_index: int, track_id: int, playlist_id: int) -> bytes:
    return struct.pack("<III", entry_index, track_id, playlist_id)


def history_playlist_row(id_: int, name: str) -> bytes:
    return struct.pack("<I", id_) + short_ascii(name)


def history_entry_row(track_id: int, playlist_id: int, entry_index: int) -> bytes:
    return struct.pack("<III", track_id, playlist_id, entry_index)


#: Defaults for every fixed field of a track row, in ``TRACK_FMT`` order.
TRACK_DEFAULTS: dict[str, int] = {
    "subtype": 0x24, "index_shift": 0, "bitmask": 0, "sample_rate": 44100,
    "composer_id": 0, "file_size": 0, "u_14": 0, "u_18": 19048, "u_1a": 30967,
    "artwork_id": 0, "key_id": 0, "original_artist_id": 0, "label_id": 0,
    "remixer_id": 0, "bitrate": 320, "track_number": 0, "tempo": 12800,
    "genre_id": 0, "album_id": 0, "artist_id": 0, "id": 0,
    "disc_number": 0, "play_count": 0, "year": 0, "sample_depth": 16,
    "duration": 0, "u_56": 41, "color_id": 0, "rating": 0, "u_5a": 1, "u_5c": 3,
}

#: Strings of a track row, in offset-array order, with their defaults.
TRACK_STRING_DEFAULTS: dict[str, str] = {
    "isrc": "", "texter": "", "unknown_string_2": "", "unknown_string_3": "",
    "unknown_string_4": "", "message": "", "kuvo_public": "", "autoload_hot_cues": "ON",
    "unknown_string_5": "", "unknown_string_6": "", "date_added": "2025-10-01",
    "release_date": "", "mix_name": "", "unknown_string_7": "", "analyze_path": "",
    "analyze_date": "2025-10-01", "comment": "", "title": "", "unknown_string_8": "",
    "filename": "", "file_path": "",
}


def track_row(**overrides) -> bytes:
    """A track row: fixed fields, then 21 offsets, then the strings they name.

    A string given as ``bytes`` is used as encoded, which is how a caller asks
    for the long ASCII or UTF-16 forms instead of the compact one.
    """
    fixed = dict(TRACK_DEFAULTS)
    strings: dict[str, str | bytes] = dict(TRACK_STRING_DEFAULTS)
    for name, value in overrides.items():
        if name in strings:
            strings[name] = value
        elif name in fixed:
            fixed[name] = value
        else:
            raise KeyError(f"track rows have no field {name!r}")

    head = struct.pack(TRACK_FMT, *fixed.values())
    base = len(head) + 2 * len(strings)  # the offsets follow the fixed part
    offsets, blobs, cursor = [], [], base
    for value in strings.values():
        blob = value if isinstance(value, bytes) else short_ascii(value)
        offsets.append(cursor)
        blobs.append(blob)
        cursor += len(blob)
    return head + struct.pack(f"<{len(offsets)}H", *offsets) + b"".join(blobs)


# -- pages -----------------------------------------------------------------


def build_page(index: int, page_type: int, next_page: int, rows: list[bytes | None],
               *, page_flags: int = 0x34, page_size: int = PAGE_SIZE) -> bytes:
    """Lay rows into a page heap and build the row index behind them.

    A ``None`` row still consumes an index slot, with its presence bit clear
    and an offset left pointing at the start of the heap -- what a deleted row
    looks like once rekordbox has reused or abandoned its bytes.
    """
    page = bytearray(page_size)
    struct.pack_into("<5I", page, 0, 0, index, page_type, next_page, 0)

    heap, offsets = bytearray(), []
    for row in rows:
        if row is None:
            offsets.append(0)
            continue
        offsets.append(len(heap))
        heap += row
        heap += b"\x00" * (len(heap) % 2)  # keep rows two-byte aligned

    index_len = ((len(rows) - 1) // ROWS_PER_GROUP + 1) * ROW_GROUP_STRIDE if rows else 0
    if PAGE_HEADER_LEN + len(heap) + index_len > page_size:
        raise ValueError("rows do not fit in one page")
    page[PAGE_HEADER_LEN : PAGE_HEADER_LEN + len(heap)] = heap

    present = [row is not None for row in rows]
    packed = len(rows) | (sum(present) << 13)
    page[0x18:0x1B] = packed.to_bytes(3, "little")
    page[0x1B] = page_flags
    struct.pack_into(
        "<HHHHHH", page, 0x1C,
        page_size - PAGE_HEADER_LEN - len(heap) - index_len,  # free_size
        len(heap),                                            # used_size
        0, 0, 0, 0,
    )

    for group in range((len(rows) - 1) // ROWS_PER_GROUP + 1 if rows else 0):
        base = page_size - group * ROW_GROUP_STRIDE
        mask = 0
        for slot in range(ROWS_PER_GROUP):
            i = group * ROWS_PER_GROUP + slot
            if i >= len(rows):
                break
            struct.pack_into("<H", page, base - (6 + 2 * slot), offsets[i])
            mask |= present[i] << slot
        struct.pack_into("<H", page, base - 4, mask)
    return bytes(page)


def build_file(chains: dict[int, list[list[bytes | None] | None]],
               *, page_size: int = PAGE_SIZE) -> bytes:
    """Assemble a whole file from a page chain per table type.

    Each chain is a list of pages; a ``None`` page becomes a non-data page,
    which a reader has to walk past rather than trying to find rows in.
    """
    pages: list[bytes] = []
    tables: list[tuple[int, int, int]] = []
    next_index = 1
    for page_type, chain in chains.items():
        first = next_index
        for i, rows in enumerate(chain):
            index = next_index + i
            last = i == len(chain) - 1
            pages.append(
                build_page(
                    index, page_type,
                    # The final page of a table links past the end of the file.
                    index + 1 if not last else 0xFFFFFFFF,
                    rows or [],
                    page_flags=0x64 if rows is None else 0x34,
                    page_size=page_size,
                )
            )
        tables.append((page_type, first, next_index + len(chain) - 1))
        next_index += len(chain)

    header = bytearray(page_size)
    struct.pack_into("<7I", header, 0, 0, page_size, len(tables), next_index, 0, 1, 0)
    for i, (page_type, first, last) in enumerate(tables):
        struct.pack_into("<4I", header, 0x1C + i * 16, page_type, 0, first, last)
    return bytes(header) + b"".join(pages)


# -- the sample library ----------------------------------------------------


def sample_pdb() -> bytes:
    """A three-track legacy library, spread over two pages of tracks."""
    analyze = "/PIONEER/USBANLZ/P%03d/0000000%d/ANLZ0000.DAT"
    return build_file(
        {
            PageType.TRACKS: [
                None,  # the garbage page rekordbox leaves at the head of a chain
                [
                    track_row(
                        id=1, title="Alpha Track", artist_id=1, album_id=1, genre_id=1,
                        key_id=1, label_id=1, color_id=1, rating=5, tempo=12800,
                        duration=181, file_size=4_331_520, track_number=1, year=2019,
                        filename="cipher.mp3",
                        file_path="/Contents/Kevin MacLeod/Electronic Light/cipher.mp3",
                        analyze_path=analyze % (1, 1), comment="opener",
                    ),
                    None,  # deleted: its offset survives, its presence bit does not
                    track_row(
                        id=2, title=long_utf16("Beta Track (Café Mix)"), artist_id=2, album_id=1,
                        genre_id=1, key_id=1, rating=3, tempo=14000, duration=145,
                        track_number=2, filename="coldfunk.mp3",
                        file_path=long_utf16("/Contents/Kevin MacLeod/Funkorama/coldfunk.mp3"),
                        analyze_path=analyze % (2, 2),
                        mix_name=long_utf16("Café Mix"),
                    ),
                ],
                [
                    track_row(
                        id=3, title="Gamma Track", artist_id=2, genre_id=1, rating=0,
                        tempo=17400, duration=98, track_number=3,
                        filename="electrodoodle.mp3",
                        file_path=long_ascii(
                            "/Contents/Kevin MacLeod/Incompetech/electrodoodle.mp3"
                        ),
                        analyze_path=analyze % (3, 3),
                    ),
                ],
            ],
            PageType.ARTISTS: [
                [
                    artist_row(1, "Kevin MacLeod"),
                    artist_row(2, "Kevin MacLeod & Friends", far=True),
                ]
            ],
            PageType.ALBUMS: [[album_row(1, "Electronic Light", artist_id=1)]],
            PageType.GENRES: [[genre_row(1, "Electronic")]],
            PageType.KEYS: [[key_row(1, "8A")]],
            PageType.LABELS: [[label_row(1, "Incompetech")]],
            PageType.COLORS: [[color_row(1, "Pink")]],
            PageType.ARTWORK: [[artwork_row(1, "/PIONEER/Artwork/00001.jpg")]],
            PageType.PLAYLIST_TREE: [
                [
                    playlist_tree_row(1, "Sets", folder=True),
                    playlist_tree_row(2, "Warm Up", parent_id=1, sort_order=1),
                ]
            ],
            PageType.PLAYLIST_ENTRIES: [
                [
                    playlist_entry_row(1, 1, 2),
                    playlist_entry_row(2, 3, 2),
                    playlist_entry_row(3, 2, 2),
                ]
            ],
            PageType.HISTORY_PLAYLISTS: [[history_playlist_row(1, "HISTORY 001")]],
            PageType.HISTORY_ENTRIES: [[history_entry_row(1, 1, 1)]],
            PageType.COLUMNS: [[b"\x00" * 8]],  # a table whose layout is unknown
        }
    )


def sample_ext_pdb() -> bytes:
    """A matching ``exportExt.pdb``: one My Tag category, two tags."""

    def tag_row(id_: int, name: str, *, category: int = 0, position: int = 0,
                is_category: bool = False) -> bytes:
        """The name follows the 0x1f-byte fixed part, then an empty string."""
        encoded = short_ascii(name)
        head = struct.pack(
            "<HH8xIIIIxBB", 0x0680, id_ * 0x20, category, position, id_,
            int(is_category), 0x1F, 0x1F + len(encoded),
        )
        return head + encoded + short_ascii("")

    return build_file(
        {
            ExtPageType.TAGS: [
                [
                    tag_row(1, "Situation", is_category=True, position=0),
                    tag_row(2, "Peak Time", category=1, position=0),
                    tag_row(3, "Warm Up", category=1, position=1),
                ]
            ],
            ExtPageType.TAG_TRACKS: [
                [
                    struct.pack("<4xII4x", 1, 2),
                    struct.pack("<4xII4x", 3, 3),
                ]
            ],
        }
    )
