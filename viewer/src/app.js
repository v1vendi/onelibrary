/**
 * OneLibrary viewer: load a device, browse it, draw waveforms.
 *
 * Everything runs locally. The database is decrypted in the page with
 * WebCrypto and never leaves the machine.
 */

import { decrypt, DecryptError, DEFAULT_KEY } from './sqlcipher.js';
import { SQLiteDatabase } from './sqlite.js';
import { parseAnlz } from './anlz.js';
import { drawOverview, drawDetail, TRACK_COLORS } from './waveform.js';
import { fmtPosition } from './player.js';
import { Deck, PITCH_RANGES } from './deck.js';
import { Editor, EDITABLE, saveEdits } from './editor.js';

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
};

const decks = { A: new Deck('A'), B: new Deck('B') };
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

async function anlzFor(track) {
  const p = track.analysisDataFilePath;
  if (!p) return null;
  const rel = p.replace(/^\//, '').toLowerCase();
  const dat = state.files.get(rel) || [...state.files].find(([k]) => k.endsWith(rel))?.[1];
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
  const hasAudio = deck.load({
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
  for (const id of ids) row.append(renderDeck(decks[id], lanes));
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
  head.append(art);

  const ident = el('div', 'ident');
  const f = deck.track ? trackFields(deck.track) : {};
  ident.append(el('div', 'deck-title', deck.track?.title || 'No track loaded'));
  ident.append(el('div', 'deck-artist', f.artist || ''));
  head.append(ident);

  const clocks = el('div', 'clocks');
  const elapsed = el('div', 'clock mono', fmtPosition(deck.player.positionMs));
  const remain = el('div', 'remain mono', '-' + fmtPosition(deck.remainingMs));
  clocks.append(elapsed, remain);
  head.append(clocks);
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

  // Tempo: readout, fader, range, sync.
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
  bar.append(tempo);

  // A latch, not a one-shot: while it is on the deck keeps following the other
  // deck's tempo and stays held on its bar grid.
  const sync = button(
    'dbtn sync' + (deck.syncOn ? ' on' : ''),
    'BEAT SYNC',
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
  if (deckCount === 2) bar.append(sync);
  panel.append(bar);

  // -- hot cues ----------------------------------------------------------
  const pads = el('div', 'pads');
  for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) {
    const cue = deck.hotCues.find((c) => c.hotLetter === letter);
    const pad = el('button', 'pad' + (cue ? ' set' : ''), letter);
    pad.title = cue ? `Jump to hot cue ${letter}` : `No hot cue ${letter}`;
    pad.disabled = !cue;
    pad.onclick = () => deck.jumpToHotCue(letter);
    pads.append(pad);
  }
  panel.append(pads);

  // -- redraw wiring -----------------------------------------------------
  const redraw = () => {
    drawDetail(detail, deck.anlz?.waveform, deck.cues, deck.anlz?.beats ?? [],
               deck.durationMs, deck.player.positionMs, state.zoomMs);
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
  };
  deck._redraw = redraw;

  // The animation loop only runs while a deck is playing, so anything that
  // moves the playhead while paused — CUE, a hot cue, sync, a keyboard jump —
  // needs its own refresh. Listeners are cleared first because renderDeck runs
  // again on every re-render and would otherwise stack one per pass.
  deck.listeners.clear();
  deck.onChange(redraw);

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
        ((m.clientX - lastX) / detail.clientWidth) * state.zoomMs);
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
      if (deck.player.playing) deck._redraw?.();
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
  let saved = 'modern';
  try { saved = localStorage.getItem('onelibrary.skin') || 'modern'; } catch { /* ignore */ }
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
