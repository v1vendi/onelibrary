# Producing the sample library

The viewer ships a small device it can load on its own, so someone who has
never seen a OneLibrary export can still try the thing. That device lives in
[`viewer/sample/`](../viewer/sample) and is fetched over HTTP by the *Load a
sample library* link.

It is a **real rekordbox export**. Nothing in it is written by this project:
`tools/import_sample_library.py` copies what rekordbox produced, byte for byte,
and only arranges the files into the layout the page fetches.

That is a deliberate reversal. The sample used to be synthesised end to end by
`tools/make_sample_library.py`, analysis included — and synthesising analysis
means detecting tempo, which it got subtly wrong: 119.85 BPM against a track cut
at 120, 149.80 against 150. A constant grid a fifth of a BPM out looks right for
the first bars and is three quarters of a beat out by the end. The fix is not a
better detector. It is to stop detecting and use the analysis rekordbox already
did.

## What you need

Audio you are allowed to redistribute. This is a public repository and every
visitor downloads these files, so "free to listen to" is not enough — it has to
be a licence that permits redistribution.

The current three are by Kevin MacLeod under **Creative Commons: By
Attribution**, which permits it as long as attribution ships alongside. They are
already in the tree under `viewer/sample/Contents/`, so you can re-import those
rather than sourcing new ones.

> Tracks that are *free to use in videos* — the Monstercat catalogue, Crab Rave
> among it — are not redistributable. They can be played over your own content
> with credit; they cannot be committed to a repository and served to everyone
> who opens the page. That is a different permission, and this needs the second
> one.

Keep the total under about 25 MB. The page downloads all of it in one go, and
the importer warns past that. The current set is 11.4 MB, helped by re-encoding
to 128 kbps — a derivative, which By Attribution allows.

## In rekordbox

1. **Import the audio** and let rekordbox analyse it. The analysis is the whole
   point of doing this in rekordbox, so let it finish before exporting.

2. **Check the grid against the music.** Play each track and confirm the
   downbeats land on the downbeats. Tempo detection is normally right on
   four-to-the-floor material and is worth a listen on anything else — if the
   grid is wrong here it will be wrong in the sample, and the importer cannot
   tell (see below).

3. **Set cues worth showing.** Hot cues and memory cues are a large part of what
   the viewer displays, and a sample with none of them demonstrates very little.
   A few hot cues across the pads, and a memory cue or two, is enough.

4. **Fill in the metadata**, including a comment naming the licence. The
   viewer shows title, artist, album, genre, comment, rating and colour, so
   anything left blank is a blank column in the demo.

5. **Put them in a playlist.** The viewer has a playlist pane; without one there
   is nothing in it.

6. **Export to a USB stick or SD card**, and give the device an impersonal
   name. The name is stored in the database as `property.deviceName` and ships
   publicly — the importer prints it so you can catch it before it does.

7. **Make sure it exports as OneLibrary, not the legacy format.** If the device
   comes back with `PIONEER/rekordbox/export.pdb` and no `exportLibrary.db`,
   it is a legacy Device Library. In rekordbox, right-click the device and
   choose *Convert to OneLibrary*. The importer will not find a database
   otherwise, and neither will the viewer.

Menu wording moves between rekordbox versions; the intent above is stable even
where the exact labels are not.

## Packaging it

```bash
cd python
python tools/import_sample_library.py /Volumes/YOURDEVICE
```

It defaults to writing `viewer/sample/`. It reads the export, checks it, then
copies the database, the audio, and every ANLZ file beside each track's `.DAT`
— the `.EXT` sibling carries the modern cues and the colour waveform, and the
viewer reads both. Finally it writes `manifest.json`, which is how the page
knows what to fetch, since it cannot list a directory over HTTP.

`CREDITS.md` is preserved across a re-import rather than regenerated — it is
written by hand and carries the attribution the licence requires. **Update it
if you change the tracks.** The importer warns if it is missing but cannot know
whether its contents still match what you shipped.

Nothing is written if a check fails. `--force` overrides that.

## What the checks do and do not catch

The importer compares each stored tempo against the beatgrid actually written,
which catches a corrupt or mismatched grid. It does **not** catch a grid that is
wrong about the music: whatever detector wrote the grid wrote the tempo too, so
the two agree perfectly while both being wrong. That is exactly how the
synthesised grids passed unnoticed for as long as they did. Only comparing the
grid against the audio catches it, and that is the analysis this script exists
to stop doing — which is why step 2 above is a listen, not a command.

The one cheap signal that does catch it is arithmetic. Produced music is cut to
a whole or half BPM almost without exception, so a tempo far from one is a sign
the analysis missed rather than that the track is unusual. The importer reports
it as a hint, not a verdict, because live and acoustic material genuinely sits
anywhere.

## Verifying it in the page

```bash
cd viewer && npm run serve
```

Open http://localhost:8777, click *Load a sample library*, and load a track onto
a deck. The grid marks should sit on the transients, and the downbeat lines on
the bar. Play it against the second deck with SYNC to confirm the bars line up
— a grid that is slightly out reads as two tracks slowly walking apart, which
is the failure this whole arrangement exists to prevent.
