/**
 * ANLZ analysis files: cues, beatgrid and waveforms.
 *
 * A `PMAI` header followed by length-prefixed tagged sections. `.DAT` holds
 * the legacy-compatible data; `.EXT` holds the modern superset. Read `.EXT`
 * when present - a `.DAT` carries only the hot cues older players understand.
 *
 * Waveform encodings, established against a real rekordbox 7 export:
 *
 *   PWAV / PWV3   one byte per column: height = b & 0x1f, whiteness = b >> 5
 *   PWV5          u16be per column: height = (d >> 2) & 0x1f,
 *                 then three 3-bit colour fields at bits 15-13, 12-10 and 9-7
 *
 * The PWV5 height field was determined empirically, not taken from published
 * notes: across 24,898 columns it correlates at r = +0.956 with the PWV3
 * height for the same track, where every other candidate bit position scored
 * below 0.37. The three 3-bit fields above it are colour; their channel order
 * is unconfirmed.
 */

const NO_LOOP = 0xffffffff;

export const CUE_LIST = { MEMORY: 0, HOT: 1 };
export const CUE_TYPE = { CUE: 1, LOOP: 2 };

export function parseSections(buffer) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = String.fromCharCode(...data.subarray(0, 4));
  if (magic !== 'PMAI') throw new Error('not an ANLZ file');
  const sections = [];
  let off = dv.getUint32(4);
  while (off + 12 <= data.length) {
    const tag = String.fromCharCode(...data.subarray(off, off + 4));
    if (!tag.trim()) break;
    const headerLen = dv.getUint32(off + 4);
    const totalLen = dv.getUint32(off + 8);
    if (totalLen <= 0 || off + totalLen > data.length) break;
    sections.push({ tag, headerLen, body: data.subarray(off, off + totalLen) });
    off += totalLen;
  }
  return sections;
}

function parseCueSection({ body, headerLen }, extended) {
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const listType = dv.getUint32(12);
  const magic = extended ? 'PCP2' : 'PCPT';
  const cues = [];
  let off = headerLen;
  while (off + 12 <= body.length) {
    if (String.fromCharCode(...body.subarray(off, off + 4)) !== magic) break;
    const entryLen = dv.getUint32(off + 8);
    let hotSlot, cueType, timeMs, loopEnd, color = null;
    if (extended) {
      hotSlot = dv.getUint32(off + 12);
      cueType = body[off + 16];
      timeMs = dv.getUint32(off + 20);
      loopEnd = dv.getUint32(off + 24);
      color = [body[off + 28], body[off + 29], body[off + 30]];
    } else {
      hotSlot = dv.getUint32(off + 12);
      cueType = body[off + 28];
      timeMs = dv.getUint32(off + 32);
      loopEnd = dv.getUint32(off + 36);
    }
    cues.push({
      hotSlot,
      cueType: cueType === 2 ? CUE_TYPE.LOOP : CUE_TYPE.CUE,
      timeMs,
      loopEndMs: loopEnd === NO_LOOP ? null : loopEnd,
      color,
      isMemory: hotSlot === 0,
      hotLetter: hotSlot === 0 ? null : String.fromCharCode(64 + hotSlot),
    });
    if (!entryLen) break;
    off += entryLen;
  }
  return { listType, cues };
}

/** Beat markers: `{ beat, bpm, timeMs }`, beat being 1-4 within the bar. */
export function parseBeatGrid(sections) {
  const s = sections.find((x) => x.tag === 'PQTZ');
  if (!s) return [];
  const dv = new DataView(s.body.buffer, s.body.byteOffset, s.body.byteLength);
  const count = dv.getUint32(20);
  const beats = [];
  for (let i = 0; i < count; i++) {
    const o = s.headerLen + i * 8;
    if (o + 8 > s.body.length) break;
    beats.push({ beat: dv.getUint16(o), bpm: dv.getUint16(o + 2) / 100, timeMs: dv.getUint32(o + 4) });
  }
  return beats;
}

/**
 * A waveform as `{ height, r, g, b }` columns, height normalised to 0..1.
 * Prefers the colour detail waveform, then mono detail, then the preview.
 */
export function parseWaveform(sections) {
  const colour = sections.find((x) => x.tag === 'PWV5');
  if (colour) {
    const { body, headerLen } = colour;
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const cols = [];
    for (let o = headerLen; o + 2 <= body.length; o += 2) {
      const d = dv.getUint16(o);
      // Channel order inferred, not confirmed. The bits15-13 field correlates
      // most strongly with overall height in every track measured (r=+0.26 and
      // +0.39 on two tracks, where the other two fields go negative), which is
      // the behaviour of the bass band -- so it is treated as blue, matching
      // how rekordbox renders bass-heavy material.
      cols.push({
        height: ((d >> 2) & 0x1f) / 31,
        b: (d >> 13) & 7,
        g: (d >> 10) & 7,
        r: (d >> 7) & 7,
      });
    }
    return { columns: cols, source: 'PWV5' };
  }
  for (const tag of ['PWV3', 'PWAV']) {
    const s = sections.find((x) => x.tag === tag);
    if (!s) continue;
    const cols = [];
    for (let o = s.headerLen; o < s.body.length; o++) {
      const b = s.body[o];
      const w = b >> 5;
      cols.push({ height: (b & 0x1f) / 31, r: w, g: w, b: w });
    }
    return { columns: cols, source: tag };
  }
  return { columns: [], source: null };
}

/**
 * Everything the viewer needs, from a track's ANLZ files.
 *
 * Pass both the `.DAT` and the `.EXT`: they are not alternatives but
 * complements. The beatgrid `PQTZ` appears only in the `.DAT`, while `PCO2`
 * extended cues and the `PWV5` colour waveform appear only in the `.EXT`.
 * Reading either alone loses data - a `.EXT` on its own yields no beatgrid.
 *
 * @param {...(ArrayBuffer|Uint8Array|null)} buffers
 */
export function parseAnlz(...buffers) {
  const sections = buffers
    .filter(Boolean)
    .flatMap((b) => {
      try { return parseSections(b); } catch { return []; }
    });
  if (!sections.length) throw new Error('no readable ANLZ data');
  const extended = sections.some((s) => s.tag === 'PCO2');
  const lists = sections
    .filter((s) => s.tag === (extended ? 'PCO2' : 'PCOB'))
    .map((s) => parseCueSection(s, extended));
  const cues = lists.flatMap((l) => l.cues).sort((a, b) => a.timeMs - b.timeMs);
  return {
    tags: sections.map((s) => s.tag),
    cues,
    beats: parseBeatGrid(sections),
    waveform: parseWaveform(sections),
  };
}
