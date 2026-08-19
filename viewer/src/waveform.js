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

/**
 * Map a PWV5 3-bit RGB triple to a CSS colour.
 *
 * The channels are normalised against the strongest of the three rather than
 * against a fixed floor. A flat floor washes every column toward grey-pink,
 * because all three bands are non-zero nearly everywhere; normalising instead
 * lets a bass-dominant column read as actually blue.
 */
function columnColor(col) {
  if (col.r === col.g && col.g === col.b) {
    const v = 90 + col.r * 22;
    return `rgb(${v},${v},${v})`;
  }
  const peak = Math.max(col.r, col.g, col.b, 1);
  const norm = (c) => Math.round(55 + (c / peak) * 200);
  return `rgb(${norm(col.r)},${norm(col.g)},${norm(col.b)})`;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{columns:Array}} waveform
 * @param {Array} cues
 * @param {Array} beats
 * @param {number} durationMs
 */
export function drawWaveform(canvas, waveform, cues = [], beats = [], durationMs = 0) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const cssH = canvas.clientHeight || 160;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const cols = waveform?.columns || [];
  if (!cols.length) {
    ctx.fillStyle = 'rgba(128,128,128,0.6)';
    ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('no waveform data', cssW / 2, cssH / 2);
    return;
  }

  const mid = cssH / 2;
  const maxAmp = cssH / 2 - 12;

  // Beat grid first, so the waveform sits on top of it.
  if (beats.length && durationMs) {
    for (const b of beats) {
      const x = (b.timeMs / durationMs) * cssW;
      if (x < 0 || x > cssW) continue;
      const downbeat = b.beat === 1;
      ctx.strokeStyle = downbeat ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.07)';
      ctx.lineWidth = downbeat ? 1 : 0.5;
      ctx.beginPath();
      ctx.moveTo(x, mid - maxAmp);
      ctx.lineTo(x, mid + maxAmp);
      ctx.stroke();
    }
  }

  // Loop regions, behind the waveform.
  for (const c of cues) {
    if (!c.loopEndMs || !durationMs) continue;
    const x1 = (c.timeMs / durationMs) * cssW;
    const x2 = (c.loopEndMs / durationMs) * cssW;
    ctx.fillStyle = LOOP_FILL;
    ctx.fillRect(x1, mid - maxAmp, Math.max(2, x2 - x1), maxAmp * 2);
  }

  // The envelope: one vertical bar per pixel column, peak-picked.
  const perPixel = cols.length / cssW;
  for (let px = 0; px < cssW; px++) {
    const start = Math.floor(px * perPixel);
    const end = Math.max(start + 1, Math.floor((px + 1) * perPixel));
    let peak = 0;
    let pick = cols[start];
    for (let i = start; i < end && i < cols.length; i++) {
      if (cols[i].height > peak) { peak = cols[i].height; pick = cols[i]; }
    }
    if (!pick) continue;
    const h = Math.max(1, peak * maxAmp);
    ctx.fillStyle = columnColor(pick);
    ctx.fillRect(px, mid - h, 1, h * 2);
  }

  // Cue markers on top.
  for (const c of cues) {
    if (!durationMs) continue;
    const x = (c.timeMs / durationMs) * cssW;
    const color = c.isMemory ? MEMORY_CUE_COLOR : HOT_CUE_COLOR;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, cssH);
    ctx.stroke();

    const label = c.isMemory ? '◆' : c.hotLetter;
    ctx.fillStyle = color;
    ctx.fillRect(x - 8, 0, 16, 14);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, 7);
  }
}

/* ---------------------------------------------------------------------------
   Playback views
   --------------------------------------------------------------------------- */

/** Set up a canvas for CSS-pixel drawing at device resolution. */
function prepare(canvas) {
  const dpr = window.devicePixelRatio || 1;
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
  const amp = h / 2 - 4;

  for (const c of cues) {
    if (!c.loopEndMs || !durationMs) continue;
    ctx.fillStyle = LOOP_FILL;
    const x1 = (c.timeMs / durationMs) * w;
    const x2 = (c.loopEndMs / durationMs) * w;
    ctx.fillRect(x1, 0, Math.max(2, x2 - x1), h);
  }

  const per = cols.length / w;
  for (let px = 0; px < w; px++) {
    const a = Math.floor(px * per);
    const b = Math.max(a + 1, Math.floor((px + 1) * per));
    let peak = 0, pick = cols[a];
    for (let i = a; i < b && i < cols.length; i++) {
      if (cols[i].height > peak) { peak = cols[i].height; pick = cols[i]; }
    }
    if (!pick) continue;
    const played = durationMs && (px / w) * durationMs < positionMs;
    ctx.fillStyle = columnColor(pick);
    ctx.globalAlpha = played ? 1 : 0.4;
    const y = Math.max(1, peak * amp);
    ctx.fillRect(px, mid - y, 1, y * 2);
  }
  ctx.globalAlpha = 1;

  for (const c of cues) {
    if (!durationMs) continue;
    const x = (c.timeMs / durationMs) * w;
    ctx.fillStyle = cueColor(c);
    ctx.fillRect(x - 1, 0, 2, h);
  }

  if (durationMs) {
    const x = (positionMs / durationMs) * w;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 1, 0, 2, h);
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
  const amp = h / 2 - 6;
  const startMs = positionMs - windowMs / 2;
  const msToX = (ms) => ((ms - startMs) / windowMs) * w;
  const colsPerMs = cols.length / durationMs;

  // Beat grid behind everything.
  for (const b of beats) {
    if (b.timeMs < startMs - 50 || b.timeMs > startMs + windowMs + 50) continue;
    const x = msToX(b.timeMs);
    const downbeat = b.beat === 1;
    ctx.fillStyle = downbeat ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.13)';
    ctx.fillRect(x, downbeat ? 0 : h * 0.18, downbeat ? 1.5 : 1, downbeat ? h : h * 0.64);
  }

  for (const c of cues) {
    if (!c.loopEndMs) continue;
    const x1 = msToX(c.timeMs), x2 = msToX(c.loopEndMs);
    if (x2 < 0 || x1 > w) continue;
    ctx.fillStyle = LOOP_FILL;
    ctx.fillRect(x1, 0, x2 - x1, h);
  }

  // One bar per pixel column, peak-picked within that pixel's time slice.
  for (let px = 0; px < w; px++) {
    const ms = startMs + (px / w) * windowMs;
    if (ms < 0 || ms > durationMs) continue;
    const a = Math.floor(ms * colsPerMs);
    const b = Math.max(a + 1, Math.floor((startMs + ((px + 1) / w) * windowMs) * colsPerMs));
    let peak = 0, pick = cols[a];
    for (let i = a; i < b && i < cols.length; i++) {
      if (cols[i]?.height > peak) { peak = cols[i].height; pick = cols[i]; }
    }
    if (!pick) continue;
    ctx.fillStyle = columnColor(pick);
    const y = Math.max(1, peak * amp);
    ctx.fillRect(px, mid - y, 1, y * 2);
  }

  for (const c of cues) {
    const x = msToX(c.timeMs);
    if (x < -12 || x > w + 12) continue;
    const color = cueColor(c);
    ctx.fillStyle = color;
    ctx.fillRect(x - 1, 0, 2, h);
    const label = c.isMemory ? '◆' : c.hotLetter;
    ctx.fillRect(x - 9, 0, 18, 15);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 11px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, 8);
  }

  // Fixed centre playhead.
  ctx.fillStyle = '#ff3b30';
  ctx.fillRect(w / 2 - 1, 0, 2, h);
}
