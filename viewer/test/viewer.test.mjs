import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decrypt, DecryptError } from '../src/sqlcipher.js';
import { SQLiteDatabase, parseColumns } from '../src/sqlite.js';
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
