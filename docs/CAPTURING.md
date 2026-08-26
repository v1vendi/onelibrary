# Capturing an export

Everything downstream — the schema, the field semantics, the writer — depends
on captures made here. This is the protocol.

## Prerequisites

A USB stick or SD card, formatted by rekordbox (`Preferences → Advanced →
USB/SD` or right-click the device in the tree view). Any size; the test
playlist should be small.

## One-time: a controlled baseline

A small, deliberately varied playlist makes diffs readable. Twelve tracks or
so, chosen so that each capture isolates one variable cleanly.

1. In rekordbox, make a playlist called `ONELIBRARY-TEST`.
2. Add ~12 tracks. Include at least one of each: a track with no cues, a track
   with several hot cues, a track with a saved loop, a track with a rating, a
   track with a colour, and a track with a myTag.
3. Export to the device. Make sure the export is in **OneLibrary** format —
   right-click the device in the tree view; if it offers *Convert to
   OneLibrary*, the device is still on the legacy format and needs converting.
4. Eject properly, then re-mount.

```bash
python tools/capture.py /Volumes/YOURUSB -o tests/corpus/00-baseline
```

Confirm it found the database:

```bash
onelibrary inspect /Volumes/YOURUSB
```

If `OneLibrary: no` but `legacy PDB: yes`, the device was not converted — go
back to step 3. (`inspect` will happily read the legacy library instead, but
that is not what is being captured here.)

## The differential sequence

Each step changes **exactly one thing**, re-exports, and captures. One variable
per capture is the whole point; two changes at once produces a diff nobody can
attribute.

| Capture | Change to make | Isolates |
|---|---|---|
| `01-hotcue` | Add one hot cue to one track | hot cue storage, position units |
| `02-hotcue-move` | Move that same hot cue slightly | position encoding, resolution |
| `03-hotcue-colour` | Recolour that hot cue | cue colour enum |
| `04-memcue` | Add one memory cue to a different track | memory vs hot cue discriminator |
| `05-loop` | Save one loop | loop end field, loop flag |
| `06-rating` | Set one track to 4 stars | rating scale (0–5 vs 0–255) |
| `07-colour` | Set one track's colour to red | track colour enum |
| `08-mytag` | Apply one myTag | tag join table |
| `09-beatgrid` | Nudge one track's first downbeat | beatgrid storage, ANLZ vs DB |
| `10-bpm` | Change one track's BPM | tempo units (likely centi-BPM) |
| `11-playlist-order` | Swap two tracks' order in the playlist | ordering key |
| `12-playlist-rename` | Rename the playlist | playlist row identity |
| `13-folder` | Move the playlist into a new folder | tree parent linkage |
| `14-history` | Play a track on the device, then re-capture | history session writing |

```bash
# after each change + re-export:
python tools/capture.py /Volumes/YOURUSB -o tests/corpus/01-hotcue
python tools/diff_exports.py tests/corpus/00-baseline tests/corpus/01-hotcue
```

Diff against the *immediately preceding* capture for incremental changes
(`02` vs `01`), and against `00-baseline` for independent ones.

## Reading a diff

The tool suppresses `usn`, `rb_local_usn`, `created_at`, `updated_at` by
default — rekordbox rewrites these on every export and they would bury the
signal. If a diff still looks noisy, add more with `--ignore`.

Blob columns are reported by byte offset:

```
  ~ id=42.analysis_data: blob 2/128 bytes differ: @16: 00->01, @17: 2c->91
```

Two bytes at offset 16 changing when one hot cue moved is a 16-bit position
field at that offset. That is how the packed layouts get resolved.

## Privacy

Captures contain your music metadata — titles, artists, file paths, play
history. `tests/corpus/` is gitignored. Do not commit captures, and redact
before sharing a diff publicly.
