/**
 * Audio playback on the Web Audio API.
 *
 * This deliberately does not play through an `<audio>` element. `currentTime`
 * on a media element snaps to a decoder frame boundary — 26 ms for MP3 at
 * 44.1 kHz, before encoder delay — so a seek lands up to a frame away from
 * where it was asked to go, and reading the position back is quantised the same
 * way. At 94 BPM that is about a sixteenth of a beat: enough to hear two decks
 * flam, and the reason sync felt permanently late.
 *
 * Decoding the whole file into an `AudioBuffer` makes `start(when, offset)`
 * exact in both arguments, and position is derived from `AudioContext`'s clock,
 * which advances with the audio hardware rather than in frame steps.
 *
 * The cost is memory and an up-front decode: roughly 60 MB of float samples for
 * a three-minute stereo track.
 */

import { buildEnvelope } from './envelope.js';

/** One context for the page; browsers cap how many may exist. */
let sharedContext = null;

export function audioContext() {
  if (!sharedContext) {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) return null;
    sharedContext = new Ctor({ latencyHint: 'interactive' });
  }
  return sharedContext;
}

export class Player {
  constructor(context = audioContext()) {
    this.ctx = context;
    this.buffer = null;
    /** Peak summary of the decoded audio, for drawing. */
    this.envelope = null;
    this.source = null;
    this.cues = [];
    this.listeners = new Set();
    this.rate = 1;
    /** Buffer position, in seconds, that the current source started from. */
    this.offset = 0;
    /** Context time that source started at, for deriving position. */
    this.startedAt = 0;
    this._playing = false;

    if (this.ctx) {
      // source -> low -> mid -> high -> gain -> out. Shelf/peak points follow
      // the usual three-band DJ split: everything under ~220 Hz is "low",
      // everything over ~3.2 kHz is "high", and the mid is a broad bell
      // between them rather than a narrow notch.
      this.low = this.ctx.createBiquadFilter();
      this.low.type = 'lowshelf';
      this.low.frequency.value = 220;
      this.mid = this.ctx.createBiquadFilter();
      this.mid.type = 'peaking';
      this.mid.frequency.value = 1000;
      this.mid.Q.value = 0.8;
      this.high = this.ctx.createBiquadFilter();
      this.high.type = 'highshelf';
      this.high.frequency.value = 3200;
      // Two gain stages in series, not one: the channel fader and the
      // crossfader are independent controls, and folding them into a single
      // node makes each one overwrite the other's setting.
      this.gain = this.ctx.createGain();
      this.xfade = this.ctx.createGain();

      this.low.connect(this.mid);
      this.mid.connect(this.high);
      this.high.connect(this.gain);
      this.gain.connect(this.xfade);
      this.xfade.connect(this.ctx.destination);

      // Tapped after the crossfader so the visualiser shows what is actually
      // audible, not what the deck would sound like on its own.
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.75;
      this.xfade.connect(this.analyser);
      this.spectrum = new Uint8Array(this.analyser.frequencyBinCount);
    }
    this.volume = 1;
    this.eq = { low: 0, mid: 0, high: 0 };
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  /** Decode a file into memory. Returns false when there is nothing to play. */
  async load(file, cues = []) {
    this.stop();
    this.cues = [...cues].sort((a, b) => a.timeMs - b.timeMs);
    this.buffer = null;
    this.envelope = null;
    this.offset = 0;
    if (!file || !this.ctx) { this.emit(); return false; }
    try {
      this.buffer = await this.ctx.decodeAudioData(await file.arrayBuffer());
      this.envelope = buildEnvelope(this.buffer);
    } catch {
      this.buffer = null;   // unsupported codec, or a truncated file
      this.envelope = null;
    }
    this.emit();
    return Boolean(this.buffer);
  }

  get hasAudio() { return Boolean(this.buffer); }
  get playing() { return this._playing; }
  get durationMs() { return (this.buffer?.duration ?? 0) * 1000; }

  get positionMs() {
    if (!this.buffer) return 0;
    if (!this._playing) return this.offset * 1000;
    const elapsed = (this.ctx.currentTime - this.startedAt) * this.rate;
    return Math.min(this.offset + elapsed, this.buffer.duration) * 1000;
  }

  /**
   * Begin playback, optionally at a precise moment on the audio clock.
   *
   * `at` is an `AudioContext` timestamp. Scheduling a little ahead is what lets
   * two decks start genuinely together instead of one call after the other.
   */
  play(at = 0) {
    if (!this.buffer || this._playing) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();

    const source = this.ctx.createBufferSource();
    source.buffer = this.buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.low);

    const when = at || this.ctx.currentTime;
    const from = Math.max(0, Math.min(this.offset, this.buffer.duration - 0.001));
    source.start(when, from);
    source.onended = () => {
      if (this.source !== source) return;   // superseded by a seek
      this._playing = false;
      this.source = null;
      this.offset = this.buffer ? this.buffer.duration : 0;
      this.emit();
    };

    this.source = source;
    this.offset = from;
    this.startedAt = when;
    this._playing = true;
    this.emit();
  }

  pause() {
    if (!this._playing) return;
    this.offset = this.positionMs / 1000;
    const source = this.source;
    this.source = null;
    this._playing = false;
    source.onended = null;
    try { source.stop(); } catch { /* already ended */ }
    this.emit();
  }

  /**
   * Let go of the decoded audio, not just the playing source.
   *
   * `stop()` deliberately keeps the buffer, because stopping is what pause and
   * seek do and decoding again would cost hundreds of milliseconds. Emptying a
   * deck is the other case: the audio then belongs to a track -- sometimes to a
   * whole device -- that the page no longer has loaded, so holding it both
   * wastes tens of megabytes and leaves something playable that nothing on
   * screen refers to.
   */
  unload() {
    this.stop();
    this.buffer = null;
    this.envelope = null;
    this.cues = [];
    this.emit();
  }

  stop() {
    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch { /* already ended */ }
      this.source = null;
    }
    this._playing = false;
    this.offset = 0;
  }

  toggle() {
    if (!this.hasAudio) return;
    if (this._playing) this.pause(); else this.play();
  }

  /**
   * Channel fader, 0 to 1.
   *
   * Ramped rather than assigned: a step change in gain is a discontinuity in
   * the waveform, which is audible as a click.
   */
  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.gain) {
      this.gain.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
    }
    this.emit();
  }

  /** Crossfader contribution for this channel, 0 to 1. */
  setChannelGain(g) {
    if (this.xfade) {
      this.xfade.gain.setTargetAtTime(
        Math.max(0, Math.min(1, g)), this.ctx.currentTime, 0.01
      );
    }
  }

  /**
   * One EQ band, in decibels. A killed band is -26 dB rather than -Infinity:
   * inaudible, but it keeps the filter numerically well behaved.
   */
  setEq(band, db) {
    const clamped = Math.max(-26, Math.min(12, db));
    this.eq[band] = clamped;
    const node = this[band];
    if (node) node.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.01);
    this.emit();
  }

  /** Seek exactly. Restarting the source is what keeps it sample-accurate. */
  seekMs(ms) {
    if (!this.buffer) return;
    const wasPlaying = this._playing;
    if (wasPlaying) this.pause();
    this.offset = Math.max(0, Math.min(ms / 1000, this.buffer.duration));
    if (wasPlaying) this.play();
    else this.emit();
  }

  /**
   * Change speed without moving the playhead.
   *
   * Position is elapsed context time multiplied by the rate in force, so the
   * rate cannot change without rebasing the origin — otherwise every second
   * already played is retroactively re-measured at the new speed.
   */
  setRate(rate) {
    const next = Math.max(0.25, Math.min(4, rate));
    if (this._playing) {
      this.offset = this.positionMs / 1000;
      this.startedAt = this.ctx.currentTime;
      this.source.playbackRate.value = next;
    }
    this.rate = next;
  }

  /**
   * Jump to the neighbouring cue.
   *
   * The epsilon only excludes the cue the playhead is sitting *on*, so landing
   * on a cue and pressing "previous" again steps to the one before it. It must
   * stay small: widening it into a grace window has the opposite of the
   * intended effect, making "previous" skip the cue just passed and jump two
   * back instead.
   */
  jumpCue(direction) {
    if (!this.cues.length) return null;
    const now = this.positionMs;
    const EPSILON_MS = 5;
    const target =
      direction > 0
        ? this.cues.find((c) => c.timeMs > now + EPSILON_MS)
        : [...this.cues].reverse().find((c) => c.timeMs < now - EPSILON_MS);
    if (!target) return null;
    this.seekMs(target.timeMs);
    return target;
  }
}

/**
 * Winamp's spectrum analyser ramp, from the base skin's VISCOLOR.TXT.
 *
 * Twenty-four entries: index 0 is the background, 1 the dotted grid, 2 to 17
 * run the bar gradient from red at the peak down to green at the floor, and
 * the rest colour the oscilloscope. Only the bar range is needed here.
 */
export const VIS_COLORS = [
  [239, 49, 16], [206, 41, 16], [214, 90, 0], [214, 102, 0], [214, 115, 0],
  [198, 123, 8], [222, 165, 24], [214, 181, 33], [189, 222, 41], [148, 222, 33],
  [41, 206, 16], [50, 190, 16], [57, 181, 16], [49, 156, 8], [41, 148, 0],
  [24, 132, 8],
];

/** `m:ss.d` — a DJ reads tenths, so they are shown. */
export function fmtPosition(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const d = Math.floor((total * 10) % 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}
