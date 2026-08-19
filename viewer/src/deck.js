/**
 * A deck: one loaded track, its analysis, and its tempo.
 *
 * Tempo is driven through `playbackRate`, which shifts pitch with it — the
 * behaviour of a turntable or a CDJ with master tempo off, not of a
 * key-preserving stretch. That is the honest default for a pitch fader; key
 * lock would need a time-stretcher this does not have.
 */

import { Player } from './player.js';

/** Pitch fader ranges a CDJ offers, in percent. */
export const PITCH_RANGES = [6, 10, 16, 100];

export class Deck {
  /** @param {string} id display label, "A" or "B" */
  constructor(id) {
    this.id = id;
    this.player = new Player();
    this.track = null;
    this.anlz = null;
    this.artworkUrl = null;
    /** Pitch adjustment in percent; 0 is the track's recorded tempo. */
    this.pitch = 0;
    this.range = 6;
    /** Where CUE returns to. Defaults to the first memory cue. */
    this.cuePointMs = 0;
    this.listeners = new Set();
    this.player.onChange(() => this.emit());
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const fn of this.listeners) fn(this); }

  get loaded() { return Boolean(this.track); }
  get cues() { return this.anlz?.cues ?? []; }
  get hotCues() { return this.cues.filter((c) => !c.isMemory); }

  /** The track's analysed tempo, before the pitch fader. */
  get baseBpm() {
    return this.track?.bpmx100 ? this.track.bpmx100 / 100 : null;
  }

  /** The tempo it is actually playing at. */
  get bpm() {
    return this.baseBpm === null ? null : this.baseBpm * (1 + this.pitch / 100);
  }

  get durationMs() {
    return this.player.durationMs || (this.track?.length ?? 0) * 1000;
  }

  get remainingMs() {
    return Math.max(0, this.durationMs - this.player.positionMs);
  }

  load({ track, anlz, audioFile, artworkUrl }) {
    if (this.artworkUrl) URL.revokeObjectURL(this.artworkUrl);
    this.track = track;
    this.anlz = anlz;
    this.artworkUrl = artworkUrl ?? null;
    this.pitch = 0;
    this.player.audio.playbackRate = 1;
    const memory = (anlz?.cues ?? []).filter((c) => c.isMemory);
    this.cuePointMs = memory.length ? memory[0].timeMs : 0;
    this.player.load(audioFile, anlz?.cues ?? []);
    this.emit();
    return Boolean(audioFile);
  }

  setPitch(percent) {
    this.pitch = Math.max(-this.range, Math.min(this.range, percent));
    // playbackRate is clamped by the browser well outside any DJ range.
    this.player.audio.playbackRate = 1 + this.pitch / 100;
    this.emit();
  }

  setRange(range) {
    this.range = range;
    this.setPitch(this.pitch); // re-clamp if the new range is narrower
  }

  resetPitch() { this.setPitch(0); }

  /**
   * CUE, as on a player: stop and return to the cue point.
   *
   * Pressing it while already stopped at the cue point moves the cue point to
   * the current position instead, which is how a cue gets re-set without a
   * separate control.
   */
  cue() {
    const atCuePoint = Math.abs(this.player.positionMs - this.cuePointMs) < 30;
    if (!this.player.playing && atCuePoint) {
      this.cuePointMs = this.player.positionMs;
    } else {
      this.player.audio.pause();
      this.player.seekMs(this.cuePointMs);
    }
    this.emit();
  }

  setCuePoint(ms) {
    this.cuePointMs = Math.max(0, ms);
    this.emit();
  }

  jumpToHotCue(letter) {
    const cue = this.hotCues.find((c) => c.hotLetter === letter);
    if (!cue) return null;
    this.player.seekMs(cue.timeMs);
    return cue;
  }

  /**
   * Where the playhead sits between two beats, as a fraction of one beat.
   *
   * Beat times come from the analysis and are in the track's own timeline, so
   * they stay valid whatever the pitch fader is doing -- `currentTime` is media
   * time, not wall-clock time.
   */
  beatPhaseAt(ms = this.player.positionMs) {
    const beats = this.anlz?.beats ?? [];
    if (beats.length < 2) return null;
    let i = 0;
    while (i < beats.length - 2 && beats[i + 1].timeMs <= ms) i++;
    const from = beats[i].timeMs;
    const to = beats[i + 1].timeMs;
    const span = to - from;
    if (span <= 0) return null;
    return { index: i, phase: (ms - from) / span, beatMs: span, beatNumber: beats[i].beat };
  }

  /**
   * Position within the four-beat bar, as a fraction of the bar.
   *
   * Beat-level alignment is not enough to make two tracks sit together: landing
   * on the right beat but the wrong beat *of the bar* puts a snare where a kick
   * should be. `beat` counts 1-4 in the analysis, so the bar position is that
   * count plus the fraction through the current beat.
   */
  barPhaseAt(ms = this.player.positionMs) {
    const at = this.beatPhaseAt(ms);
    if (!at) return null;
    const withinBar = ((at.beatNumber - 1) % 4 + 4) % 4;
    return { ...at, barPhase: (withinBar + at.phase) / 4, barMs: at.beatMs * 4 };
  }

  /**
   * Match another deck's tempo *and* line the beats up.
   *
   * Matching BPM alone leaves the two tracks running at the same speed but out
   * of phase, which is not what a sync button is for. After the tempo is set,
   * the playhead moves to the nearest beat boundary and takes on the other
   * deck's position within its beat, so the transients land together.
   *
   * Returns the reason it could not, rather than silently doing nothing.
   */
  syncTo(other) {
    if (!this.baseBpm) return 'this deck has no analysed BPM';
    const target = other?.bpm;
    if (!target) return 'the other deck has no analysed BPM';
    const needed = (target / this.baseBpm - 1) * 100;
    if (Math.abs(needed) > this.range) {
      return `needs ${needed >= 0 ? '+' : ''}${needed.toFixed(1)}% — beyond ±${this.range}%`;
    }
    this.setPitch(needed);

    const theirs = other.barPhaseAt();
    const mine = this.barPhaseAt();
    if (!theirs || !mine) {
      this.emit();
      return null; // tempo matched; no beatgrid to align against
    }

    // Align on the bar, then pick whichever candidate position is nearest.
    //
    // Matching bar phase alone still leaves a choice of which bar to land in,
    // and taking the wrong one throws the track a whole bar out. Every
    // candidate that satisfies the phase sits one bar apart, so generating the
    // neighbours and choosing the closest keeps the correction under half a bar
    // while still landing on the right beat of the bar.
    const barMs = mine.barMs;
    const myBarStart = this.player.positionMs - mine.barPhase * barMs;
    const aligned = myBarStart + theirs.barPhase * barMs;
    const candidates = [aligned - barMs, aligned, aligned + barMs].filter((t) => t >= 0);
    const best = candidates.reduce((a, b) =>
      Math.abs(b - this.player.positionMs) < Math.abs(a - this.player.positionMs) ? b : a
    );

    this.player.seekMs(best);
    this.emit();
    return null;
  }

  unload() {
    this.player.stop();
    if (this.artworkUrl) URL.revokeObjectURL(this.artworkUrl);
    this.artworkUrl = null;
    this.track = null;
    this.anlz = null;
    this.emit();
  }
}
