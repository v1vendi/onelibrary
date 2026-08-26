"""Reading the legacy DeviceSQL export, against a file built in the tests.

The fixture is assembled by ``pdb_fixture``; see its docstring for what the
library contains and which corners of the format it is shaped to exercise.
"""

from __future__ import annotations

import struct

import pytest

from onelibrary.pdb import (
    PAGE_HEADER_LEN,
    ExtPageType,
    PageType,
    PdbError,
    PdbFile,
    parse_page,
    read_string,
)
from tests import pdb_fixture as fx


@pytest.fixture
def pdb_path(tmp_path):
    p = tmp_path / "export.pdb"
    p.write_bytes(fx.sample_pdb())
    return p


@pytest.fixture
def pdb(pdb_path):
    return PdbFile(pdb_path)


@pytest.fixture
def ext_pdb(tmp_path):
    p = tmp_path / "exportExt.pdb"
    p.write_bytes(fx.sample_ext_pdb())
    return PdbFile(p)


def by_id(rows):
    return {r["id"]: r for r in rows}


# -- strings ---------------------------------------------------------------


@pytest.mark.parametrize(
    "encode,text",
    [
        (fx.short_ascii, ""),
        (fx.short_ascii, "a"),
        (fx.short_ascii, "Kevin MacLeod"),
        (fx.short_ascii, "x" * 126),
        (fx.long_ascii, ""),
        (fx.long_ascii, "/Contents/Kevin MacLeod/Funkorama/coldfunk.mp3"),
        (fx.long_utf16, "Café Mix"),
        (fx.long_utf16, "アルファ"),
    ],
)
def test_reads_every_string_encoding(encode, text):
    page = b"\x00" * 16 + encode(text) + b"\x00" * 16
    assert read_string(page, 16) == text


def test_string_offset_outside_the_page_is_an_error():
    with pytest.raises(PdbError, match="outside the page"):
        read_string(b"\x00" * 8, 99)


def test_a_string_running_past_the_page_is_an_error():
    # A long string whose declared length reaches beyond the bytes it has.
    page = b"\x40" + struct.pack("<H", 4096) + b"\x00" + b"body"
    with pytest.raises(PdbError, match="claims"):
        read_string(page, 0)


# -- the file header -------------------------------------------------------


def test_rejects_a_file_that_is_not_devicesql(tmp_path):
    p = tmp_path / "export.pdb"
    p.write_bytes(b"SQLite format 3\x00" + b"\x00" * 4096)
    with pytest.raises(PdbError, match="not a DeviceSQL export"):
        PdbFile(p)


def test_rejects_an_implausible_page_size(tmp_path):
    p = tmp_path / "export.pdb"
    p.write_bytes(struct.pack("<7I", 0, 7, 0, 0, 0, 0, 0) + b"\x00" * 4096)
    with pytest.raises(PdbError, match="implausible page size"):
        PdbFile(p)


def test_missing_file(tmp_path):
    with pytest.raises(FileNotFoundError):
        PdbFile(tmp_path / "nope.pdb")


def test_opens_a_device_tree(tmp_path):
    root = tmp_path / "USB"
    (root / "PIONEER" / "rekordbox").mkdir(parents=True)
    (root / "PIONEER" / "rekordbox" / "export.pdb").write_bytes(fx.sample_pdb())
    assert PdbFile(root).row_count("tracks") == 3


def test_reports_its_geometry(pdb):
    assert pdb.page_size == 4096
    assert pdb.page_count * 4096 == len(pdb.data)
    assert "export.pdb" in repr(pdb)


# -- tables ----------------------------------------------------------------


def test_lists_the_tables_it_declares(pdb):
    assert set(pdb.tables()) >= {
        "tracks", "artists", "albums", "genres", "keys", "labels", "colors",
        "artwork", "playlist_tree", "playlist_entries",
    }


def test_names_a_declared_table_it_cannot_read(pdb):
    assert "columns" in pdb.tables()
    assert "columns" not in pdb.readable_tables()


def test_counts_rows_of_a_table_it_cannot_read(pdb):
    """Counting needs only the row index, so it works without a layout."""
    assert pdb.row_count("columns") == 1
    with pytest.raises(PdbError, match="row layout"):
        list(pdb.rows("columns"))


def test_an_unknown_table_name(pdb):
    with pytest.raises(PdbError, match="no table named"):
        pdb.row_count("nonesuch")


# -- rows ------------------------------------------------------------------


def test_reads_tracks_across_a_page_chain(pdb):
    """Three tracks: two on one page, a third on the page it links to."""
    tracks = by_id(pdb.rows("tracks"))
    assert sorted(tracks) == [1, 2, 3]
    assert tracks[3]["title"] == "Gamma Track"


def test_skips_the_deleted_row(pdb):
    """The deleted row keeps its index slot; only its presence bit is clear."""
    page = pdb.page(2)
    assert page.num_row_offsets == 3
    assert page.num_rows == 2
    assert len(page.row_offsets) == 2


def test_skips_a_non_data_page_at_the_head_of_a_chain(pdb):
    assert not pdb.page(1).is_data_page
    assert pdb.page(2).is_data_page


def test_decodes_track_fields(pdb):
    track = by_id(pdb.rows("tracks"))[1]
    assert track["title"] == "Alpha Track"
    assert track["tempo"] == 12800
    assert track["rating"] == 5
    assert track["duration"] == 181
    assert track["year"] == 2019
    assert track["file_size"] == 4_331_520
    assert track["artist_id"] == 1
    assert track["album_id"] == 1
    assert track["comment"] == "opener"
    assert track["filename"] == "cipher.mp3"
    assert track["analyze_path"].endswith("ANLZ0000.DAT")


def test_decodes_long_track_strings(pdb):
    """A path too long for the compact form, and a name outside ASCII."""
    tracks = by_id(pdb.rows("tracks"))
    assert tracks[2]["title"] == "Beta Track (Café Mix)"
    assert tracks[2]["file_path"] == "/Contents/Kevin MacLeod/Funkorama/coldfunk.mp3"
    assert tracks[2]["mix_name"] == "Café Mix"
    assert tracks[3]["file_path"].endswith("electrodoodle.mp3")


def test_reads_both_near_and_far_name_offsets(pdb):
    """Bit 0x04 of subtype moves the name offset from one byte to two."""
    artists = by_id(pdb.rows("artists"))
    assert artists[1]["name"] == "Kevin MacLeod"
    assert artists[1]["subtype"] & 0x04 == 0
    assert artists[2]["name"] == "Kevin MacLeod & Friends"
    assert artists[2]["subtype"] & 0x04 == 0x04


def test_reads_the_lookup_tables(pdb):
    assert by_id(pdb.rows("albums"))[1] == {
        "subtype": 0x80, "index_shift": 0x20, "artist_id": 1, "id": 1,
        "name": "Electronic Light",
    }
    assert by_id(pdb.rows("genres"))[1]["name"] == "Electronic"
    assert by_id(pdb.rows("keys"))[1]["name"] == "8A"
    assert by_id(pdb.rows("labels"))[1]["name"] == "Incompetech"
    assert by_id(pdb.rows("colors"))[1]["name"] == "Pink"
    assert by_id(pdb.rows("artwork"))[1]["path"] == "/PIONEER/Artwork/00001.jpg"


def test_reads_the_playlist_tree(pdb):
    tree = by_id(pdb.rows("playlist_tree"))
    assert tree[1]["is_folder"] is True
    assert tree[2] == {
        "parent_id": 1, "sort_order": 1, "id": 2, "is_folder": False, "name": "Warm Up",
    }


def test_reads_playlist_entries_in_position_order(pdb):
    entries = sorted(pdb.rows("playlist_entries"), key=lambda r: r["entry_index"])
    assert [e["track_id"] for e in entries] == [1, 3, 2]
    assert {e["playlist_id"] for e in entries} == {2}


def test_reads_history(pdb):
    assert by_id(pdb.rows("history_playlists"))[1]["name"] == "HISTORY 001"
    assert list(pdb.rows("history_entries")) == [
        {"track_id": 1, "playlist_id": 1, "entry_index": 1}
    ]


def test_limit_stops_early(pdb):
    assert len(list(pdb.rows("tracks", limit=2))) == 2


def test_columns_match_the_rows_that_come_back(pdb):
    for table in pdb.readable_tables():
        row = next(iter(pdb.rows(table, limit=1)), None)
        if row is None:
            continue
        assert [c["name"] for c in pdb.columns(table)] == list(row)


# -- the extension database ------------------------------------------------


def test_reads_my_tags_from_exportext(ext_pdb):
    assert ext_pdb.ext
    tags = by_id(ext_pdb.rows("tags"))
    assert tags[1]["is_category"] is True
    assert tags[1]["name"] == "Situation"
    assert tags[2]["name"] == "Peak Time"
    assert tags[2]["category"] == 1


def test_reads_tag_assignments(ext_pdb):
    assert sorted((r["track_id"], r["tag_id"]) for r in ext_pdb.rows("tag_tracks")) == [
        (1, 2), (3, 3)
    ]


def test_the_two_files_number_their_tables_differently(pdb, ext_pdb):
    """Type 3 is albums in export.pdb and tags in exportExt.pdb."""
    assert pdb.table_name(PageType.ALBUMS) == "albums"
    assert ext_pdb.table_name(ExtPageType.TAGS) == "tags"


def test_ext_is_inferred_from_the_filename(tmp_path):
    p = tmp_path / "exportExt.pdb"
    p.write_bytes(fx.sample_ext_pdb())
    assert PdbFile(p).ext


# -- pages -----------------------------------------------------------------


def test_a_row_index_that_overruns_the_heap_is_an_error():
    """A page claiming more rows than its index could hold must not be read."""
    page = bytearray(fx.build_page(1, PageType.TRACKS, 0xFFFFFFFF, []))
    page[0x18:0x1B] = (4096).to_bytes(3, "little")
    with pytest.raises(PdbError, match="overruns"):
        parse_page(bytes(page), 4096)


def test_a_page_shorter_than_its_header_is_an_error():
    with pytest.raises(PdbError, match="shorter than"):
        parse_page(b"\x00" * 8, 4096)


def test_a_page_outside_the_file(pdb):
    with pytest.raises(PdbError, match="outside"):
        pdb.page(pdb.page_count)


def test_row_offsets_are_relative_to_the_end_of_the_page_header(pdb):
    assert all(o >= PAGE_HEADER_LEN for o in pdb.page(2).row_offsets)


# -- schema ----------------------------------------------------------------


def test_schema_describes_what_it_can_and_cannot_read(pdb):
    sql = pdb.schema_sql()
    assert "CREATE TABLE tracks (" in sql
    assert "    analyze_path" in sql
    assert "-- table columns: row layout unknown" in sql


def test_closing_is_a_no_op(pdb_path):
    with PdbFile(pdb_path) as f:
        assert f.row_count("tracks") == 3
