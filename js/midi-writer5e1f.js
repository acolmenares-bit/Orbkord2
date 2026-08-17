// midi-writer.js
// Minimal Standard MIDI File (format 0) encoder — the counterpart to the parser
// in midi-file.js. Takes a flat note list in seconds and produces a .mid byte
// stream (single track, single tempo). Used to export generated sequences.
// Dual export (browser global + Node test runner).
//
// MPE mode (opts.tuning): a plain .mid can only carry 12-TET note numbers, so a
// microtonal take would import into a DAW sounding ordinary. MPE fixes that
// without needing MIDI 2.0 — every note gets its OWN channel plus a pitch bend
// carrying its offset from 12-TET, which Ableton/Logic/Bitwig all read today:
//
//   ch 1        MPE Configuration Message: lower zone owns 15 member channels
//   ch 2..16    one voice each — RPN pitch-bend range, then bend + note
//
// Voices round-robin over the member channels and are returned to the pool at
// note-off, so a channel is never reused while it is still sounding.

'use strict';

const MidiWriter = (() => {

  const MPE_MASTER = 0;        // channel 1 (0-based) — the zone's master
  const MPE_MEMBERS = 15;      // channels 2..16 carry the voices
  const MPE_BEND_SEMIS = 48;   // the MPE convention; DAWs expect ±48

  const writeVarLen = (out, value) => {
    let buffer = value & 0x7f;
    while ((value >>= 7) > 0) { buffer <<= 8; buffer |= (value & 0x7f) | 0x80; }
    for (;;) {
      out.push(buffer & 0xff);
      if (buffer & 0x80) buffer >>= 8; else break;
    }
  };

  const pushU32 = (out, v) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  const pushU16 = (out, v) => out.push((v >>> 8) & 0xff, v & 0xff);
  const pushStr = (out, s) => { for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff); };

  /**
   * @param {Array} notes  [{ midi, start, end, velocity }]  times in seconds
   * @param {object} [opts]
   * @param {number} [opts.bpm=100]
   * @param {number} [opts.ppq=480]    ticks per quarter note
   * @param {string} [opts.name]       track name meta event
   * @param {object} [opts.tuning]     a Tuning.Scale → write an MPE file whose
   *                                   per-note bends carry the microtonal
   *                                   offsets (omit for a plain 12-TET file)
   * @returns {Uint8Array} the .mid file bytes
   */
  function build(notes, opts = {}) {
    const bpm = opts.bpm || 100;
    const ppq = opts.ppq || 480;
    const secToTick = (s) => Math.max(0, Math.round(s * (bpm / 60) * ppq));
    // 12-TET needs no bends, so it exports as an ordinary single-channel file.
    const tuning = (opts.tuning && !opts.tuning.is12TET) ? opts.tuning : null;

    // Explode notes into on/off events, then sort by tick (off before on at a
    // tie so a repeated pitch retriggers cleanly).
    const events = [];
    for (const n of notes) {
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity ?? 96)));
      events.push({ tick: secToTick(n.start), type: 'on',  midi: n.midi, vel });
      events.push({ tick: secToTick(n.end),   type: 'off', midi: n.midi, vel: 0 });
    }
    events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

    // How far this note sits from its 12-TET position, as a 14-bit bend.
    const bendFor = (midi) => {
      const cents = tuning.centsOf(midi) - (midi - tuning.refMidi) * 100;
      const v = 8192 + Math.round((cents / (MPE_BEND_SEMIS * 100)) * 8192);
      return Math.max(0, Math.min(16383, v));
    };
    // Round-robin so a just-released channel isn't reused immediately — its
    // release tail may still be ringing in the DAW's instrument.
    const freeChannels = [];
    for (let i = 0; i < MPE_MEMBERS; i++) freeChannels.push(MPE_MASTER + 1 + i);
    const heldChannel = new Map();   // midi → channel

    const track = [];
    // Tempo meta (FF 51 03 tttttt)
    const usPerQuarter = Math.round(60000000 / bpm);
    writeVarLen(track, 0);
    track.push(0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
    // Track name meta (FF 03 len …)
    if (opts.name) {
      writeVarLen(track, 0);
      track.push(0xff, 0x03);
      writeVarLen(track, opts.name.length);
      pushStr(track, opts.name);
    }

    // MPE setup, all at tick 0: declare the zone on the master channel, then
    // widen every member channel's pitch-bend range to ±48 semitones. Without
    // the RPN the DAW assumes ±2 and every offset lands 24× too small.
    if (tuning) {
      const rpn = (ch, msb, lsb, valMsb) => {
        writeVarLen(track, 0); track.push(0xb0 | ch, 101, msb);
        writeVarLen(track, 0); track.push(0xb0 | ch, 100, lsb);
        writeVarLen(track, 0); track.push(0xb0 | ch, 6, valMsb);
        writeVarLen(track, 0); track.push(0xb0 | ch, 38, 0);
      };
      rpn(MPE_MASTER, 0, 6, MPE_MEMBERS);              // MCM: 15 member channels
      for (let i = 0; i < MPE_MEMBERS; i++) {
        rpn(MPE_MASTER + 1 + i, 0, 0, MPE_BEND_SEMIS); // pitch-bend range
      }
    }

    let prevTick = 0;
    for (const ev of events) {
      writeVarLen(track, ev.tick - prevTick);
      prevTick = ev.tick;
      if (!tuning) {
        if (ev.type === 'on') track.push(0x90, ev.midi & 0x7f, ev.vel & 0x7f);
        else                  track.push(0x80, ev.midi & 0x7f, 0x00);
        continue;
      }
      if (ev.type === 'on') {
        // If the pool is dry, steal the oldest sounding channel rather than
        // dropping the note.
        let ch = freeChannels.shift();
        if (ch === undefined) {
          const oldest = heldChannel.keys().next().value;
          ch = heldChannel.get(oldest);
          heldChannel.delete(oldest);
        }
        heldChannel.set(ev.midi, ch);
        const bend = bendFor(ev.midi);
        track.push(0xe0 | ch, bend & 0x7f, (bend >> 7) & 0x7f);   // bend first…
        writeVarLen(track, 0);
        track.push(0x90 | ch, ev.midi & 0x7f, ev.vel & 0x7f);     // …then the note
      } else {
        const ch = heldChannel.get(ev.midi);
        if (ch === undefined) { track.push(0x80, ev.midi & 0x7f, 0x00); continue; }
        heldChannel.delete(ev.midi);
        freeChannels.push(ch);
        track.push(0x80 | ch, ev.midi & 0x7f, 0x00);
      }
    }
    // End of track
    writeVarLen(track, 0);
    track.push(0xff, 0x2f, 0x00);

    const out = [];
    pushStr(out, 'MThd');
    pushU32(out, 6);
    pushU16(out, 0);        // format 0
    pushU16(out, 1);        // one track
    pushU16(out, ppq);
    pushStr(out, 'MTrk');
    pushU32(out, track.length);
    for (const b of track) out.push(b);

    return new Uint8Array(out);
  }

  return { build };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MidiWriter;
