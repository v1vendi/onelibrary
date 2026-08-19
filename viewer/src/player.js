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
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
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
    source.connect(this.gain);

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

/** `m:ss.d` — a DJ reads tenths, so they are shown. */
export function fmtPosition(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const d = Math.floor((total * 10) % 10);
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}
