"""Applying change-sets produced by the browser viewer.

The guard that matters: a change-set carries the value the browser saw, and
applying it must refuse where the device has since moved on rather than
silently overwriting someone else's edit.
"""

from __future__ import annotations

import json

import pytest

from onelibrary.cli import main
from onelibrary.db import OneLibraryDB
from onelibrary.writer import Library, Track, write_device

KEY = "c" * 64


@pytest.fixture
def device(tmp_path, monkeypatch):
    monkeypatch.setenv("ONELIBRARY_KEY", KEY)
    lib = Library(
        tracks=[
            Track(title="One", path="/Contents/1.mp3", artist="A", genre="Techno", rating=0),
            Track(title="Two", path="/Contents/2.mp3", artist="B", rating=5),
        ],
        playlists=[],
    )
    write_device(tmp_path, lib, KEY)
    return tmp_path


def changeset(tmp_path, edits):
    p = tmp_path / "edits.json"
    p.write_text(json.dumps({"format": "onelibrary-changeset", "version": 1, "edits": edits}))
    return str(p)


def content(device):
    with OneLibraryDB(device, KEY) as db:
        genres = {r["genre_id"]: r["name"] for r in db.rows("genre")}
        artists = {r["artist_id"]: r["name"] for r in db.rows("artist")}
        return {
            r["content_id"]: dict(r) | {
                "_genre": genres.get(r["genre_id"]),
                "_artist": artists.get(r["artist_id_artist"]),
            }
            for r in db.rows("content")
        }


def test_applies_simple_fields(device, tmp_path):
    cs = changeset(tmp_path, [{
        "content_id": 1, "title": "One",
        "fields": {"rating": {"from": 0, "to": 4}, "djComment": {"from": None, "to": "banger"}},
    }])
    assert main(["apply", cs, str(device)]) == 0
    row = content(device)[1]
    assert row["rating"] == 4
    assert row["djComment"] == "banger"


def test_title_updates_search_column(device, tmp_path):
    cs = changeset(tmp_path, [{
        "content_id": 1, "title": "One", "fields": {"title": {"from": "One", "to": "Renamed"}},
    }])
    main(["apply", cs, str(device)])
    row = content(device)[1]
    assert row["title"] == "Renamed"
    assert row["titleForSearch"] == "RENAMED"


def test_interns_a_new_lookup_value(device, tmp_path):
    cs = changeset(tmp_path, [{
        "content_id": 1, "title": "One", "fields": {"genre": {"from": "Techno", "to": "House"}},
    }])
    main(["apply", cs, str(device)])
    assert content(device)[1]["_genre"] == "House"


def test_reuses_an_existing_lookup_value(device, tmp_path):
    """Setting track 2's artist to track 1's must not create a duplicate row."""
    cs = changeset(tmp_path, [{
        "content_id": 2, "title": "Two", "fields": {"artist": {"from": "B", "to": "A"}},
    }])
    main(["apply", cs, str(device)])
    with OneLibraryDB(device, KEY) as db:
        names = [r["name"] for r in db.rows("artist")]
    assert sorted(names) == ["A", "B"]
    assert content(device)[2]["_artist"] == "A"


def test_clearing_a_lookup_sets_null(device, tmp_path):
    cs = changeset(tmp_path, [{
        "content_id": 1, "title": "One", "fields": {"genre": {"from": "Techno", "to": None}},
    }])
    main(["apply", cs, str(device)])
    assert content(device)[1]["genre_id"] is None


def test_refuses_when_the_device_moved_on(device, tmp_path, capsys):
    cs = changeset(tmp_path, [{
        "content_id": 2, "title": "Two", "fields": {"rating": {"from": 1, "to": 3}},
    }])
    assert main(["apply", cs, str(device)]) == 1, "a skipped change must be reported"
    assert content(device)[2]["rating"] == 5, "the device value must be left alone"
    assert "skip" in capsys.readouterr().err


def test_force_overrides_the_guard(device, tmp_path):
    cs = changeset(tmp_path, [{
        "content_id": 2, "title": "Two", "fields": {"rating": {"from": 1, "to": 3}},
    }])
    assert main(["apply", cs, str(device), "--force"]) == 0
    assert content(device)[2]["rating"] == 3


def test_rejects_a_foreign_file(device, tmp_path, capsys):
    p = tmp_path / "other.json"
    p.write_text(json.dumps({"format": "something-else"}))
    assert main(["apply", str(p), str(device)]) == 1
    assert "not a OneLibrary change-set" in capsys.readouterr().err
