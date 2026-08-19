/**
 * Audio playback for a loaded device.
 *
 * The audio lives on the device beside the database, so when a whole folder is
 * dropped the File objects are already in hand: a track plays from an object
 * URL over its own File, with no copying and no upload.
 *
 * Cue navigation is defined against the track's real cue list, so "next cue"
 * means the next marker a DJ actually set, not a fixed interval.
 */

export class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.url = null;
    this.cues = [];
    this.listeners = new Set();

    for (const ev of ['play', 'pause', 'ended', 'seeked', 'loadedmetadata', 'error']) {
      this.audio.addEventListener(ev, () => this.emit());
    }
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this);
  }

  /** Load a File. Returns false when the device has no audio for this track. */
  load(file, cues = []) {
    this.stop();
    this.cues = [...cues].sort((a, b) => a.timeMs - b.timeMs);
    if (!file) {
      this.emit();
      return false;
    }
    this.url = URL.createObjectURL(file);
    this.audio.src = this.url;
    this.emit();
    return true;
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
  }

  get hasAudio() { return Boolean(this.url); }
  get playing() { return this.hasAudio && !this.audio.paused && !this.audio.ended; }
  get positionMs() { return this.audio.currentTime * 1000; }
  get durationMs() {
    return Number.isFinite(this.audio.duration) ? this.audio.duration * 1000 : 0;
  }

  toggle() {
    if (!this.hasAudio) return;
    if (this.audio.paused) this.audio.play().catch(() => this.emit());
    else this.audio.pause();
  }

  seekMs(ms) {
    if (!this.hasAudio) return;
    const limit = this.durationMs || Infinity;
    this.audio.currentTime = Math.max(0, Math.min(ms, limit - 1)) / 1000;
    this.emit();
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
