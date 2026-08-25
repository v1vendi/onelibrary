/**
 * Waveform rendering: the colour envelope, beat grid, and cue markers.
 *
 * Drawn on a canvas sized in CSS pixels and scaled by devicePixelRatio, so it
 * stays sharp on retina displays without the caller thinking about it.
 */

import { peakBetween } from './envelope.js';

/** rekordbox's eight track colours, matching the `color` table by id. */
export const TRACK_COLORS = {
  1: '#f0f', 2: '#f33', 3: '#f93', 4: '#fd3',
  5: '#3d3', 6: '#3dd', 7: '#39f', 8: '#888',
};

const HOT_CUE_COLOR = '#00c8ff';
const MEMORY_CUE_COLOR = '#ff9500';
const LOOP_FILL = 'rgba(0, 200, 255, 0.18)';

/**
 * One column's band mix, taken from the ANLZ data nearest a source index.
 *
 * The envelope supplies the shape; this only supplies the colour split, so a
 * single representative column is enough.
 */
function binAt(cols, index, step) {
  const i = Math.max(0, Math.min(cols.length - 1, Math.round(index)));
  return binColumns(cols, i, Math.min(i + step, cols.length), step)[0]
    ?? { height: 0, low: 0, mid: 0, high: 0 };
}

/**
 * Draw one stroke as an envelope with the bands nested inside it.
 *
 * Each band occupies a fraction of the same outline rather than having its own
 * height, so low/mid/high read as a split of one shape. Highs sit innermost
 * because they are the narrowest and would otherwise be buried.
 */
function drawNested(ctx, x, width, mid, amp, lo, hi, bin, colour) {
  const top = mid - shape(Math.abs(hi)) * amp;
  const bottom = mid + shape(Math.abs(lo)) * amp;
  if (bottom - top < 1) { ctx.fillStyle = colour ? BAND_LOW : MONO; ctx.fillRect(x, mid, width, 1); return; }

  if (!colour) {
    ctx.fillStyle = MONO;
    ctx.fillRect(x, top, width, bottom - top);
    return;
  }
  const sum = bin.low + bin.mid + bin.high || 1;
  const fractions = [
    [BAND_LOW, 1],
    [BAND_MID, (bin.mid + bin.high) / sum],
    [BAND_HIGH, bin.high / sum],
  ];
  for (const [fill, fraction] of fractions) {
    const t = mid - (mid - top) * fraction;
    const b = mid + (bottom - mid) * fraction;
    ctx.fillStyle = fill;
    ctx.fillRect(x, t, width, Math.max(1, b - t));
  }
}

/** Size a canvas for CSS-pixel drawing at device resolution, and clear it. */
function prepare(canvas) {
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 100;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function cueColor(cue) {
  return cue.isMemory ? MEMORY_CUE_COLOR : HOT_CUE_COLOR;
}

/* Beatgrid markers, drawn at the edges rather than across the waveform. */
const BEAT_TICK = '#8a8a8a';
const BEAT_DOWN = '#e13b2b';
const BEAT_LINE = 'rgba(190,190,190,0.5)';
const BEAT_DOWN_LINE = 'rgba(255,255,255,0.95)';
const BEAT_TICK_SIZE = 4;

/** Target stroke pitch and gap for the scrolling view, in CSS pixels. */
const TARGET_BAR_PX = 3;
const BAR_GAP_PX = 1;

/** A small triangle pointing into the canvas from edge `y`. */
function tick(ctx, x, y, size, direction) {
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size * direction * 1.4);
  ctx.closePath();
  ctx.fill();
}

/* rekordbox's three-band palette: bass blue, mid amber, highs near-white. */
const BAND_LOW = '#1e5fd0';
const BAND_MID = '#a9741e';
const BAND_HIGH = '#f0ede4';
const MONO = '#9aa4b0';

/**
 * Bin the source columns into fixed groups, aligned to the *source* index.
 *
 * Alignment is what stops the waveform shimmering. Binning by screen position
 * re-slices the data every frame as the playhead advances, so the peak inside
 * each bin jumps between neighbouring samples and the whole envelope crawls.
 * Anchoring the bins to absolute column indices means a given bin always
 * covers the same samples, and scrolling only changes where it is drawn.
 */
function binColumns(cols, from, to, step) {
  const bins = [];
  const first = Math.floor(from / step) * step;
  for (let i = first; i < to; i += step) {
    let hi = 0, lo = 0, mid = 0, high = 0;
    const end = Math.min(i + step, cols.length);
    for (let j = Math.max(0, i); j < end; j++) {
      const c = cols[j];
      if (!c) continue;
      if (c.height > hi) hi = c.height;
      if (c.b > lo) lo = c.b;
      if (c.g > mid) mid = c.g;
      if (c.r > high) high = c.r;
    }
    bins.push({ index: i, height: hi, low: lo, mid, high });
  }
  return bins;
}

/**
 * Perceptual curve applied to column heights before drawing.
 *
 * The stored heights are close to linear amplitude, and music spends most of
 * its time far below peak — across a typical zoomed window the mean height is
 * about 0.16 against a max near 0.94. Drawn literally that is a thin line with
 * occasional spikes. Raising it to a fractional power lifts the body without
 * touching the peaks, which is why DJ software waveforms look full rather than
 * flat.
 */
const DISPLAY_GAMMA = 0.75;
const shape = (height) => Math.pow(Math.max(0, height), DISPLAY_GAMMA);

/**
 * Draw one column as three stacked bands.
 *
 * Bands are painted widest first so the narrower ones stay visible on top,
 * which is how the low/mid/high split reads as a single shape rather than
 * three competing ones.
 */
function drawBands(ctx, x, width, mid, amp, bin, colour) {
  if (colour) {
    const peak = Math.max(bin.low, bin.mid, bin.high, 1);
    const h = Math.max(1, shape(bin.height) * amp);
    const bands = [
      [BAND_LOW, (bin.low / peak) * h],
      [BAND_MID, (bin.mid / peak) * h],
      [BAND_HIGH, (bin.high / peak) * h],
    ].sort((a, b) => b[1] - a[1]);
    for (const [fill, height] of bands) {
      ctx.fillStyle = fill;
      const hh = Math.max(1, height);
      ctx.fillRect(x, mid - hh, width, hh * 2);
    }
  } else {
    const h = Math.max(1, shape(bin.height) * amp);
    ctx.fillStyle = MONO;
    ctx.fillRect(x, mid - h, width, h * 2);
  }
}

/**
 * The whole track at a glance, with a playhead.
 *
 * Drawn the way rekordbox draws its overview, which differs from the scrolling
 * view in three ways:
 *
 * - **Half, not mirrored.** It rises from a baseline at the bottom rather than
 *   spreading either side of a centre line, which gives the same information in
 *   half the height.
 * - **Bands stacked, not overlaid.** Bass sits at the bottom with mid and highs
 *   piled on top, so the band mix reads as a single column rather than three
 *   shapes fighting for the same space.
 * - **The played part is dimmed, not the part to come.** What is left to play is
 *   what a DJ is reading, so it stays bright.
 */
export function drawOverview(canvas, waveform, cues, durationMs, positionMs) {
  const { ctx, w, h } = prepare(canvas);
  const cols = waveform?.columns || [];
  if (!cols.length) return;
  const base = h - 2;
  const amp = h - 6;
  const colour = waveform.source === 'PWV5';

  for (const c of cues) {
    if (!c.loopEndMs || !durationMs) continue;
    ctx.fillStyle = LOOP_FILL;
    const x1 = (c.timeMs / durationMs) * w;
    const x2 = (c.loopEndMs / durationMs) * w;
    ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
  }

  const step = Math.max(1, Math.round(cols.length / w));
  const barW = Math.max(1, w / (cols.length / step));
  for (const bin of binColumns(cols, 0, cols.length, step)) {
    const x = (bin.index / cols.length) * w;
    const total = Math.max(1, shape(bin.height) * amp);
    if (colour) {
      // Proportion the stack by each band's share of the column.
      const sum = bin.low + bin.mid + bin.high || 1;
      let y = base;
      for (const [fill, share] of [
        [BAND_LOW, bin.low / sum],
        [BAND_MID, bin.mid / sum],
        [BAND_HIGH, bin.high / sum],
      ]) {
        const seg = total * share;
        ctx.fillStyle = fill;
        ctx.fillRect(x, y - seg, barW, seg);
        y -= seg;
      }
    } else {
      ctx.fillStyle = MONO;
      ctx.fillRect(x, base - total, barW, total);
    }
  }

  if (durationMs) {
    const played = (positionMs / durationMs) * w;
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.fillRect(0, 0, played, h);
  }

  for (const c of cues) {
    if (!durationMs) continue;
    ctx.fillStyle = cueColor(c);
    ctx.fillRect((c.timeMs / durationMs) * w - 1, 0, 2, h);
  }
  if (durationMs) {
    ctx.fillStyle = '#fff';
    ctx.fillRect((positionMs / durationMs) * w - 1, 0, 2, h);
  }
}

/**
 * The zoomed, scrolling view — the one a DJ actually reads.
 *
 * The playhead is fixed at the centre and the waveform moves beneath it, which
 * is how CDJs and rekordbox present playback: the eye stays in one place and
 * upcoming material arrives from the right. Beat markers are drawn from the
 * real beatgrid, with downbeats emphasised, so bar boundaries are visible.
 *
 * @param {number} windowMs how much time fits across the canvas
 */
export function drawDetail(canvas, waveform, cues, beats, durationMs, positionMs, windowMs = 8000, envelope = null) {
  const { ctx, w, h } = prepare(canvas);
  const cols = waveform?.columns || [];
  if (!cols.length || !durationMs) return;

  const mid = h / 2;
  const amp = h / 2 - 14;
  const colour = waveform.source === 'PWV5';
  const startMs = positionMs - windowMs / 2;
  const msToX = (ms) => ((ms - startMs) / windowMs) * w;
  // The playhead advances continuously, so a raw msToX() places every beat
  // tick at a fresh fractional pixel each frame; the browser's antialiasing
  // then varies frame to frame and reads as a flicker on the grid even though
  // nothing is actually changing shape. Snapping to the device-pixel grid
  // gives each tick a small number of crisp, stable positions instead.
  const dpr = globalThis.devicePixelRatio || 1;
  const snapX = (x) => Math.round(x * dpr) / dpr;

  const colsPerMs = cols.length / durationMs;
  const pxPerCol = w / (windowMs * colsPerMs);
  // Aim for a stroke every few pixels with a gap between, rather than one bar
  // per pixel. Contiguous bars merge into a solid block; separated strokes are
  // what make the shape readable and give the waveform its texture.
  const step = Math.max(1, Math.round(TARGET_BAR_PX / pxPerCol));
  const barW = Math.max(1, pxPerCol * step);
  const strokeW = Math.max(1, barW - BAR_GAP_PX);

  const fromCol = Math.floor(startMs * colsPerMs) - step;
  const toCol = Math.ceil((startMs + windowMs) * colsPerMs) + step;

  // The beatgrid reads from the edges, as on a CDJ: a tick above and below each
  // beat rather than a line through the waveform, so the grid never competes
  // with the audio it is measuring. Downbeats are red and carry a full-height
  // line, which is what makes bar boundaries findable at a glance.
  for (const b of beats) {
    if (b.timeMs < startMs - 50 || b.timeMs > startMs + windowMs + 50) continue;
    const x = snapX(msToX(b.timeMs));
    const downbeat = b.beat === 1;
    ctx.fillStyle = downbeat ? BEAT_DOWN_LINE : BEAT_LINE;
    ctx.fillRect(x - 0.5, 0, downbeat ? 1.5 : 1, h);
    ctx.fillStyle = downbeat ? BEAT_DOWN : BEAT_TICK;
    tick(ctx, x, 0, BEAT_TICK_SIZE, 1);
    tick(ctx, x, h, BEAT_TICK_SIZE, -1);
  }

  for (const c of cues) {
    if (!c.loopEndMs) continue;
    const x1 = msToX(c.timeMs), x2 = msToX(c.loopEndMs);
    if (x2 < 0 || x1 > w) continue;
    ctx.fillStyle = LOOP_FILL;
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  // Bins are anchored to source columns, so the shape stays fixed and only its
  // screen position moves -- the waveform glides instead of boiling.
  if (envelope) {
    // With decoded audio available the shape comes from a real min/max envelope
    // and the bands are nested inside it, rather than three separate heights.
    // One outline shared by all three is what gives the waveform its continuous
    // form instead of a picket fence.
    //
    // The bins are cut from the track's timeline, not from the screen's. This
    // loop used to walk pixel positions and derive a time from each, which
    // sounds equivalent and is not: `startMs` moves every frame, so the bin
    // boundaries slid through the audio and every feature was re-cut on a
    // different grid each time it was drawn. Measured across the sample track,
    // one feature's drawn height swung 30% on average and 63% at the ninetieth
    // percentile as the view scrolled past it, purely from where the boundaries
    // happened to land. Walking bin indices pins each bin to one span of audio
    // for the life of the track, so a feature keeps its shape and only moves.
    const msPerStroke = (windowMs / w) * (barW || 1);
    const firstBin = Math.floor(startMs / msPerStroke);
    const lastBin = Math.ceil((startMs + windowMs) / msPerStroke);
    for (let i = firstBin; i <= lastBin; i++) {
      const t0 = i * msPerStroke;
      if (t0 < 0 || t0 > durationMs) continue;
      // Fractional, and deliberately not snapped to the device pixel grid the
      // way the beat ticks above are. Snapping here would quantise the bars to
      // alternating 3- and 4-pixel widths, which is the same shimmer moved from
      // the heights into the widths. A fixed shape at a fractional position is
      // what actually glides.
      const x = ((t0 - startMs) / windowMs) * w;
      const { min: lo, max: hi } = peakBetween(envelope, t0, t0 + msPerStroke);
      const bin = binAt(cols, t0 * colsPerMs, step);
      drawNested(ctx, x, strokeW, mid, amp, lo, hi, bin, colour);
    }
  } else {
    for (const bin of binColumns(cols, fromCol, Math.min(toCol, cols.length), step)) {
      if (bin.index < 0) continue;
      const x = (bin.index / colsPerMs - startMs) / windowMs * w;
      if (x < -barW || x > w) continue;
      drawBands(ctx, x, strokeW, mid, amp, bin, colour);
    }
  }

  for (const c of cues) {
    const x = snapX(msToX(c.timeMs));
    if (x < -12 || x > w + 12) continue;
    const color = cueColor(c);
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, 0, 2, h);
    ctx.fillRect(x - 9, 0, 18, 15);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.isMemory ? '◆' : c.hotLetter, x, 8);
  }

  ctx.fillStyle = '#ff3b30';
  ctx.fillRect(w / 2 - 1, 0, 2, h);
}


/**
 * Winamp's spectrum analyser.
 *
 * Nineteen bars, coloured top-down from the skin's own ramp so a bar's tip is
 * red and its base green, with a peak dot that falls back slowly — the detail
 * that makes the original read as responsive rather than twitchy.
 *
 * Bins are grouped logarithmically. An FFT spreads its bins evenly across
 * frequency, so a linear grouping gives fifteen bars of treble nobody can hear
 * moving and one bar holding the entire bass.
 */
const VIS_BARS = 19;
const PEAK_FALL = 0.6;

export function drawSpectrum(canvas, spectrum, peaks, colors) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 76;
  const h = canvas.clientHeight || 38;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  if (!spectrum || !spectrum.length) return;

  const barW = w / VIS_BARS;
  const bins = spectrum.length;
  for (let i = 0; i < VIS_BARS; i++) {
    const from = Math.floor(bins ** (i / VIS_BARS)) - 1;
    const to = Math.max(from + 1, Math.floor(bins ** ((i + 1) / VIS_BARS)) - 1);
    let peak = 0;
    for (let b = Math.max(0, from); b < Math.min(bins, to); b++) {
      if (spectrum[b] > peak) peak = spectrum[b];
    }
    const value = peak / 255;
    peaks[i] = Math.max(value, (peaks[i] ?? 0) - PEAK_FALL / 60);

    const x = Math.floor(i * barW);
    const bw = Math.max(1, Math.floor(barW) - 1);
    const rows = Math.round(value * colors.length);
    for (let r = 0; r < rows; r++) {
      // Row 0 is the floor, so the ramp is indexed from its green end up.
      const [cr, cg, cb] = colors[colors.length - 1 - r];
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      const rowH = h / colors.length;
      ctx.fillRect(x, h - (r + 1) * rowH, bw, Math.ceil(rowH) - 0.5);
    }
    if (peaks[i] > 0.02) {
      ctx.fillStyle = 'rgb(150,150,150)';   // VISCOLOR entry 23
      ctx.fillRect(x, h - peaks[i] * h - 1, bw, 1.5);
    }
  }
}
