  // synth.js
  // Polyphonic WebAudio engine. Two sound sources behind one API:
  //   • built-in oscillator synth (default, zero download)
  //   • Sampler instruments distilled from SF2s (js/sampler.js, lazy-loaded)
  // All voices route through masterGain → compressor → destination AND
  // → recorderDestination, so exported videos carry the audio track.

  'use strict';

  class Synth {
    constructor() {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'interactive',
      });
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.9;

      // ---------- Reverb ----------
      this.dryGain = this.ctx.createGain();
      // this.dryGain.gain.value = 1.0;  

      this.reverbSend = this.ctx.createGain();
      this.reverbSend.gain.value = 0.15;      // default 15%

      this.convolver = this.ctx.createConvolver();

      this.wetGain = this.ctx.createGain();
      this.wetGain.gain.value = 0.8;

      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -18;
      this.compressor.ratio.value = 6;

      // this.masterGain.connect(this.compressor);


      // dry path
      this.dryGain.connect(this.masterGain);

      // wet path
      this.reverbSend.connect(this.convolver);
      this.convolver.connect(this.wetGain);
      this.wetGain.connect(this.masterGain);

      // master
      this.masterGain.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      this.recorderDestination = this.ctx.createMediaStreamDestination();
      this.compressor.connect(this.recorderDestination);

      // All voices (osc or sampler) sum on voiceBus, which normally feeds the
      // dry + reverb sends directly. setExpression() can insert a processing
      // bus (Air Brass breath control) between voiceBus and those sends — one
      // insert shapes every sounding voice, so polyphony/harmonizer are
      // untouched. The metronome click stays on masterGain (never breath-gated).
      this.voiceBus = this.ctx.createGain();
      this.voiceBus.connect(this.dryGain);
      this.voiceBus.connect(this.reverbSend);
      this.expression = null;

      this.liveVoices = new Map(); // midi → voice (for live input note-off)

      this.instrument = null;      // active Sampler (null = oscillator synth)
      this._samplers = new Map();  // name → Sampler (cache across switches)

      // Microtonal pitch map (js/tuning.js). null == plain 12-TET. Note numbers
      // stay 12-TET everywhere else in the app — only frequency is retuned.
      this.tuning = null;
    }

    // Swap the pitch map. Pass null (or a 12-TET scale) for normal tuning.
    setTuning(t) { this.tuning = (t && !t.is12TET) ? t : null; }

    // Insert (or remove, with null) an ExpressionBus between the voices and
    // the dry/reverb sends.
    setExpression(bus) {
      if (this.expression === bus) return;
      try { this.voiceBus.disconnect(); } catch (_) {}
      if (this.expression) { try { this.expression.output.disconnect(); } catch (_) {} }
      if (bus) {
        this.voiceBus.connect(bus.input);
        bus.output.connect(this.dryGain);
        bus.output.connect(this.reverbSend);
      } else {
        this.voiceBus.connect(this.dryGain);
        this.voiceBus.connect(this.reverbSend);
      }
      this.expression = bus;
    }

    get now() { return this.ctx.currentTime; }

    resume() {
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    // Master output level (0..~1.5). Everything sums at masterGain before the
    // compressor + recorder tap, so this governs both speakers and recordings.
    setVolume(v) { this.masterGain.gain.value = v; }

    async loadReverb(url) {
        const data = await fetch(url).then(r => r.arrayBuffer());
        this.convolver.buffer = await this.ctx.decodeAudioData(data);
    }

    // setReverb(amount) {
    //     this.reverbSend.gain.value = amount;
    // }
    setReverb(amount) {
      amount = Math.max(0, Math.min(1, amount));

      // Keep dry stable. Slider just controls how much signal goes into reverb.
      this.dryGain.gain.value = 1.0;

      // Moderate send amount.
      this.reverbSend.gain.value = amount * 0.55;

      // Fixed wet return level.
      this.wetGain.gain.value = 0.60;
    }

    // Switch sound source. name = null → built-in synth; otherwise a folder
    // under assets/sf/ (e.g. 'rhodes', 'petrof'). Lazy-loads + caches.
    async setInstrument(name) {
      if (!name) { this.instrument = null; return; }
      let s = this._samplers.get(name);
      if (!s) {
        // s = new Sampler(this.ctx, this.masterGain);
        s = new Sampler(this.ctx, this);
        await s.load(`assets/sf/${name}`);
        this._samplers.set(name, s);
      }
      this.instrument = s;
    }

    midiToFreq(midi) {
      if (this.tuning) return this.tuning.freqOf(midi);
      return 440 * Math.pow(2, (midi - 69) / 12);
    }

    // Schedule a note at an absolute AudioContext time. Returns voice handle
    // ({nodes, gain, released}) usable with releaseVoice().
    playNote(midi, velocity, when, duration = null) {
      if (this.instrument && this.instrument.ready) {
        return this.instrument.playNote(midi, velocity, when, duration,
          (v, t) => this.releaseVoice(v, t));
      }

      const freq = this.midiToFreq(midi);
      const vel = Math.max(0.05, Math.min(1, velocity / 127));
      const t = Math.max(when, this.now);

      const gain = this.ctx.createGain();
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = Math.min(8000, 800 + freq * 4 + vel * 3000);
      filter.Q.value = 0.5;

      const osc1 = this.ctx.createOscillator();
      osc1.type = 'triangle';
      osc1.frequency.value = freq;
      const osc2 = this.ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = freq * 2;
      const osc2gain = this.ctx.createGain();
      osc2gain.gain.value = 0.25 * vel;

      osc1.connect(filter);
      osc2.connect(osc2gain);
      osc2gain.connect(filter);
      filter.connect(gain);
      gain.connect(this.voiceBus);

      const peak = 0.5 * vel;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(peak, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, peak * 0.35), t + 0.35);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0008, peak * 0.12), t + 1.6);

      osc1.start(t);
      osc2.start(t);

      const voice = { nodes: [osc1, osc2], gain, released: false };

      if (duration !== null) {
        this.releaseVoice(voice, t + duration);
      }
      return voice;
    }

    releaseVoice(voice, when = null) {
      if (voice.released) return;
      voice.released = true;
      const t = Math.max(when ?? this.now, this.now);
      const g = voice.gain.gain;
      // cancelScheduledValues() snaps the param back to its last *event*
      // value (not the current ramped value) → audible pop. cancelAndHold
      // freezes at the actual current value; fall back to pinning .value.
      if (typeof g.cancelAndHoldAtTime === 'function') {
        g.cancelAndHoldAtTime(t);
      } else {
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
      }
      g.setTargetAtTime(0, t, 0.07);
      // Stop only once the tail is truly inaudible (τ·10) — stopping while
      // the gain is still non-zero is itself a click.
      for (const n of voice.nodes) {
        try { n.stop(t + 0.8); } catch (_) { /* already stopped */ }
      }
    }

    // --- Live input helpers ---
    noteOn(midi, velocity) {
      this.resume();
      this.noteOff(midi);
      this.liveVoices.set(midi, this.playNote(midi, velocity, this.now));
    }

    noteOff(midi) {
      const v = this.liveVoices.get(midi);
      if (v) {
        this.releaseVoice(v);
        this.liveVoices.delete(midi);
      }
    }

    allNotesOff() {
      for (const v of this.liveVoices.values()) this.releaseVoice(v);
      this.liveVoices.clear();
    }

    // Metronome tick: a short enveloped blip, brighter/louder on the downbeat.
    click(when, accent = false) {
      const t = Math.max(when, this.now);
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = accent ? 2000 : 1400;
      const peak = accent ? 0.5 : 0.28;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
      osc.connect(g);
      g.connect(this.masterGain);
      osc.start(t);
      osc.stop(t + 0.06);
    }
  }
