"""SQLAlchemy models for the OneLibrary ``exportLibrary.db`` schema.

Recovered by introspecting a real export written by rekordbox 7 (build
2025-10-22) and verified against the source ``master.db``. Column names and
types are reproduced exactly as rekordbox declares them -- **including its
typos** -- because a writer has to match them byte for byte:

- :attr:`Album.isComplation` -- rekordbox's spelling of "isCompilation"
- :attr:`Cue.OutFileOffsetInBlock` -- capitalised ``Out`` where every sibling
  field uses lowercase ``out``

The declared SQL types are only ``integer`` and ``varchar``; SQLite applies no
constraints beyond that, and no NOT NULL, DEFAULT, or FOREIGN KEY clauses are
declared anywhere in the schema. Relationships below are inferred from naming
and confirmed by data inspection, not enforced by the database.

See ``spec/ONELIBRARY.md`` for field semantics.
"""

from __future__ import annotations

from sqlalchemy import Integer, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

#: ``property.dbVersion`` value observed in exports from rekordbox 7.
KNOWN_DB_VERSION = "1000"


class Base(DeclarativeBase):
    pass


class Content(Base):
    """A track on the device.

    ``masterDbId`` / ``masterContentId`` link the row back to the desktop
    library it came from: ``masterContentId`` equals ``djmdContent.ID`` in
    ``master.db``, and ``masterDbId`` identifies the source library (constant
    across every row of one export). Verified: all 11 rows of a test export
    resolved to matching titles, ratings and BPM in the source database.
    """

    __tablename__ = "content"

    content_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    title: Mapped[str | None] = mapped_column(String)
    #: Case/accent-folded ``title`` used for on-player search.
    titleForSearch: Mapped[str | None] = mapped_column(String)
    subtitle: Mapped[str | None] = mapped_column(String)
    #: Tempo in centi-BPM: 12400 is 124.00 BPM. Matches ``djmdContent.BPM``.
    bpmx100: Mapped[int | None] = mapped_column(Integer)
    #: Duration in whole seconds.
    length: Mapped[int | None] = mapped_column(Integer)
    trackNo: Mapped[int | None] = mapped_column(Integer)
    discNo: Mapped[int | None] = mapped_column(Integer)
    artist_id_artist: Mapped[int | None] = mapped_column(Integer)
    artist_id_remixer: Mapped[int | None] = mapped_column(Integer)
    artist_id_originalArtist: Mapped[int | None] = mapped_column(Integer)
    artist_id_composer: Mapped[int | None] = mapped_column(Integer)
    artist_id_lyricist: Mapped[int | None] = mapped_column(Integer)
    album_id: Mapped[int | None] = mapped_column(Integer)
    genre_id: Mapped[int | None] = mapped_column(Integer)
    label_id: Mapped[int | None] = mapped_column(Integer)
    key_id: Mapped[int | None] = mapped_column(Integer)
    color_id: Mapped[int | None] = mapped_column(Integer)
    image_id: Mapped[int | None] = mapped_column(Integer)
    djComment: Mapped[str | None] = mapped_column(String)
    #: Star rating 0-5. Same scale as ``master.db`` -- *not* the 0/51/.../255
    #: encoding used elsewhere in the rekordbox ecosystem.
    rating: Mapped[int | None] = mapped_column(Integer)
    releaseYear: Mapped[int | None] = mapped_column(Integer)
    releaseDate: Mapped[str | None] = mapped_column(String)
    dateCreated: Mapped[str | None] = mapped_column(String)
    dateAdded: Mapped[str | None] = mapped_column(String)
    #: Device-relative POSIX path, e.g. ``/Contents/Artist/Album/Track.mp3``.
    path: Mapped[str | None] = mapped_column(String)
    fileName: Mapped[str | None] = mapped_column(String)
    fileSize: Mapped[int | None] = mapped_column(Integer)
    #: Container/codec discriminator. ``1`` observed for MP3. [UNKNOWN] otherwise.
    fileType: Mapped[int | None] = mapped_column(Integer)
    bitrate: Mapped[int | None] = mapped_column(Integer)
    bitDepth: Mapped[int | None] = mapped_column(Integer)
    samplingRate: Mapped[int | None] = mapped_column(Integer)
    isrc: Mapped[str | None] = mapped_column(String)
    djPlayCount: Mapped[int | None] = mapped_column(Integer)
    isHotCueAutoLoadOn: Mapped[int | None] = mapped_column(Integer)
    isKuvoDeliverStatusOn: Mapped[int | None] = mapped_column(Integer)
    kuvoDeliveryComment: Mapped[str | None] = mapped_column(String)
    #: Identifies the source desktop library. Constant within one export.
    masterDbId: Mapped[int | None] = mapped_column(Integer)
    #: ``djmdContent.ID`` in the source ``master.db``.
    masterContentId: Mapped[int | None] = mapped_column(Integer)
    #: Device-relative path to the ANLZ file holding beatgrid and waveform
    #: data, e.g. ``/PIONEER/USBANLZ/P073/0001E327/ANLZ0000.DAT``. The ``.EXT``
    #: sibling lives beside it.
    analysisDataFilePath: Mapped[str | None] = mapped_column(String)
    #: Bitfield of completed analysis passes. ``41`` (0b101001) observed
    #: throughout a fully analysed export. [UNKNOWN] per-bit meaning.
    analysedBits: Mapped[int | None] = mapped_column(Integer)
    contentLink: Mapped[int | None] = mapped_column(Integer)
    hasModified: Mapped[int | None] = mapped_column(Integer)
    cueUpdateCount: Mapped[int | None] = mapped_column(Integer)
    analysisDataUpdateCount: Mapped[int | None] = mapped_column(Integer)
    informationUpdateCount: Mapped[int | None] = mapped_column(Integer)


class Cue(Base):
    """A cue point, hot cue, or loop.

    Empty in an export whose tracks carry no cues; the ANLZ ``PCOB``/``PCO2``
    tags are header-only in that case too, so the two representations agree.

    The position of a single cue is stored **eleven times over** in different
    units. That redundancy exists so a player can seek frame-accurately in any
    supported container without re-parsing the file: microseconds for display,
    150 fps CD frames, MPEG frame numbers, and byte offsets into the decoded
    stream. A writer must keep them mutually consistent. [UNKNOWN] which
    fields players actually read.
    """

    __tablename__ = "cue"

    cue_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content_id: Mapped[int | None] = mapped_column(Integer)
    #: Discriminates memory cue / hot cue / loop. [UNKNOWN] enum values.
    kind: Mapped[int | None] = mapped_column(Integer)
    #: Index into :class:`Color`. [UNKNOWN] whether it shares that table.
    colorTableIndex: Mapped[int | None] = mapped_column(Integer)
    cueComment: Mapped[str | None] = mapped_column(String)
    isActiveLoop: Mapped[int | None] = mapped_column(Integer)
    beatLoopNumerator: Mapped[int | None] = mapped_column(Integer)
    beatLoopDenominator: Mapped[int | None] = mapped_column(Integer)
    inUsec: Mapped[int | None] = mapped_column(Integer)
    outUsec: Mapped[int | None] = mapped_column(Integer)
    in150FramePerSec: Mapped[int | None] = mapped_column(Integer)
    out150FramePerSec: Mapped[int | None] = mapped_column(Integer)
    inMpegFrameNumber: Mapped[int | None] = mapped_column(Integer)
    outMpegFrameNumber: Mapped[int | None] = mapped_column(Integer)
    inMpegAbs: Mapped[int | None] = mapped_column(Integer)
    outMpegAbs: Mapped[int | None] = mapped_column(Integer)
    inDecodingStartFramePosition: Mapped[int | None] = mapped_column(Integer)
    outDecodingStartFramePosition: Mapped[int | None] = mapped_column(Integer)
    inFileOffsetInBlock: Mapped[int | None] = mapped_column(Integer)
    #: Note the capital ``O`` -- rekordbox's own inconsistency, preserved.
    OutFileOffsetInBlock: Mapped[int | None] = mapped_column("OutFileOffsetInBlock", Integer)
    inNumberOfSampleInBlock: Mapped[int | None] = mapped_column(Integer)
    outNumberOfSampleInBlock: Mapped[int | None] = mapped_column(Integer)


# -- lookup tables ----------------------------------------------------------
#
# These hold only the values actually referenced by the exported tracks, not a
# full enumeration. ``color`` is the exception: all eight rekordbox colours are
# always present.


class Genre(Base):
    __tablename__ = "genre"
    genre_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)


class Artist(Base):
    __tablename__ = "artist"
    artist_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    nameForSearch: Mapped[str | None] = mapped_column(String)


class Album(Base):
    __tablename__ = "album"
    album_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    artist_id: Mapped[int | None] = mapped_column(Integer)
    image_id: Mapped[int | None] = mapped_column(Integer)
    #: rekordbox's spelling of "isCompilation". Preserved deliberately.
    isComplation: Mapped[int | None] = mapped_column("isComplation", Integer)
    nameForSearch: Mapped[str | None] = mapped_column(String)


class Label(Base):
    __tablename__ = "label"
    label_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)


class Key(Base):
    """Musical key, e.g. ``Gm``, ``F#m``, ``C``. Table name is a SQL keyword."""

    __tablename__ = "key"
    key_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)


class Color(Base):
    """The eight rekordbox track colours.

    Verified stable across exports: 1 Pink, 2 Red, 3 Orange, 4 Yellow,
    5 Green, 6 Aqua, 7 Blue, 8 Dark.
    """

    __tablename__ = "color"
    color_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)


class Image(Base):
    """Album artwork, by device-relative path under ``PIONEER/Artwork``."""

    __tablename__ = "image"
    image_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    path: Mapped[str | None] = mapped_column(String)


# -- tree structures --------------------------------------------------------
#
# playlist, hotCueBankList, history and myTag share one shape: an ``attribute``
# discriminator, a self-referential ``*_id_parent``, and a ``sequenceNo`` for
# sibling ordering. ``attribute`` is presumed to separate folders from leaves.
# [UNKNOWN] its exact values.


class Playlist(Base):
    __tablename__ = "playlist"
    playlist_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sequenceNo: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str | None] = mapped_column(String)
    image_id: Mapped[int | None] = mapped_column(Integer)
    attribute: Mapped[int | None] = mapped_column(Integer)
    playlist_id_parent: Mapped[int | None] = mapped_column(Integer)


class PlaylistContent(Base):
    """Ordered playlist membership. ``sequenceNo`` is 1-based."""

    __tablename__ = "playlist_content"
    __mapper_args__ = {"primary_key": ["playlist_id", "content_id", "sequenceNo"]}
    playlist_id: Mapped[int] = mapped_column(Integer)
    content_id: Mapped[int] = mapped_column(Integer)
    sequenceNo: Mapped[int] = mapped_column(Integer)


class HotCueBankList(Base):
    __tablename__ = "hotCueBankList"
    hotCueBankList_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sequenceNo: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str | None] = mapped_column(String)
    image_id: Mapped[int | None] = mapped_column(Integer)
    attribute: Mapped[int | None] = mapped_column(Integer)
    hotCueBankList_id_parent: Mapped[int | None] = mapped_column(Integer)


class HotCueBankListCue(Base):
    __tablename__ = "hotCueBankList_cue"
    __mapper_args__ = {"primary_key": ["hotCueBankList_id", "cue_id", "sequenceNo"]}
    hotCueBankList_id: Mapped[int] = mapped_column(Integer)
    cue_id: Mapped[int] = mapped_column(Integer)
    sequenceNo: Mapped[int] = mapped_column(Integer)


class History(Base):
    """A DJ set recorded on the device. Written by the player, not rekordbox."""

    __tablename__ = "history"
    history_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sequenceNo: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str | None] = mapped_column(String)
    attribute: Mapped[int | None] = mapped_column(Integer)
    history_id_parent: Mapped[int | None] = mapped_column(Integer)


class HistoryContent(Base):
    __tablename__ = "history_content"
    __mapper_args__ = {"primary_key": ["history_id", "content_id", "sequenceNo"]}
    history_id: Mapped[int] = mapped_column(Integer)
    content_id: Mapped[int] = mapped_column(Integer)
    sequenceNo: Mapped[int] = mapped_column(Integer)


class MyTag(Base):
    """MyTag tree. IDs are large and library-scoped, not 1-based like others."""

    __tablename__ = "myTag"
    myTag_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    sequenceNo: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str | None] = mapped_column(String)
    attribute: Mapped[int | None] = mapped_column(Integer)
    myTag_id_parent: Mapped[int | None] = mapped_column(Integer)


class MyTagContent(Base):
    __tablename__ = "myTag_content"
    __mapper_args__ = {"primary_key": ["myTag_id", "content_id"]}
    myTag_id: Mapped[int] = mapped_column(Integer)
    content_id: Mapped[int] = mapped_column(Integer)


# -- browse configuration ---------------------------------------------------


class MenuItem(Base):
    """Browse menu entries. ``category`` and ``sort`` reference these."""

    __tablename__ = "menuItem"
    menuItem_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[int | None] = mapped_column(Integer)
    name: Mapped[str | None] = mapped_column(String)


class Category(Base):
    """Which browse categories the player shows, and in what order."""

    __tablename__ = "category"
    category_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    menuItem_id: Mapped[int | None] = mapped_column(Integer)
    sequenceNo: Mapped[int | None] = mapped_column(Integer)
    isVisible: Mapped[int | None] = mapped_column(Integer)


class Sort(Base):
    """Which sort options the player offers."""

    __tablename__ = "sort"
    sort_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    menuItem_id: Mapped[int | None] = mapped_column(Integer)
    sequenceNo: Mapped[int | None] = mapped_column(Integer)
    isVisible: Mapped[int | None] = mapped_column(Integer)
    isSelectedAsSubColumn: Mapped[int | None] = mapped_column(Integer)


# -- device -----------------------------------------------------------------


class Property(Base):
    """Single-row device descriptor. Declares no primary key in the schema."""

    __tablename__ = "property"
    __mapper_args__ = {"primary_key": ["deviceName", "createdDate"]}
    deviceName: Mapped[str | None] = mapped_column(String)
    #: ``"1000"`` in rekordbox 7 exports.
    dbVersion: Mapped[str | None] = mapped_column(String)
    numberOfContents: Mapped[int | None] = mapped_column(Integer)
    #: ``YYYY-MM-DD``.
    createdDate: Mapped[str | None] = mapped_column(String)
    backGroundColorType: Mapped[int | None] = mapped_column(Integer)
    myTagMasterDBID: Mapped[int | None] = mapped_column(Integer)


class RecommendedLike(Base):
    """Track-to-track similarity, for the players' "related tracks" feature."""

    __tablename__ = "recommendedLike"
    __mapper_args__ = {"primary_key": ["content_id_1", "content_id_2"]}
    content_id_1: Mapped[int] = mapped_column(Integer)
    content_id_2: Mapped[int] = mapped_column(Integer)
    rating: Mapped[int | None] = mapped_column(Integer)
    createdDate: Mapped[int | None] = mapped_column(Integer)


#: Every table in the schema, in the order rekordbox declares them.
ALL_TABLES = [
    Content, Genre, Artist, Album, Label, Key, Color, Playlist, PlaylistContent,
    HotCueBankList, HotCueBankListCue, History, HistoryContent, Image, Cue,
    MenuItem, Category, Sort, Property, RecommendedLike, MyTag, MyTagContent,
]
