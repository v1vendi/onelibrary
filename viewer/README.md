# OneLibrary Viewer

Browse a rekordbox **OneLibrary** export in the browser. Drag a USB stick onto
the page and get the track list, playlists, cues, loops, beatgrid and colour
waveforms.

Everything runs locally. The database is decrypted **in the page** with
WebCrypto; nothing is uploaded, and there is no server.

```bash
npm test          # 21 tests
npm run build     # -> dist/index.html, a single self-contained file
npm run serve     # then open http://localhost:8777
```

## How it works

Three pieces, each written from scratch so the viewer stays one file with no
WASM blob and no external fetches:

| Module | Does |
|---|---|
| `src/sqlcipher.js` | SQLCipher 4 decryption using only WebCrypto |
| `src/sqlite.js` | A minimal SQLite reader — b-trees, records, overflow pages |
| `src/sqlite_write.js` | A SQLite writer — serialises tables and indexes back into a file |
| `src/editor.js` | Track edits and saving |
| `src/anlz.js` | ANLZ cues, beatgrid and waveforms |
| `src/waveform.js` | Canvas rendering |
| `src/player.js` | Playback and cue stepping |

### Decryption

`exportLibrary.db` uses SQLCipher 4 defaults: 4096-byte pages with 80 reserved
bytes (16-byte IV + 64-byte HMAC-SHA512), PBKDF2-HMAC-SHA512 at 256,000
iterations, AES-256-CBC. Page 1 opens with a 16-byte plaintext salt.

Two things make this awkward in a browser, and both are handled:

**WebCrypto has no raw CBC.** It always applies PKCS#7 and rejects ciphertext
that does not end in valid padding, but SQLCipher pages are unpadded.
Encrypting an empty buffer under the final ciphertext block as IV yields
exactly one block of valid padding; appending it lets `decrypt()` succeed and
strip it, leaving the true plaintext.

**A wrong key must fail loudly.** Byte 16 of the decrypted first page is the
SQLite page-size field and byte 20 is the reserve field, so a correct
decryption reports back exactly the geometry used to perform it. The decryptor
asserts this, so a bad passphrase raises instead of producing noise.

A 118 KB export decrypts in about 70 ms.

### Waveforms

The colour waveform (`PWV5`) packs each column into a `u16be`. The height field
was determined empirically rather than taken from published notes: across
24,898 columns it correlates at **r = +0.956** with the mono `PWV3` height for
the same track, where every other candidate bit position scored below 0.37.

```
height = (d >> 2) & 0x1f
```

The three 3-bit fields above it are colour. Their channel order is *inferred,
not confirmed* — the bits 15–13 field tracks overall loudness most closely in
every track measured, which is bass-band behaviour, so it is rendered as blue.

## Playback

Drop the whole device and tracks play from their own files — no copying, no
upload. The deck follows the CDJ convention: a zoomed view scrolls under a
playhead fixed at the centre, with the beatgrid drawn from the real analysis
and downbeats emphasised, over a static overview strip showing the whole track.

| Control | |
|---|---|
| `space` | play / pause |
| `←` `→` | previous / next cue |
| click or drag the overview | seek |
| drag the detail view | scrub at the current zoom |

Zoom runs 4s–32s across the deck.

## Editing

Title, artist, album, genre, comment, rating and colour are editable. Changes
are held as a change-set rather than applied in place, so setting a value back
to its original removes it from the count rather than recording a no-op, and
Discard is always exact.

**Save changes** takes whichever route the browser allows:

- **Open device…** (Chrome, Edge) grants a writable handle, and saving
  **overwrites `exportLibrary.db` on the stick in place**. The previous
  database is kept as `exportLibrary.db.bak` first, and the stale `-wal`/`-shm`
  sidecars are removed so nothing replays over the new file. Dragging a folder
  in cannot do this — drag-and-drop yields read-only handles.
- **Otherwise** it downloads the rebuilt `exportLibrary.db` to copy over
  `PIONEER/rekordbox/` yourself.
- **In the published artifact** the download allowlist has no `.db` extension,
  so it saves `onelibrary-edits.json` instead:

  ```bash
  onelibrary apply onelibrary-edits.json /Volumes/YOURUSB
  ```

  The change-set records the value the browser saw alongside the new one, so
  `apply` refuses any field the device has changed since — `--force` overrides.

Every route rebuilds the whole database rather than patching bytes. That is
deliberate: changing a rating from 0 to 5 changes its serial type from
"constant zero" to "8-bit integer", so the record grows and the page has to be
laid out again regardless.

The output is verified by `PRAGMA integrity_check` and
`PRAGMA cipher_integrity_check` in SQLCipher itself, not just by reading it
back with the same code that wrote it.

## Skins

Winamp's whole identity was skinning, so the classic look ships as a switch
rather than a replacement — the toggle sits in the header and the choice
persists.

The classic skin is a **hand-built homage, not a port**. Real Winamp skins are
bitmap sets owned by Nullsoft and its successors; nothing here is copied from
them. The bevels, the backlit display and the playlist colours are rebuilt in
CSS from the era's Win95 3D conventions. It deliberately commits to its own
dark chassis rather than following the viewer's light/dark theme.

One substantive departure: Winamp's display green was `#00FF00`, which vibrates
badly against black at small sizes. This uses a slightly desaturated green that
holds its edge in text while still reading as a phosphor display.

## Limitations

- Reads the `.DAT` and `.EXT` files a track references. Drop the **whole
  device**, not just the database, or there are no waveforms.
- Editing covers database fields only. Cues live in ANLZ and are not editable
  here.
- Saving in place needs the File System Access API — Chrome or Edge, and not
  inside the published artifact's frame. Elsewhere it falls back to a download
  or a change-set.
- Phrase analysis (`PSSI`) and the 3-band waveform (`PWV4`) are parsed but not
  yet displayed.

## License

MIT. Not affiliated with AlphaTheta / Pioneer DJ.
