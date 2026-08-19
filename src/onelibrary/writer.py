"""Create and modify OneLibrary databases.

Two things a writer can do, and they are worth separating:

**Modify an existing export.** Read a device rekordbox produced, change track
metadata, ratings, colours, playlists or cues, and write it back. Everything
needed for this is here and round-trip tested.

**Build a device from nothing.** Only partly possible. The database side is
complete -- :func:`create_database` emits rekordbox's exact schema and
:class:`LibraryWriter` populates every table. What cannot be synthesised is the
*analysis*: beatgrids and waveforms live in ANLZ files (see
``spec/ONELIBRARY.md`` §4.5-4.6), and producing them from raw audio means beat
detection and waveform generation -- reimplementing rekordbox's analysis
engine, which this project does not attempt. A device built from scratch
therefore carries no beatgrid and no waveform, and players will show a flat
line. Copy the ANLZ files from a rekordbox export to get real analysis.

Cues are the exception: they live in ANLZ but are cheap to *edit*, because the
cue sections can be rewritten in place without touching the analysis. See
:mod:`onelibrary.anlz_write`.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from onelibrary import defaults
from onelibrary.db import EXPORT_DB_RELPATH, open_encrypted
from onelibrary.keys import resolve_key
from sqlalchemy.schema import CreateTable

from onelibrary.schema import Base

try:
    import sqlcipher3 as _sqlcipher
except ImportError as exc:  # pragma: no cover
    raise ImportError("pip install sqlcipher3-wheels") from exc


def _quote(passphrase: str) -> str:
    return "'" + passphrase.replace("'", "''") + "'"


def create_database(path: str | Path, key: str, *, overwrite: bool = False):
    """Create an empty, correctly-shaped OneLibrary database.

    Uses SQLCipher 4 defaults, matching rekordbox: AES-256-CBC, 4096-byte
    pages, 80 reserved bytes, PBKDF2-HMAC-SHA512 at 256,000 iterations. These
    are the library's defaults, so no cipher pragmas are issued -- setting them
    explicitly is how implementations accidentally diverge.

    The schema comes from :mod:`onelibrary.schema`, which a test pins against
    ``spec/schema.sql`` captured from a real export, so the emitted DDL matches
    rekordbox's column-for-column.
    """
    path = Path(path)
    if path.exists():
        if not overwrite:
            raise FileExistsError(path)
        path.unlink()
    path.parent.mkdir(parents=True, exist_ok=True)

    conn = _sqlcipher.connect(str(path))
    conn.execute(f"PRAGMA key = {_quote(key)}")
    for table in Base.metadata.sorted_tables:
        conn.execute(str(CreateTable(table)).strip())
    conn.commit()
    return conn


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------


@dataclass
class Track:
    """A track to write. Only ``title`` and ``path`` are strictly required."""

    title: str
    path: str
    artist: str | None = None
    album: str | None = None
    genre: str | None = None
    label: str | None = None
    key: str | None = None
    #: 1-8, indexing :data:`onelibrary.defaults.COLORS`.
    color_id: int | None = None
    #: 0-5 stars.
    rating: int = 0
    #: Tempo in centi-BPM: 12400 is 124.00 BPM.
    bpmx100: int | None = None
    #: Duration in whole seconds.
    length: int | None = None
    bitrate: int | None = None
    file_size: int | None = None
    #: 1 for MP3. Other values unconfirmed.
    file_type: int = 1
    dj_comment: str | None = None
    #: Device-relative path to the ANLZ ``.DAT``. Without it, no analysis.
    analysis_path: str | None = None
    master_content_id: int | None = None
    content_id: int | None = None


@dataclass
class Playlist:
    name: str
    tracks: list[Track] = field(default_factory=list)
    parent: "Playlist | None" = None
    playlist_id: int | None = None


@dataclass
class Library:
    """Everything a device holds."""

    tracks: list[Track] = field(default_factory=list)
    playlists: list[Playlist] = field(default_factory=list)
    device_name: str = ""
    master_db_id: int | None = None
    created: str | None = None


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


class LibraryWriter:
    """Populate a OneLibrary database from a :class:`Library`."""

    def __init__(self, conn):
        self.conn = conn
        self._lookup_cache: dict[tuple[str, str], int] = {}

    def _lookup_id(self, table: str, id_col: str, name: str | None) -> int | None:
        """Intern a name into a lookup table, returning its id.

        Lookup tables hold only the values the exported tracks actually use, so
        ids are allocated on demand rather than from a fixed enumeration.
        """
        if not name:
            return None
        cached = self._lookup_cache.get((table, name))
        if cached:
            return cached
        row = self.conn.execute(
            f'SELECT {id_col} FROM "{table}" WHERE name = ?', (name,)
        ).fetchone()
        if row:
            new_id = row[0]
        else:
            row = self.conn.execute(f'SELECT COALESCE(MAX({id_col}), 0) FROM "{table}"').fetchone()
            new_id = row[0] + 1
            self.conn.execute(f'INSERT INTO "{table}" ({id_col}, name) VALUES (?, ?)', (new_id, name))
        self._lookup_cache[(table, name)] = new_id
        return new_id

    def write_defaults(self) -> None:
        """Write the browse configuration and colour palette."""
        self.conn.executemany("INSERT INTO menuItem VALUES (?,?,?)", defaults.MENU_ITEMS)
        self.conn.executemany("INSERT INTO category VALUES (?,?,?,?)", defaults.CATEGORIES)
        self.conn.executemany("INSERT INTO sort VALUES (?,?,?,?,?)", defaults.SORT_OPTIONS)
        self.conn.executemany("INSERT INTO color VALUES (?,?)", defaults.COLORS)
        self.conn.executemany(
            "INSERT INTO myTag (myTag_id, sequenceNo, name, attribute, myTag_id_parent) "
            "VALUES (?,?,?,?,0)",
            [(i, seq, name, defaults.MYTAG_FOLDER) for i, seq, name in defaults.MYTAG_ROOTS],
        )

    def write_library(self, library: Library) -> None:
        self.write_defaults()

        for n, track in enumerate(library.tracks, start=1):
            if track.content_id is None:
                track.content_id = n
            self.conn.execute(
                """INSERT INTO content (
                       content_id, title, titleForSearch, bpmx100, length,
                       artist_id_artist, album_id, genre_id, label_id, key_id,
                       color_id, rating, djComment, path, fileName, fileSize,
                       fileType, bitrate, masterDbId, masterContentId,
                       analysisDataFilePath, analysedBits
                   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    track.content_id,
                    track.title,
                    (track.title or "").upper(),
                    track.bpmx100,
                    track.length,
                    self._lookup_id("artist", "artist_id", track.artist),
                    self._album_id(track.album),
                    self._lookup_id("genre", "genre_id", track.genre),
                    self._lookup_id("label", "label_id", track.label),
                    self._lookup_id("key", "key_id", track.key),
                    track.color_id,
                    track.rating,
                    track.dj_comment,
                    track.path,
                    Path(track.path).name if track.path else None,
                    track.file_size,
                    track.file_type,
                    track.bitrate,
                    library.master_db_id,
                    track.master_content_id,
                    track.analysis_path,
                    41 if track.analysis_path else None,
                ),
            )

        for n, playlist in enumerate(library.playlists, start=1):
            if playlist.playlist_id is None:
                playlist.playlist_id = n
            self.conn.execute(
                "INSERT INTO playlist (playlist_id, sequenceNo, name, attribute, "
                "playlist_id_parent) VALUES (?,?,?,0,?)",
                (playlist.playlist_id, n, playlist.name,
                 playlist.parent.playlist_id if playlist.parent else 0),
            )
            self.conn.executemany(
                "INSERT INTO playlist_content VALUES (?,?,?)",
                [(playlist.playlist_id, t.content_id, i)
                 for i, t in enumerate(playlist.tracks, start=1)],
            )

        self.conn.execute(
            "INSERT INTO property (deviceName, dbVersion, numberOfContents, "
            "createdDate, backGroundColorType, myTagMasterDBID) VALUES (?,?,?,?,0,0)",
            (
                library.device_name,
                defaults.DB_VERSION,
                len(library.tracks),
                library.created or date.today().isoformat(),
            ),
        )
        self.conn.commit()

    def _album_id(self, name: str | None) -> int | None:
        if not name:
            return None
        row = self.conn.execute("SELECT album_id FROM album WHERE name = ?", (name,)).fetchone()
        if row:
            return row[0]
        row = self.conn.execute("SELECT COALESCE(MAX(album_id), 0) FROM album").fetchone()
        new_id = row[0] + 1
        self.conn.execute(
            "INSERT INTO album (album_id, name, artist_id, image_id, isComplation, "
            "nameForSearch) VALUES (?,?,NULL,NULL,0,?)",
            (new_id, name, name.upper()),
        )
        return new_id


def write_device(root: str | Path, library: Library, key: str | None = None) -> Path:
    """Write a complete OneLibrary database into a device tree.

    Creates ``PIONEER/rekordbox/exportLibrary.db``. Does **not** copy audio or
    generate ANLZ analysis -- see the module docstring.
    """
    root = Path(root)
    db_path = root / EXPORT_DB_RELPATH
    key = key or resolve_key(allow_extract=False)
    conn = create_database(db_path, key, overwrite=True)
    LibraryWriter(conn).write_library(library)
    conn.close()
    return db_path


def copy_analysis(src_root: str | Path, dst_root: str | Path, library: Library) -> int:
    """Copy the ANLZ files a library references from one device tree to another.

    The practical way to get real beatgrids and waveforms onto a generated
    device, given that synthesising them is out of scope.
    """
    src_root, dst_root = Path(src_root), Path(dst_root)
    copied = 0
    for track in library.tracks:
        if not track.analysis_path:
            continue
        rel = track.analysis_path.lstrip("/")
        for suffix in (".DAT", ".EXT", ".2EX"):
            src = (src_root / rel).with_suffix(suffix)
            if not src.exists():
                continue
            dst = (dst_root / rel).with_suffix(suffix)
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            copied += 1
    return copied
