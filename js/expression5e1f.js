// expression.js
// ExpressionBus — the breath-controlled insert for Air Brass mode. Sits between
// the Synth's voiceBus and the dry/reverb sends, so ONE breath value shapes
// every sounding voice at once (melody + all harmonizer notes together — the
// instrument stays fully polyphonic, this is expression, not voice allocation).
//
//   GLOBAL (all voices):
//     voiceBus → drive → tanh shaper → makeup → breathGain → out
//   PER VOICE (built by prepareVoice(), spliced in by the sampler):
//     voiceGain → lowpass ← cutoff/Q driven by the breath signals × an
//                           ATTACK envelope that always starts at 0
//
// Why the filter is per-voice: with a single shared filter, starting a note
// while already blowing hard drops it in at full brightness — the "punch" that
// makes it sound like a soundfont rather than a wind instrument. Each voice now
// opens from closed over its own attack (~70ms), so no matter how hard you are
// blowing, every note swells in. Breath still governs where it swells TO.
//
// Portamento: voices remember the previous chord "generation" and glide into
// pitch from the nearest note of it, so chord changes slide rather than jump.
//
// All curves are named consts below for tuning — same convention as the
// harmonizer weights.

'use strict';

const BREATH_MAP = {
  GAIN_EXP: 1.6,       // perceptual loudness curve: gain = b^exp
  CUTOFF_MIN: 300,     // Hz at breath 0 (closed, dark)
  CUTOFF_MAX: 900,    // Hz at breath 1 (open, bright) — exponential sweep
  Q_MIN: 0.3,          // slight resonance rises with breath
  Q_MAX: 1.9,
  DRIVE_MIN: 1.0,      // saturation pre-gain (into tanh)
  DRIVE_MAX: 1.2,      // was 1.9 — that saturated the tanh on hard attacks
  VIB_THRESHOLD: 0.2, // vibrato only above this breath level…
  VIB_CENTS: 10,       // …ramping to ± this depth at full breath
  VIB_HZ: 5.2,         // brass-player vibrato rate
  SMOOTH_TC: 0.05,     // setTargetAtTime time constant (s) — desktop-side glide

  ATTACK_S: 0.2,      // per-note swell from silent+closed → breath level
  GLIDE_S: 0.15,       // portamento into pitch from the previous chord
  CUTOFF_FLOOR: 180,   // Hz the per-voice filter sits at before the attack
  GLIDE_MAX_SEMIS: 12, // clamp: never swoop more than an octave
  CHORD_WINDOW: 0.03,  // notes within this many seconds = one chord
  PARAM_MAX_S: 0.5,    // UI ceiling for attack/glide
};

// Pure mapping (node-testable): breath 0..1 → audio parameter targets.
function mapBreath(b) {
  b = Math.max(0, Math.min(1, b));
  const M = BREATH_MAP;
  const vibNorm = b <= M.VIB_THRESHOLD ? 0 : (b - M.VIB_THRESHOLD) / (1 - M.VIB_THRESHOLD);
  return {
    gain: Math.pow(b, M.GAIN_EXP),
    cutoff: M.CUTOFF_MIN * Math.pow(M.CUTOFF_MAX / M.CUTOFF_MIN, b),
    q: M.Q_MIN + (M.Q_MAX - M.Q_MIN) * b,
    drive: M.DRIVE_MIN + (M.DRIVE_MAX - M.DRIVE_MIN) * b,
    vibCents: vibNorm * M.VIB_CENTS,
  };
}

// Nearest note of the previous chord to glide from, clamped to an octave.
// null = no glide (nothing before it, or it is the same pitch).
function glideOriginFor(midi, prevGen, maxSemis = BREATH_MAP.GLIDE_MAX_SEMIS) {
  if (!prevGen || !prevGen.length) return null;
  let best = null;
  for (const p of prevGen) {
    if (best === null || Math.abs(p - midi) < Math.abs(best - midi)) best = p;
  }
  if (best === null || best === midi) return null;
  return midi + Math.max(-maxSemis, Math.min(maxSemis, best - midi));
}

// cents of pitch wobble → playbackRate offset (for rates ≈ 1, which holds:
// samples are rendered every 3 semitones so runtime rates stay within ±1.5 st).
const CENTS_TO_RATE = Math.LN2 / 1200;

class ExpressionBus {
  constructor(ctx) {
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.drive = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.makeup = ctx.createGain();
    this.breathGain = ctx.createGain();
    this.output = this.breathGain;

    // Gentle tanh curve; DRIVE pushes signal into the knee for warmth.
    const N = 1024, curve = new Float32Array(N);
    const K = 1.5, norm = Math.tanh(K);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = Math.tanh(K * x) / norm;
    }
    this.shaper.curve = curve;
    this.shaper.oversample = '2x';

    this.input.connect(this.drive);
    this.drive.connect(this.shaper);
    this.shaper.connect(this.makeup);
    this.makeup.connect(this.breathGain);

    // Control signals fanned out to every voice's filter. Each voice scales
    // them by its own attack envelope, so breath moves all voices together
    // while each note still opens from zero.
    this.cutoffSignal = ctx.createConstantSource();
    this.qSignal = ctx.createConstantSource();
    this.cutoffSignal.start();
    this.qSignal.start();

    // Shared vibrato LFO: sine × depth. attachVoice() fans the depth node out
    // to each active voice's playbackRate (AudioParams sum their inputs).
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = BREATH_MAP.VIB_HZ;
    this.vibrato = ctx.createGain();
    this.vibrato.gain.value = 0;
    this.lfo.connect(this.vibrato);
    this.lfo.start();

    this.attack = BREATH_MAP.ATTACK_S;
    this.glide = BREATH_MAP.GLIDE_S;

    // Chord "generations" for portamento: notes landing within CHORD_WINDOW of
    // each other belong to the same chord; the one before it is what we slide
    // from. Uses AudioContext time, so scheduled file playback groups correctly
    // by the file's own chord rhythm.
    this._prevGen = [];
    this._curGen = [];
    this._lastNoteAt = -Infinity;

    this.setBreath(1); // neutral until a phone speaks
  }

  setAttack(s) { this.attack = Math.max(0, Math.min(BREATH_MAP.PARAM_MAX_S, s)); }
  setGlide(s) { this.glide = Math.max(0, Math.min(BREATH_MAP.PARAM_MAX_S, s)); }

  // b∈[0,1] → glide all parameters toward their mapped targets.
  setBreath(b) {
    const p = mapBreath(b);
    const t = this.ctx.currentTime, tc = BREATH_MAP.SMOOTH_TC;
    this.breathGain.gain.setTargetAtTime(p.gain, t, tc);
    this.cutoffSignal.offset.setTargetAtTime(p.cutoff, t, tc);
    this.qSignal.offset.setTargetAtTime(p.q, t, tc);
    this.drive.gain.setTargetAtTime(p.drive, t, tc);
    // Partial makeup so saturation adds warmth, not just level.
    this.makeup.gain.setTargetAtTime(1 / Math.sqrt(p.drive), t, tc);
    this.vibrato.gain.setTargetAtTime(p.vibCents * CENTS_TO_RATE, t, tc);
    this.breath = b;
  }

  // Build one voice's filter + attack envelopes and work out its glide origin.
  // `when` is the voice's start time in AudioContext seconds.
  prepareVoice(midi, when) {
    if (when - this._lastNoteAt > BREATH_MAP.CHORD_WINDOW) {
      this._prevGen = this._curGen;
      this._curGen = [];
    }
    this._lastNoteAt = when;
    this._curGen.push(midi);

    const glideFrom = this.glide > 0 ? glideOriginFor(midi, this._prevGen) : null;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    // Params read as base + sum(connected signals), so the bases are the
    // "note just started" values and the envelopes add the breath on top.
    filter.frequency.value = BREATH_MAP.CUTOFF_FLOOR;
    filter.Q.value = 0;

    // Separate envelope per param — one shared gain node would SUM cutoff
    // and Q into a single wrong number.
    const atk = Math.max(0.002, this.attack);
    const atkCut = this.ctx.createGain();
    const atkQ = this.ctx.createGain();
    for (const g of [atkCut, atkQ]) {
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(1, when + atk);
    }
    this.cutoffSignal.connect(atkCut);
    atkCut.connect(filter.frequency);
    this.qSignal.connect(atkQ);
    atkQ.connect(filter.Q);

    return { filter, atkCut, atkQ, glideFrom, attack: atk, glide: this.glide };
  }

  // Tear a voice's insert down (called when its source ends).
  releaseVoice(shaped) {
    if (!shaped) return;
    try { this.cutoffSignal.disconnect(shaped.atkCut); } catch (_) {}
    try { this.qSignal.disconnect(shaped.atkQ); } catch (_) {}
    try { shaped.atkCut.disconnect(); } catch (_) {}
    try { shaped.atkQ.disconnect(); } catch (_) {}
    try { shaped.filter.disconnect(); } catch (_) {}
  }

  // Voice pitch-vibrato hookup (sampler passes each source's playbackRate).
  attachVoice(rateParam) { this.vibrato.connect(rateParam); }
  detachVoice(rateParam) { try { this.vibrato.disconnect(rateParam); } catch (_) {} }
}

if (typeof module !== 'undefined') {
  module.exports = { ExpressionBus, mapBreath, glideOriginFor, BREATH_MAP, CENTS_TO_RATE };
}
