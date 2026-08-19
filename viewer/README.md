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
upload. Load a track by dragging it from the list onto a deck, or with the
LOAD button.

One deck by default; **Two decks** switches to the mixing layout, where the
scrolling lanes run the full width and stack so both playheads sit on one
vertical line — which is what makes the phase difference between two tracks
visible. Each deck has artwork, elapsed and remaining time, CUE and play, hot
cue pads A–H, a pitch fader with ±6/10/16/100% ranges, and BEAT SYNC.

**BEAT SYNC aligns the bar, not just the tempo.** Matching BPM leaves two
tracks at the same speed but out of step; matching the *beat* is still not
enough, because landing on the right beat but the wrong beat of the bar puts a
snare where a kick should be. Sync therefore matches tempo, then aligns
position within the four-beat bar, choosing whichever candidate bar is nearest
so the correction stays under half a bar. If the tempo difference is beyond the
pitch range it says so rather than doing nothing.

| Control | |
|---|---|
| `space` | play / pause the focused deck |
| `←` `→` | previous / next cue |
| `esc` | CUE |
| `q` `w` | focus deck A / B |
| click or drag the overview | seek |
| drag the scrolling view | scrub |

## Waveforms

The colour waveform is drawn as three bands from the `PWV5` data — bass, mid
and highs.

The **scrolling view** mirrors around a centre line with the bands overlaid,
widest first. Its beatgrid reads from the edges, as on a CDJ: a tick above and
below each beat rather than a line through the waveform, with downbeats in red
carrying a full-height line.

The **overview** follows rekordbox instead: it rises from a baseline rather
than mirroring, stacks the bands (bass at the bottom, highs on top) rather than
overlaying them, and dims what has already played — what is left to play is
what a DJ is reading, so that stays bright.

Two details make it behave like a DJ display rather than a plot:

**Bins are anchored to source columns, not to screen position.** Re-slicing the
data by pixel every frame makes the peak inside each bin jump between
neighbouring samples, and the whole envelope crawls. Anchoring means a bin
always covers the same samples and scrolling only changes where it is drawn.

**Heights get a perceptual curve.** Music sits far below peak most of the time —
across a typical window the mean column height is about 0.16 against a max near
0.94. Drawn literally that is a thin line with occasional spikes, so heights are
raised to a fractional power, lifting the body without touching the peaks.

## Editing

Title, artist, album, genre, comment, rating and colour are editable. Changes
are held as a change-set rather than applied in place, so setting a value back
to its original removes it from the count rather than recording a no-op, and
Discard is always exact.

**Save changes** produces a file; the database is replaced by hand. The page
cannot write to the stick directly — the File System Access API only hands out
a writable directory handle from a picker in a top-level document, and the
published page runs in a sandboxed frame where that picker never opens.

- **Normally** it downloads the rebuilt `exportLibrary.db`. Copy that over
  `PIONEER/rekordbox/` on the device, replacing the original.
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
- Saving produces a file to copy over the original; the page cannot write to
  the device in place.
- Phrase analysis (`PSSI`) and the 3-band waveform (`PWV4`) are parsed but not
  yet displayed.

## License

MIT. Not affiliated with AlphaTheta / Pioneer DJ.
