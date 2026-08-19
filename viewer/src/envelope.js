/**
 * A peak envelope built from decoded audio.
 *
 * The stored `PWV5` waveform is only 150 columns a second at five bits of
 * height, which is why it renders as coarse blocks: at any useful zoom there
 * are barely more columns than pixels, so every stroke is a hard step. The
 * decoded buffer is already in memory for playback, so a real min/max envelope
 * can be summarised from it once at load and drawn smoothly at any zoom.
 *
 * ANLZ still supplies the band mix — its three-bit low/mid/high split is real
 * analysis and cheaper than filtering the audio again — so this only replaces
 * the *shape*, not the colour.
 */

/** Envelope resolution. 800/s is well past what any zoom level resolves. */
const BUCKETS_PER_SECOND = 800;

/**
 * Summarise an AudioBuffer into per-bucket peaks.
 *
 * Channels are folded together by taking the widest excursion of either, rather
 * than averaging: averaging cancels out-of-phase stereo content and flattens
 * exactly the transients the envelope exists to show.
 *
 * @returns {{min: Float32Array, max: Float32Array, rate: number, buckets: number}}
 */
export function buildEnvelope(audioBuffer, bucketsPerSecond = BUCKETS_PER_SECOND) {
  const channels = [];
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    channels.push(audioBuffer.getChannelData(c));
  }
  const buckets = Math.max(1, Math.ceil(audioBuffer.duration * bucketsPerSecond));
  const perBucket = audioBuffer.length / buckets;
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);

  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * perBucket);
    const to = Math.min(audioBuffer.length, Math.floor((b + 1) * perBucket));
    let lo = 0;
    let hi = 0;
    for (const data of channels) {
      for (let i = from; i < to; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max, rate: bucketsPerSecond, buckets };
}

/**
 * Peak over a time span, in the envelope's own units.
 *
 * Spans are given in milliseconds so callers do not have to know the bucket
 * rate, and are clamped so a window that runs off either end of the track
 * returns silence rather than reading past the array.
 */
export function peakBetween(envelope, fromMs, toMs) {
  if (!envelope) return { min: 0, max: 0 };
  const first = Math.max(0, Math.floor((fromMs / 1000) * envelope.rate));
  const last = Math.min(envelope.buckets, Math.ceil((toMs / 1000) * envelope.rate));
  let lo = 0;
  let hi = 0;
  for (let i = first; i < last; i++) {
    if (envelope.min[i] < lo) lo = envelope.min[i];
    if (envelope.max[i] > hi) hi = envelope.max[i];
  }
  return { min: lo, max: hi };
}
