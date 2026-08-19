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
