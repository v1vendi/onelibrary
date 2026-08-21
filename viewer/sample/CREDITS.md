# Sample library credits

The three tracks in this sample device are by **Kevin MacLeod** (incompetech.com)
and are used under **Creative Commons: By Attribution**. Attribution is a
condition of that licence, which is what this file is for.

| Track | Album | Source |
|---|---|---|
| Electrodoodle | Incompetech | https://incompetech.com/music/royalty-free/ |
| Cipher | Electronic Light | https://incompetech.com/music/royalty-free/ |
| Cold Funk | Funkorama | https://incompetech.com/music/royalty-free/ |

Kevin MacLeod's own prescribed attribution is:

> Music by Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution

The audio has been **re-encoded to 128 kbps** from the 320 kbps originals, to
keep the page a reasonable download. That is a derivative, which By Attribution
permits. The originals came from the Internet Archive item
[`kevin-macleod-music-col`](https://archive.org/details/kevin-macleod-music-col).

> That Archive item is tagged Public Domain Mark by its uploader. That tag looks
> wrong — Kevin MacLeod releases under By Attribution, not into the public
> domain — so these files are treated as By Attribution and credited here
> accordingly. Confirm the exact licence version at incompetech.com before
> relying on it for anything beyond this demo.

## Everything else here

The database and the analysis are **synthesised**, not copied from a rekordbox
export. `python/tools/make_sample_library.py` detects the tempo, builds the
beatgrid, summarises the waveforms and writes the ANLZ and the encrypted
database. Section layouts are taken byte for byte from a real export.

The beatgrids are therefore *estimates*. They are close — each grid sits on
2.2–2.6x the average onset energy of its track — but they are not rekordbox's
own analysis, and the hot cues are placed every 32 bars by arithmetic rather
than by anyone listening to the music.

## Rebuilding

```bash
python tools/make_sample_library.py AUDIO... --meta meta.json -o ../viewer/sample
```

Requires ffmpeg and numpy, neither of which is a dependency of the library.
