"""Writing OneLibrary databases.

The important property is not that a written database is readable by us -- it
is that it is shaped exactly like one rekordbox wrote. Schema drift is the
failure mode that produces a device a player silently refuses.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from onelibrary import defaults
from onelibrary.db import OneLibraryDB
from onelibrary.writer import (
    Library,
    LibraryWriter,
    Playlist,
    Track,
    create_database,
    write_device,
)

KEY = "a" * 64
SCHEMA_SQL = Path(__file__).parent.parent / "spec" / "schema.sql"


@pytest.fixture
def written(tmp_path):
    db = tmp_path / "exportLibrary.db"
    conn = create_database(db, KEY)
    t1 = Track(
        title="Alpha", path="/Contents/A/alpha.mp3", artist="Aphex", album="SAW",
        genre="Ambient", key="Gm", label="Warp", bpmx100=12400, length=300,
        rating=5, color_id=3,
        analysis_path="/PIONEER/USBANLZ/P001/00000001/ANLZ0000.DAT",
    )
    t2 = Track(title="Beta", path="/Contents/B/beta.mp3", artist="Orbital", bpmx100=13000)
    t3 = Track(title="Gamma", path="/Contents/C/gamma.mp3", artist="Aphex", album="SAW")
    lib = Library(
        tracks=[t1, t2, t3],
        playlists=[Playlist(name="Set 1", tracks=[t2, t1])],
        device_name="TESTUSB",
        master_db_id=12345,
    )
    LibraryWriter(conn).write_library(lib)
    conn.close()
    return db


def test_refuses_to_clobber(tmp_path):
    db = tmp_path / "x.db"
    create_database(db, KEY).close()
    with pytest.raises(FileExistsError):
        create_database(db, KEY)
    create_database(db, KEY, overwrite=True).close()  # explicit overwrite is fine


def test_generated_schema_matches_rekordbox(written):
    """Column names and order must match the captured reference exactly."""
    reference = {}
    for m in re.finditer(r"CREATE TABLE (\w+)\((.*?)\);", SCHEMA_SQL.read_text(), re.S):
        reference[m.group(1)] = [c.strip().split()[0] for c in m.group(2).split(",") if c.strip()]

    with OneLibraryDB(written, KEY) as db:
        assert set(db.tables()) == set(reference)
        for table, expected in reference.items():
            assert [c["name"] for c in db.columns(table)] == expected, table


def test_writes_browse_defaults(written):
    with OneLibraryDB(written, KEY) as db:
        assert db.row_count("menuItem") == len(defaults.MENU_ITEMS)
        assert db.row_count("category") == len(defaults.CATEGORIES)
        assert db.row_count("sort") == len(defaults.SORT_OPTIONS)
        assert db.row_count("color") == 8


def test_localisation_markers_survive(written):
    """menuItem names carry U+FFFA/U+FFFB so the player localises them."""
    with OneLibraryDB(written, KEY) as db:
        names = [r["name"] for r in db.rows("menuItem")]
    assert all(n.startswith("￺") and n.endswith("￻") for n in names)


def test_track_fields_round_trip(written):
    with OneLibraryDB(written, KEY) as db:
        rows = {r["title"]: dict(r) for r in db.rows("content")}
    alpha = rows["Alpha"]
    assert alpha["bpmx100"] == 12400
    assert alpha["rating"] == 5
    assert alpha["color_id"] == 3
    assert alpha["length"] == 300
    assert alpha["fileName"] == "alpha.mp3"
    assert alpha["masterDbId"] == 12345


def test_analysed_bits_only_when_analysis_present(written):
    with OneLibraryDB(written, KEY) as db:
        rows = {r["title"]: dict(r) for r in db.rows("content")}
    assert rows["Alpha"]["analysedBits"] == 41
    assert rows["Beta"]["analysedBits"] is None


def test_lookup_tables_are_interned(written):
    """Two tracks by the same artist must share one artist row."""
    with OneLibraryDB(written, KEY) as db:
        artists = [r["name"] for r in db.rows("artist")]
        albums = [r["name"] for r in db.rows("album")]
    assert sorted(artists) == ["Aphex", "Orbital"]
    assert albums == ["SAW"]


def test_playlist_membership_is_ordered(written):
    with OneLibraryDB(written, KEY) as db:
        rows = sorted(db.rows("playlist_content"), key=lambda r: r["sequenceNo"])
        order = [(r["content_id"], r["sequenceNo"]) for r in rows]
    assert order == [(2, 1), (1, 2)], "playlist order must be preserved, not track order"


def test_property_row(written):
    with OneLibraryDB(written, KEY) as db:
        prop = dict(list(db.rows("property"))[0])
    assert prop["deviceName"] == "TESTUSB"
    assert prop["dbVersion"] == defaults.DB_VERSION
    assert prop["numberOfContents"] == 3


def test_write_device_places_db_canonically(tmp_path):
    lib = Library(tracks=[Track(title="X", path="/Contents/x.mp3")])
    out = write_device(tmp_path, lib, KEY)
    assert out == tmp_path / "PIONEER" / "rekordbox" / "exportLibrary.db"
    assert out.exists()


def test_wrong_key_cannot_read_what_we_wrote(written):
    from onelibrary.db import NotEncryptedError

    with pytest.raises(NotEncryptedError):
        OneLibraryDB(written, "b" * 64)


@pytest.mark.parametrize("field,value", [("rating", 0), ("bpmx100", None), ("color_id", None)])
def test_optional_fields_accept_empty(tmp_path, field, value):
    db = tmp_path / "e.db"
    conn = create_database(db, KEY)
    t = Track(title="T", path="/Contents/t.mp3", **{field: value})
    LibraryWriter(conn).write_library(Library(tracks=[t]))
    conn.close()
    with OneLibraryDB(db, KEY) as r:
        assert r.row_count("content") == 1
