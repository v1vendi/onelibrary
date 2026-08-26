"""The legacy DeviceSQL export (``export.pdb``) that OneLibrary replaces.

rekordbox has written this format to USB and SD media for over a decade, and
still does: rekordbox 7 emits ``export.pdb`` alongside ``exportExt.pdb`` and
``PIONEER/USBANLZ``, and converts a device to OneLibrary only when asked. Any
tool that wants to read *the devices people actually have* has to read both.

This module is **read-only**. Writing DeviceSQL means allocating within a page
heap and rebuilding the row index in place; rekordbox can convert a legacy
device to OneLibrary itself, so the writing effort belongs on the newer format.

Layout
------
The file is a sequence of fixed-size pages. Page 0 is a header giving the page
size and listing the tables; each table names a row type and points at the
first and last page of a linked list of pages holding rows of that type.

Within a page, rows live in a heap growing forward from the end of the page
header, while an index of their offsets grows *backwards* from the end of the
page. That index is made of groups of sixteen 2-byte offsets, each group led by
a 16-bit presence mask::

    +-------------------+ 0x00
    | page header       |
    +-------------------+ 0x28  row offsets are relative to here
    | rows ->           |
    |                   |
    |         <- string |
    +-------------------+
    | <- row index      |  group 0 spans len_page-0x24 .. len_page
    +-------------------+ len_page

Deleted rows leave their offsets in place and clear their presence bit, so the
mask is the only thing that says which rows are real. A row whose bit is clear
may not even be well-formed -- it has to be skipped, not merely ignored.

Every variable-length string is stored out of line, elsewhere in the same page,
and located by an offset relative to the *row*, not to the page.

The row layouts follow crate-digger's ``rekordbox_pdb.ksy``, the community
reference for this format, reverse-engineered by @henrybetts, @flesniak and
@brunchboy. ``spec/DEVICESQL.md`` describes the parts this project relies on.
"""

from __future__ import annotations

import struct
from collections.abc import Iterator
from dataclasses import dataclass, field
from enum import IntEnum
from pathlib import Path

#: Relative location of the legacy library within a device tree.
EXPORT_PDB_RELPATH = Path("PIONEER") / "rekordbox" / "export.pdb"

#: Relative location of the legacy extension database (My Tag data).
EXPORT_EXT_PDB_RELPATH = Path("PIONEER") / "rekordbox" / "exportExt.pdb"

PAGE_HEADER_LEN = 0x28
ROW_GROUP_STRIDE = 0x24
ROWS_PER_GROUP = 16

#: Sanity bound on ``len_page``; a real export uses 4096.
MAX_PAGE_SIZE = 1 << 20


class PdbError(RuntimeError):
    """Raised when a file is not a readable DeviceSQL export."""


class PageType(IntEnum):
    """Row type of a table in ``export.pdb``, as named by crate-digger."""

    TRACKS = 0
    GENRES = 1
    ARTISTS = 2
    ALBUMS = 3
    LABELS = 4
    KEYS = 5
    COLORS = 6
    PLAYLIST_TREE = 7
    PLAYLIST_ENTRIES = 8
    UNKNOWN_9 = 9
    UNKNOWN_10 = 10
    HISTORY_PLAYLISTS = 11
    HISTORY_ENTRIES = 12
    ARTWORK = 13
    UNKNOWN_14 = 14
    UNKNOWN_15 = 15
    COLUMNS = 16
    UNKNOWN_17 = 17
    UNKNOWN_18 = 18
    HISTORY = 19


class ExtPageType(IntEnum):
    """Row type of a table in ``exportExt.pdb``. An unrelated numbering."""

    UNKNOWN_0 = 0
    UNKNOWN_1 = 1
    UNKNOWN_2 = 2
    TAGS = 3
    TAG_TRACKS = 4
    UNKNOWN_5 = 5
    UNKNOWN_6 = 6
    UNKNOWN_7 = 7
    UNKNOWN_8 = 8


# -- strings ---------------------------------------------------------------


def read_string(page: bytes, offset: int) -> str:
    """Read one ``device_sql_string`` at ``offset`` within a page image.

    Three encodings share one leading byte. ``0x40`` and ``0x90`` introduce a
    four-byte header holding a byte length that *includes* the header; anything
    else is a short ASCII string whose length is mangled into the byte itself
    -- incremented, doubled, and incremented again, so it always comes out odd.

    ASCII bodies are decoded as latin-1 rather than strict ASCII: rekordbox
    writes anything outside ASCII in the UTF-16 form, so the bytes are ASCII in
    practice, and latin-1 turns a violation of that into a visible character
    rather than an exception in the middle of somebody's library.
    """
    if not 0 <= offset < len(page):
        raise PdbError(f"string offset {offset} lies outside the page")
    kind = page[offset]
    if kind in (0x40, 0x90):
        (length,) = struct.unpack_from("<H", page, offset + 1)
        if length < 4 or offset + length > len(page):
            raise PdbError(f"long string at {offset} claims {length} bytes")
        body = page[offset + 4 : offset + length]
        return body.decode("utf-16-le" if kind == 0x90 else "latin-1", "replace")
    length = kind >> 1
    if length < 1 or offset + length > len(page):
        raise PdbError(f"short string at {offset} claims {length} bytes")
    return page[offset + 1 : offset + length].decode("latin-1", "replace")


# -- row layouts -----------------------------------------------------------


@dataclass(frozen=True)
class RowSpec:
    """How to read one kind of row: a fixed struct, then its strings.

    ``fields`` names each value unpacked by ``fmt``; ``_`` discards one whose
    meaning is not known. Strings are reached in one of three ways, and no row
    type uses more than one of them:

    ``inline``
        A single string starting immediately after the fixed part.
    ``long_name``
        ``(near, far)`` positions of two candidate offsets. Bit ``0x04`` of
        ``subtype`` says the name sits more than 0xff bytes from the row, in
        which case the wider of the two offsets applies.
    ``indexed``
        Names for an array of 2-byte offsets following the fixed part -- the
        twenty-one strings of a track row.
    """

    table: str
    fmt: str
    fields: tuple[str, ...]
    inline: str | None = None
    long_name: tuple[int, int] | None = None
    indexed: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        unpacked = len(struct.unpack(self.fmt, bytes(struct.calcsize(self.fmt))))
        if unpacked != len(self.fields):
            raise ValueError(
                f"{self.table}: {len(self.fields)} field names for {unpacked} packed values"
            )

    @property
    def fixed_len(self) -> int:
        return struct.calcsize(self.fmt)

    @property
    def columns(self) -> tuple[str, ...]:
        """Every column a row of this type yields, in the order it reports."""
        named = tuple(f for f in self.fields if f != "_")
        if self.long_name:
            strings: tuple[str, ...] = ("name",)
        elif self.indexed:
            strings = self.indexed
        else:
            strings = (self.inline,) if self.inline else ()
        renamed = tuple("is_folder" if c == "raw_is_folder" else c for c in named)
        renamed = tuple("is_category" if c == "raw_is_category" else c for c in renamed)
        return renamed + strings


#: The twenty-one strings a track row points at, in offset-array order.
TRACK_STRINGS = (
    "isrc",
    "texter",
    "unknown_string_2",
    "unknown_string_3",
    "unknown_string_4",
    "message",
    "kuvo_public",
    "autoload_hot_cues",
    "unknown_string_5",
    "unknown_string_6",
    "date_added",
    "release_date",
    "mix_name",
    "unknown_string_7",
    "analyze_path",
    "analyze_date",
    "comment",
    "title",
    "unknown_string_8",
    "filename",
    "file_path",
)

#: Fixed part of a track row: 0x5e bytes, then the twenty-one string offsets.
TRACK_FMT = "<HHIIIIIHH" + "I" * 12 + "H" * 6 + "BB" + "HH"

ROW_SPECS: dict[int, RowSpec] = {
    PageType.TRACKS: RowSpec(
        table="tracks",
        fmt=TRACK_FMT,
        fields=(
            "subtype", "index_shift", "bitmask", "sample_rate", "composer_id",
            "file_size", "_", "_", "_",
            "artwork_id", "key_id", "original_artist_id", "label_id", "remixer_id",
            "bitrate", "track_number", "tempo", "genre_id", "album_id", "artist_id", "id",
            "disc_number", "play_count", "year", "sample_depth", "duration", "_",
            "color_id", "rating", "_", "_",
        ),
        indexed=TRACK_STRINGS,
    ),
    PageType.GENRES: RowSpec("genres", "<I", ("id",), inline="name"),
    PageType.ARTISTS: RowSpec(
        "artists", "<HHIBB", ("subtype", "index_shift", "id", "_", "_"),
        long_name=(0x09, 0x0A),
    ),
    PageType.ALBUMS: RowSpec(
        "albums", "<HHIIIIBB",
        ("subtype", "index_shift", "_", "artist_id", "id", "_", "_", "_"),
        long_name=(0x15, 0x16),
    ),
    PageType.LABELS: RowSpec("labels", "<I", ("id",), inline="name"),
    PageType.KEYS: RowSpec("keys", "<II", ("id", "id2"), inline="name"),
    PageType.COLORS: RowSpec("colors", "<5xHx", ("id",), inline="name"),
    PageType.PLAYLIST_TREE: RowSpec(
        "playlist_tree", "<I4xIII", ("parent_id", "sort_order", "id", "raw_is_folder"),
        inline="name",
    ),
    PageType.PLAYLIST_ENTRIES: RowSpec(
        "playlist_entries", "<III", ("entry_index", "track_id", "playlist_id")
    ),
    PageType.HISTORY_PLAYLISTS: RowSpec("history_playlists", "<I", ("id",), inline="name"),
    PageType.HISTORY_ENTRIES: RowSpec(
        "history_entries", "<III", ("track_id", "playlist_id", "entry_index")
    ),
    PageType.ARTWORK: RowSpec("artwork", "<I", ("id",), inline="path"),
}

EXT_ROW_SPECS: dict[int, RowSpec] = {
    ExtPageType.TAGS: RowSpec(
        "tags", "<HH8xIIIIxBB",
        ("subtype", "tag_index", "category", "category_pos", "id", "raw_is_category", "_", "_"),
        long_name=(0x1D, 0x1E),
    ),
    ExtPageType.TAG_TRACKS: RowSpec("tag_tracks", "<4xII4x", ("track_id", "tag_id")),
}


def parse_row(page: bytes, row_base: int, spec: RowSpec) -> dict:
    """Decode one row of ``spec``, ``row_base`` bytes into a page image."""
    if row_base + spec.fixed_len > len(page):
        raise PdbError(f"{spec.table} row at {row_base} runs past the end of the page")
    values = struct.unpack_from(spec.fmt, page, row_base)
    row: dict = {}
    for name, value in zip(spec.fields, values, strict=True):
        if name == "_":
            continue
        # The format stores these as counts; only their nonzero-ness matters.
        if name in ("raw_is_folder", "raw_is_category"):
            row[name.removeprefix("raw_")] = bool(value)
        else:
            row[name] = value

    if spec.long_name:
        near, far = spec.long_name
        if row.get("subtype", 0) & 0x04:
            (offset,) = struct.unpack_from("<H", page, row_base + far)
        else:
            offset = page[row_base + near]
        row["name"] = read_string(page, row_base + offset)
    elif spec.indexed:
        offsets = struct.unpack_from(f"<{len(spec.indexed)}H", page, row_base + spec.fixed_len)
        for name, offset in zip(spec.indexed, offsets, strict=True):
            row[name] = read_string(page, row_base + offset)
    elif spec.inline:
        row[spec.inline] = read_string(page, row_base + spec.fixed_len)
    return row


# -- pages -----------------------------------------------------------------


@dataclass
class Page:
    """One parsed page: its header, and where the rows it holds begin."""

    index: int
    type: int
    next_page: int
    page_flags: int
    num_row_offsets: int
    num_rows: int
    row_offsets: list[int] = field(default_factory=list)

    @property
    def is_data_page(self) -> bool:
        """Pages with bit 0x40 set hold allocation bookkeeping, not rows."""
        return self.page_flags & 0x40 == 0


def parse_page(image: bytes, page_size: int) -> Page:
    """Parse a page header and walk its row index backwards from the end.

    Only the offsets of *present* rows are collected: a cleared presence bit
    means the row was deleted, and its bytes are no longer valid to decode.
    """
    if len(image) < PAGE_HEADER_LEN:
        raise PdbError("page is shorter than its own header")
    _gap, index, page_type, next_page, _sequence = struct.unpack_from("<5I", image, 0)
    # A 24-bit little-endian bitfield: 13 bits of offsets, then 11 of live rows.
    packed = int.from_bytes(image[0x18:0x1B], "little")
    page = Page(
        index=index,
        type=page_type,
        next_page=next_page,
        page_flags=image[0x1B],
        num_row_offsets=packed & 0x1FFF,
        num_rows=(packed >> 13) & 0x7FF,
    )
    if not page.is_data_page or not page.num_row_offsets:
        return page

    groups = (page.num_row_offsets - 1) // ROWS_PER_GROUP + 1
    for group in range(groups):
        base = page_size - group * ROW_GROUP_STRIDE
        if base - (6 + 2 * (ROWS_PER_GROUP - 1)) < PAGE_HEADER_LEN:
            raise PdbError(f"page {index}: the row index overruns the page heap")
        (present,) = struct.unpack_from("<H", image, base - 4)
        for slot in range(ROWS_PER_GROUP):
            if group * ROWS_PER_GROUP + slot >= page.num_row_offsets:
                break
            if not present >> slot & 1:
                continue
            (offset,) = struct.unpack_from("<H", image, base - (6 + 2 * slot))
            page.row_offsets.append(PAGE_HEADER_LEN + offset)
    return page


@dataclass(frozen=True)
class Table:
    """A table header from page 0: a row type, and the pages holding it."""

    type: int
    first_page: int
    last_page: int


# -- the file --------------------------------------------------------------


class PdbFile:
    """A legacy DeviceSQL export, opened read-only.

    Accepts the ``export.pdb`` file itself or the root of a device tree. Pass
    ``ext=True`` -- or point it at a file named ``exportExt.pdb``, which does
    that for you -- to read the extension database, whose table numbering has
    nothing to do with the main one's.

    The surface deliberately mirrors :class:`onelibrary.db.OneLibraryDB`
    (``tables``, ``columns``, ``row_count``, ``rows``, ``schema_sql``,
    ``close``) so that a caller which only wants to read a library does not
    have to care which of the two formats a device carries.
    """

    def __init__(self, path: str | Path, *, ext: bool | None = None):
        path = Path(path)
        if path.is_dir():
            path = path / (EXPORT_EXT_PDB_RELPATH if ext else EXPORT_PDB_RELPATH)
        if not path.exists():
            raise FileNotFoundError(path)
        self.path = path
        self.ext = path.name.lower() == "exportext.pdb" if ext is None else ext
        self.data = path.read_bytes()
        self._specs = EXT_ROW_SPECS if self.ext else ROW_SPECS
        self._enum = ExtPageType if self.ext else PageType
        self._read_header()

    def _read_header(self) -> None:
        if len(self.data) < 0x1C:
            raise PdbError(f"{self.path}: too short to be a DeviceSQL export")
        zero, page_size, num_tables, _unused, _u1, _sequence, gap = struct.unpack_from(
            "<7I", self.data, 0
        )
        if zero != 0 or gap != 0:
            raise PdbError(f"{self.path}: not a DeviceSQL export (header is not zeroed)")
        if not 0 < page_size <= MAX_PAGE_SIZE or len(self.data) % page_size:
            raise PdbError(f"{self.path}: implausible page size {page_size}")
        if 0x1C + num_tables * 16 > page_size:
            raise PdbError(f"{self.path}: {num_tables} tables do not fit in the header page")
        self.page_size = page_size
        self.page_count = len(self.data) // page_size

        self._tables: dict[int, Table] = {}
        for i in range(num_tables):
            type_, _empty, first, last = struct.unpack_from("<4I", self.data, 0x1C + i * 16)
            # A file may name one type twice; the first entry is the live one.
            self._tables.setdefault(type_, Table(type_, first, last))

    # -- introspection ---------------------------------------------------

    def page(self, index: int) -> Page:
        if not 0 <= index < self.page_count:
            raise PdbError(f"page {index} lies outside a {self.page_count}-page file")
        start = index * self.page_size
        return parse_page(self.data[start : start + self.page_size], self.page_size)

    def table_name(self, type_: int) -> str:
        """A stable name for a table type, whether or not it can be read."""
        spec = self._specs.get(type_)
        if spec:
            return spec.table
        try:
            return self._enum(type_).name.lower()
        except ValueError:
            return f"type_{type_}"

    def tables(self) -> list[str]:
        """Names of the tables this file declares, in header order."""
        return [self.table_name(t) for t in self._tables]

    def readable_tables(self) -> list[str]:
        """The subset of :meth:`tables` whose row layout is known."""
        return [self.table_name(t) for t in self._tables if t in self._specs]

    def columns(self, table: str) -> list[dict]:
        """Column metadata for ``table``, shaped like ``OneLibraryDB.columns``."""
        return [
            {"name": c, "type": "", "notnull": False, "default": None, "pk": 0}
            for c in self._spec_for(table).columns
        ]

    def _type_for(self, table: str) -> int:
        for type_ in self._tables:
            if self.table_name(type_) == table:
                return type_
        raise PdbError(f"no table named {table!r} in {self.path.name}")

    def _spec_for(self, table: str) -> RowSpec:
        spec = self._specs.get(self._type_for(table))
        if spec is None:
            raise PdbError(f"the row layout of table {table!r} is not known")
        return spec

    # -- rows ------------------------------------------------------------

    def _pages(self, type_: int) -> Iterator[Page]:
        """Walk a table's linked list of pages.

        Stops at the declared last page, at a page belonging to some other
        table, or at a link that leaves the file -- the last of which is how an
        empty table is written, its ``next_page`` pointing past the end.
        """
        table = self._tables[type_]
        seen: set[int] = set()
        index = table.first_page
        while 0 <= index < self.page_count and index not in seen:
            seen.add(index)
            page = self.page(index)
            if page.type != type_:
                return
            yield page
            if index == table.last_page:
                return
            index = page.next_page

    def rows(self, table: str, limit: int | None = None) -> Iterator[dict]:
        """Yield every present row of ``table`` as a dict."""
        spec = self._spec_for(table)
        type_ = self._type_for(table)
        count = 0
        for page in self._pages(type_):
            if not page.is_data_page:
                continue
            start = page.index * self.page_size
            image = self.data[start : start + self.page_size]
            for offset in page.row_offsets:
                yield parse_row(image, offset, spec)
                count += 1
                if limit is not None and count >= limit:
                    return

    def row_count(self, table: str) -> int:
        """Count the present rows of ``table`` without decoding them.

        Works for tables whose row layout is unknown, which is the point: an
        unreadable table with rows in it is worth knowing about.
        """
        return sum(
            len(p.row_offsets) for p in self._pages(self._type_for(table)) if p.is_data_page
        )

    def schema_sql(self) -> str:
        """The row layouts as CREATE statements, for symmetry with OneLibrary.

        DeviceSQL carries no schema of its own -- the layouts are fixed by the
        format and live in this reader -- so what comes back describes what can
        be decoded, and is not something read out of the file.
        """
        out = [
            f"-- DeviceSQL export {self.path.name}: "
            f"{self.page_count} pages of {self.page_size} bytes.",
            "-- Row layouts are fixed by the format; these statements describe what",
            "-- this reader decodes, and are not stored anywhere in the file.",
        ]
        for type_ in self._tables:
            name = self.table_name(type_)
            spec = self._specs.get(type_)
            if spec is None:
                out.append(f"-- table {name}: row layout unknown")
                continue
            cols = ",\n".join(f"    {c}" for c in spec.columns)
            out.append(f"CREATE TABLE {name} (\n{cols}\n);")
        return "\n".join(out)

    # -- lifecycle -------------------------------------------------------

    def close(self) -> None:
        """Present for symmetry with ``OneLibraryDB``; nothing is held open."""

    def __enter__(self) -> PdbFile:
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"<PdbFile {self.path.name} pages={self.page_count} tables={len(self._tables)}>"
