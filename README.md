# onelibrary

Open-source tooling for **OneLibrary**, the cross-brand DJ library format that
AlphaTheta and Algoriddim launched in October 2025 as the successor to
rekordbox's legacy DeviceSQL (`export.pdb`) USB exports.

> **Status: pre-alpha.** The decryption layer works and is verified. The format
> itself is still being reverse-engineered. Nothing here is stable yet.

**[Open the viewer →](https://v1vendi.github.io/onelibrary/)** — drag a USB
stick onto the page and browse the library, then mix off it: a two-deck player
with a mixer, beat sync and hot cues, playable from a **Pioneer DDJ-FLX4** over
Web MIDI. Everything runs locally; nothing is uploaded, and there is nothing to
install. No device to hand? The page loads a **sample library** so you can try
it without one.

## What is here

| | |
|---|---|
| **[`python/`](python)** | The `onelibrary` library and CLI — read and write exports, resolve keys, parse ANLZ. [README](python/README.md) |
| **[`viewer/`](viewer)** | A browser viewer and two-deck player for the same format — decrypts in the page with WebCrypto, no server, DDJ-FLX4 over Web MIDI. [README](viewer/README.md) |
| **[`spec/`](spec)** | The format specification: [`ONELIBRARY.md`](spec/ONELIBRARY.md) and the captured [`schema.sql`](spec/schema.sql) |
| **[`docs/`](docs)** | Reverse-engineering method — [`CAPTURING.md`](docs/CAPTURING.md) |

The two implementations are independent: the viewer is plain JavaScript with no
build dependencies and does not call the Python library. They meet at the format
specification, and at one file — the viewer cannot write to a device in place,
so it emits a change-set that the CLI applies:

```bash
onelibrary apply onelibrary-edits.json /Volumes/MYUSB
```

## Why

The legacy PDB format is well documented by the community — crate-digger,
rekordcrate, pyrekordbox, rekordbox-parser. OneLibrary is not, and AlphaTheta
is migrating its product line onto it (CDJ-3000X, XDJ-AZ, OPUS-QUAD, OMNIS-DUO,
and CDJ-3000 on firmware 3.15+). Every open-source tool that reads or writes
rekordbox USBs needs this format documented.

Some prior art exists for *reading*: [`onelibrary-connect`](https://github.com/chrisle/onelibrary-connect)
(TypeScript) and `rbox` (Python). Nothing open-source can **write** a OneLibrary
export. That is the gap this project aims to fill, alongside a written format
specification.

## Quick start

```bash
# the library
uv pip install -e ./python
onelibrary inspect /Volumes/MYUSB

# the viewer
cd viewer && npm test && npm run build   # -> dist/index.html, one self-contained file
```

The viewer has no dependencies to install — no lockfile, no `node_modules`, no
WASM blob. `npm run build` inlines every module into a single HTML file that
works from a `file://` URL.

## Scope and limitations

**Generated exports have not been tested on hardware.** This project is
developed without access to a CDJ-3000X, XDJ-AZ, OPUS-QUAD, or OMNIS-DUO.
Round-tripping through rekordbox itself is the strongest verification
performed here. Do not assume a generated device will boot on a player until
someone has actually tried it.

This is an interoperability project. It reads and writes your own library. It
does not circumvent DRM on audio content and ships no copyrighted material.

Not affiliated with, endorsed by, or supported by AlphaTheta / Pioneer DJ.

## License

MIT. See [LICENSE](LICENSE).
