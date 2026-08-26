# The OneLibrary format

Reverse-engineering notes for the AlphaTheta / Pioneer DJ **OneLibrary** device
format, successor to the legacy DeviceSQL `export.pdb`. That legacy format is
already documented elsewhere; what this project reads of it is summarised in
[`DEVICESQL.md`](DEVICESQL.md).

Every claim below is tagged:

- **[VERIFIED]** — reproduced directly against software on hand, with the
  method stated so it can be re-run.
- **[REPORTED]** — published by others, not yet independently confirmed here.
- **[UNKNOWN]** — open question. Deliberately not guessed at.

Observations are pinned to the build they came from, because obfuscation
details drift between releases.

**Reference build:** rekordbox 7, macOS arm64, `Contents/MacOS/rekordbox`,
264,567,632 bytes, dated 2025-10-22.

---

## 1. Background

OneLibrary launched in October 2025 as a joint AlphaTheta / Algoriddim format,
evolved from AlphaTheta's earlier *Device Library Plus*. AlphaTheta states the
two are mutually compatible. Supported hardware: CDJ-3000X, XDJ-AZ, OPUS-QUAD,
OMNIS-DUO, and CDJ-3000 on firmware 3.15+. **[REPORTED]**

## 2. Device layout

Paths recovered from the reference binary's string table. **[VERIFIED]**

```
PIONEER/
  rekordbox/
    exportLibrary.db     OneLibrary database (SQLCipher)
    export.pdb           legacy DeviceSQL library
    exportExt.pdb        legacy extension database
  USBANLZ/
    .../ANLZ0000.DAT     per-track analysis: beatgrid, cues, waveform
    .../ANLZ0000.EXT     extended analysis
  Artwork/               album art
  MYSETTING.DAT          player preferences
  MYSETTING2.DAT
  DEVSETTING.DAT
```

**OneLibrary does not replace the legacy tree — it is written alongside it.**
rekordbox 7 still emits `export.pdb`, `exportExt.pdb`, and `PIONEER/USBANLZ`.
AlphaTheta's own UI text confirms coexistence: *"On USB storage devices or SD
cards that have both library formats, OneLibrary will be used."* **[VERIFIED]**

Consequence for implementers: a writer that emits only `exportLibrary.db`
produces a device that OneLibrary-aware players can read but older players
cannot. Waveform and detailed beatgrid data still appear to live in ANLZ files
referenced from the database rather than inline. **[UNKNOWN]** — needs
confirmation against a real export.

rekordbox exposes an explicit one-way conversion, `Convert to OneLibrary`,
implemented at `DeviceLibraryPlusDlgManager::toSqliteDbConversion`. **[VERIFIED]**

## 3. Encryption

`exportLibrary.db` is a **SQLCipher** database. The application bundle ships
`Contents/MacOS/libsqlcipher.0.dylib`. **[VERIFIED]**

Parameters — **SQLCipher 4 defaults**, no compatibility pragma required:

| Parameter | Value |
|---|---|
| Cipher | AES-256-CBC |
| Page size | 4096 |
| KDF | PBKDF2-HMAC-SHA512, 256,000 iterations |
| Per-page MAC | HMAC-SHA512 |

**The passphrase is supplied as a string, not as a raw hex key.** This is the
single most common integration mistake: `PRAGMA key = 'abc…'` succeeds where
`PRAGMA key = "x'abc…'"` fails with `file is not a database`, because the
latter tells SQLCipher to treat the value as 32 raw key bytes and skip the KDF
entirely. **[VERIFIED]** — confirmed against
`~/Library/Pioneer/rekordbox/master.db` with SQLCipher 4.12.0, which opened to
374 schema objects as a passphrase and failed under every hex-raw and
`cipher_compatibility` combination tried.

This matches the `legacy = 4` setting reported for
`better-sqlite3-multiple-ciphers`, which selects SQLCipher 4 semantics in that
binding. **[REPORTED]**

### 3.1 Known passphrases

| Database | Passphrase | Status |
|---|---|---|
| `master.db` | `402fd482c38817c35ffa8ffb8c7d93143b749e7d315df7a81732a1ff43608497` | **[VERIFIED]** opens the local database |
| `exportLibrary.db` | `r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls` | **[VERIFIED]** opens a real rekordbox 7 export |

Both are 64 characters. `master.db`'s is hex-shaped but is *not* used as hex;
`exportLibrary.db`'s contains non-hex letters, so it cannot be, which is
consistent with both being plain passphrases.

The two are **not** interchangeable: the `master.db` passphrase fails on an
export with `file is not a database`, and vice versa. **[VERIFIED]**

The passphrase is reported to be neither licence- nor machine-dependent — the
same value across all installations. **[REPORTED]**

### 3.2 Passphrase obfuscation — open

Recovering the passphrase from the reference build is **unsolved**. Several
avenues were closed off; they are recorded here so nobody repeats them.

**The published extraction recipe does not reproduce.** A widely-cited gist
describes: base85 (RFC 1924) decode a blob, XOR with the repeating key
`657f48f84c437cc1`, then zlib inflate. Replaying that chain on the documented
blob fails at the final step with `zlib.error: unknown compression method`, and
that blob does not occur in the reference binary. **[VERIFIED]** — negative.

**Neither passphrase is present in the clear.** A literal substring search
finds nothing. **[VERIFIED]** — negative.

**Neither passphrase is hidden under a single-byte XOR.** Proven exhaustively
in one pass using an XOR-delta scan: the sequence `b[i] ^ b[i+1]` is invariant
under XOR with any constant, so searching for the passphrase's delta sequence
across all 264 MB covers all 255 possible keys simultaneously. No match for
either passphrase. **[VERIFIED]** — negative.

Single-byte XOR *is* used for other strings in this binary — a build path was
recovered under XOR `0x19` — so the technique is present, just not applied to
the passphrase. **[VERIFIED]**

What remains: the obfuscation is multi-stage and build-specific. Locating it
means static analysis of the code around the `sqlite3_key` / `PRAGMA key` call
sites in `libsqlcipher.0.dylib`'s callers. **[UNKNOWN]**

## 4. Schema

**Recovered in full.** 22 tables, 4 indexes, no views or triggers. The
complete DDL is committed verbatim at [`schema.sql`](schema.sql), and modelled
in `src/onelibrary/schema.py`. **[VERIFIED]** — introspected from an export
written by the reference build.

Declared types are only `integer` and `varchar`. **The schema declares no
NOT NULL, no DEFAULT, and no FOREIGN KEY constraints anywhere.** All
relationships below are inferred from naming and confirmed against data; none
are enforced by the database. **[VERIFIED]**

### 4.1 Reading an export: the WAL trap

rekordbox leaves most of a fresh export in the write-ahead log. One observed
export was a 118 KB `exportLibrary.db` beside a **1.1 MB**
`exportLibrary.db-wal`. Opening the main file alone reports a nearly empty
library — 26 schema objects and almost no rows — with no error.

Any reader must copy `exportLibrary.db`, `-wal` and `-shm` together and
checkpoint before reading. **[VERIFIED]**

### 4.2 Tables

| Table | Rows in test export | Purpose |
|---|---|---|
| `content` | 11 | tracks |
| `cue` | 0 | cue points, hot cues, loops |
| `artist`, `album`, `genre`, `label`, `key`, `color`, `image` | 14/11/9/10/7/8/11 | lookups |
| `playlist`, `playlist_content` | 1 / 11 | playlist tree + ordered membership |
| `myTag`, `myTag_content` | 28 / 1 | tag tree + assignments |
| `history`, `history_content` | 0 | player-written set history |
| `hotCueBankList`, `hotCueBankList_cue` | 0 | hot cue banks |
| `menuItem`, `category`, `sort` | 27 / 22 / 17 | browse UI configuration |
| `property` | 1 | device descriptor |
| `recommendedLike` | 0 | track similarity |

Lookup tables hold **only the values referenced by exported tracks**, not a
full enumeration — an export of 11 tracks yielded 7 keys and 9 genres. `color`
is the exception: all eight are always present. **[VERIFIED]**

### 4.3 Verified field semantics

| Field | Meaning |
|---|---|
| `content.bpmx100` | centi-BPM — `12400` is 124.00 BPM |
| `content.length` | duration in whole seconds |
| `content.rating` | 0–5 stars, **not** the 0/51/…/255 encoding used elsewhere in the rekordbox ecosystem |
| `content.path` | device-relative POSIX path, e.g. `/Contents/Artist/Album/Track.mp3` |
| `content.masterContentId` | `djmdContent.ID` in the source `master.db` |
| `content.masterDbId` | identifies the source library; constant across one export |
| `content.analysisDataFilePath` | device-relative path to the ANLZ `.DAT` |
| `color` | 1 Pink, 2 Red, 3 Orange, 4 Yellow, 5 Green, 6 Aqua, 7 Blue, 8 Dark |
| `property.dbVersion` | `"1000"` in rekordbox 7 exports |
| `*_content.sequenceNo` | 1-based ordering within the parent |

The `masterContentId` linkage was confirmed by resolving all 11 rows of a test
export against the source `master.db`: titles, ratings and BPM matched on every
row. **[VERIFIED]**

Four tree tables — `playlist`, `hotCueBankList`, `history`, `myTag` — share one
shape: an `attribute` discriminator, a self-referential `*_id_parent`, and
`sequenceNo` for sibling order. `attribute` presumably separates folders from
leaves; exact values **[UNKNOWN]**.

`myTag` IDs are large and library-scoped (e.g. `1478790622`) rather than
1-based like every other table, and `property.myTagMasterDBID` scopes them.
**[VERIFIED]**

### 4.4 Reproduce rekordbox's typos

A writer must emit these exactly as rekordbox declares them:

- `album.isComplation` — rekordbox's spelling of "isCompilation"
- `cue.OutFileOffsetInBlock` — capital `O`, where every sibling field uses
  lowercase `out`

This is consistent with `master.db`, which has its own (`djmdColor.Commnt`).
**[VERIFIED]**

### 4.5 Cues are not in the database

**This is the most important finding for anyone writing an implementation.**

rekordbox does not populate the `cue` table on export. A test export in which
one track carried three hot cues, and another carried two memory cues plus a
hot cue and a saved loop, had **zero rows** in `cue`. Every one of those cues
was in the ANLZ files. **[VERIFIED]**

The only trace in the database is `content.cueUpdateCount` — `7` on the two
tracks with cues, `2` on a third, empty on the eight without. **[VERIFIED]**

A writer that fills the `cue` table and stops produces a device with no cues on
it. Cues must be written into ANLZ.

The `cue` table is presumed to exist for the *player* to write into when a DJ
saves cues on the hardware. **[UNKNOWN]** — untested, no hardware available.

Note also that when populated, a cue's position is recorded in **eleven**
different units: `inUsec`, `in150FramePerSec`, `inMpegFrameNumber`,
`inMpegAbs`, `inDecodingStartFramePosition`, `inFileOffsetInBlock`,
`inNumberOfSampleInBlock`, each with an `out*` counterpart for loops. The
redundancy lets a player seek frame-accurately in any container without
re-parsing the file. **[UNKNOWN]** which fields players read, and **[UNKNOWN]**
the `kind` enum — neither can be resolved without a populated table.

### 4.6 Relationship to ANLZ

**Beatgrids and waveforms are not in the database.** `content` carries no
beatgrid, waveform, or phrase column; `analysisDataFilePath` points at
`/PIONEER/USBANLZ/<P0xx>/<8-hex>/ANLZ0000.DAT`, with the `.EXT` sibling beside
it. **[VERIFIED]**

The ANLZ files are the *same* format the legacy PDB export uses, and parse with
existing tooling. Tags observed across a full export:

| File | Tags |
|---|---|
| `.DAT` | `PPTH` path, `PVBR` VBR index, `PQTZ` beatgrid, `PWAV`/`PWV2` waveforms, `PCOB` ×2 cue lists |
| `.EXT` | `PPTH`, `PWV3`/`PWV4`/`PWV5` colour waveforms, `PCOB` ×2, `PCO2` ×2 extended cues, `PQT2` extended beatgrid, `PSSI` phrase/song structure |

In an export whose tracks carry no cues, `PCOB` is 24 bytes and `PCO2` is 20 —
header-only — matching the empty `cue` table. The two representations agree.
**[VERIFIED]**

A complete writer must therefore emit ANLZ files as well as the database.
crate-digger and pyrekordbox already document this format; reuse them.

#### Cue encoding in ANLZ

`PCOB` holds basic cues as `PCPT` entries; `PCO2` holds the extended form as
`PCP2` entries, adding colour. Each file carries two of each — one list for
memory cues, one for hot cues, discriminated by the section's `type` field
(0 = memory, 1 = hot). **[VERIFIED]**

| Field | Meaning |
|---|---|
| `hot` | `0` = memory cue; `1`–`8` = hot cue A–H |
| `type` | `1` = cue point, `2` = loop |
| `time` | position in **milliseconds** |
| `loop_time` | loop end in ms; `0xFFFFFFFF` means "not a loop" |

Decoded from a real export: a track with hot cues at 109 ms (A), 93,012 ms (C)
and 116,238 ms (D); and another with memory cues at 0 ms and 19,363 ms, a hot
cue A at 24,460 ms, and a hot cue C **loop** from 39,768 ms to 42,274 ms — a
2,506 ms loop. **[VERIFIED]**

**The `.DAT` and `.EXT` files disagree, by design.** `.DAT` carries only the
hot cues older players understand; `.EXT` carries the full modern set. One
observed track listed 2 hot cues in its `.DAT` and 3 in its `.EXT`. Read the
`.EXT` when present; a writer must emit both, with the `.DAT` as the
compatible subset. **[VERIFIED]**

## 5. Method

Schema introspection gives table and column *names*. It does not give
*meanings* — which integer is "hot cue B", how a beatgrid blob is packed, what
unit a position is in. Those come from differential analysis:

1. Export a small controlled playlist from rekordbox to a device.
2. `python tools/capture.py /Volumes/USB -o corpus/00-baseline`
3. Change **exactly one thing** in rekordbox — add one hot cue, nudge one
   beatgrid marker, set one colour, rename one playlist, set one rating.
4. Re-export and capture again.
5. `python tools/diff_exports.py corpus/00-baseline corpus/01-change`

Whatever moved is where that feature lives. The diff tool reports blob changes
by byte offset, which is what pins down packed binary layouts.

Suppress sync churn when diffing. rekordbox maintains `usn`, `rb_local_usn`,
`created_at`, `updated_at`, and `rb_local_*` bookkeeping columns that change on
every export and will otherwise bury the signal. These are in the diff tool's
default ignore list. **[VERIFIED]** — observed in `master.db`.

## 6. Prior art

| Project | Language | Scope |
|---|---|---|
| [onelibrary-connect](https://github.com/chrisle/onelibrary-connect) | TypeScript, MIT | OneLibrary, read-only |
| [rbox](https://pypi.org/project/rbox/) | Python | OneLibrary unlock + contents |
| [pyrekordbox](https://github.com/dylanljones/pyrekordbox) | Python, MIT | `master.db`, ANLZ, XML, MySettings |
| [rekordcrate](https://github.com/Holzhaus/rekordcrate) | Rust | legacy PDB + ANLZ |
| [crate-digger](https://github.com/Deep-Symmetry/crate-digger) | Java | legacy PDB + ANLZ |

ANLZ files are already well documented by crate-digger and pyrekordbox. This
project should reuse that work rather than re-derive it.

## 7. References

- [OneLibrary — AlphaTheta](https://alphatheta.com/en/onelibrary/)
- [DJ brands unite to launch OneLibrary — rekordbox](https://rekordbox.com/en/2025/10/dj-brands-unite-to-launch-onelibrary/)
- [OneLibrary FAQ — rekordbox](https://rekordbox.com/en/support/faq/onelibrary-7/)
- [SQLCipher design — Zetetic](https://www.zetetic.net/sqlcipher/design/)
- [Notes on OneLibrary SQLCipher encryption — 0xdevalias gist](https://gist.github.com/0xdevalias/b803476793b56f7c45e6361799168eb0)
- [Add OneLibrary support — mixxx#15556](https://github.com/mixxxdj/mixxx/issues/15556)
