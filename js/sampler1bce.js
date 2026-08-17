// sampler.js
// SoundFont sample playback. Loads a set built by tools/render-soundfont.js:
// each pitch is captured at several VELOCITY LAYERS (soft..hard), so a soft note
// plays its real soft-attack recording rather than a forte sample turned down —
// this is what makes it sound like Sforzando instead of "hit hard". At play time
// we pick the nearest key, then the nearest velocity layer. Voices route into
// the destination the Synth provides, so recording/export chains keep working.
//
// Back-compat: also loads the old single-layer manifests ({key,root,tune,file}).

'use strict';

class Sampler {
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.layered = false;
    this.keys = [];          // sorted unique sample keys (layered mode)
    this.byKey = new Map();  // key → [{vel, root, tune, buffer}] sorted by vel
    this.flat = [];          // [{key, root, tune, buffer}] (old single-layer)
    this.loop = null;        // {start, end} secs — sustain loop (brass/pads)
    this.ready = false;
  }

  async load(baseUrl) {
    const man = await (await fetch(`${baseUrl}/manifest.json`)).json();
    this.loop = man.loop || null;
    const byFile = new Map(); // decode each unique file once
    const decode = (file) => {
      if (!byFile.has(file)) {
        byFile.set(file, (async () => {
          const ab = await (await fetch(`${baseUrl}/${file}`)).arrayBuffer();
          return this.ctx.decodeAudioData(ab);
        })());
      }
      return byFile.get(file);
    };

    this.layered = man.samples.length > 0 && man.samples[0].vel !== undefined;

    if (this.layered) {
      for (const s of man.samples) {
        const buffer = await decode(s.file);
        if (!this.byKey.has(s.key)) this.byKey.set(s.key, []);
        this.byKey.get(s.key).push({ vel: s.vel, root: s.key, tune: 0, buffer });
      }
      for (const arr of this.byKey.values()) arr.sort((a, b) => a.vel - b.vel);
      this.keys = [...this.byKey.keys()].sort((a, b) => a - b);
    } else {
      this.flat = await Promise.all(man.samples.map(async (s) => ({
        key: s.key, root: s.root, tune: s.tune, buffer: await decode(s.file),
      })));
      this.flat.sort((a, b) => a.key - b.key);
    }
    this.ready = true;
    return this;
  }

  // Nearest key, then nearest velocity layer within that key.
  pick(midi, velocity) {
    if (!this.layered) {
      let best = this.flat[0];
      for (const s of this.flat) {
        if (Math.abs(s.key - midi) < Math.abs(best.key - midi)) best = s;
      }
      return best;
    }
    let bestKey = this.keys[0];
    for (const k of this.keys) {
      if (Math.abs(k - midi) < Math.abs(bestKey - midi)) bestKey = k;
    }
    const layers = this.byKey.get(bestKey);
    let best = layers[0];
    for (const l of layers) {
      if (Math.abs(l.vel - velocity) < Math.abs(best.vel - velocity)) best = l;
    }
    return best;
  }

  // Same contract as Synth.playNote: returns a voice handle the Synth's
  // releaseVoice() understands ({nodes, gain, released}).
  playNote(midi, velocity, when, duration = null, releaseFn = null) {
    // Microtonal tuning lives entirely here: the samples were rendered at
    // 12-TET pitches, so we pick by where the note actually SOUNDS (not by its
    // note number — in linear mode those diverge by octaves) and shift by the
    // cents difference. No retuned sample sets needed.
    const tuning = this.destination.tuning || null;
    const s = this.pick(tuning ? tuning.pitchMidi(midi) : midi, velocity);
    const vel = Math.max(0.05, Math.min(1, velocity / 127));
    const t = Math.max(when, this.ctx.currentTime);

    const src = this.ctx.createBufferSource();
    src.buffer = s.buffer;
    const shiftCents = tuning
      ? tuning.centsOf(midi) - (s.root - tuning.refMidi) * 100
      : (midi - s.root) * 100;
    const rate = Math.pow(2, (shiftCents + s.tune) / 1200);
    src.playbackRate.value = rate;

    // Air Brass: per-voice filter + attack envelope + portamento. The bus
    // decides all three, so nothing here needs to know about breath.
    const exp = this.destination.expression;
    const shaped = exp ? exp.prepareVoice(midi, t) : null;

    if (shaped && shaped.glideFrom !== null && shaped.glide > 0) {
      // Slide in from the nearest note of the previous chord (in the active
      // tuning, so portamento lands on real scale degrees).
      const gapCents = tuning
        ? tuning.centsOf(shaped.glideFrom) - tuning.centsOf(midi)
        : (shaped.glideFrom - midi) * 100;
      const from = rate * Math.pow(2, gapCents / 1200);
      src.playbackRate.setValueAtTime(from, t);
      src.playbackRate.exponentialRampToValueAtTime(rate, t + shaped.glide);
    }

    // Sustain loop (manifest.loop, seam crossfade baked at render time) —
    // brass/pad sets hold forever; the note ends when releaseVoice() ramps
    // the gain and stops the source.
    if (this.loop) {
      src.loop = true;
      src.loopStart = this.loop.start;
      src.loopEnd = this.loop.end;
    }

    const gain = this.ctx.createGain();
    // The layer already encodes the dynamic timbre + level, so only a gentle
    // trim on top (avoids double-counting velocity into loudness).
    const peak = 0.78 + 0.22 * vel;
    // Normally a 2ms ramp-in to kill the buffer-start edge click, preserving
    // the sample's own attack. Under Air Brass the bus supplies a longer
    // attack so notes swell in from silence instead of punching.
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + (shaped ? shaped.attack : 0.002));

    src.connect(gain);
    if (shaped) {
      gain.connect(shaped.filter);
      shaped.filter.connect(this.destination.voiceBus);
    } else {
      gain.connect(this.destination.voiceBus);
    }

    // Air Brass: the ExpressionBus' shared vibrato LFO modulates each voice's
    // pitch (playbackRate sums its inputs); detached when the voice ends.
    if (exp) exp.attachVoice(src.playbackRate);

    src.start(t);
    src.onended = () => {
      try { gain.disconnect(); } catch (_) {}
      if (exp) { exp.detachVoice(src.playbackRate); exp.releaseVoice(shaped); }
    };

    const voice = { nodes: [src], gain, released: false };
    if (duration !== null && releaseFn) releaseFn(voice, t + duration);
    return voice;
  }
}

if (typeof module !== 'undefined') module.exports = { Sampler };
