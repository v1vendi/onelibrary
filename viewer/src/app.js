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
import { Player, fmtPosition } from './player.js';
import { Editor, EDITABLE, buildEditedDatabase, downloadDatabase } from './editor.js';

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

const player = new Player();
const editor = new Editor();
let rafHandle = null;

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
  const key = $('#key').value.trim() || DEFAULT_KEY;
  let plain;
  try {
    plain = await decrypt(buffer, key, (done, total) => {
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
                          ['BPM', 'r'], ['Key', null], ['Time', 'r'], ['Rating', null]]) {
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
    tr.append(el('td', 'num', t.bpmx100 ? (t.bpmx100 / 100).toFixed(2) : ''));
    tr.append(el('td', null, f.key));
    tr.append(el('td', 'num', fmtTime(t.length)));
    tr.append(el('td', 'stars', '★'.repeat(rating || 0)));
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

/** Locate the audio file for a track in the dropped device tree. */
function audioFileFor(track) {
  if (!track.path) return null;
  const rel = track.path.replace(/^\//, '').toLowerCase();
  return (
    state.files.get(rel) ||
    [...state.files].find(([k]) => k.endsWith(rel))?.[1] ||
    null
  );
}

function transportButton(label, title, onClick) {
  const b = el('button', 'tbtn', label);
  b.title = title;
  b.setAttribute('aria-label', title);
  b.onclick = onClick;
  return b;
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

    if (spec.kind === 'rating') {
      const stars = el('div', 'stars-edit');
      const paint = (value) => {
        [...stars.children].forEach((s, i) => s.classList.toggle('on', i < value));
      };
      for (let i = 1; i <= 5; i++) {
        const star = el('button', 'star', '★');
        star.title = `${i} star${i === 1 ? '' : 's'}`;
        star.onclick = () => {
          const next = editor.get(id, 'rating', original) === i ? 0 : i;
          editor.set(id, 'rating', next, original);
          paint(next);
          row.classList.toggle('changed', editor.has(id, 'rating'));
          renderList();
          renderSaveBar();
        };
        stars.append(star);
      }
      paint(current || 0);
      row.append(stars);
    } else if (spec.kind === 'color') {
      const swatches = el('div', 'swatches');
      const paint = (value) => {
        [...swatches.children].forEach((s) =>
          s.classList.toggle('on', Number(s.dataset.id) === Number(value))
        );
      };
      for (const c of state.db.select('color')) {
        const b = el('button', 'swatch-btn');
        b.dataset.id = c.color_id;
        b.style.background = TRACK_COLORS[c.color_id] || '#888';
        b.title = c.name;
        b.onclick = () => {
          const next = Number(editor.get(id, 'color_id', original)) === c.color_id ? null : c.color_id;
          editor.set(id, 'color_id', next, original);
          paint(next);
          row.classList.toggle('changed', editor.has(id, 'color_id'));
          renderList();
          renderSaveBar();
        };
        swatches.append(b);
      }
      const none = el('button', 'swatch-btn none', '×');
      none.title = 'No colour';
      none.onclick = () => {
        editor.set(id, 'color_id', null, original);
        paint(null);
        row.classList.toggle('changed', editor.has(id, 'color_id'));
        renderList();
        renderSaveBar();
      };
      swatches.append(none);
      paint(current);
      row.append(swatches);
    } else {
      const input = el('input', 'edit');
      input.type = 'text';
      input.value = current ?? '';
      input.placeholder = '—';
      input.oninput = () => {
        editor.set(id, spec.field, input.value, original);
        row.classList.toggle('changed', editor.has(id, spec.field));
        renderList();
        renderSaveBar();
      };
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

  const overview = el('canvas', 'wave overview');
  const detailCanvas = el('canvas', 'wave detail');
  detail.append(detailCanvas);
  detail.append(overview);

  const transport = el('div', 'transport');
  detail.append(transport);
  const legend = el('div', 'legend');
  detail.append(legend);
  if (t.path) detail.append(el('div', 'path', t.path));

  const anlz = await anlzFor(t);
  state.anlz = anlz;
  const durationFallback = (t.length || 0) * 1000;

  if (!anlz) {
    legend.textContent = 'No analysis file loaded for this track.';
    return;
  }

  const audio = audioFileFor(t);
  const hasAudio = player.load(audio, anlz.cues);

  const duration = () => player.durationMs || durationFallback;
  const redraw = () => {
    const pos = player.positionMs;
    drawDetail(detailCanvas, anlz.waveform, anlz.cues, anlz.beats, duration(), pos, state.zoomMs);
    drawOverview(overview, anlz.waveform, anlz.cues, duration(), pos);
  };

  // --- transport ---------------------------------------------------------
  const playBtn = transportButton('▶', 'Play or pause (space)', () => player.toggle());
  transport.append(transportButton('⏮', 'Previous cue (left arrow)', () => player.jumpCue(-1)));
  transport.append(playBtn);
  transport.append(transportButton('⏭', 'Next cue (right arrow)', () => player.jumpCue(1)));

  const clock = el('span', 'clock mono', '0:00.0');
  transport.append(clock);
  transport.append(el('span', 'clock-total mono', `/ ${fmtTime(t.length)}`));

  const zoom = el('div', 'zoom');
  zoom.append(el('span', 'label', 'Zoom'));
  for (const [ms, name] of [[4000, '4s'], [8000, '8s'], [16000, '16s'], [32000, '32s']]) {
    const b = el('button', 'zbtn' + (state.zoomMs === ms ? ' on' : ''), name);
    b.onclick = () => {
      state.zoomMs = ms;
      for (const other of zoom.querySelectorAll('.zbtn')) other.classList.remove('on');
      b.classList.add('on');
      redraw();
    };
    zoom.append(b);
  }
  transport.append(zoom);

  if (!hasAudio) {
    transport.append(
      el('span', 'nowav', 'no audio on this device — waveform and cues only')
    );
    for (const b of transport.querySelectorAll('.tbtn')) b.disabled = true;
  }

  // --- interaction -------------------------------------------------------
  const seekFromOverview = (ev) => {
    const r = overview.getBoundingClientRect();
    player.seekMs(((ev.clientX - r.left) / r.width) * duration());
    redraw();
  };
  overview.onpointerdown = (ev) => {
    overview.setPointerCapture(ev.pointerId);
    seekFromOverview(ev);
    overview.onpointermove = (m) => m.buttons && seekFromOverview(m);
  };
  overview.onpointerup = () => { overview.onpointermove = null; };

  // Dragging the detail view scrubs, at the zoom level currently shown.
  detailCanvas.onpointerdown = (ev) => {
    detailCanvas.setPointerCapture(ev.pointerId);
    let lastX = ev.clientX;
    detailCanvas.onpointermove = (m) => {
      if (!m.buttons) return;
      const dx = m.clientX - lastX;
      lastX = m.clientX;
      player.seekMs(player.positionMs - (dx / detailCanvas.clientWidth) * state.zoomMs);
      redraw();
    };
  };
  detailCanvas.onpointerup = () => { detailCanvas.onpointermove = null; };

  player.onChange(() => {
    playBtn.textContent = player.playing ? '⏸' : '▶';
    clock.textContent = fmtPosition(player.positionMs);
    redraw();
  });

  if (rafHandle) cancelAnimationFrame(rafHandle);
  const tick = () => {
    if (player.playing) {
      clock.textContent = fmtPosition(player.positionMs);
      redraw();
    }
    rafHandle = requestAnimationFrame(tick);
  };
  tick();

  // --- legend ------------------------------------------------------------
  const hot = anlz.cues.filter((c) => !c.isMemory);
  const mem = anlz.cues.filter((c) => c.isMemory);
  const loops = anlz.cues.filter((c) => c.loopEndMs);
  legend.replaceChildren();
  legend.append(el('span', 'chip hot', `${hot.length} hot cue${hot.length === 1 ? '' : 's'}`));
  legend.append(el('span', 'chip mem', `${mem.length} memory cue${mem.length === 1 ? '' : 's'}`));
  if (loops.length) legend.append(el('span', 'chip loop', `${loops.length} loop${loops.length === 1 ? '' : 's'}`));
  legend.append(el('span', 'chip', `${anlz.beats.length} beats`));
  legend.append(el('span', 'chip', anlz.waveform.source || 'no waveform'));

  redraw();
  window.onresize = redraw;
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

  const save = el('button', 'save', 'Download edited database');
  save.onclick = async () => {
    save.disabled = true;
    save.textContent = 'Building…';
    try {
      const key = $('#key').value.trim() || undefined;
      const bytes = await buildEditedDatabase(state.db, editor, key);
      downloadDatabase(bytes);
      status(
        'Saved exportLibrary.db. Copy it to PIONEER/rekordbox/ on the device, ' +
        'replacing the original.',
        'ok'
      );
    } catch (err) {
      status(`Could not build the database: ${err.message}`, 'error');
    } finally {
      save.disabled = false;
      save.textContent = 'Download edited database';
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
  renderSaveBar();
}

// -- wiring ----------------------------------------------------------------

export function init() {
  const zone = $('#dropzone');
  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); });
  }
  for (const ev of ['dragleave', 'drop']) {
    document.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); });
  }
  document.addEventListener('drop', async (e) => {
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

  // Public API: drive the viewer without a drag-and-drop gesture. `files` maps
  // lowercase device-relative paths to File or Blob objects.
  // Transport shortcuts. Ignored while typing in the passphrase field.
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); player.toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); player.jumpCue(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); player.jumpCue(1); }
  });

  // Public API: drive the viewer without a drag-and-drop gesture. `files` maps
  // lowercase device-relative paths to File or Blob objects.
  window.OneLibraryViewer = { load, selectTrack, state, player, editor };
}
