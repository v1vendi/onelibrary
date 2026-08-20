/**
 * Pioneer DDJ-FLX4 support over Web MIDI.
 *
 * The mapping is taken from the controller definition rekordbox ships at
 * `rekordbox.app/Contents/Resources/MidiMappings/DDJ-FLX4.midi.csv`, not
 * guessed. That file lists each control as a status/data pair plus the channel
 * each deck answers on, which is the shape reproduced below.
 *
 * Two conventions from that file matter:
 *
 * **Deck is the channel.** `PlayPause` is note `0x0B` on channel 0 for deck 1
 * and channel 1 for deck 2. Performance pads are the exception, answering on
 * channels 7 and 9.
 *
 * **Faders and knobs are 14-bit.** Anything the file calls `KnobSliderHiRes`
 * sends its high seven bits on the listed controller and the low seven on that
 * controller plus 32, so a tempo fader resolves to 16384 steps rather than 128.
 * Reading only the MSB would quantise the pitch fader to about 0.05% steps,
 * which is audible as stepping when riding it against another deck.
 */

/** Controls that answer on the deck's own channel. */
const NOTE = {
  0x0b: 'playPause',
  0x0c: 'cue',
  0x58: 'sync',
  0x3f: 'shift',
  0x36: 'jogTouch',
};

/** 14-bit controls, by their MSB controller number. */
const CC_HIRES = {
  0x00: 'tempo',
  0x13: 'channelFader',
  0x07: 'eqHigh',
  0x0b: 'eqMid',
  0x0f: 'eqLow',
};

/** Relative encoders: value is an offset from 0x40, not an absolute position. */
const CC_RELATIVE = {
  0x22: 'jogScratch',
  0x23: 'jogBend',
};

/** Channel 6 carries the mixer and browser, which belong to no single deck. */
const GLOBAL_CHANNEL = 6;
const GLOBAL_NOTE = { 0x46: 'loadA', 0x47: 'loadB', 0x41: 'browsePress' };
const GLOBAL_CC_HIRES = { 0x1f: 'crossfader' };
const GLOBAL_CC_RELATIVE = { 0x40: 'browse' };

/** Pads answer on their own channels; 7 is deck A, 9 is deck B. */
const PAD_CHANNELS = { 7: 'A', 9: 'B' };

const DECK_CHANNELS = { 0: 'A', 1: 'B' };

export const SUPPORTED_DEVICE = /DDJ-FLX4/i;

export class MidiController {
  /**
   * @param {object} handlers  called with (deck, value) as each control moves
   */
  constructor(handlers = {}) {
    this.handlers = handlers;
    this.access = null;
    this.input = null;
    this.shift = false;
    /** Pending MSBs for 14-bit pairs, keyed by `${channel}:${controller}`. */
    this.msb = new Map();
  }

  get connected() { return Boolean(this.input); }
  get deviceName() { return this.input?.name ?? null; }

  /**
   * Ask for MIDI and attach to the first FLX4 found.
   *
   * @returns {Promise<string|null>} the reason it could not, or null on success
   */
  async connect() {
    if (!navigator.requestMIDIAccess) {
      return 'This browser has no Web MIDI. Chrome or Edge are needed.';
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      return 'MIDI access was refused.';
    }
    this.access.onstatechange = () => this.attach();
    return this.attach();
  }

  attach() {
    const inputs = [...this.access.inputs.values()];
    const found = inputs.find((i) => SUPPORTED_DEVICE.test(i.name || ''));
    for (const i of inputs) i.onmidimessage = null;
    this.input = found ?? null;
    if (!found) {
      this.handlers.onStatus?.(null);
      return inputs.length
        ? `No DDJ-FLX4 among ${inputs.length} MIDI device(s).`
        : 'No MIDI devices found. Connect the controller and switch it on.';
    }
    found.onmidimessage = (e) => this.onMessage(e.data);
    this.handlers.onStatus?.(found.name);
    return null;
  }

  disconnect() {
    if (this.input) this.input.onmidimessage = null;
    this.input = null;
    this.handlers.onStatus?.(null);
  }

  onMessage(data) {
    const [status, d1, d2] = data;
    const type = status & 0xf0;
    const channel = status & 0x0f;

    if (type === 0x90 || type === 0x80) {
      const pressed = type === 0x90 && d2 > 0;
      this.onNote(channel, d1, pressed);
    } else if (type === 0xb0) {
      this.onControl(channel, d1, d2);
    }
  }

  onNote(channel, note, pressed) {
    const pad = PAD_CHANNELS[channel];
    if (pad !== undefined && note <= 0x07) {
      // Pads 0-7 are hot cues A-H in the order the pads are laid out.
      if (pressed) this.handlers.hotCue?.(pad, 'ABCDEFGH'[note]);
      return;
    }

    if (channel === GLOBAL_CHANNEL) {
      const name = GLOBAL_NOTE[note];
      if (name && pressed) this.handlers[name]?.();
      return;
    }

    const deck = DECK_CHANNELS[channel];
    const name = NOTE[note];
    if (!name) return;
    if (name === 'shift') { this.shift = pressed; return; }
    if (deck === undefined) return;
    // Buttons fire on press; releases only matter for shift and jog touch.
    if (name === 'jogTouch') this.handlers.jogTouch?.(deck, pressed);
    else if (pressed) this.handlers[name]?.(deck, this.shift);
  }

  onControl(channel, controller, value) {
    if (channel === GLOBAL_CHANNEL) {
      const rel = GLOBAL_CC_RELATIVE[controller];
      if (rel) { this.handlers[rel]?.(value - 0x40); return; }
      const hires = this.resolveHiRes(channel, controller, value, GLOBAL_CC_HIRES);
      if (hires) this.handlers[hires.name]?.(hires.value);
      return;
    }

    const deck = DECK_CHANNELS[channel];
    if (deck === undefined) return;

    const rel = CC_RELATIVE[controller];
    if (rel) { this.handlers[rel]?.(deck, value - 0x40); return; }

    const hires = this.resolveHiRes(channel, controller, value, CC_HIRES);
    if (hires) this.handlers[hires.name]?.(deck, hires.value);
  }

  /**
   * Combine an MSB/LSB pair into a 0..1 fraction.
   *
   * The LSB arrives on the MSB's controller plus 32. An MSB on its own is held
   * until its partner lands; a controller that only ever sends the MSB would
   * therefore go unreported, so the MSB is also emitted immediately at its own
   * resolution and refined when the LSB follows.
   */
  resolveHiRes(channel, controller, value, table) {
    const asMsb = table[controller];
    if (asMsb) {
      this.msb.set(`${channel}:${controller}`, value);
      return { name: asMsb, value: value / 127 };
    }
    const msbController = controller - 32;
    const asLsb = table[msbController];
    if (!asLsb) return null;
    const high = this.msb.get(`${channel}:${msbController}`);
    if (high === undefined) return null;
    return { name: asLsb, value: ((high << 7) | value) / 16383 };
  }
}
