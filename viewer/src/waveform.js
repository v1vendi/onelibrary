/**
 * Waveform rendering: the colour envelope, beat grid, and cue markers.
 *
 * Drawn on a canvas sized in CSS pixels and scaled by devicePixelRatio, so it
 * stays sharp on retina displays without the caller thinking about it.
 */

/** rekordbox's eight track colours, matching the `color` table by id. */
export const TRACK_COLORS = {
  1: '#f0f', 2: '#f33', 3: '#f93', 4: '#fd3',
  5: '#3d3', 6: '#3dd', 7: '#39f', 8: '#888',
};

const HOT_CUE_COLOR = '#00c8ff';
const MEMORY_CUE_COLOR = '#ff9500';
const LOOP_FILL = 'rgba(0, 200, 255, 0.18)';

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
const DISPLAY_GAMMA = 0.6;
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
 * This is the overview strip: it never scrolls, so a click maps linearly to a
 * position and the player can be scrubbed by dragging across it.
 */
export function drawOverview(canvas, waveform, cues, durationMs, positionMs) {
  const { ctx, w, h } = prepare(canvas);
  const cols = waveform?.columns || [];
  if (!cols.length) return;
  const mid = h / 2;
  const amp = h / 2 - 3;
  const colour = waveform.source === 'PWV5';

  for (const c of cues) {
    if (!c.loopEndMs || !durationMs) continue;
    ctx.fillStyle = LOOP_FILL;
    const x1 = (c.timeMs / durationMs) * w;
    const x2 = (c.loopEndMs / durationMs) * w;
    ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
  }

  const step = Math.max(1, Math.round(cols.length / w));
  for (const bin of binColumns(cols, 0, cols.length, step)) {
    const x = (bin.index / cols.length) * w;
    drawBands(ctx, x, Math.max(1, w / (cols.length / step)), mid, amp, bin, colour);
  }

  // Dim what has not played yet, so progress reads at a glance.
  if (durationMs) {
    const played = (positionMs / durationMs) * w;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(played, 0, w - played, h);
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
export function drawDetail(canvas, waveform, cues, beats, durationMs, positionMs, windowMs = 8000) {
  const { ctx, w, h } = prepare(canvas);
  const cols = waveform?.columns || [];
  if (!cols.length || !durationMs) return;

  const mid = h / 2;
  const amp = h / 2 - 8;
  const colour = waveform.source === 'PWV5';
  const startMs = positionMs - windowMs / 2;
  const msToX = (ms) => ((ms - startMs) / windowMs) * w;

  const colsPerMs = cols.length / durationMs;
  const pxPerCol = w / (windowMs * colsPerMs);
  // One bin per screen pixel at most; never finer than one source column.
  const step = Math.max(1, Math.ceil(1 / pxPerCol));
  const barW = Math.max(1, pxPerCol * step);

  const fromCol = Math.floor(startMs * colsPerMs) - step;
  const toCol = Math.ceil((startMs + windowMs) * colsPerMs) + step;

  for (const b of beats) {
    if (b.timeMs < startMs - 50 || b.timeMs > startMs + windowMs + 50) continue;
    const x = msToX(b.timeMs);
    const downbeat = b.beat === 1;
    ctx.fillStyle = downbeat ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.16)';
    ctx.fillRect(x, downbeat ? 0 : h * 0.2, downbeat ? 1.5 : 1, downbeat ? h : h * 0.6);
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
  for (const bin of binColumns(cols, fromCol, Math.min(toCol, cols.length), step)) {
    if (bin.index < 0) continue;
    const x = (bin.index / colsPerMs - startMs) / windowMs * w;
    if (x < -barW || x > w) continue;
    drawBands(ctx, x, barW, mid, amp, bin, colour);
  }

  for (const c of cues) {
    const x = msToX(c.timeMs);
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
