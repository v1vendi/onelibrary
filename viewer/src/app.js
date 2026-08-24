/**
 * OneLibrary viewer: load a device, browse it, draw waveforms.
 *
 * Everything runs locally. The database is decrypted in the page with
 * WebCrypto and never leaves the machine.
 */

import { decrypt, DecryptError, DEFAULT_KEY } from './sqlcipher.js';
import { SQLiteDatabase } from './sqlite.js';
import { parseAnlz } from './anlz.js';
import { drawOverview, drawDetail, drawSpectrum, TRACK_COLORS } from './waveform.js';
import { fmtPosition, VIS_COLORS } from './player.js';
import { Deck, PITCH_RANGES } from './deck.js';
import { Editor, EDITABLE, saveEdits } from './editor.js';
import { MidiController } from './midi.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const state = {
  db: null,
  files: new Map(), // device-relative path (lowercase) -> File
  tracks: [],
  lookups: {},
  selected: null,
  anlz: null,
  zoomMs: 8000,
  crossfade: 0.5,
};

const decks = { A: new Deck('A'), B: new Deck('B') };

/**
 * Coalesce redraws into one per animation frame.
 *
 * Deck changes are broadcast synchronously, and a dragged fader emits an input
 * event far faster than the display refreshes -- so a canvas that redrew on
 * each one ran the waveform several times per frame and tore. Work is queued
 * here instead and flushed once per frame, which also means the many small
 * changes a single gesture produces cost one redraw between them.
 */
let mixerUnsubscribe = [];
const pendingRedraws = new Set();
let redrawFrame = null;

function scheduleRedraw(fn) {
  pendingRedraws.add(fn);
  if (redrawFrame !== null) return;
  redrawFrame = requestAnimationFrame(() => {
    redrawFrame = null;
    const due = [...pendingRedraws];
    pendingRedraws.clear();
    for (const f of due) f();
  });
}

/**
 * Rebuild the deck DOM, at most once per frame.
 *
 * A rebuild replaces the controls, so doing it mid-gesture would tear the
 * element out from under the pointer. Deferring to a frame boundary keeps a
 * burst of changes to a single rebuild.
 */
let renderFrame = null;
function scheduleRenderDecks() {
  if (renderFrame !== null) return;
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    renderDecks();
  });
}
const editor = new Editor();
let rafHandle = null;
/** The deck a bare space/arrow keypress drives. */
let focusedDeck = 'A';
/** 1 or 2 decks. Two is the mixing layout; one is just a player. */
let deckCount = 1;

// -- loading ---------------------------------------------------------------

function status(msg, kind = 'info') {
  const bar = $('#status');
  bar.textContent = msg;
  bar.dataset.kind = kind;
  bar.hidden = !msg;
}

/** Recursively collect files from a dropped directory entry. */
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.set((prefix + entry.name).toLowerCase(), file);
    return;
  }
  const reader = entry.createReader();
  for (;;) {
    const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
    if (!batch.length) break;
    for (const e of batch) await walkEntry(e, `${prefix}${entry.name}/`, out);
  }
}

async function collectFromDrop(dataTransfer) {
  const out = new Map();
  const items = [...dataTransfer.items];
  const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) {
    for (const e of entries) await walkEntry(e, '', out);
  } else {
    for (const f of dataTransfer.files) out.set(f.name.toLowerCase(), f);
  }
  return out;
}

function findDatabase(files) {
  for (const [path, file] of files) {
    if (path.endsWith('exportlibrary.db')) return { path, file };
  }
  return null;
}

async function load(files) {
  state.files = files;
  const found = findDatabase(files);
  if (!found) {
    const legacy = [...files.keys()].some((p) => p.endsWith('export.pdb'));
    status(
      legacy
        ? 'This device has a legacy Device Library (export.pdb) but no OneLibrary database. In rekordbox, right-click the device and choose "Convert to OneLibrary".'
        : 'No exportLibrary.db found. Drop a device folder, or the database file itself.',
      'error'
    );
    return;
  }

  status(`Decrypting ${found.path}…`);
  const buffer = new Uint8Array(await found.file.arrayBuffer());
  let plain;
  try {
    plain = await decrypt(buffer, DEFAULT_KEY, (done, total) => {
      if (done % 512 === 0) status(`Decrypting… ${done}/${total} pages`);
    });
  } catch (err) {
    status(
      err instanceof DecryptError
        ? `${err.message}`
        : `Unexpected failure: ${err.message}`,
      'error'
    );
    return;
  }

  try {
    state.db = new SQLiteDatabase(plain);
  } catch (err) {
    status(`Decrypted, but the result is not readable: ${err.message}`, 'error');
    return;
  }

  // Empty the decks, now that the new database is known to be readable and the
  // old one is definitely being replaced. A loaded deck holds the previous
  // device's decoded audio, beatgrid and artwork, while everything drawn around
  // it -- title, artist, tempo, the grid itself -- is re-resolved against the
  // database that just replaced it. Left alone the deck keeps playing the old
  // track underneath the new library's grid, which is every part of the page
  // disagreeing with every other at once. Done after the error returns above,
  // so a device that fails to open leaves what is playing alone.
  for (const deck of Object.values(decks)) {
    if (deck.syncOn) deck.disableSync();
    deck.unload();
  }

  buildModel();
  render();
  const anlzCount = [...files.keys()].filter((p) => p.includes('anlz')).length;
  status(
    anlzCount
      ? `Loaded ${state.tracks.length} tracks, ${anlzCount} analysis files.`
      : `Loaded ${state.tracks.length} tracks. No ANLZ files found — drop the whole device folder to see waveforms and cues.`,
    'ok'
  );
  setTimeout(() => status(''), 6000);
}

function indexBy(rows, key) {
  return Object.fromEntries(rows.map((r) => [r[key], r]));
}

function buildModel() {
  const db = state.db;
  const safe = (t) => { try { return db.select(t); } catch { return []; } };
  state.lookups = {
    artist: indexBy(safe('artist'), 'artist_id'),
    album: indexBy(safe('album'), 'album_id'),
    genre: indexBy(safe('genre'), 'genre_id'),
    key: indexBy(safe('key'), 'key_id'),
    color: indexBy(safe('color'), 'color_id'),
    label: indexBy(safe('label'), 'label_id'),
  };
  state.tracks = safe('content');
  state.playlists = safe('playlist');
  state.playlistContent = safe('playlist_content');
  state.property = safe('property')[0] || {};
}

// -- rendering -------------------------------------------------------------

const fmtTime = (s) => {
  if (!s && s !== 0) return '';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

function trackFields(t) {
  const L = state.lookups;
  return {
    artist: L.artist[t.artist_id_artist]?.name || '',
    album: L.album[t.album_id]?.name || '',
    genre: L.genre[t.genre_id]?.name || '',
    key: L.key[t.key_id]?.name || '',
    color: t.color_id ? TRACK_COLORS[t.color_id] : null,
    colorName: L.color[t.color_id]?.name || '',
  };
}

function renderSidebar() {
  const side = $('#sidebar');
  side.replaceChildren();

  const prop = state.property;
  const head = el('div', 'device');
  head.append(el('div', 'device-name', prop.deviceName || 'OneLibrary device'));
  head.append(
    el('div', 'device-meta', `${prop.numberOfContents ?? state.tracks.length} tracks · db v${prop.dbVersion ?? '?'}`)
  );
  if (prop.createdDate) head.append(el('div', 'device-meta', `exported ${prop.createdDate}`));
  side.append(head);

  side.append(el('div', 'label sec-title', 'Playlists'));

  const navButton = (name, count, active, onClick) => {
    const b = el('button', 'nav' + (active ? ' active' : ''));
    b.append(el('span', null, name));
    b.append(el('span', 'n', String(count)));
    b.onclick = onClick;
    return b;
  };

  side.append(
    navButton('All tracks', state.tracks.length, state.filter == null, () => {
      state.filter = null; render();
    })
  );
  for (const p of state.playlists) {
    const count = state.playlistContent.filter((x) => x.playlist_id === p.playlist_id).length;
    side.append(
      navButton(p.name, count, state.filter === p.playlist_id, () => {
        state.filter = p.playlist_id; render();
      })
    );
  }
}

function visibleTracks() {
  if (state.filter == null) return state.tracks;
  const ids = state.playlistContent
    .filter((x) => x.playlist_id === state.filter)
    .sort((a, b) => a.sequenceNo - b.sequenceNo)
    .map((x) => x.content_id);
  const byId = indexBy(state.tracks, 'content_id');
  return ids.map((id) => byId[id]).filter(Boolean);
}

function renderList() {
  const list = $('#list');
  list.replaceChildren();
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [h, cls] of [['', null], ['Title', null], ['Artist', 'artist'],
                          ['BPM', 'r bpm'], ['Key', 'key'], ['Time', 'r'], ['Rating', null]]) {
    hr.append(el('th', cls, h));
  }
  thead.append(hr);
  table.append(thead);
  const tbody = el('tbody');

  for (const t of visibleTracks()) {
    const f = trackFields(t);
    const rating = editor.get(t.content_id, 'rating', t.rating);
    const colorId = editor.get(t.content_id, 'color_id', t.color_id);
    const title = editor.get(t.content_id, 'title', t.title);
    const tr = el('tr');
    tr.className = [
      state.selected?.content_id === t.content_id ? 'sel' : '',
      editor.changes.has(t.content_id) ? 'edited' : '',
    ].filter(Boolean).join(' ');
    const swatch = el('td', 'swatch');
    if (colorId) {
      const dot = el('span', 'dot');
      dot.style.background = TRACK_COLORS[colorId] || '#888';
      swatch.append(dot);
    }
    tr.append(swatch);
    tr.append(el('td', 'title', title || ''));
    tr.append(el('td', 'artist', f.artist));
    tr.append(el('td', 'num bpm', t.bpmx100 ? (t.bpmx100 / 100).toFixed(2) : ''));
    tr.append(el('td', 'key', f.key));
    tr.append(el('td', 'num', fmtTime(t.length)));
    tr.append(el('td', 'stars', '★'.repeat(rating || 0)));
    tr.draggable = true;
    tr.ondragstart = (e) => {
      e.dataTransfer.setData('application/x-onelibrary-track', String(t.content_id));
      e.dataTransfer.effectAllowed = 'copy';
    };
    tr.onclick = () => selectTrack(t);
    tbody.append(tr);
  }
  table.append(tbody);
  list.append(table);
}

/**
 * Fetch the bundled sample device and load it as if it had been dropped.
 *
 * The files are served beside the page rather than embedded: the audio is most
 * of the payload, and inlining it would cost every visitor the download whether
 * or not they ever press the button.
 *
 * `manifest.json` lists the tree because a static host has no directory
 * listing, and the viewer has to know what the device contains before it can
 * read any of it.
 */
async function loadSampleLibrary(btn) {
  const base = 'sample/';
  const original = btn.textContent;
  btn.disabled = true;
  try {
    status('Fetching the sample library…');
    const names = await (await fetch(base + 'manifest.json')).json();
    // Only the device tree itself. CREDITS.md and meta.json sit alongside it
    // for people reading the repository, and are not part of the device.
    const wanted = names.filter((n) => /^(PIONEER|Contents)\//.test(n));
    const files = new Map();
    let done = 0;
    for (const rel of wanted) {
      // Each path segment is encoded separately: the names carry spaces, and
      // encoding the whole path would take the separators with it.
      const url = base + rel.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${rel} — ${res.status}`);
      const blob = await res.blob();
      files.set(rel.toLowerCase(), new File([blob], rel.split('/').pop()));
      btn.textContent = `Loading… ${++done}/${wanted.length}`;
    }
    await load(files);
  } catch (err) {
    status(`Could not load the sample library: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/** Locate a device file by its stored path, which is device-relative. */
function deviceFile(storedPath) {
  if (!storedPath) return null;
  const rel = storedPath.replace(/^\//, '').toLowerCase();
  return state.files.get(rel) || [...state.files].find(([k]) => k.endsWith(rel))?.[1] || null;
}

async function artworkUrlFor(track) {
  if (!track.image_id) return null;
  const row = state.db.select('image').find((i) => i.image_id === track.image_id);
  const file = deviceFile(row?.path);
  return file ? URL.createObjectURL(file) : null;
}

function button(cls, label, title, onClick) {
  const b = el('button', cls, label);
  if (title) { b.title = title; b.setAttribute('aria-label', title); }
  b.onclick = onClick;
  return b;
}

/** Load the selected track onto a deck. */
async function loadDeck(id, track) {
  if (!track) return;
  const deck = decks[id];
  const anlz = await anlzFor(track);
  const hasAudio = await deck.load({
    track,
    anlz,
    audioFile: deviceFile(track.path),
    artworkUrl: await artworkUrlFor(track),
  });
  focusedDeck = id;
  renderDecks();
  if (!hasAudio) {
    status(`Deck ${id}: no audio for this track on the device — waveform and cues only.`);
  }
}

function renderDecks() {
  const wrap = $('#decks');
  wrap.replaceChildren();
  const ids = deckCount === 2 ? ['A', 'B'] : ['A'];
  wrap.dataset.count = String(deckCount);
  if (deckCount === 1 && focusedDeck !== 'A') focusedDeck = 'A';

  // With two decks the scrolling lanes run the full width and stack, as on a
  // CDJ pair: both playheads sit on the same vertical line, which is what makes
  // phase differences between the two tracks visible at a glance.
  const lanes = deckCount === 2 ? el('div', 'lanes') : null;
  if (lanes) wrap.append(lanes);

  const row = el('div', 'deck-row');
  if (deckCount === 2) {
    // Deck, mixer, deck — the desk layout, so each channel strip sits beside
    // the deck it controls.
    row.append(renderDeck(decks.A, lanes), renderMixer(), renderDeck(decks.B, lanes));
    applyCrossfade();
  } else {
    for (const id of ids) row.append(renderDeck(decks[id], lanes));
    decks.A.player.setChannelGain(1);
  }
  wrap.append(row);
  startDeckAnimation();
}

/**
 * Switch between the single player and the two-deck mixing layout.
 *
 * Dropping to one deck stops and unloads the second rather than leaving it
 * playing out of sight.
 */
function setDeckCount(n) {
  deckCount = n;
  if (n === 1) decks.B.unload();
  try { localStorage.setItem('onelibrary.decks', String(n)); } catch { /* private mode */ }
  const btn = $('#decktoggle');
  if (btn) btn.textContent = n === 2 ? 'Single deck' : 'Two decks';
  renderDecks();
}

function renderDeck(deck, lanes = null) {
  const other = decks[deck.id === 'A' ? 'B' : 'A'];
  const panel = el('section', 'deck' + (focusedDeck === deck.id ? ' focused' : ''));
  panel.dataset.deck = deck.id;
  panel.onpointerdown = () => { focusedDeck = deck.id; markFocus(); };

  // Dropping a row from the list loads it onto this deck.
  panel.ondragover = (e) => {
    if (!e.dataTransfer.types.includes('application/x-onelibrary-track')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    panel.classList.add('drop');
  };
  panel.ondragleave = () => panel.classList.remove('drop');
  panel.ondrop = (e) => {
    panel.classList.remove('drop');
    const id = Number(e.dataTransfer.getData('application/x-onelibrary-track'));
    const track = state.tracks.find((t) => t.content_id === id);
    if (!track) return;
    e.preventDefault();
    e.stopPropagation();   // the page-level handler loads devices, not tracks
    loadDeck(deck.id, track);
  };

  // -- header: artwork, identity, tempo, clocks --------------------------
  const head = el('div', 'deck-head');
  const art = el('div', 'art');
  if (deck.artworkUrl) {
    const img = el('img');
    img.src = deck.artworkUrl;
    img.alt = '';
    art.append(img);
  } else {
    art.append(el('span', 'art-empty', deck.id));
  }

  const vis = el('canvas', 'vis');
  vis.title = 'Spectrum';
  const visPeaks = [];

  const ident = el('div', 'ident');
  const f = deck.track ? trackFields(deck.track) : {};
  ident.append(el('div', 'deck-title', deck.track?.title || 'No track loaded'));
  ident.append(el('div', 'deck-artist', f.artist || ''));

  const clocks = el('div', 'clocks');
  const elapsed = el('div', 'clock mono', fmtPosition(deck.player.positionMs));
  const remain = el('div', 'remain mono', '-' + fmtPosition(deck.remainingMs));
  clocks.append(elapsed, remain);

  // Identity and the clock share one display -- two regions of the same
  // panel rather than two separate boxes -- with the visualiser to its left
  // instead of wedged between them.
  const display = el('div', 'display');
  display.append(ident, clocks);
  head.append(art, vis, display);
  panel.append(head);

  // -- waveforms ---------------------------------------------------------
  const detail = el('canvas', 'wave detail');
  const overview = el('canvas', 'wave overview');
  if (lanes) {
    const lane = el('div', 'lane');
    lane.append(el('span', 'lane-tag', deck.id));
    lane.append(detail);
    lanes.append(lane);
    panel.append(overview);
  } else {
    panel.append(detail, overview);
  }

  // -- transport ---------------------------------------------------------
  const bar = el('div', 'deck-bar');

  const loadBtn = button('dbtn load', 'LOAD', `Load the selected track onto deck ${deck.id}`,
    () => loadDeck(deck.id, state.selected));
  bar.append(loadBtn);

  const cueBtn = button('dbtn cue', 'CUE', 'Return to the cue point; press again there to move it',
    () => deck.cue());
  const playBtn = button('dbtn play', deck.player.playing ? '❚❚' : '▶',
    'Play or pause', () => deck.player.toggle());
  bar.append(cueBtn, playBtn);

  // The tempo column sits in the transport row itself, pushed to the far
  // right by its own margin, so it reads as part of the same control cluster
  // as LOAD/CUE/PLAY rather than as a separate block below the pads.
  const tempo = el('div', 'tempo');
  const bpmRead = el('div', 'bpm-read mono',
    deck.bpm === null ? '--.--' : deck.bpm.toFixed(2));
  const pitchRead = el('div', 'pitch-read mono',
    `${deck.pitch >= 0 ? '+' : ''}${deck.pitch.toFixed(1)}%`);
  const readouts = el('div', 'tempo-readouts');
  readouts.append(bpmRead, pitchRead);
  tempo.append(readouts);

  const fader = el('input', 'fader');
  fader.type = 'range';
  fader.min = String(-deck.range);
  fader.max = String(deck.range);
  fader.step = '0.02';
  fader.value = String(deck.pitch);
  fader.title = 'Pitch';
  fader.oninput = () => deck.setPitch(Number(fader.value));
  fader.ondblclick = () => { deck.resetPitch(); renderDecks(); };
  tempo.append(fader);

  const ranges = el('div', 'ranges');
  for (const r of PITCH_RANGES) {
    const b = el('button', 'rbtn' + (deck.range === r ? ' on' : ''), `±${r}`);
    b.onclick = () => { deck.setRange(r); renderDecks(); };
    ranges.append(b);
  }
  tempo.append(ranges);

  // A latch, not a one-shot: while it is on the deck keeps following the other
  // deck's tempo and stays held on its bar grid.
  const sync = button(
    'dbtn sync' + (deck.syncOn ? ' on' : ''),
    'SYNC',
    deck.syncOn ? 'Release the lock' : `Lock to deck ${other.id}`,
    () => {
      if (deck.syncOn) {
        deck.disableSync();
      } else {
        // Only one deck follows; locking this one releases the other so they
        // cannot chase each other.
        if (other.syncOn) other.disableSync();
        const problem = deck.enableSync(other);
        if (problem) { status(`Deck ${deck.id} cannot sync: ${problem}`, 'error'); return; }
        status('');
      }
      renderDecks();
    }
  );
  sync.setAttribute('aria-pressed', String(deck.syncOn));
  if (!deck.loaded || !other.loaded || deckCount === 1) sync.disabled = true;
  // Placed before the ranges so the DOM order matches the visual one: SYNC
  // heads the right-hand column of the tempo block, above the switchers.
  if (deckCount === 2) tempo.insertBefore(sync, ranges);

  // -- hot cues ----------------------------------------------------------
  // Two rows of four: A-D over E-H, which keeps the pads compact rather than
  // stretching a single row across the whole panel.
  const pads = el('div', 'pads');
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    const cue = deck.hotCues.find((c) => c.hotLetter === letter);
    const pad = el('button', 'pad' + (cue ? ' set' : ''), letter);
    pad.title = cue ? `Jump to hot cue ${letter}` : `No hot cue ${letter}`;
    pad.disabled = !cue;
    pad.onclick = () => deck.jumpToHotCue(letter);
    pads.append(pad);
  }

  // The transport buttons and the pads stack in their own column so the
  // tempo block can run down the full height beside them, right where LOAD,
  // CUE and PLAY are, instead of opening a gap under the short button row.
  const controls = el('div', 'deck-controls');
  const left = el('div', 'deck-controls-left');
  left.append(bar, pads);
  controls.append(left, tempo);
  panel.append(controls);

  // -- redraw wiring -----------------------------------------------------
  const redraw = () => {
    drawDetail(detail, deck.anlz?.waveform, deck.cues, deck.anlz?.beats ?? [],
               deck.durationMs, deck.player.positionMs, visibleWindowMs(deck),
               deck.player.envelope);
    drawOverview(overview, deck.anlz?.waveform, deck.cues,
                 deck.durationMs, deck.player.positionMs);
    elapsed.textContent = fmtPosition(deck.player.positionMs);
    remain.textContent = '-' + fmtPosition(deck.remainingMs);
    playBtn.textContent = deck.player.playing ? '❚❚' : '▶';
    // Driven from deck state, not from the fader's own input event, so BEAT
    // SYNC and any other programmatic tempo change show up in the readout too.
    bpmRead.textContent = deck.bpm === null ? '--.--' : deck.bpm.toFixed(2);
    pitchRead.textContent = `${deck.pitch >= 0 ? '+' : ''}${deck.pitch.toFixed(1)}%`;
    if (document.activeElement !== fader) fader.value = String(deck.pitch);
    const analyser = deck.player.analyser;
    if (analyser) {
      if (deck.player.playing) analyser.getByteFrequencyData(deck.player.spectrum);
      else deck.player.spectrum.fill(0);
      drawSpectrum(vis, deck.player.spectrum, visPeaks, VIS_COLORS);
    }
  };
  deck._redraw = redraw;

  // The animation loop only runs while a deck is playing, so anything that
  // moves the playhead while paused — CUE, a hot cue, sync, a keyboard jump —
  // needs its own refresh. Listeners are cleared first because renderDeck runs
  // again on every re-render and would otherwise stack one per pass.
  deck.listeners.clear();
  deck.onChange(() => scheduleRedraw(redraw));

  const seek = (ev) => {
    const r = overview.getBoundingClientRect();
    deck.player.seekMs(((ev.clientX - r.left) / r.width) * deck.durationMs);
    redraw();
  };
  overview.onpointerdown = (ev) => {
    overview.setPointerCapture(ev.pointerId);
    seek(ev);
    overview.onpointermove = (m) => m.buttons && seek(m);
  };
  overview.onpointerup = () => { overview.onpointermove = null; };
  detail.onpointerdown = (ev) => {
    detail.setPointerCapture(ev.pointerId);
    let lastX = ev.clientX;
    detail.onpointermove = (m) => {
      if (!m.buttons) return;
      deck.player.seekMs(deck.player.positionMs -
        ((m.clientX - lastX) / detail.clientWidth) * visibleWindowMs(deck));
      lastX = m.clientX;
      redraw();
    };
  };
  detail.onpointerup = () => { detail.onpointermove = null; };

  requestAnimationFrame(redraw);
  return panel;
}

function markFocus() {
  for (const p of document.querySelectorAll('.deck')) {
    p.classList.toggle('focused', p.dataset.deck === focusedDeck);
  }
}

/** One animation loop for both decks, rather than one each. */
function startDeckAnimation() {
  if (rafHandle) cancelAnimationFrame(rafHandle);
  const tick = () => {
    for (const [id, deck] of Object.entries(decks)) {
      // A locked deck is held every frame, not only when SYNC was pressed.
      if (deck.syncOn) deck.holdSync(decks[id === 'A' ? 'B' : 'A']);
      // Queued rather than called: a change emitted earlier this frame may
      // already have scheduled this deck, and the queue is a set, so the two
      // paths collapse into one draw instead of two.
      if (deck.player.playing && deck._redraw) scheduleRedraw(deck._redraw);
    }
    rafHandle = requestAnimationFrame(tick);
  };
  tick();
}

async function anlzFor(track) {
  const p = track.analysisDataFilePath;
  if (!p) return null;
  const rel = p.replace(/^\//, '').toLowerCase();
  const dat = deviceFile(p);
  const extKey = rel.replace(/\.dat$/, '.ext');
  const ext = state.files.get(extKey) || [...state.files].find(([k]) => k.endsWith(extKey))?.[1];
  if (!dat && !ext) return null;
  try {
    return parseAnlz(
      dat ? new Uint8Array(await dat.arrayBuffer()) : null,
      ext ? new Uint8Array(await ext.arrayBuffer()) : null
    );
  } catch {
    return null;
  }
}

/**
 * Wire a DDJ-FLX4 to the decks.
 *
 * Continuous controls are mapped so the hardware's physical centre matches the
 * software's neutral: an EQ knob at twelve o'clock is 0 dB, a tempo fader at
 * centre is 0%. Jogs move the playhead by time rather than by beats, so a
 * nudge behaves the same whatever the track's tempo.
 */
function createMidi() {
  const controller = new MidiController({
    onStatus: (name) => {
      const btn = $('#midi');
      if (!btn) return;
      btn.classList.toggle('on', Boolean(name));
      btn.textContent = name ? 'FLX4 connected' : 'Connect FLX4';
    },
    playPause: (id) => { decks[id].player.toggle(); scheduleRenderDecks(); },
    cue: (id) => { decks[id].cue(); scheduleRenderDecks(); },
    sync: (id) => {
      const deck = decks[id];
      const other = decks[id === 'A' ? 'B' : 'A'];
      if (deck.syncOn) deck.disableSync();
      else {
        if (other.syncOn) other.disableSync();
        const problem = deck.enableSync(other);
        if (problem) { status(`Deck ${id} cannot sync: ${problem}`, 'error'); return; }
      }
      scheduleRenderDecks();
    },
    hotCue: (id, letter) => decks[id].jumpToHotCue(letter),
    loadA: () => state.selected && loadDeck('A', state.selected),
    loadB: () => state.selected && loadDeck('B', state.selected),
    tempo: (id, fraction) => {
      // Fader centre is 0%; the ends are the deck's current range.
      // A 14-bit fader emits far faster than the display refreshes, so the
      // rebuild is deferred rather than run per message.
      const deck = decks[id];
      deck.setPitch((0.5 - fraction) * 2 * deck.range);
      scheduleRenderDecks();
    },
    channelFader: (id, fraction) => decks[id].player.setVolume(fraction),
    crossfader: (fraction) => { state.crossfade = fraction; applyCrossfade(); },
    eqLow: (id, f) => decks[id].player.setEq('low', eqDbFromKnob(f)),
    eqMid: (id, f) => decks[id].player.setEq('mid', eqDbFromKnob(f)),
    eqHigh: (id, f) => decks[id].player.setEq('high', eqDbFromKnob(f)),
    jogBend: (id, delta) => decks[id].player.seekMs(decks[id].player.positionMs + delta * 4),
    jogScratch: (id, delta) => decks[id].player.seekMs(decks[id].player.positionMs + delta * 12),
    browse: (delta) => moveSelection(delta > 0 ? 1 : -1),
  });
  return controller;
}

/**
 * Knob position to decibels.
 *
 * Centre detent is 0 dB. Below centre runs down to a kill at -26 dB and above
 * it up to +12, which is the asymmetry a DJ mixer has: you cut far further
 * than you boost.
 */
function eqDbFromKnob(fraction) {
  return fraction >= 0.5 ? (fraction - 0.5) * 2 * 12 : (fraction - 0.5) * 2 * 26;
}

/** Step the highlighted track, for the browse encoder. */
function moveSelection(step) {
  const rows = visibleTracks();
  if (!rows.length) return;
  const at = rows.findIndex((t) => t.content_id === state.selected?.content_id);
  const next = rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + step))];
  if (next) selectTrack(next);
}

/**
 * A rotary EQ knob.
 *
 * Real mixers use rotaries here and a pointer round a dial reads faster than a
 * slider when there are six of them side by side. Dragging is vertical because
 * a knob that tracks horizontal movement fights the mouse on a narrow control;
 * double-click returns it to centre.
 */
function knob(label, initialDb, onChange) {
  const MIN = -26, MAX = 12;
  const wrap = el('div', 'knob-wrap');
  const dial = el('div', 'knob');
  dial.tabIndex = 0;
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', `${label} EQ`);
  const pointer = el('div', 'knob-pointer');
  dial.append(pointer);
  const read = el('div', 'knob-read mono');

  let db = initialDb;
  const paint = () => {
    // -26..+12 dB mapped across 270 degrees, with 0 dB straight up.
    const frac = db >= 0 ? db / MAX : db / -MIN;
    dial.style.setProperty('--angle', `${frac * 135}deg`);
    read.textContent = db === 0 ? '0' : `${db > 0 ? '+' : ''}${db.toFixed(0)}`;
    dial.setAttribute('aria-valuenow', db.toFixed(0));
    dial.classList.toggle('killed', db <= MIN + 0.5);
  };
  const set = (next) => {
    db = Math.max(MIN, Math.min(MAX, next));
    paint();
    onChange(db);
  };

  dial.onpointerdown = (ev) => {
    dial.setPointerCapture(ev.pointerId);
    let lastY = ev.clientY;
    dial.onpointermove = (m) => {
      if (!m.buttons) return;
      set(db + (lastY - m.clientY) * 0.5);
      lastY = m.clientY;
    };
  };
  dial.onpointerup = () => { dial.onpointermove = null; };
  dial.ondblclick = () => set(0);
  dial.onkeydown = (ev) => {
    const step = ev.shiftKey ? 6 : 1;
    if (ev.key === 'ArrowUp') { ev.preventDefault(); set(db + step); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); set(db - step); }
    else if (ev.key === 'Home') { ev.preventDefault(); set(0); }
  };

  paint();
  wrap.append(dial, el('div', 'knob-label label', label), read);
  // The dial has to be drivable from outside as well as by the pointer: MIDI
  // moves the same value, and a control that only tracked its own events would
  // sit still while the audio changed under it.
  return {
    el: wrap,
    sync: (value) => {
      if (document.activeElement === dial || value === db) return;
      db = value;
      paint();
    },
  };
}

/** One mixer channel: three EQ knobs over a vertical fader. */
function mixerChannel(deck) {
  const ch = el('div', 'channel');
  ch.append(el('div', 'ch-id', deck.id));

  const eq = el('div', 'eq');
  const knobs = [];
  for (const [band, label] of [['high', 'HI'], ['mid', 'MID'], ['low', 'LO']]) {
    const k = knob(label, deck.player.eq[band], (db) => deck.player.setEq(band, db));
    knobs.push([band, k]);
    eq.append(k.el);
  }
  ch.append(eq);

  const fader = el('input', 'volume');
  fader.type = 'range';
  fader.min = '0'; fader.max = '1'; fader.step = '0.01';
  fader.value = String(deck.player.volume);
  fader.title = `Deck ${deck.id} level`;
  fader.setAttribute('aria-label', `Deck ${deck.id} level`);
  fader.oninput = () => deck.player.setVolume(Number(fader.value));
  ch.append(fader);

  // Follow the player rather than only the pointer, so a controller moving the
  // same value is reflected here. The element being dragged is left alone: a
  // fader that rewrote itself under the pointer would fight the gesture.
  const refresh = () => {
    if (document.activeElement !== fader) fader.value = String(deck.player.volume);
    for (const [band, k] of knobs) k.sync(deck.player.eq[band]);
  };
  mixerUnsubscribe.push(deck.player.onChange(() => scheduleRedraw(refresh)));
  return ch;
}

/**
 * The mixer sits between the two decks, as it does on a real desk.
 *
 * The crossfader runs under both channel strips rather than beside them: it
 * belongs to neither channel, and putting it in its own column made the mixer
 * wider than the decks it separates.
 */
function renderMixer() {
  // Listeners are dropped first: renderMixer runs again on every rebuild and
  // would otherwise stack one subscription per pass.
  for (const off of mixerUnsubscribe) off();
  mixerUnsubscribe = [];

  const mixer = el('section', 'mixer bevel-out');
  mixer.append(mixerChannel(decks.A), mixerChannel(decks.B));

  const cross = el('div', 'crossfade-row');
  const xf = el('input', 'crossfader');
  xf.type = 'range'; xf.min = '0'; xf.max = '1'; xf.step = '0.01';
  xf.value = String(state.crossfade);
  xf.title = 'Crossfader — double-click to centre';
  xf.setAttribute('aria-label', 'Crossfader');
  xf.oninput = () => {
    state.crossfade = Number(xf.value);
    applyCrossfade();
  };
  xf.ondblclick = () => { state.crossfade = 0.5; xf.value = '0.5'; applyCrossfade(); };
  cross.append(xf);
  mixer.append(cross);

  state.syncCrossfader = () => {
    if (document.activeElement !== xf) xf.value = String(state.crossfade);
  };
  return mixer;
}

/**
 * Constant-power crossfade.
 *
 * A linear blend dips in the middle, because two uncorrelated signals at half
 * amplitude sum to less than either at full. Taking the square root of each
 * side keeps total power flat across the travel.
 */
function applyCrossfade() {
  const x = state.crossfade;
  state.syncCrossfader?.();
  decks.A.player.setChannelGain(Math.sqrt(1 - x));
  decks.B.player.setChannelGain(Math.sqrt(x));
}

/**
 * How much of a track's own timeline fills the deck's detail view.
 *
 * The zoom control is expressed in real seconds, not track seconds. A deck
 * running fast covers more of its own timeline per second on screen, so the
 * window is scaled by the playback rate — otherwise two decks locked to the
 * same tempo would scroll at visibly different speeds, and their beat marks
 * would drift apart on screen while the audio stayed together.
 */
function visibleWindowMs(deck) {
  return state.zoomMs * (deck.player.rate || 1);
}

/** The editable metadata form for one track. */
function buildEditor(track, fields) {
  const wrap = el('div', 'editor');
  const id = track.content_id;
  const originalOf = (spec) =>
    spec.kind === 'lookup' ? fields[spec.field] || '' : track[spec.field] ?? null;

  for (const spec of EDITABLE) {
    const original = originalOf(spec);
    const current = editor.get(id, spec.field, original);
    const row = el('div', 'field' + (editor.has(id, spec.field) ? ' changed' : ''));
    row.append(el('label', 'label', spec.label));
    const touched = () => {
      row.classList.toggle('changed', editor.has(id, spec.field));
      renderList();
      renderSaveBar();
    };

    if (spec.kind === 'rating') {
      const stars = el('div', 'stars-edit');
      const paint = (v) => [...stars.children].forEach((s, i) => s.classList.toggle('on', i < v));
      for (let i = 1; i <= 5; i++) {
        const star = el('button', 'star', '★');
        star.title = `${i} star${i === 1 ? '' : 's'}`;
        star.onclick = () => {
          const next = editor.get(id, 'rating', original) === i ? 0 : i;
          editor.set(id, 'rating', next, original);
          paint(next); touched();
        };
        stars.append(star);
      }
      paint(current || 0);
      row.append(stars);
    } else if (spec.kind === 'color') {
      const swatches = el('div', 'swatches');
      const paint = (v) => [...swatches.children].forEach((s) =>
        s.classList.toggle('on', Number(s.dataset.id) === Number(v)));
      for (const c of state.db.select('color')) {
        const b = el('button', 'swatch-btn');
        b.dataset.id = c.color_id;
        b.style.background = TRACK_COLORS[c.color_id] || '#888';
        b.title = c.name;
        b.onclick = () => {
          const next = Number(editor.get(id, 'color_id', original)) === c.color_id ? null : c.color_id;
          editor.set(id, 'color_id', next, original);
          paint(next); touched();
        };
        swatches.append(b);
      }
      const none = el('button', 'swatch-btn none', '×');
      none.title = 'No colour';
      none.onclick = () => { editor.set(id, 'color_id', null, original); paint(null); touched(); };
      swatches.append(none);
      paint(current);
      row.append(swatches);
    } else {
      const input = el('input', 'edit');
      input.type = 'text';
      input.value = current ?? '';
      input.placeholder = '—';
      input.oninput = () => { editor.set(id, spec.field, input.value, original); touched(); };
      row.append(input);
    }
    wrap.append(row);
  }
  return wrap;
}

async function selectTrack(t) {
  state.selected = t;
  renderList();
  const detail = $('#detail');
  detail.replaceChildren();
  detail.hidden = false;

  const f = trackFields(t);
  detail.append(el('h2', null, t.title || '(untitled)'));

  const load = el('div', 'load-row');
  load.append(el('span', 'label', deckCount === 2 ? 'Load to' : 'Load'));
  for (const id of deckCount === 2 ? ['A', 'B'] : ['A']) {
    load.append(button('dbtn', deckCount === 2 ? `DECK ${id}` : 'PLAY DECK',
                       `Load onto deck ${id}`, () => loadDeck(id, t)));
  }
  detail.append(load);

  detail.append(buildEditor(t, f));

  const readonly = el('div', 'meta');
  for (const [k, v] of [
    ['BPM', t.bpmx100 ? (t.bpmx100 / 100).toFixed(2) : ''],
    ['Key', f.key], ['Length', fmtTime(t.length)],
    ['Bitrate', t.bitrate ? `${t.bitrate} kbps` : ''],
  ]) {
    if (!v) continue;
    const item = el('span');
    item.append(el('span', 'label', k + ' '));
    item.append(el('span', 'v', v));
    readonly.append(item);
  }
  detail.append(readonly);
  if (t.path) detail.append(el('div', 'path', t.path));
}

/** The save bar, shown only once there is something to save. */
function renderSaveBar() {
  const bar = $('#savebar');
  bar.hidden = !editor.dirty;
  if (!editor.dirty) return;
  bar.replaceChildren();
  const n = editor.count;
  const tracks = editor.changes.size;
  bar.append(
    el('span', 'count',
       `${n} change${n === 1 ? '' : 's'} on ${tracks} track${tracks === 1 ? '' : 's'}`)
  );

  const save = el('button', 'save', 'Save changes');
  save.onclick = async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      const route = await saveEdits(state.db, editor);
      if (route === 'cancelled') {
        status('Save cancelled.');
      } else {
        status({
          picked: 'Saved. If you wrote over PIONEER/rekordbox/exportLibrary.db the device is up to date.',
          database: 'Saved exportLibrary.db. Copy it into PIONEER/rekordbox/ on the device, replacing the original.',
          changeset: 'Saved onelibrary-edits.json. Apply it with: onelibrary apply onelibrary-edits.json /Volumes/YOURUSB',
        }[route], 'ok');
        if (route === 'picked') { editor.clear(); render(); }
      }
    } catch (err) {
      status(
        err?.code === 'declined'
          ? 'Save cancelled.'
          : `Could not save: ${err?.message || err}`,
        err?.code === 'declined' ? 'info' : 'error'
      );
    } finally {
      save.disabled = false;
      save.textContent = 'Save changes';
    }
  };
  bar.append(save);

  const revert = el('button', 'revert', 'Discard');
  revert.onclick = () => {
    editor.clear();
    if (state.selected) selectTrack(state.selected);
    render();
  };
  bar.append(revert);
}

function render() {
  $('#dropzone').hidden = true;
  $('#main').hidden = false;
  renderSidebar();
  renderList();
  renderDecks();
  renderSaveBar();
}

// -- wiring ----------------------------------------------------------------

/**
 * Skin switching.
 *
 * Winamp's own identity was skinning, so this ships as a switch rather than a
 * replacement. The choice persists, and the classic skin commits to its own
 * dark chassis instead of following the viewer's light/dark theme.
 */
function initSkin() {
  const btn = $('#skin');
  const apply = (skin) => {
    document.documentElement.dataset.skin = skin;
    btn.textContent = skin === 'classic' ? 'Modern skin' : 'Classic skin';
    try { localStorage.setItem('onelibrary.skin', skin); } catch { /* private mode */ }
    if (state.selected) selectTrack(state.selected);
  };
  // The document already carries the resolved skin: a script in the head sets
  // it before first paint so the page does not flash the other one. This only
  // has to agree with it and label the button.
  let saved = document.documentElement.dataset.skin || 'classic';
  try { saved = localStorage.getItem('onelibrary.skin') || saved; } catch { /* ignore */ }
  apply(saved);
  btn.onclick = () => apply(document.documentElement.dataset.skin === 'classic' ? 'modern' : 'classic');
}

function initDeckCount() {
  let saved = 1;
  try { saved = Number(localStorage.getItem('onelibrary.decks')) || 1; } catch { /* ignore */ }
  const btn = $('#decktoggle');
  btn.onclick = () => setDeckCount(deckCount === 2 ? 1 : 2);
  deckCount = saved === 2 ? 2 : 1;
  btn.textContent = deckCount === 2 ? 'Single deck' : 'Two decks';
}

function initSidebar() {
  const btn = $('#sidetoggle');
  const apply = (collapsed) => {
    $('#main').dataset.sidebar = collapsed ? 'collapsed' : 'open';
    btn.textContent = collapsed ? '▸' : '◂';
    btn.title = collapsed ? 'Show playlists' : 'Hide playlists';
    btn.setAttribute('aria-expanded', String(!collapsed));
    try { localStorage.setItem('onelibrary.sidebar', collapsed ? '1' : '0'); } catch { /* ignore */ }
  };
  let collapsed = false;
  try { collapsed = localStorage.getItem('onelibrary.sidebar') === '1'; } catch { /* ignore */ }
  apply(collapsed);
  btn.onclick = () => apply($('#main').dataset.sidebar !== 'collapsed');
}

export function init() {
  initSkin();
  initDeckCount();
  initSidebar();
  const zone = $('#dropzone');
  // A track being dragged to a deck must not look like a device being dropped
  // on the page, so those drags are left alone here.
  const isTrackDrag = (e) =>
    e.dataTransfer?.types.includes('application/x-onelibrary-track');

  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => {
      if (isTrackDrag(e)) return;
      e.preventDefault();
      zone.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  }
  document.addEventListener('drop', async (e) => {
    if (isTrackDrag(e)) return;
    status('Reading files…');
    await load(await collectFromDrop(e.dataTransfer));
  });
  $('#picker').addEventListener('change', async (e) => {
    const out = new Map();
    for (const f of e.target.files) {
      out.set((f.webkitRelativePath || f.name).toLowerCase(), f);
    }
    await load(out);
  });

  const sampleBtn = $('#trysample');
  if (sampleBtn) sampleBtn.onclick = () => loadSampleLibrary(sampleBtn);

  const midiBtn = $('#midi');
  if (midiBtn) {
    const controller = createMidi();
    midiBtn.onclick = async () => {
      if (controller.connected) { controller.disconnect(); return; }
      const problem = await controller.connect();
      status(problem || `Connected to ${controller.deviceName}.`, problem ? 'error' : 'ok');
    };
  }

  // Transport shortcuts, suppressed while a metadata field has focus so typing
  // a title does not scrub the deck.
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    const deck = decks[focusedDeck];
    if (e.key === ' ') { e.preventDefault(); deck.player.toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); deck.player.jumpCue(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); deck.player.jumpCue(1); }
    else if (e.key.toLowerCase() === 'q') { focusedDeck = 'A'; markFocus(); }
    else if (e.key.toLowerCase() === 'w') { focusedDeck = 'B'; markFocus(); }
    else if (e.key === 'Escape') { deck.cue(); }
  });

  // Public API: drive the viewer without a drag-and-drop gesture. `files` maps
  // lowercase device-relative paths to File or Blob objects.
  window.OneLibraryViewer = { load, selectTrack, loadDeck, state, decks, editor };
}
