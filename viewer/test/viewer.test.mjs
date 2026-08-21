import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decrypt, DecryptError } from '../src/sqlcipher.js';
import { SQLiteDatabase, parseColumns, rowidAlias } from '../src/sqlite.js';
import { parseAnlz, parseSections, CUE_TYPE } from '../src/anlz.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'sample.db');
const PASS = 'testpassphrase';
const raw = () => new Uint8Array(readFileSync(FIXTURE));

// -- sqlcipher --------------------------------------------------------------

test('decrypts a SQLCipher 4 database', async () => {
  const plain = await decrypt(raw(), PASS);
  assert.equal(new TextDecoder().decode(plain.subarray(0, 15)), 'SQLite format 3');
  assert.equal(plain.length % 4096, 0);
});

test('a wrong passphrase fails loudly rather than yielding noise', async () => {
  await assert.rejects(() => decrypt(raw(), 'not-the-passphrase'), DecryptError);
});

test('rejects a file that is not a whole number of pages', async () => {
  await assert.rejects(() => decrypt(raw().subarray(0, 5000), PASS), DecryptError);
});

test('rejects a file smaller than one page', async () => {
  await assert.rejects(() => decrypt(new Uint8Array(16), PASS), DecryptError);
});

test('reports progress while decrypting', async () => {
  const seen = [];
  await decrypt(raw(), PASS, (done, total) => seen.push([done, total]));
  assert.ok(seen.length > 0);
  assert.equal(seen.at(-1)[0], seen.at(-1)[1]);
});

// -- sqlite -----------------------------------------------------------------

async function open() {
  return new SQLiteDatabase(await decrypt(raw(), PASS));
}

test('reads the schema', async () => {
  const db = await open();
  assert.deepEqual(db.tableNames(), ['content', 'playlist', 'playlist_content', 'property']);
});

test('reads rows with correct types', async () => {
  const db = await open();
  const rows = db.select('content');
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'Alpha Track');
  assert.equal(rows[0].bpmx100, 12800);
  assert.equal(rows[0].rating, 5);
});

test('preserves non-ASCII text', async () => {
  const db = await open();
  assert.equal((await open()).select('content')[1].title, 'Бета Трек');
});

test('follows overflow pages for long values', async () => {
  const db = await open();
  const long = db.select('content')[2].title;
  assert.ok(long.length > 900, `expected a spilled value, got ${long.length} chars`);
  assert.ok(long.startsWith('Gamma long long'));
  assert.ok(long.endsWith('long'));
});

test('represents SQL NULL as null', async () => {
  const db = await open();
  assert.equal(db.select('content')[2].analysisDataFilePath, null);
});

test('INTEGER PRIMARY KEY resolves from the rowid', async () => {
  const db = await open();
  assert.deepEqual(db.select('content').map((r) => r.content_id), [1, 2, 3]);
});

test('reads a table with no declared primary key', async () => {
  const db = await open();
  const p = db.select('property')[0];
  assert.equal(p.deviceName, 'TESTDEV');
  assert.equal(p.numberOfContents, 3);
});

test('unknown table raises', async () => {
  const db = await open();
  assert.throws(() => db.select('nope'), /no such table/);
});

test('parseColumns handles a real CREATE TABLE', () => {
  assert.deepEqual(
    parseColumns('CREATE TABLE t(a integer primary key, b varchar, c integer)'),
    ['a', 'b', 'c']
  );
});

test('parseColumns unquotes identifiers', () => {
  // Regression: rekordbox writes these bare, but a database built through a
  // tool that quotes mixed-case names writes "analysisDataFilePath" -- and the
  // quotes became part of the key, so the field read back as undefined and
  // every track silently lost its analysis, beatgrid and cues.
  assert.deepEqual(
    parseColumns('CREATE TABLE content(content_id INTEGER, "analysisDataFilePath" VARCHAR, `djComment` VARCHAR, [rating] INTEGER)'),
    ['content_id', 'analysisDataFilePath', 'djComment', 'rating']
  );
});

test('parseColumns skips table-level constraints', () => {
  // `PRIMARY KEY (a)` is a clause in the same comma list, not a column; its
  // first word was being taken as a column named PRIMARY.
  assert.deepEqual(
    parseColumns('CREATE TABLE t(a INTEGER, b VARCHAR, PRIMARY KEY (a), FOREIGN KEY(b) REFERENCES u(x), UNIQUE (b), CHECK (a > 0))'),
    ['a', 'b']
  );
});

test('parseColumns does not split inside parentheses', () => {
  // A comma inside DECIMAL(10,2) split one column in two and shifted every
  // column after it by one position.
  assert.deepEqual(
    parseColumns('CREATE TABLE t(a DECIMAL(10,2), b VARCHAR(255), c INTEGER)'),
    ['a', 'b', 'c']
  );
});

test('rowidAlias sees through quoting', () => {
  assert.equal(rowidAlias('CREATE TABLE t("content_id" INTEGER PRIMARY KEY, b VARCHAR)'), 'content_id');
  assert.equal(rowidAlias('CREATE TABLE t(a INT PRIMARY KEY, b VARCHAR)'), null);
});

// -- anlz -------------------------------------------------------------------

function buildPcpt(hot, type, timeMs, loopEnd = 0xffffffff) {
  const b = new Uint8Array(52);
  const dv = new DataView(b.buffer);
  b.set([0x50, 0x43, 0x50, 0x54]); // PCPT
  dv.setUint32(4, 12); dv.setUint32(8, 52);
  dv.setUint32(12, hot); dv.setUint32(16, 0); dv.setUint32(20, 0);
  b[28] = type;
  dv.setUint32(32, timeMs); dv.setUint32(36, loopEnd);
  return b;
}
function buildPcob(listType, entries) {
  const payload = entries.reduce((a, e) => a + e.length, 0);
  const b = new Uint8Array(24 + payload);
  const dv = new DataView(b.buffer);
  b.set([0x50, 0x43, 0x4f, 0x42]); // PCOB
  dv.setUint32(4, 24); dv.setUint32(8, 24 + payload); dv.setUint32(12, listType);
  dv.setUint16(18, entries.length); dv.setUint32(20, entries.length);
  let at = 24;
  for (const e of entries) { b.set(e, at); at += e.length; }
  return b;
}
function buildAnlz(...sections) {
  const payload = sections.reduce((a, s) => a + s.length, 0);
  const b = new Uint8Array(28 + payload);
  const dv = new DataView(b.buffer);
  b.set([0x50, 0x4d, 0x41, 0x49]); // PMAI
  dv.setUint32(4, 28); dv.setUint32(8, 28 + payload);
  let at = 28;
  for (const s of sections) { b.set(s, at); at += s.length; }
  return b;
}

test('rejects a non-ANLZ file', () => {
  assert.throws(() => parseSections(new Uint8Array(64)), /not an ANLZ/);
});

test('parses hot cues and memory cues', () => {
  const f = buildAnlz(
    buildPcob(1, [buildPcpt(1, 1, 24460), buildPcpt(3, 2, 39768, 42274)]),
    buildPcob(0, [buildPcpt(0, 1, 0)])
  );
  const a = parseAnlz(f);
  assert.equal(a.cues.length, 3);
  assert.deepEqual(a.cues.map((c) => c.timeMs), [0, 24460, 39768]);
  assert.equal(a.cues.find((c) => c.timeMs === 0).isMemory, true);
  assert.equal(a.cues.find((c) => c.timeMs === 24460).hotLetter, 'A');
});

test('recognises a loop and its end', () => {
  const f = buildAnlz(buildPcob(1, [buildPcpt(3, 2, 39768, 42274)]));
  const [loop] = parseAnlz(f).cues;
  assert.equal(loop.cueType, CUE_TYPE.LOOP);
  assert.equal(loop.loopEndMs, 42274);
  assert.equal(loop.hotLetter, 'C');
});

test('the no-loop sentinel becomes null', () => {
  const f = buildAnlz(buildPcob(1, [buildPcpt(1, 1, 1000)]));
  assert.equal(parseAnlz(f).cues[0].loopEndMs, null);
});

test('merges sections across .DAT and .EXT', () => {
  const dat = buildAnlz(buildPcob(0, [buildPcpt(0, 1, 500)]));
  const ext = buildAnlz(buildPcob(1, [buildPcpt(2, 1, 900)]));
  const a = parseAnlz(dat, ext);
  assert.equal(a.cues.length, 2);
  assert.deepEqual(a.cues.map((c) => c.timeMs), [500, 900]);
});

test('tolerates a missing sibling file', () => {
  const dat = buildAnlz(buildPcob(0, [buildPcpt(0, 1, 500)]));
  assert.equal(parseAnlz(dat, null).cues.length, 1);
});

test('throws when nothing is readable', () => {
  assert.throws(() => parseAnlz(null, null), /no readable ANLZ/);
});

// -- player -----------------------------------------------------------------
//
// The Player needs an <audio> element, so its cue-stepping logic is tested
// through a small stand-in rather than by loading a DOM.

import { Player, fmtPosition } from '../src/player.js';

function cueStepper(cues, positionMs) {
  const p = Object.create(Player.prototype);
  p.cues = [...cues].sort((a, b) => a.timeMs - b.timeMs);
  let pos = positionMs;
  Object.defineProperty(p, 'positionMs', { get: () => pos });
  p.seekMs = (ms) => { pos = ms; };
  return p;
}

const CUES = [{ timeMs: 0 }, { timeMs: 19363 }, { timeMs: 24460 }, { timeMs: 39768 }];

test('next cue walks forward and stops at the end', () => {
  const p = cueStepper(CUES, 0);
  assert.deepEqual([1, 2, 3, 4].map(() => p.jumpCue(1)?.timeMs ?? null), [19363, 24460, 39768, null]);
});

test('previous cue walks back and stops at the start', () => {
  const p = cueStepper(CUES, 39768);
  assert.deepEqual([1, 2, 3, 4].map(() => p.jumpCue(-1)?.timeMs ?? null), [24460, 19363, 0, null]);
});

test('previous returns to the cue just passed, not two back', () => {
  // Regression: a wide grace window made this skip 24460 and land on 19363.
  const p = cueStepper(CUES, 24560);
  assert.equal(p.jumpCue(-1)?.timeMs, 24460);
});

test('previous from exactly on a cue steps to the one before', () => {
  const p = cueStepper(CUES, 24460);
  assert.equal(p.jumpCue(-1)?.timeMs, 19363);
});

test('cue stepping is a no-op with no cues', () => {
  const p = cueStepper([], 1000);
  assert.equal(p.jumpCue(1), null);
  assert.equal(p.jumpCue(-1), null);
});

test('position formatting shows tenths', () => {
  assert.equal(fmtPosition(0), '0:00.0');
  assert.equal(fmtPosition(61500), '1:01.5');
  assert.equal(fmtPosition(-5), '0:00.0');
  assert.equal(fmtPosition(NaN), '0:00.0');
});

// -- writing ----------------------------------------------------------------

import { encrypt } from '../src/sqlcipher.js';
import { writeDatabase, buildRecord, SQLiteWriteError } from '../src/sqlite_write.js';
import { Editor } from '../src/editor.js';

test('encrypt then decrypt returns the original image', async () => {
  const plain = await decrypt(raw(), PASS);
  const round = await decrypt(await encrypt(plain, PASS), PASS);
  assert.deepEqual(Buffer.from(round), Buffer.from(plain));
});

test('encryption uses a fresh IV per run, so output differs', async () => {
  const plain = await decrypt(raw(), PASS);
  const a = await encrypt(plain, PASS);
  const b = await encrypt(plain, PASS);
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
});

test('encrypt rejects a partial page', async () => {
  await assert.rejects(() => encrypt(new Uint8Array(100), PASS));
});

test('records encode integers by narrowest serial type', () => {
  // 0 and 1 are their own serial types and occupy no payload bytes.
  assert.equal(buildRecord([0]).length, 2);
  assert.equal(buildRecord([1]).length, 2);
  assert.equal(buildRecord([5]).length, 3);
  assert.equal(buildRecord([300]).length, 4);
});

test('records round-trip through the reader', async () => {
  const tables = [{
    name: 't', sql: 'CREATE TABLE t(a integer primary key, b varchar, c integer)',
    columns: ['a', 'b', 'c'], rowidAlias: 'a',
    rows: [
      { __rowid: 1, a: 1, b: 'hello', c: 0 },
      { __rowid: 2, a: 2, b: 'Кириллица', c: 42 },
      { __rowid: 3, a: 3, b: null, c: -7 },
    ],
  }];
  const db = new SQLiteDatabase(writeDatabase(tables));
  const rows = db.select('t');
  assert.deepEqual(rows.map((r) => r.b), ['hello', 'Кириллица', null]);
  assert.deepEqual(rows.map((r) => r.c), [0, 42, -7]);
  assert.deepEqual(rows.map((r) => r.a), [1, 2, 3]);
});

test('an empty table produces a readable page', async () => {
  // Regression: writing 0 as the cell-content offset means 65536 in the file
  // format, which made SQLite report free-space corruption on empty tables.
  const db = new SQLiteDatabase(writeDatabase([{
    name: 'empty', sql: 'CREATE TABLE empty(a integer primary key, b varchar)',
    columns: ['a', 'b'], rowidAlias: 'a', rows: [],
  }]));
  assert.deepEqual(db.select('empty'), []);
});

test('a table spanning many pages round-trips', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({
    __rowid: i + 1, a: i + 1, b: `row ${i} ${'x'.repeat(60)}`,
  }));
  const db = new SQLiteDatabase(writeDatabase([{
    name: 'big', sql: 'CREATE TABLE big(a integer primary key, b varchar)',
    columns: ['a', 'b'], rowidAlias: 'a', rows,
  }]));
  const back = db.select('big');
  assert.equal(back.length, 400);
  assert.equal(back[399].b, rows[399].b);
});

test('an oversized record raises rather than truncating', () => {
  assert.throws(() => writeDatabase([{
    name: 'x', sql: 'CREATE TABLE x(a integer primary key, b varchar)',
    columns: ['a', 'b'], rowidAlias: 'a',
    rows: [{ __rowid: 1, a: 1, b: 'y'.repeat(9000) }],
  }]), SQLiteWriteError);
});

// -- editor -----------------------------------------------------------------

test('an edit back to the original value is not a change', () => {
  const e = new Editor();
  e.set(1, 'rating', 4, 0);
  assert.equal(e.count, 1);
  e.set(1, 'rating', 0, 0);
  assert.equal(e.count, 0);
  assert.equal(e.dirty, false);
});

test('empty string and null are the same absence', () => {
  const e = new Editor();
  e.set(1, 'title', '', null);
  assert.equal(e.count, 0);
});

test('changes are counted per field across tracks', () => {
  const e = new Editor();
  e.set(1, 'rating', 4, 0);
  e.set(1, 'title', 'x', 'y');
  e.set(2, 'rating', 3, 0);
  assert.equal(e.count, 3);
  assert.equal(e.changes.size, 2);
});

test('get falls back to the original until edited', () => {
  const e = new Editor();
  assert.equal(e.get(1, 'rating', 5), 5);
  e.set(1, 'rating', 2, 5);
  assert.equal(e.get(1, 'rating', 5), 2);
});

test('clear drops everything', () => {
  const e = new Editor();
  e.set(1, 'rating', 4, 0);
  e.clear();
  assert.equal(e.dirty, false);
});

// -- build ------------------------------------------------------------------

test('the bundled page parses', async () => {
  // Regression: concatenating modules put two PAGE_SIZE declarations in one
  // scope, so the whole script failed to parse and nothing on the page ran.
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'no inlined script found in dist/index.html');
  assert.doesNotThrow(() => new Function(script));
});

test('the bundle exposes the entry point', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const html = readFileSync(join(root, 'dist', 'index.html'), 'utf8');
  assert.match(html, /__app_js\.init\(\);/);
});

// -- deck -------------------------------------------------------------------

import { Deck } from '../src/deck.js';

/**
 * A deck with a synthetic beatgrid.
 *
 * Built from the prototype rather than the constructor: `new Deck()` creates a
 * Player, which creates an `Audio` element that does not exist in Node. The
 * tempo and beat logic under test never touches the element.
 */
function fakeDeck(id, bpm, beatCount = 64, startMs = 0) {
  const d = Object.create(Deck.prototype);
  d.id = id;
  d.pitch = 0;
  d.range = 6;
  d.cuePointMs = 0;
  d.syncOn = false;
  d.listeners = new Set();
  // A Player-shaped stub: the real one builds a Web Audio graph, which does not
  // exist in Node, and none of the tempo logic under test touches it.
  d.player = {
    playing: false, rate: 1,
    setRate(r) { this.rate = r; },
    pause() { this.playing = false; },
  };
  const beatMs = 60000 / bpm;
  d.track = { bpmx100: Math.round(bpm * 100), length: 300 };
  d.anlz = {
    beats: Array.from({ length: beatCount }, (_, i) => ({
      beat: (i % 4) + 1, bpm, timeMs: Math.round(startMs + i * beatMs),
    })),
    cues: [],
  };
  let pos = 0;
  Object.defineProperty(d.player, 'positionMs', { get: () => pos, configurable: true });
  d.player.seekMs = (ms) => { pos = ms; };
  return d;
}

test('tempo sync sets the pitch that matches BPM', () => {
  const a = fakeDeck('A', 128);
  const b = fakeDeck('B', 124);
  assert.equal(b.syncTo(a), null);
  assert.ok(Math.abs(b.bpm - 128) < 0.01, `expected 128, got ${b.bpm}`);
});

test('sync widens the fader instead of refusing', () => {
  // 94.4 -> 128 BPM needs +35.6%, far past the ±6% the fader starts on.
  const a = fakeDeck('A', 128);
  const b = fakeDeck('B', 94.4);
  b.setRange(6);
  assert.equal(b.syncTo(a), null);
  assert.equal(b.range, 100, 'the range should open to the narrowest that fits');
  assert.ok(Math.abs(b.bpm - 128) < 0.01, `expected 128 BPM, got ${b.bpm}`);
});

test('sync picks the narrowest range that reaches', () => {
  const a = fakeDeck('A', 128);
  const b = fakeDeck('B', 120);   // +6.67%, so ±10 is enough
  b.setRange(6);
  assert.equal(b.syncTo(a), null);
  assert.equal(b.range, 10);
});

test('an already-wide range is left alone', () => {
  const a = fakeDeck('A', 122);
  const b = fakeDeck('B', 120);   // +1.67%, well inside ±16
  b.setRange(16);
  assert.equal(b.syncTo(a), null);
  assert.equal(b.range, 16, 'the range should not narrow on its own');
});

test('sync aligns the beat phase, not just the tempo', () => {
  const a = fakeDeck('A', 120);
  const b = fakeDeck('B', 120);
  a.player.seekMs(a.anlz.beats[8].timeMs + 125); // a quarter into a beat
  b.player.seekMs(b.anlz.beats[8].timeMs + 400); // most of the way through one
  assert.equal(b.syncTo(a), null);
  const pa = a.beatPhaseAt(), pb = b.beatPhaseAt();
  assert.ok(Math.abs(pa.phase - pb.phase) < 0.02,
    `phases should match: ${pa.phase.toFixed(3)} vs ${pb.phase.toFixed(3)}`);
});

test('sync corrects by less than half a beat', () => {
  const a = fakeDeck('A', 120);
  const b = fakeDeck('B', 120);
  const beatMs = 500;
  a.player.seekMs(a.anlz.beats[8].timeMs);
  const before = b.anlz.beats[8].timeMs + 0.4 * beatMs;
  b.player.seekMs(before);
  b.syncTo(a);
  assert.ok(Math.abs(b.player.positionMs - before) <= beatMs / 2 + 1,
    'sync must not lurch the track more than half a beat');
});

test('sync still matches tempo when there is no beatgrid', () => {
  const a = fakeDeck('A', 128);
  const b = fakeDeck('B', 124);
  b.anlz = { beats: [], cues: [] };
  assert.equal(b.syncTo(a), null);
  assert.ok(Math.abs(b.bpm - 128) < 0.01);
});

test('beat phase runs 0..1 through a beat', () => {
  const d = fakeDeck('A', 120);
  d.player.seekMs(d.anlz.beats[4].timeMs);
  assert.ok(d.beatPhaseAt().phase < 0.01);
  d.player.seekMs(d.anlz.beats[4].timeMs + 250);
  assert.ok(Math.abs(d.beatPhaseAt().phase - 0.5) < 0.02);
});

test('the pitch fader clamps to its range', () => {
  const d = fakeDeck('A', 128);
  d.setRange(6);
  d.setPitch(50);
  assert.equal(d.pitch, 6);
  d.setPitch(-50);
  assert.equal(d.pitch, -6);
});

test('narrowing the range re-clamps the current pitch', () => {
  const d = fakeDeck('A', 128);
  d.setRange(16);
  d.setPitch(12);
  d.setRange(6);
  assert.equal(d.pitch, 6);
});

// -- rendering --------------------------------------------------------------
//
// A smoke test with a stub canvas. The build only syntax-checks the bundle, and
// none of the other tests touch the renderers, so a missing helper inside
// drawDetail once threw on every frame while everything still passed.

import { drawDetail, drawOverview } from '../src/waveform.js';

function stubCanvas(w = 600, h = 120) {
  const calls = { fillRect: 0, fillText: 0, fill: 0, fills: new Set() };
  const ctx = {
    set fillStyle(v) { calls.fills.add(v); },
    get fillStyle() { return '#000'; },
    setTransform() {}, clearRect() {}, fillRect() { calls.fillRect++; },
    fillText() { calls.fillText++; }, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() { calls.fill++; }, stroke() {}, save() {}, restore() {},
    set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
    set strokeStyle(v) {}, set lineWidth(v) {}, set globalAlpha(v) {},
  };
  return { canvas: { clientWidth: w, clientHeight: h, width: w, height: h,
                     getContext: () => ctx }, calls };
}

const WAVE = {
  source: 'PWV5',
  columns: Array.from({ length: 2000 }, (_, i) => ({
    height: (i % 31) / 31, b: i % 8, g: (i * 3) % 8, r: (i * 5) % 8,
  })),
};
const BEATS = Array.from({ length: 100 }, (_, i) => ({ beat: (i % 4) + 1, bpm: 120, timeMs: i * 500 }));
const RENDER_CUES = [
  { timeMs: 1000, isMemory: true, hotLetter: null, loopEndMs: null },
  { timeMs: 4000, isMemory: false, hotLetter: 'A', loopEndMs: 6000 },
];

test('drawDetail paints without throwing', () => {
  const { canvas, calls } = stubCanvas();
  drawDetail(canvas, WAVE, RENDER_CUES, BEATS, 50000, 5000, 8000);
  assert.ok(calls.fillRect > 50, `expected many bars, got ${calls.fillRect}`);
});

test('drawOverview paints without throwing', () => {
  const { canvas, calls } = stubCanvas(600, 60);
  drawOverview(canvas, WAVE, RENDER_CUES, 50000, 5000);
  assert.ok(calls.fillRect > 50, `expected many bars, got ${calls.fillRect}`);
});

test('the colour waveform uses the three-band palette', () => {
  const { canvas, calls } = stubCanvas();
  drawDetail(canvas, WAVE, [], [], 50000, 5000, 8000);
  for (const band of ['#1e5fd0', '#a9741e', '#f0ede4']) {
    assert.ok(calls.fills.has(band), `missing band colour ${band}`);
  }
});

test('a mono waveform falls back to a single colour', () => {
  const { canvas, calls } = stubCanvas();
  const mono = { source: 'PWV3', columns: WAVE.columns };
  drawDetail(canvas, mono, [], [], 50000, 5000, 8000);
  assert.ok(calls.fills.has('#9aa4b0'));
  assert.ok(!calls.fills.has('#1e5fd0'), 'bands must not appear without PWV5');
});

test('renderers tolerate an empty waveform', () => {
  const { canvas } = stubCanvas();
  assert.doesNotThrow(() => drawDetail(canvas, { columns: [] }, [], [], 1000, 0, 8000));
  assert.doesNotThrow(() => drawOverview(canvas, null, [], 1000, 0));
});

test('binning is stable as the playhead advances', () => {
  // The anti-flicker property: bins anchored to source columns mean the same
  // number of bars is drawn frame to frame, rather than re-slicing each time.
  const counts = [];
  for (const pos of [5000, 5007, 5013, 5021]) {
    const { canvas, calls } = stubCanvas();
    drawDetail(canvas, WAVE, [], [], 50000, pos, 8000);
    counts.push(calls.fillRect);
  }
  const spread = Math.max(...counts) - Math.min(...counts);
  assert.ok(spread <= 3, `bar count should be near-constant, spread was ${spread}`);
});

test('the beatgrid draws edge ticks, not lines through the waveform', () => {
  const { canvas, calls } = stubCanvas();
  drawDetail(canvas, WAVE, [], BEATS, 50000, 5000, 8000);
  // Two triangles per visible beat, filled as paths.
  assert.ok(calls.fill >= 16, `expected beat ticks as paths, got ${calls.fill}`);
  assert.ok(calls.fills.has('#e13b2b'), 'downbeats should be red');
  assert.ok(calls.fills.has('#8a8a8a'), 'plain beats should be grey');
});

test('the overview stacks bands from a baseline rather than mirroring', () => {
  const { canvas, calls } = stubCanvas(600, 60);
  drawOverview(canvas, WAVE, [], 50000, 25000);
  for (const band of ['#1e5fd0', '#a9741e', '#f0ede4']) {
    assert.ok(calls.fills.has(band), `missing band ${band}`);
  }
  // The played half is dimmed; the part still to come stays bright.
  assert.ok(calls.fills.has('rgba(0,0,0,0.58)'), 'played region should be dimmed');
});

// -- sync as a latch --------------------------------------------------------

test('sync engages and releases', () => {
  const a = fakeDeck('A', 128), b = fakeDeck('B', 124);
  assert.equal(b.syncOn, false);
  assert.equal(b.enableSync(a), null);
  assert.equal(b.syncOn, true);
  b.disableSync();
  assert.equal(b.syncOn, false);
});

test('sync still refuses past the widest fader', () => {
  const a = fakeDeck('A', 300);
  const b = fakeDeck('B', 60);    // +400%, beyond even ±100%
  const problem = b.syncTo(a);
  assert.match(problem, /past the widest fader/);
  assert.equal(b.pitch, 0, 'a refused sync must not move the fader');
  assert.equal(b.syncOn, false, 'and must not latch');
});

test('releasing restores the deck to its own fader', () => {
  const a = fakeDeck('A', 128), b = fakeDeck('B', 124);
  b.enableSync(a);
  b.player.setRate(1.007);               // as a nudge would leave it
  b.disableSync();
  assert.equal(b.player.rate, b.baseRate);
});

test('a locked deck keeps following the master tempo', () => {
  const a = fakeDeck('A', 128), b = fakeDeck('B', 124);
  b.setRange(16);
  b.enableSync(a);
  a.setPitch(2);                          // master fader moves
  b.player.playing = false;
  b.holdSync(a);
  assert.ok(Math.abs(b.bpm - a.bpm) < 0.01, `${b.bpm} should track ${a.bpm}`);
});

test('holding is inert when either deck is stopped', () => {
  const a = fakeDeck('A', 128), b = fakeDeck('B', 124);
  b.setRange(16);
  b.enableSync(a);
  b.holdSync(a);
  assert.equal(b.player.rate, b.baseRate,
    'a stopped deck should sit at its plain rate, not a correction');
});

test('holdSync does nothing when not latched', () => {
  const a = fakeDeck('A', 128), b = fakeDeck('B', 124);
  b.player.setRate(1);
  b.holdSync(a);
  assert.equal(b.pitch, 0);
  assert.equal(b.player.rate, 1);
});

// -- envelope ---------------------------------------------------------------

import { buildEnvelope, peakBetween } from '../src/envelope.js';

/** A stand-in for AudioBuffer; only the accessors the builder uses. */
function fakeBuffer(channels, sampleRate = 100) {
  const length = channels[0].length;
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (i) => channels[i],
  };
}

test('the envelope captures the peak of each bucket', () => {
  const data = Float32Array.from({ length: 100 }, (_, i) => (i === 50 ? 0.9 : 0.1));
  const env = buildEnvelope(fakeBuffer([data]), 10);
  assert.equal(env.buckets, 10);
  // Float32 storage rounds 0.9 to 0.89999997, so compare with a tolerance.
  assert.ok(Math.max(...env.max) > 0.89, 'the transient must survive summarisation');
});

test('channels fold by widest excursion, not by average', () => {
  // Out-of-phase content averages to silence; the envelope must not vanish.
  const left = Float32Array.from({ length: 20 }, () => 0.8);
  const right = Float32Array.from({ length: 20 }, () => -0.8);
  const env = buildEnvelope(fakeBuffer([left, right]), 10);
  assert.ok(Math.max(...env.max) > 0.7);
  assert.ok(Math.min(...env.min) < -0.7);
});

test('peakBetween reads a time span', () => {
  const data = Float32Array.from({ length: 100 }, (_, i) => (i > 80 ? 1 : 0));
  const env = buildEnvelope(fakeBuffer([data]), 100);
  assert.ok(peakBetween(env, 900, 1000).max > 0.9, 'late transient should be found');
  assert.equal(peakBetween(env, 0, 100).max, 0, 'early silence should stay silent');
});

test('peakBetween clamps outside the track', () => {
  const env = buildEnvelope(fakeBuffer([new Float32Array(50)]), 50);
  assert.deepEqual(peakBetween(env, -5000, -1000), { min: 0, max: 0 });
  assert.deepEqual(peakBetween(env, 900_000, 999_000), { min: 0, max: 0 });
});

test('peakBetween tolerates a missing envelope', () => {
  assert.deepEqual(peakBetween(null, 0, 100), { min: 0, max: 0 });
});

// -- MIDI -------------------------------------------------------------------
//
// Message decoding is tested directly: the mapping comes from rekordbox's own
// controller definition, so the thing worth pinning is that bytes off the wire
// reach the right deck with the right value.

import { MidiController } from '../src/midi.js';

function recorder() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  const c = new MidiController({
    playPause: record('playPause'), cue: record('cue'), sync: record('sync'),
    hotCue: record('hotCue'), tempo: record('tempo'), eqLow: record('eqLow'),
    crossfader: record('crossfader'), channelFader: record('channelFader'),
    loadA: record('loadA'), loadB: record('loadB'), browse: record('browse'),
    jogBend: record('jogBend'),
  });
  return { c, calls };
}

test('the deck is the MIDI channel', () => {
  const { c, calls } = recorder();
  c.onMessage([0x90, 0x0b, 127]);   // play, channel 0
  c.onMessage([0x91, 0x0b, 127]);   // play, channel 1
  assert.deepEqual(calls.map((x) => x[1]), ['A', 'B']);
});

test('note-off and zero velocity do not fire buttons', () => {
  const { c, calls } = recorder();
  c.onMessage([0x80, 0x0b, 0]);
  c.onMessage([0x90, 0x0b, 0]);
  assert.equal(calls.length, 0);
});

test('pads map to hot cues on their own channels', () => {
  const { c, calls } = recorder();
  c.onMessage([0x97, 0x00, 127]);   // channel 7, pad 1 -> deck A hot cue A
  c.onMessage([0x99, 0x03, 127]);   // channel 9, pad 4 -> deck B hot cue D
  assert.deepEqual(calls, [['hotCue', 'A', 'A'], ['hotCue', 'B', 'D']]);
});

test('a 14-bit fader resolves finer than its MSB alone', () => {
  const { c, calls } = recorder();
  c.onMessage([0xb0, 0x00, 64]);          // tempo MSB
  c.onMessage([0xb0, 0x20, 127]);         // its LSB, on controller + 32
  const [, , coarse] = calls[0];
  const [, , fine] = calls[1];
  assert.ok(Math.abs(coarse - 64 / 127) < 1e-9);
  assert.ok(fine > coarse, 'the pair must refine the MSB-only value');
  assert.ok(Math.abs(fine - ((64 << 7) | 127) / 16383) < 1e-9);
});

test('an LSB with no preceding MSB is ignored', () => {
  const { c, calls } = recorder();
  c.onMessage([0xb0, 0x20, 100]);
  assert.equal(calls.length, 0);
});

test('the mixer answers on channel 6, not a deck channel', () => {
  const { c, calls } = recorder();
  c.onMessage([0xb6, 0x1f, 127]);
  c.onMessage([0x96, 0x46, 127]);
  c.onMessage([0x96, 0x47, 127]);
  assert.deepEqual(calls.map((x) => x[0]), ['crossfader', 'loadA', 'loadB']);
});

test('the browse encoder reports a signed delta around 0x40', () => {
  const { c, calls } = recorder();
  c.onMessage([0xb6, 0x40, 0x41]);
  c.onMessage([0xb6, 0x40, 0x3f]);
  assert.deepEqual(calls.map((x) => x[1]), [1, -1]);
});

test('the jog reports a signed delta per deck', () => {
  const { c, calls } = recorder();
  c.onMessage([0xb1, 0x23, 0x44]);
  assert.deepEqual(calls[0], ['jogBend', 'B', 4]);
});

test('shift is tracked as a modifier, not dispatched', () => {
  const { c, calls } = recorder();
  c.onMessage([0x90, 0x3f, 127]);
  assert.equal(c.shift, true);
  assert.equal(calls.length, 0);
  c.onMessage([0x90, 0x0b, 127]);
  assert.deepEqual(calls[0], ['playPause', 'A', true], 'shift should reach the handler');
  c.onMessage([0x90, 0x3f, 0]);
  assert.equal(c.shift, false);
});

test('unmapped messages are ignored', () => {
  const { c, calls } = recorder();
  c.onMessage([0x90, 0x77, 127]);
  c.onMessage([0xe0, 0x00, 64]);
  assert.equal(calls.length, 0);
});
