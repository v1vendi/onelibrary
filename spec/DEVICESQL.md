# The legacy DeviceSQL format

Notes on the **DeviceSQL** export (`export.pdb`) that OneLibrary replaces, as
far as this project reads it. The companion document is
[`ONELIBRARY.md`](ONELIBRARY.md), which covers the newer format.

Every claim below is tagged:

- **[VERIFIED]** — reproduced directly against software on hand, with the
  method stated so it can be re-run.
- **[REPORTED]** — published by others, not yet independently confirmed here.
- **[UNKNOWN]** — open question. Deliberately not guessed at.

Unlike OneLibrary, this format is **already well documented**, and this project
claims no discovery in it. The layouts here follow crate-digger's
[`rekordbox_pdb.ksy`][ksy], reverse-engineered by @henrybetts, @flesniak and
@brunchboy, and are recorded here only so that the two readers in this
repository can be read and checked without leaving it. Where this document says
something the reference does not, it is about *this project's* handling, not
about the format.

[ksy]: https://github.com/Deep-Symmetry/crate-digger/blob/master/src/main/kaitai/rekordbox_pdb.ksy

---

## 1. Why it is still here

OneLibrary does not replace the legacy tree, it is written beside it: rekordbox
7 emits `export.pdb`, `exportExt.pdb` and `PIONEER/USBANLZ` as it always has,
and converts a device only when explicitly asked. **[VERIFIED]** — see
[`ONELIBRARY.md` §2](ONELIBRARY.md).

So a device in the wild carries the legacy library, the new one, or both, and
anything that reads devices has to read both. Where a device has both, prefer
OneLibrary: it is the one rekordbox now maintains, and the one AlphaTheta's own
UI says the players will use.

## 2. Scope in this project

**Read-only, both implementations.** `export.pdb` and `exportExt.pdb` are
parsed; neither is written.

That is a deliberate limit rather than an unfinished one. Writing DeviceSQL
means allocating inside a page heap, rebuilding a row index in place, and
splitting a page when a row no longer fits — and it buys little, because
rekordbox will convert a legacy device to OneLibrary itself, and the whole
point of this project is that nothing open-source can write *that*. The
consequence to know about: `onelibrary apply` refuses a legacy device, and the
viewer shows a legacy library without offering to edit it.

| | |
|---|---|
| [`python/src/onelibrary/pdb.py`](../python/src/onelibrary/pdb.py) | `PdbFile`, the same surface as `OneLibraryDB` |
| [`viewer/src/pdb.js`](../viewer/src/pdb.js) | `PdbDatabase`, rows translated to OneLibrary names |
| [`python/tests/pdb_fixture.py`](../python/tests/pdb_fixture.py) | builds the fixture both are tested against |

The two readers are independent, as the two library readers already are. They
meet at one generated fixture file, so a disagreement between them is a bug in
one of them rather than a difference between fixtures that drifted apart.

### How they were checked

A converted device carries both libraries, which makes it its own test: the
same library, written twice, by rekordbox. **[VERIFIED]** — against a real
14-track export carrying `export.pdb`, `exportExt.pdb` and `exportLibrary.db`
side by side:

- Every table's row count matched its OneLibrary counterpart: 14 tracks,
  15 artists, 12 albums, 11 genres, 10 labels, 10 keys, 8 colors, 11 artwork,
  1 playlist, 11 playlist entries, 28 My Tags.
- `title`, `tempo`, `duration`, `bitrate`, `rating`, `year`, `file_size` and
  `analyze_path` agreed with `title`, `bpmx100`, `length`, `bitrate`, `rating`,
  `releaseYear`, `fileSize` and `analysisDataFilePath` on **every** track.
- Artist, playlist and My Tag names matched as sets, including four tracks
  whose titles or paths are not ASCII.

Reproduce it on any converted device with the script in this project's history,
or in miniature by comparing `onelibrary dump --legacy` against
`onelibrary dump`.

## 3. File layout

Little-endian throughout. The file is a whole number of fixed-size pages;
`export.pdb` uses 4096 bytes. **[REPORTED]**

Page 0 is the file header:

| Offset | Type | Meaning |
|---|---|---|
| `0x00` | u32 | zero |
| `0x04` | u32 | `len_page`, the page size |
| `0x08` | u32 | number of table entries that follow |
| `0x0c` | u32 | next unused page; points past the end of the file |
| `0x10` | u32 | unknown |
| `0x14` | u32 | sequence, incremented on every edit |
| `0x18` | u32 | zero |
| `0x1c` | — | table entries, 16 bytes each |

Each table entry is a row type and the two ends of a linked list of pages:

| Offset | Type | Meaning |
|---|---|---|
| `+0x00` | u32 | row type (see §6) |
| `+0x04` | u32 | empty candidate |
| `+0x08` | u32 | first page index |
| `+0x0c` | u32 | last page index |

A page index is multiplied by `len_page` to get a file offset. Walking a table
means following `next_page` from the first page, and stopping at the declared
last page — or, sooner, at a page whose type is not the table's, or at a link
that leaves the file. An empty table is written with that last shape.
**[REPORTED]**

## 4. Page structure

Every page opens with a 0x28-byte header:

| Offset | Type | Meaning |
|---|---|---|
| `0x00` | u32 | zero |
| `0x04` | u32 | this page's own index |
| `0x08` | u32 | row type |
| `0x0c` | u32 | next page in this table |
| `0x10` | u32 | sequence at the time this page was edited |
| `0x14` | — | 4 bytes, unknown |
| `0x18` | b13 | `num_row_offsets`: index slots ever allocated here |
| — | b11 | `num_rows`: slots currently live |
| `0x1b` | u8 | page flags |
| `0x1c` | u16 | free bytes in the heap |
| `0x1e` | u16 | bytes in use in the heap |
| `0x20` | u16 | rows touched by the last transaction, or `0x1fff` if it failed |
| `0x22` | u16 | index of the first such row |
| `0x24` | — | 4 bytes, unknown |

The two counts share a 24-bit little-endian bitfield at `0x18`: thirteen bits
of `num_row_offsets`, then eleven of `num_rows`.

**Bit `0x40` of the page flags marks a page that holds no rows.** These sit at
the head of most table chains, and their trailing bytes are not a row index —
parsing one as if it were produces garbage offsets into arbitrary memory. Skip
them. **[REPORTED]**

Past the header the page is a heap that rows are scattered around, while an
index of their offsets is built **backwards from the end of the page** in
groups of sixteen:

```
+-------------------+ 0x00
| page header       |
+-------------------+ 0x28   row offsets are measured from here
| rows ->           |
|                   |
|         <- string |
+-------------------+
| <- row index      |  group 0 spans len_page-0x24 .. len_page
+-------------------+ len_page
```

Group *g* has its base at `len_page - g * 0x24`, and from that base:

| Position | Type | Meaning |
|---|---|---|
| `base - 4` | u16 | presence mask, bit *n* for slot *n* |
| `base - (6 + 2n)` | u16 | offset of row *n*, past the end of the page header |

**A cleared presence bit is not a hint, it is a hard stop.** A deleted row
keeps its index slot and its offset, and rekordbox is free to reuse or abandon
the bytes it pointed at; the row it names may no longer be well-formed. The
mask is the only thing that says which rows exist. **[REPORTED]**

## 5. Strings

Every variable-length string is stored out of line elsewhere in the same page,
and addressed by an offset relative to **the row**, not the page. The leading
byte selects one of three encodings: **[REPORTED]**

| Leading byte | Form | Body |
|---|---|---|
| `0x40` | u16 length, then 1 unknown byte | ASCII, `length - 4` bytes |
| `0x90` | u16 length, then 1 unknown byte | UTF-16LE, `length - 4` bytes |
| anything else | length mangled into the byte itself | ASCII, `(byte >> 1) - 1` bytes |

The declared length of the two long forms *includes* the four-byte header. The
short form's byte is the length incremented, doubled, and incremented again,
which is why it always reads as odd — and why an empty string is `0x03`.

Both readers here decode the ASCII forms as latin-1 rather than strict ASCII.
rekordbox writes anything outside ASCII in the UTF-16 form, so the bytes are
ASCII in practice; latin-1 turns a violation of that into a visible character
instead of an exception in the middle of somebody's library.

Some rows reach their name through **two candidate offsets**, one byte and one
word, with bit `0x04` of the row's `subtype` selecting the wider one — used
when the name sits more than 0xff bytes from the row. Both are read here, and
the fixture exercises both. **[REPORTED]**

## 6. Row types

Table numbering in `export.pdb`. Types with no row layout are named but not
decoded; both readers report their row *counts*, which needs only the index.
**[REPORTED]**

| # | Table | Read here |
|---|---|---|
| 0 | tracks | yes |
| 1 | genres | yes |
| 2 | artists | yes |
| 3 | albums | yes |
| 4 | labels | yes |
| 5 | keys | yes |
| 6 | colors | yes |
| 7 | playlist_tree | yes |
| 8 | playlist_entries | yes |
| 9, 10 | unknown | — |
| 11 | history_playlists | yes |
| 12 | history_entries | yes |
| 13 | artwork | yes |
| 14, 15 | unknown | — |
| 16 | columns | — |
| 17, 18 | unknown | — |
| 19 | history | — |

**Three of the unnamed tables line up with OneLibrary tables by row count.** On
the converted device above, counting present rows in the legacy file and rows
in the new database gave, exactly: type 16 `columns` = 27 = `menuItem`;
type 17 = 22 = `category`; type 18 = 17 = `sort`. **[VERIFIED]** — counts only,
on a single device.

That is a lead, not an identification: equal counts on one library could be
coincidence, and says nothing about how the rows are laid out. **[UNKNOWN]** —
worth re-running across devices with different libraries before anyone believes
it, since all three tables look like UI bookkeeping (which browse columns to
show, which sort orders exist) that may well be the same size on every device.

`exportExt.pdb` numbers its tables **differently**, and the same number means a
different table in each file: type 3 is albums in one and tags in the other.
The Python reader takes an `ext` flag, inferred from the filename. Only tags
(3) and tag_tracks (4) are decoded — the My Tag data. **[REPORTED]**

### The track row

The one row worth writing out. Fixed part, `0x5e` bytes, then twenty-one 2-byte
string offsets: **[REPORTED]**

| Offset | Type | Field |
|---|---|---|
| `0x00` | u2 | subtype |
| `0x02` | u2 | index_shift |
| `0x04` | u4 | bitmask **[UNKNOWN]** |
| `0x08` | u4 | sample_rate |
| `0x0c` | u4 | composer_id → artists |
| `0x10` | u4 | file_size |
| `0x1c` | u4 | artwork_id → artwork |
| `0x20` | u4 | key_id → keys |
| `0x24` | u4 | original_artist_id → artists |
| `0x28` | u4 | label_id → labels |
| `0x2c` | u4 | remixer_id → artists |
| `0x30` | u4 | bitrate |
| `0x34` | u4 | track_number |
| `0x38` | u4 | tempo, **BPM × 100** |
| `0x3c` | u4 | genre_id → genres |
| `0x40` | u4 | album_id → albums |
| `0x44` | u4 | artist_id → artists |
| `0x48` | u4 | id — what a player reports over the network |
| `0x4c` | u2 | disc_number |
| `0x4e` | u2 | play_count |
| `0x50` | u2 | year |
| `0x52` | u2 | sample_depth |
| `0x54` | u2 | duration, **whole seconds** |
| `0x58` | u1 | color_id → colors |
| `0x59` | u1 | rating, 0–5 |
| `0x5e` | u2 × 21 | string offsets |

The strings, in offset order: `isrc`, `texter`, four of unknown purpose,
`message`, `kuvo_public`, `autoload_hot_cues`, two more unknown, `date_added`,
`release_date`, `mix_name`, one unknown, `analyze_path`, `analyze_date`,
`comment`, `title`, one unknown, `filename`, `file_path`.

`kuvo_public` and `autoload_hot_cues` are empty or `"ON"`. They are booleans
stored as strings. **[REPORTED]**

## 7. Analysis files

`analyze_path` points at `/PIONEER/USBANLZ/<P0xx>/<8-hex>/ANLZ0000.DAT`, with
the `.EXT` sibling beside it — the **same** files, in the same format, that
OneLibrary's `content.analysisDataFilePath` points at. **[VERIFIED]** — see
[`ONELIBRARY.md` §4](ONELIBRARY.md).

This is what makes reading the legacy library worth so little extra: beatgrids,
waveforms and cues were never in either database, and the ANLZ reader this
project already has works unchanged on a legacy device.

## 8. Mapping onto OneLibrary

The viewer's reader returns rows under OneLibrary's names, so that the track
list, the decks and the waveforms never learn which format was dropped on them.
The correspondence, for the columns the viewer reads:

| OneLibrary `content` | DeviceSQL `tracks` |
|---|---|
| `content_id` | `id` |
| `artist_id_artist` | `artist_id` |
| `bpmx100` | `tempo` |
| `length` | `duration` |
| `path` | `file_path` |
| `analysisDataFilePath` | `analyze_path` |
| `image_id` | `artwork_id` |
| `commnt` | `comment` |
| `releaseYear` | `year` |
| `title`, `rating`, `bitrate`, `album_id`, `genre_id`, `key_id`, `label_id`, `color_id` | same name |

`artist`, `album`, `genre`, `key`, `label` and `color` map `id` → `<name>_id`;
`artwork` becomes `image`; `playlist_tree` becomes `playlist` and
`playlist_entries` becomes `playlist_content`, whose `track_id` is a
`content_id` and whose `entry_index` is a `sequenceNo`.

Two things do not map:

- **Playlist folders.** DeviceSQL keeps folders in the same table as playlists,
  flagged by `raw_is_folder`. They hold no tracks, so the viewer drops them
  rather than showing entries that can never fill.
- **`property`.** DeviceSQL has no device record at all — no device name, no
  database version, no export date. The viewer synthesises the one row it
  needs, and shows the format in place of a version the file never had.

## 9. Prior art

Read these before this document; they are the source for it.

| Project | Language | Scope |
|---|---|---|
| [crate-digger](https://github.com/Deep-Symmetry/crate-digger) | Java | the reference: `rekordbox_pdb.ksy` and [Analysis.pdf][pdf] |
| [rekordcrate](https://github.com/Holzhaus/rekordcrate) | Rust | PDB + ANLZ, and a writer |
| [pyrekordbox](https://github.com/dylanljones/pyrekordbox) | Python | PDB, ANLZ, XML, MySettings |
| [python-prodj-link](https://github.com/flesniak/python-prodj-link) | Python | where much of the layout was first worked out |

[pdf]: https://github.com/Deep-Symmetry/crate-digger/blob/master/doc/Analysis.pdf
