# The OneLibrary format

Reverse-engineering notes for the AlphaTheta / Pioneer DJ **OneLibrary** device
format, successor to the legacy DeviceSQL `export.pdb`.

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
| `exportLibrary.db` | `r8gddnr4k847830ar6cqzbkk0el6qytmb3trbbx805jm74vez64i5o8fnrqryqls` | **[REPORTED]** — no export captured yet |

Both are 64 characters. `master.db`'s is hex-shaped but is *not* used as hex;
`exportLibrary.db`'s contains non-hex letters, so it cannot be, which is
consistent with both being plain passphrases.

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

**Not yet recovered.** A capture of a real export is required.

The schema is **not** embedded as SQL text in the binary. Beyond the absence of
plaintext `CREATE TABLE` statements for export tables, an exhaustive
single-byte-XOR search for the markers `CREATE TABLE`, `exportLibrary`,
`PRAGMA key`, `cipher_`, and `sqlite3_key` across all 255 keys returned no hits
anywhere in the 264 MB image. The schema is therefore constructed at runtime —
via an ORM or migration path — and can only be recovered by introspecting an
actual `exportLibrary.db`. **[VERIFIED]** — negative.

### 4.1 Tables reported by prior art

`onelibrary-connect` (MIT) exposes an API implying these entities. Column
names and types are unconfirmed here. **[REPORTED]**

- **content** — tracks, keyed by `content_id`, with foreign keys to artist,
  album, genre, key, colour, label, artwork, remixer, original artist, composer
- **cue** — cue points, loops, hot cues and hot loops in one table
- **playlist** — folder/playlist tree, plus an ordered join table
- **myTag** — tag tree with per-track assignments
- **history** — one session per DJ set, plus ordered contents
- **hotCueBankList** — hot cue bank lists and their cue members
- **menuItem** — browse menu configuration, visible categories, sort options
- **property** — device row carrying `deviceName`, `dbVersion`,
  `numberOfContents`, `createdDate`, `backgroundColorType`

Note that rekordbox's own `master.db` schema contains deliberate misspellings
(`djmdColor.Commnt`); do not assume clean naming in the export schema either.

### 4.2 Field semantics

**[UNKNOWN]** across the board — enum values, packed blob layouts, tempo and
position units, colour codes, rating scale. These are what the differential
method in §5 exists to resolve.

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
