/**
 * A minimal read-only SQLite reader.
 *
 * Written rather than pulled in so the viewer stays a single self-contained
 * file with no WASM blob and no external fetches. It implements only what
 * reading a OneLibrary export needs: the file header, `sqlite_master`, table
 * b-tree traversal, the record format, and overflow pages. No indexes, no
 * WITHOUT ROWID tables, no SQL - callers scan tables and filter in JS.
 *
 * The reserve size matters here. SQLCipher declares 80 reserved bytes per
 * page, so the usable payload is 4016 rather than 4096 bytes, and the overflow
 * thresholds are computed from the usable size. Getting this wrong silently
 * truncates long text.
 */

const TEXT = new TextDecoder('utf-8');

export class SQLiteError extends Error {}

/** Big-endian varint, up to 9 bytes. Returns [value, bytesConsumed]. */
function readVarint(bytes, offset) {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    const b = bytes[offset + i];
    if (b === undefined) throw new SQLiteError('truncated varint');
    value = (value << 7n) | BigInt(b & 0x7f);
    if ((b & 0x80) === 0) return [Number(BigInt.asIntN(64, value)), i + 1];
  }
  value = (value << 8n) | BigInt(bytes[offset + 8]);
  return [Number(BigInt.asIntN(64, value)), 9];
}

/** Decode one record body given its serial types. */
function decodeValues(bytes, offset, serialTypes) {
  const out = [];
  let p = offset;
  for (const t of serialTypes) {
    if (t === 0) { out.push(null); continue; }
    if (t === 8) { out.push(0); continue; }
    if (t === 9) { out.push(1); continue; }
    if (t >= 1 && t <= 6) {
      const len = [0, 1, 2, 3, 4, 6, 8][t];
      let v = 0n;
      for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(bytes[p + i]);
      out.push(Number(BigInt.asIntN(len * 8, v)));
      p += len;
      continue;
    }
    if (t === 7) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset + p, 8);
      out.push(dv.getFloat64(0));
      p += 8;
      continue;
    }
    if (t >= 12 && t % 2 === 0) {
      const len = (t - 12) / 2;
      out.push(bytes.subarray(p, p + len));
      p += len;
      continue;
    }
    if (t >= 13 && t % 2 === 1) {
      const len = (t - 13) / 2;
      out.push(TEXT.decode(bytes.subarray(p, p + len)));
      p += len;
      continue;
    }
    out.push(null); // reserved serial types 10 and 11
  }
  return out;
}

export class SQLiteDatabase {
  /** @param {Uint8Array} image a decrypted SQLite file */
  constructor(image) {
    this.data = image;
    const dv = new DataView(image.buffer, image.byteOffset);
    if (TEXT.decode(image.subarray(0, 15)) !== 'SQLite format 3') {
      throw new SQLiteError('not a SQLite database');
    }
    this.pageSize = dv.getUint16(16) || 65536;
    this.reserve = dv.getUint8(20);
    this.usable = this.pageSize - this.reserve;
    this.tables = this._readMaster();
  }

  _page(n) {
    const start = (n - 1) * this.pageSize;
    return this.data.subarray(start, start + this.pageSize);
  }

  /**
   * Reassemble a cell payload, following the overflow chain when the record
   * does not fit on its page.
   */
  _payload(page, offset, totalLen) {
    const maxLocal = this.usable - 35;
    if (totalLen <= maxLocal) return page.subarray(offset, offset + totalLen);

    const minLocal = ((this.usable - 12) * 32) / 255 - 23;
    let local = minLocal + ((totalLen - minLocal) % (this.usable - 4));
    if (local > maxLocal) local = minLocal;
    local = Math.floor(local);

    const chunks = [page.subarray(offset, offset + local)];
    let got = local;
    const dv = new DataView(page.buffer, page.byteOffset);
    let next = dv.getUint32(offset + local);
    while (next && got < totalLen) {
      const ov = this._page(next);
      const take = Math.min(this.usable - 4, totalLen - got);
      chunks.push(ov.subarray(4, 4 + take));
      got += take;
      next = new DataView(ov.buffer, ov.byteOffset).getUint32(0);
    }
    const out = new Uint8Array(totalLen);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  /** Walk a table b-tree, yielding [rowid, values] for every row. */
  *_walk(pageNo) {
    const page = this._page(pageNo);
    if (!page.length) return;
    // Page 1 carries the 100-byte file header before its b-tree header.
    const base = pageNo === 1 ? 100 : 0;
    const type = page[base];
    const dv = new DataView(page.buffer, page.byteOffset);
    const cellCount = dv.getUint16(base + 3);

    if (type === 5) {
      const headerLen = 12;
      for (let i = 0; i < cellCount; i++) {
        const ptr = dv.getUint16(base + headerLen + i * 2);
        yield* this._walk(dv.getUint32(ptr));
      }
      yield* this._walk(dv.getUint32(base + 8)); // rightmost child
      return;
    }
    if (type !== 13) return; // not a table b-tree page

    const headerLen = 8;
    for (let i = 0; i < cellCount; i++) {
      const ptr = dv.getUint16(base + headerLen + i * 2);
      let p = ptr;
      const [payloadLen, n1] = readVarint(page, p); p += n1;
      const [rowid, n2] = readVarint(page, p); p += n2;
      const payload = this._payload(page, p, payloadLen);
      const [headerSize, n3] = readVarint(payload, 0);
      const serialTypes = [];
      let q = n3;
      while (q < headerSize) {
        const [t, n] = readVarint(payload, q);
        serialTypes.push(t); q += n;
      }
      yield [rowid, decodeValues(payload, headerSize, serialTypes)];
    }
  }

  _readMaster() {
    const tables = new Map();
    for (const [, row] of this._walk(1)) {
      const [type, name, , rootpage, sql] = row;
      if (type !== 'table' || String(name).startsWith('sqlite_')) continue;
      tables.set(name, { name, rootpage, sql, columns: parseColumns(sql) });
    }
    return tables;
  }

  /** Every row of `table` as plain objects keyed by column name. */
  select(table) {
    const meta = this.tables.get(table);
    if (!meta) throw new SQLiteError(`no such table: ${table}`);
    const cols = meta.columns;
    const rows = [];
    for (const [rowid, values] of this._walk(meta.rootpage)) {
      const obj = {};
      cols.forEach((c, i) => {
        // An INTEGER PRIMARY KEY column is stored as NULL; the rowid is the value.
        obj[c] = values[i] === null && c.endsWith('_id') && i === 0 ? rowid : values[i] ?? null;
      });
      rows.push(obj);
    }
    return rows;
  }

  tableNames() { return [...this.tables.keys()].sort(); }
}

/** Extract column names from a CREATE TABLE statement. */
export function parseColumns(sql) {
  const m = /\(([\s\S]*)\)\s*$/.exec(sql || '');
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);
}
