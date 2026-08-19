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
| `src/sqlite.js` | A minimal read-only SQLite reader — b-trees, records, overflow pages |
| `src/anlz.js` | ANLZ cues, beatgrid and waveforms |
| `src/waveform.js` | Canvas rendering |

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

## Limitations

- Reads the `.DAT` and `.EXT` files a track references. Drop the **whole
  device**, not just the database, or there are no waveforms.
- Read-only.
- Phrase analysis (`PSSI`) and the 3-band waveform (`PWV4`) are parsed but not
  yet displayed.

## License

MIT. Not affiliated with AlphaTheta / Pioneer DJ.
