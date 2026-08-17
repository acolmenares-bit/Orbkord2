// midi-file.js
// Minimal Standard MIDI File (format 0/1) parser.
// Produces a flat, time-sorted note list in seconds plus a tempo map.

'use strict';

const MidiFile = (() => {

  function parse(arrayBuffer) {
    const data = new DataView(arrayBuffer);
    let pos = 0;

    const readStr = (n) => {
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(data.getUint8(pos + i));
      pos += n;
      return s;
    };
    const readU32 = () => { const v = data.getUint32(pos); pos += 4; return v; };
    const readU16 = () => { const v = data.getUint16(pos); pos += 2; return v; };
    const readU8  = () => { const v = data.getUint8(pos); pos += 1; return v; };
    const readVarLen = () => {
      let value = 0, byte;
      do {
        byte = readU8();
        value = (value << 7) | (byte & 0x7f);
      } while (byte & 0x80);
      return value;
    };

    if (readStr(4) !== 'MThd') throw new Error('Not a MIDI file (missing MThd header)');
    const headerLen = readU32();
    const format = readU16();
    const numTracks = readU16();
    const division = readU16();
    pos += headerLen - 6;

    if (division & 0x8000) throw new Error('SMPTE time division is not supported');
    const ticksPerQuarter = division;

    // Raw events across all tracks, in ticks
    const noteEvents = [];    // {tick, type:'on'|'off', note, velocity, channel}
    const tempoEvents = [];   // {tick, usPerQuarter}
    const sustainEvents = []; // {tick, channel, down} — CC64 damper pedal
    let trackName = '';

    for (let t = 0; t < numTracks; t++) {
      if (readStr(4) !== 'MTrk') throw new Error('Malformed MIDI file (missing MTrk)');
      const trackLen = readU32();
      const trackEnd = pos + trackLen;
      let tick = 0;
      let runningStatus = 0;

      while (pos < trackEnd) {
        tick += readVarLen();
        let status = data.getUint8(pos);
        if (status & 0x80) { pos++; runningStatus = status; }
        else status = runningStatus;

        const type = status & 0xf0;
        const channel = status & 0x0f;

        if (type === 0x90 || type === 0x80) {
          const note = readU8();
          const velocity = readU8();
          const isOn = type === 0x90 && velocity > 0;
          noteEvents.push({ tick, type: isOn ? 'on' : 'off', note, velocity, channel });
        } else if (type === 0xb0) {
          const cc = readU8();
          const val = readU8();
          if (cc === 64) sustainEvents.push({ tick, channel, down: val >= 64 });
        } else if (type === 0xa0 || type === 0xe0) {
          pos += 2;
        } else if (type === 0xc0 || type === 0xd0) {
          pos += 1;
        } else if (status === 0xff) {
          const metaType = readU8();
          const len = readVarLen();
          if (metaType === 0x51 && len === 3) {
            const usPerQuarter = (readU8() << 16) | (readU8() << 8) | readU8();
            tempoEvents.push({ tick, usPerQuarter });
          } else if (metaType === 0x03 && !trackName) {
            trackName = readStr(len);
          } else {
            pos += len;
          }
        } else if (status === 0xf0 || status === 0xf7) {
          const len = readVarLen();
          pos += len;
        } else {
          throw new Error('Unexpected MIDI status byte 0x' + status.toString(16));
        }
      }
      pos = trackEnd;
    }

    // Build tick → seconds conversion from the tempo map (default 120 BPM)
    tempoEvents.sort((a, b) => a.tick - b.tick);
    if (tempoEvents.length === 0 || tempoEvents[0].tick > 0) {
      tempoEvents.unshift({ tick: 0, usPerQuarter: 500000 });
    }
    let acc = 0;
    for (let i = 0; i < tempoEvents.length; i++) {
      tempoEvents[i].seconds = acc;
      if (i < tempoEvents.length - 1) {
        const dt = tempoEvents[i + 1].tick - tempoEvents[i].tick;
        acc += (dt / ticksPerQuarter) * (tempoEvents[i].usPerQuarter / 1e6);
      }
    }
    const tickToSeconds = (tick) => {
      let seg = tempoEvents[0];
      for (const te of tempoEvents) {
        if (te.tick <= tick) seg = te; else break;
      }
      return seg.seconds + ((tick - seg.tick) / ticksPerQuarter) * (seg.usPerQuarter / 1e6);
    };

    // Damper pedal (CC64): while it's held, a released key keeps sounding until
    // the pedal lifts. Piano MIDIs lean on this heavily — ignoring it cuts every
    // note at key-release and sounds choppy/"squashed". We extend each note-off
    // to the next pedal-up on its channel when the pedal is down at release.
    sustainEvents.sort((a, b) => a.tick - b.tick);
    function sustainedOffTick(channel, offTick) {
      if (!sustainEvents.length) return offTick;
      let down = false;
      for (const s of sustainEvents) {
        if (s.channel !== channel) continue;
        if (s.tick <= offTick) down = s.down; else break;
      }
      if (!down) return offTick;
      for (const s of sustainEvents) {
        if (s.channel === channel && s.tick >= offTick && !s.down) return s.tick;
      }
      return offTick; // pedal never lifted — leave the note's own release
    }

    // Pair note-on/off events into notes with start/end in seconds.
    // Channel 10 (index 9) is percussion — excluded from chord analysis.
    noteEvents.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));
    const open = new Map(); // key: channel*128+note → stack of {tick, velocity}
    const notes = [];
    for (const ev of noteEvents) {
      if (ev.channel === 9) continue;
      const key = ev.channel * 128 + ev.note;
      if (ev.type === 'on') {
        if (!open.has(key)) open.set(key, []);
        open.get(key).push(ev);
      } else {
        const stack = open.get(key);
        if (stack && stack.length) {
          const onEv = stack.shift();
          notes.push({
            midi: ev.note,
            channel: ev.channel,
            velocity: onEv.velocity,
            start: tickToSeconds(onEv.tick),
            end: tickToSeconds(sustainedOffTick(ev.channel, ev.tick))
          });
        }
      }
    }
    // Close any hanging notes at the last event
    const lastTick = noteEvents.length ? noteEvents[noteEvents.length - 1].tick : 0;
    for (const stack of open.values()) {
      for (const onEv of stack) {
        notes.push({
          midi: onEv.note,
          channel: onEv.channel ?? 0,
          velocity: onEv.velocity,
          start: tickToSeconds(onEv.tick),
          end: tickToSeconds(lastTick)
        });
      }
    }

    notes.sort((a, b) => a.start - b.start);
    const duration = notes.reduce((m, n) => Math.max(m, n.end), 0);
    const bpm = 60e6 / tempoEvents[0].usPerQuarter;

    return { format, numTracks, ticksPerQuarter, notes, duration, bpm, trackName };
  }

  return { parse };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = MidiFile;
