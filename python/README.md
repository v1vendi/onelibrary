# onelibrary

An open-source Python implementation of **OneLibrary**, the cross-brand DJ
library format that AlphaTheta and Algoriddim launched in October 2025 as the
successor to rekordbox's legacy DeviceSQL (`export.pdb`) USB exports.

> **Status: pre-alpha.** The decryption layer works and is verified. The format
> itself is still being reverse-engineered. Nothing here is stable yet.

Part of the [onelibrary](https://github.com/v1vendi/onelibrary) project. The
format specification lives in [`spec/ONELIBRARY.md`](../spec/ONELIBRARY.md), and
a browser viewer for the same format lives in [`viewer/`](../viewer).

## Why

The legacy PDB format is well documented by the community — crate-digger,
rekordcrate, pyrekordbox, rekordbox-parser. OneLibrary is not, and AlphaTheta
is migrating its product line onto it (CDJ-3000X, XDJ-AZ, OPUS-QUAD, OMNIS-DUO,
and CDJ-3000 on firmware 3.15+). Every open-source tool that reads or writes
rekordbox USBs needs this format documented.

Some prior art exists for *reading*: [`onelibrary-connect`](https://github.com/chrisle/onelibrary-connect)
(TypeScript) and `rbox` (Python). Nothing open-source can **write** a OneLibrary
export. That is the gap this project aims to fill.

## Install

```bash
uv pip install -e .
```

Requires Python 3.10+ and `sqlcipher3-wheels` (macOS arm64, Linux, and Windows
wheels are published; note that `sqlcipher3-binary` has **no** macOS arm64
wheels, which is why this project does not use it).

## Use

```bash
onelibrary inspect /Volumes/MYUSB     # what is on this device
onelibrary schema  /Volumes/MYUSB     # CREATE statements
onelibrary dump    /Volumes/MYUSB --table content --limit 5
onelibrary key     /Volumes/MYUSB     # how the passphrase resolves
```

```python
from onelibrary import OneLibraryDB

with OneLibraryDB("/Volumes/MYUSB") as db:
    for table in db.tables():
        print(table, db.row_count(table))
```

### Applying edits from the viewer

The browser viewer cannot write to a device in place, so it emits a change-set
instead. Apply it with:

```bash
onelibrary apply onelibrary-edits.json /Volumes/MYUSB
```

The change-set records the value the browser saw alongside the new one, so
`apply` refuses any field the device has changed since — `--force` overrides.

## Encryption

`PIONEER/rekordbox/exportLibrary.db` is a SQLCipher database using SQLCipher 4
defaults (AES-256-CBC, 4096-byte pages, PBKDF2-HMAC-SHA512 at 256,000
iterations, per-page HMAC-SHA512). The passphrase is passed as a **string**,
not as a raw hex key.

The passphrase is resolved in three tiers: an explicit `--key` or
`$ONELIBRARY_KEY`; runtime extraction from your own installed rekordbox
(cached under `~/.cache/onelibrary/`); and a bundled constant as a last
resort. Candidates are validated by actually decrypting the target database,
so a stale constant fails loudly rather than producing a confusing error.

## Scope and limitations

**Generated exports have not been tested on hardware.** This project is
developed without access to a CDJ-3000X, XDJ-AZ, OPUS-QUAD, or OMNIS-DUO.
Round-tripping through rekordbox itself is the strongest verification
performed here. Do not assume a generated device will boot on a player until
someone has actually tried it.

This is an interoperability project. It reads and writes your own library. It
does not circumvent DRM on audio content and ships no copyrighted material.

Not affiliated with, endorsed by, or supported by AlphaTheta / Pioneer DJ.

## Development

```bash
uv venv && uv pip install -e . --group dev
pytest
```

Reverse-engineering workflow — capture a baseline, change exactly one thing in
rekordbox, re-export, and diff:

```bash
python tools/capture.py /Volumes/MYUSB -o tests/corpus/00-baseline
python tools/capture.py /Volumes/MYUSB -o tests/corpus/01-one-hotcue
python tools/diff_exports.py tests/corpus/00-baseline tests/corpus/01-one-hotcue
```

Captures contain personal music metadata; `tests/corpus/` is gitignored. See
[`docs/CAPTURING.md`](../docs/CAPTURING.md).

`tools/import_sample_library.py` packages a real rekordbox export into the
sample library the viewer ships; see
[`docs/SAMPLE_LIBRARY.md`](../docs/SAMPLE_LIBRARY.md) for how to produce the
export it consumes.

## License

MIT
