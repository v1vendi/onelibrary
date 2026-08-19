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
