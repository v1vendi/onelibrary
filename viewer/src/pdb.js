/**
 * A read-only reader for the legacy DeviceSQL export, `export.pdb`.
 *
 * rekordbox still writes this format to USB and SD media, and converts a
 * device to OneLibrary only when asked, so most sticks in circulation carry
 * it. Reading it here means the page opens the device somebody actually has
 * rather than telling them to go and convert it first.
 *
 * The file is a series of fixed-size pages. Page 0 lists the tables, each of
 * which is a linked list of pages. Inside a page, rows sit in a heap growing
 * forward from the end of the 0x28-byte header, while an index of their
 * offsets grows *backwards* from the end of the page, in groups of sixteen
 * 2-byte offsets led by a presence mask. A deleted row keeps its offset and
 * loses its bit, and its bytes may be nonsense afterwards -- the mask is the
 * only thing that says which rows can be read.
 *
 * Variable-length strings live elsewhere in the same page and are addressed by
 * an offset relative to the *row*, in one of three encodings.
 *
 * What comes back from `select()` is shaped like the OneLibrary tables rather
 * than like DeviceSQL: `content` with a `content_id`, `bpmx100`, `length`, and
 * so on. The two formats hold nearly the same library under different names,
 * and translating here is what lets everything downstream -- the track list,
 * the decks, the waveforms -- stay unaware of which one was dropped on it.
 * `selectRaw()` returns the rows under their own names for anyone reading the
 * format itself.
 *
 * Layouts follow crate-digger's `rekordbox_pdb.ksy`; see `spec/DEVICESQL.md`.
 * The Python reader in `python/src/onelibrary/pdb.py` is the same parser, and
 * both are held to the same fixture library.
 */

const PAGE_HEADER_LEN = 0x28;
const ROW_GROUP_STRIDE = 0x24;
const ROWS_PER_GROUP = 16;
const MAX_PAGE_SIZE = 1 << 20;

const UTF16 = new TextDecoder('utf-16le');

export const PAGE_TYPE = {
  TRACKS: 0,
  GENRES: 1,
  ARTISTS: 2,
  ALBUMS: 3,
  LABELS: 4,
  KEYS: 5,
  COLORS: 6,
  PLAYLIST_TREE: 7,
  PLAYLIST_ENTRIES: 8,
  HISTORY_PLAYLISTS: 11,
  HISTORY_ENTRIES: 12,
  ARTWORK: 13,
  COLUMNS: 16,
};

export class PdbError extends Error {}

/** Does this look like a DeviceSQL export rather than something else? */
export function looksLikePdb(bytes) {
  if (bytes.length < 0x1c) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const pageSize = dv.getUint32(4, true);
  return (
    dv.getUint32(0, true) === 0 &&
    pageSize > 0 &&
    pageSize <= MAX_PAGE_SIZE &&
    bytes.length % pageSize === 0
  );
}

/**
 * Decode bytes that are ASCII in practice.
 *
 * Done by hand rather than with a TextDecoder because the encoding label for
 * this ('latin1', an alias for windows-1252) is the one browsers disagree
 * about most, and every byte a real export puts here is plain ASCII anyway.
 */
function decodeAscii(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}

/**
 * Read one `device_sql_string` at `offset` within a page.
 *
 * The leading byte picks the encoding. `0x40` and `0x90` introduce a four-byte
 * header whose length *includes* that header; anything else is a compact ASCII
 * string whose length is mangled into the byte itself — incremented, doubled,
 * and incremented again, which is why it always reads as odd.
 */
export function readString(page, offset) {
  if (offset < 0 || offset >= page.length) {
    throw new PdbError(`string offset ${offset} lies outside the page`);
  }
  const kind = page[offset];
  if (kind === 0x40 || kind === 0x90) {
    const length = page[offset + 1] | (page[offset + 2] << 8);
    if (length < 4 || offset + length > page.length) {
      throw new PdbError(`long string at ${offset} claims ${length} bytes`);
    }
    const body = page.subarray(offset + 4, offset + length);
    return kind === 0x90 ? UTF16.decode(body) : decodeAscii(body);
  }
  const length = kind >> 1;
  if (length < 1 || offset + length > page.length) {
    throw new PdbError(`short string at ${offset} claims ${length} bytes`);
  }
  return decodeAscii(page.subarray(offset + 1, offset + length));
}

/** The twenty-one strings a track row points at, in offset-array order. */
const TRACK_STRINGS = [
  'isrc', 'texter', 'unknown_string_2', 'unknown_string_3', 'unknown_string_4',
  'message', 'kuvo_public', 'autoload_hot_cues', 'unknown_string_5',
  'unknown_string_6', 'date_added', 'release_date', 'mix_name',
  'unknown_string_7', 'analyze_path', 'analyze_date', 'comment', 'title',
  'unknown_string_8', 'filename', 'file_path',
];

/** Where a track row's fixed fields end and its string offsets begin. */
const TRACK_OFS_STRINGS = 0x5e;

/**
 * How to read each kind of row, given the page and the row's offset in it.
 *
 * `u8`/`u16`/`u32` read little-endian at an offset past the row base. A name
 * reached through `nearFar` sits at whichever of two offsets bit 0x04 of
 * `subtype` selects: one byte for a name close to the row, two for one further
 * than 0xff bytes away.
 */
function makeReaders(page) {
  const dv = new DataView(page.buffer, page.byteOffset, page.length);
  const u8 = (at) => page[at];
  const u16 = (at) => dv.getUint16(at, true);
  const u32 = (at) => dv.getUint32(at, true);
  const nearFar = (base, subtype, near, far) =>
    readString(page, base + (subtype & 0x04 ? u16(base + far) : u8(base + near)));

  return {
    [PAGE_TYPE.TRACKS]: (b) => {
      const row = {
        subtype: u16(b), bitmask: u32(b + 0x04), sample_rate: u32(b + 0x08),
        composer_id: u32(b + 0x0c), file_size: u32(b + 0x10),
        artwork_id: u32(b + 0x1c), key_id: u32(b + 0x20),
        original_artist_id: u32(b + 0x24), label_id: u32(b + 0x28),
        remixer_id: u32(b + 0x2c), bitrate: u32(b + 0x30),
        track_number: u32(b + 0x34), tempo: u32(b + 0x38),
        genre_id: u32(b + 0x3c), album_id: u32(b + 0x40),
        artist_id: u32(b + 0x44), id: u32(b + 0x48),
        disc_number: u16(b + 0x4c), play_count: u16(b + 0x4e),
        year: u16(b + 0x50), sample_depth: u16(b + 0x52),
        duration: u16(b + 0x54), color_id: u8(b + 0x58), rating: u8(b + 0x59),
      };
      TRACK_STRINGS.forEach((name, i) => {
        row[name] = readString(page, b + u16(b + TRACK_OFS_STRINGS + i * 2));
      });
      return row;
    },
    [PAGE_TYPE.GENRES]: (b) => ({ id: u32(b), name: readString(page, b + 4) }),
    [PAGE_TYPE.LABELS]: (b) => ({ id: u32(b), name: readString(page, b + 4) }),
    [PAGE_TYPE.KEYS]: (b) => ({ id: u32(b), name: readString(page, b + 8) }),
    [PAGE_TYPE.COLORS]: (b) => ({ id: u16(b + 5), name: readString(page, b + 8) }),
    [PAGE_TYPE.ARTWORK]: (b) => ({ id: u32(b), path: readString(page, b + 4) }),
    [PAGE_TYPE.ARTISTS]: (b) => ({
      subtype: u16(b), id: u32(b + 4), name: nearFar(b, u16(b), 0x09, 0x0a),
    }),
    [PAGE_TYPE.ALBUMS]: (b) => ({
      subtype: u16(b), artist_id: u32(b + 0x08), id: u32(b + 0x0c),
      name: nearFar(b, u16(b), 0x15, 0x16),
    }),
    [PAGE_TYPE.PLAYLIST_TREE]: (b) => ({
      parent_id: u32(b), sort_order: u32(b + 0x08), id: u32(b + 0x0c),
      is_folder: u32(b + 0x10) !== 0, name: readString(page, b + 0x14),
    }),
    [PAGE_TYPE.PLAYLIST_ENTRIES]: (b) => ({
      entry_index: u32(b), track_id: u32(b + 4), playlist_id: u32(b + 8),
    }),
    [PAGE_TYPE.HISTORY_PLAYLISTS]: (b) => ({ id: u32(b), name: readString(page, b + 4) }),
    [PAGE_TYPE.HISTORY_ENTRIES]: (b) => ({
      track_id: u32(b), playlist_id: u32(b + 4), entry_index: u32(b + 8),
    }),
  };
}

/** The DeviceSQL name of each table this reader can decode. */
const TABLE_NAMES = {
  [PAGE_TYPE.TRACKS]: 'tracks',
  [PAGE_TYPE.GENRES]: 'genres',
  [PAGE_TYPE.ARTISTS]: 'artists',
  [PAGE_TYPE.ALBUMS]: 'albums',
  [PAGE_TYPE.LABELS]: 'labels',
  [PAGE_TYPE.KEYS]: 'keys',
  [PAGE_TYPE.COLORS]: 'colors',
  [PAGE_TYPE.PLAYLIST_TREE]: 'playlist_tree',
  [PAGE_TYPE.PLAYLIST_ENTRIES]: 'playlist_entries',
  [PAGE_TYPE.HISTORY_PLAYLISTS]: 'history_playlists',
  [PAGE_TYPE.HISTORY_ENTRIES]: 'history_entries',
  [PAGE_TYPE.ARTWORK]: 'artwork',
};

/**
 * The legacy tables presented under their OneLibrary names and columns.
 *
 * Only what the viewer reads is translated. Fields DeviceSQL has and
 * OneLibrary does not (`play_count`, `isrc`, the several unknown strings) stay
 * available through `selectRaw`.
 */
const VIEWS = {
  content: {
    type: PAGE_TYPE.TRACKS,
    map: (r) => ({
      content_id: r.id,
      title: r.title,
      artist_id_artist: r.artist_id,
      album_id: r.album_id,
      genre_id: r.genre_id,
      key_id: r.key_id,
      label_id: r.label_id,
      color_id: r.color_id,
      image_id: r.artwork_id,
      rating: r.rating,
      bpmx100: r.tempo,
      length: r.duration,
      bitrate: r.bitrate,
      sampleRate: r.sample_rate,
      fileSize: r.file_size,
      trackNumber: r.track_number,
      discNumber: r.disc_number,
      releaseYear: r.year,
      commnt: r.comment,
      fileName: r.filename,
      path: r.file_path,
      analysisDataFilePath: r.analyze_path,
      mixName: r.mix_name,
      isrc: r.isrc,
      releaseDate: r.release_date,
      dateAdded: r.date_added,
    }),
  },
  artist: { type: PAGE_TYPE.ARTISTS, map: (r) => ({ artist_id: r.id, name: r.name }) },
  album: {
    type: PAGE_TYPE.ALBUMS,
    map: (r) => ({ album_id: r.id, name: r.name, artist_id: r.artist_id }),
  },
  genre: { type: PAGE_TYPE.GENRES, map: (r) => ({ genre_id: r.id, name: r.name }) },
  key: { type: PAGE_TYPE.KEYS, map: (r) => ({ key_id: r.id, name: r.name }) },
  label: { type: PAGE_TYPE.LABELS, map: (r) => ({ label_id: r.id, name: r.name }) },
  color: { type: PAGE_TYPE.COLORS, map: (r) => ({ color_id: r.id, name: r.name }) },
  image: { type: PAGE_TYPE.ARTWORK, map: (r) => ({ image_id: r.id, path: r.path }) },
  playlist: {
    type: PAGE_TYPE.PLAYLIST_TREE,
    // Folders are rows in the same table as playlists. They hold no tracks, so
    // showing them would put permanently empty entries in the sidebar.
    keep: (r) => !r.is_folder,
    map: (r) => ({
      playlist_id: r.id, name: r.name, parent_id: r.parent_id, sequenceNo: r.sort_order,
    }),
  },
  playlist_content: {
    type: PAGE_TYPE.PLAYLIST_ENTRIES,
    map: (r) => ({
      playlist_id: r.playlist_id, content_id: r.track_id, sequenceNo: r.entry_index,
    }),
  },
};

export class PdbDatabase {
  /** @param {Uint8Array} image an `export.pdb` file */
  constructor(image) {
    this.data = image;
    if (image.length < 0x1c) throw new PdbError('too short to be a DeviceSQL export');
    const dv = new DataView(image.buffer, image.byteOffset, image.length);
    if (dv.getUint32(0, true) !== 0 || dv.getUint32(0x18, true) !== 0) {
      throw new PdbError('not a DeviceSQL export (header is not zeroed)');
    }
    this.pageSize = dv.getUint32(4, true);
    if (!this.pageSize || this.pageSize > MAX_PAGE_SIZE || image.length % this.pageSize) {
      throw new PdbError(`implausible page size ${this.pageSize}`);
    }
    this.pageCount = image.length / this.pageSize;

    const numTables = dv.getUint32(8, true);
    if (0x1c + numTables * 16 > this.pageSize) {
      throw new PdbError(`${numTables} tables do not fit in the header page`);
    }
    this.tables = new Map();
    for (let i = 0; i < numTables; i++) {
      const at = 0x1c + i * 16;
      const type = dv.getUint32(at, true);
      // A file may name one type twice; the first entry is the live one.
      if (!this.tables.has(type)) {
        this.tables.set(type, {
          type,
          firstPage: dv.getUint32(at + 8, true),
          lastPage: dv.getUint32(at + 12, true),
        });
      }
    }
    this._cache = new Map();
  }

  /** The page at `index`, as a header plus the offsets of its present rows. */
  page(index) {
    if (index < 0 || index >= this.pageCount) {
      throw new PdbError(`page ${index} lies outside a ${this.pageCount}-page file`);
    }
    const start = index * this.pageSize;
    const image = this.data.subarray(start, start + this.pageSize);
    const dv = new DataView(image.buffer, image.byteOffset, image.length);
    // A 24-bit little-endian bitfield: 13 bits of offsets, then 11 of live rows.
    const packed = image[0x18] | (image[0x19] << 8) | (image[0x1a] << 16);
    const page = {
      image,
      index: dv.getUint32(4, true),
      type: dv.getUint32(8, true),
      nextPage: dv.getUint32(12, true),
      // Pages with bit 0x40 set hold allocation bookkeeping, not rows.
      isDataPage: (image[0x1b] & 0x40) === 0,
      numRowOffsets: packed & 0x1fff,
      rowOffsets: [],
    };
    if (!page.isDataPage || !page.numRowOffsets) return page;

    const groups = Math.floor((page.numRowOffsets - 1) / ROWS_PER_GROUP) + 1;
    for (let group = 0; group < groups; group++) {
      const base = this.pageSize - group * ROW_GROUP_STRIDE;
      if (base - (6 + 2 * (ROWS_PER_GROUP - 1)) < PAGE_HEADER_LEN) {
        throw new PdbError(`page ${index}: the row index overruns the page heap`);
      }
      const present = dv.getUint16(base - 4, true);
      for (let slot = 0; slot < ROWS_PER_GROUP; slot++) {
        if (group * ROWS_PER_GROUP + slot >= page.numRowOffsets) break;
        if (!((present >> slot) & 1)) continue;
        page.rowOffsets.push(PAGE_HEADER_LEN + dv.getUint16(base - (6 + 2 * slot), true));
      }
    }
    return page;
  }

  /**
   * Walk a table's linked list of pages.
   *
   * Stops at the declared last page, at a page belonging to another table, or
   * at a link that leaves the file — the last of which is how an empty table
   * is written, its `next_page` pointing past the end.
   */
  *_pages(type) {
    const table = this.tables.get(type);
    if (!table) return;
    const seen = new Set();
    let index = table.firstPage;
    while (index >= 0 && index < this.pageCount && !seen.has(index)) {
      seen.add(index);
      const page = this.page(index);
      if (page.type !== type) return;
      yield page;
      if (index === table.lastPage) return;
      index = page.nextPage;
    }
  }

  /** Every present row of a DeviceSQL table, under its own column names. */
  selectRaw(name) {
    const type = Number(
      Object.keys(TABLE_NAMES).find((t) => TABLE_NAMES[t] === name)
    );
    if (Number.isNaN(type)) throw new PdbError(`no readable table named '${name}'`);
    const rows = [];
    for (const page of this._pages(type)) {
      if (!page.isDataPage) continue;
      const read = makeReaders(page.image)[type];
      for (const offset of page.rowOffsets) rows.push(read(offset));
    }
    return rows;
  }

  /**
   * A table under its OneLibrary name, so the rest of the page need not care
   * which format the device carries.
   *
   * `property` has no counterpart in DeviceSQL — the legacy format keeps no
   * device record — so it is synthesised from what is known.
   */
  select(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    let rows;
    if (name === 'property') {
      rows = [{
        deviceName: 'rekordbox device',
        numberOfContents: this.select('content').length,
      }];
    } else {
      const view = VIEWS[name];
      if (!view) throw new PdbError(`no table named '${name}'`);
      if (!this.tables.has(view.type)) return [];
      const raw = this.selectRaw(TABLE_NAMES[view.type]);
      rows = (view.keep ? raw.filter(view.keep) : raw).map(view.map);
    }
    this._cache.set(name, rows);
    return rows;
  }

  /** The OneLibrary-named tables this file can supply. */
  tableNames() {
    return Object.keys(VIEWS).filter((n) => this.tables.has(VIEWS[n].type));
  }
}
