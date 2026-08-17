// tuning.js
// Microtonal pitch engine: Scala (.scl) parsing + a Tuning object that answers
// "what frequency is this note?" for any scale.
//
// The whole design rests on one split:
//
//   MUSIC THEORY stays in 12-TET pitch classes. The harmonizer still picks
//   Cmaj7, chordpack still ranks progressions, the detector still names chords,
//   the staff still spells notes. None of them know microtonality exists.
//
//   TUNING applies only at the FREQUENCY layer — synth.midiToFreq() and the
//   sampler's playbackRate. That's why 31-EDO needs no new soundfonts: the
//   sampler already pitch-shifts in cents, and rendering every 3 semitones
//   means runtime shift stays under ±1.5 semitones whatever the scale.
//
// Two ways to map MIDI notes onto a scale:
//   'nearest' (default) — each 12-TET key snaps to the closest scale degree.
//     Your keyboard stays a keyboard; the HARMONY underneath gets the good
//     tuning. In 31-EDO a major third lands on 387.1¢ (vs 12-TET's 400¢, and
//     just intonation's 5/4 at 386.3¢) — so triads come out *more* consonant.
//   'linear' — consecutive keys walk consecutive degrees, so an octave spans
//     31 keys in 31-EDO. True microtonal playing; alien keyboard.
//
// Anchor: degree 0 sits on refMidi (C4) at its normal 12-TET frequency, so
// A/B-ing against 12-TET keeps C fixed and you hear the tuning, not a
// transposition.

'use strict';

const Tuning = (() => {

  const mod = (n, m) => ((n % m) + m) % m;

  const REF_MIDI = 60;                          // C4 == degree 0
  const REF_FREQ = 440 * Math.pow(2, -9 / 12);  // 261.6256 Hz

  // Target intervals for the isomorphic lattice, in cents (just intonation).
  const JI_FIFTH = 1200 * Math.log2(3 / 2);   // 701.955
  const JI_MAJ3 = 1200 * Math.log2(5 / 4);    // 386.314
  const JI_MIN3 = 1200 * Math.log2(6 / 5);    // 315.641

  // ------------------------------------------------------------ .scl parsing
  // Scala format: `!` comment lines, then a description line, then a note
  // count, then that many pitch lines — each either cents (has a '.') or a
  // ratio ('3/2' or a bare integer). Values may carry trailing commentary.
  // The last pitch is the PERIOD (usually the octave, 2/1 == 1200¢).
  function parseScl(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Empty .scl file');
    const lines = text.split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith('!'))
      .map((l) => l.trim());
    // The description may legitimately be blank, so only strip blanks after it.
    if (!lines.length) throw new Error('No content in .scl file');
    const description = lines.shift();
    const body = lines.filter((l) => l !== '');
    if (!body.length) throw new Error('.scl file has no note count');

    const count = parseInt(body[0], 10);
    if (!Number.isFinite(count) || count < 1) throw new Error(`Bad note count: "${body[0]}"`);
    const pitches = body.slice(1, 1 + count);
    if (pitches.length < count) {
      throw new Error(`.scl says ${count} notes but only ${pitches.length} are listed`);
    }

    const cents = pitches.map((line, i) => {
      const tok = line.split(/\s+/)[0];       // ignore trailing commentary
      let v;
      if (tok.includes('.')) {
        v = parseFloat(tok);
      } else if (tok.includes('/')) {
        const [n, d] = tok.split('/').map(Number);
        if (!(n > 0) || !(d > 0)) throw new Error(`Bad ratio on line ${i + 1}: "${tok}"`);
        v = 1200 * Math.log2(n / d);
      } else {
        const n = Number(tok);
        if (!(n > 0)) throw new Error(`Bad pitch on line ${i + 1}: "${tok}"`);
        v = 1200 * Math.log2(n);              // bare integer == n/1 ratio
      }
      if (!Number.isFinite(v)) throw new Error(`Unparseable pitch on line ${i + 1}: "${tok}"`);
      return v;
    });

    // Scala scales ascend, and the period has to be above the unison.
    for (let i = 1; i < cents.length; i++) {
      if (cents[i] <= cents[i - 1]) throw new Error('Scale degrees must ascend');
    }
    if (cents[0] <= 0) throw new Error('Scale degrees must be above the unison');

    return {
      name: description || 'Custom scale',
      // Degree 0 (the 1/1) is implicit in the file; the last entry is the period.
      degrees: [0, ...cents.slice(0, -1)],
      period: cents[cents.length - 1],
    };
  }

  // How far the 12-note subset reaches down the chain of fifths from the tonic.
  // Twelve notes can't cover twelve keys, so the window has to leave the damage
  // SOMEWHERE; the only question is where. Measured over the roots this app
  // actually comps on (I ii iii IV V vi, the secondary dominants, ♭III ♭VI ♭VII):
  //
  //   −3  the textbook harpsichord gamut (E♭→G♯ in C) — everything pure except
  //       ♭VI, which lands on BOTH a 39.5¢ sharp third and a 33.5¢ wolf fifth.
  //   −4  (A♭→C♯ in C) — no wolf fifth anywhere, and the only casualty is the
  //       third of III major.
  //
  // −4 wins because a broken fifth is far uglier than a bright third, and ♭VI is
  // core modal-interchange vocabulary here while the textbook gamut was cut for
  // repertoire that never used it. Minor keys come out clean at −4 as well, so
  // one offset serves both — though only if the MINOR tonic is what gets passed
  // in: re-anchoring A minor onto C would swap the G♯ its dominant needs for an
  // A♭ and put a wolf straight through the V chord.
  const SUBSET_WINDOW = -4;

  class Scale {
    constructor({ name, degrees, period, mode = 'nearest', key = null, refMidi = REF_MIDI, refFreq = REF_FREQ }) {
      this.name = name;
      this.degrees = degrees;
      this.period = period;
      this.mode = mode;
      this.key = key;          // {tonic: 0-11, mode: 'major'|'minor'} — see setKey
      this._subset = null;
      this.refMidi = refMidi;
      this.refFreq = refFreq;
      // 12 equal degrees of a 1200¢ period is just 12-TET wearing a hat; flag
      // it so the audio path can take its original code path unchanged.
      this.is12TET = degrees.length === 12 && Math.abs(period - 1200) < 1e-6 &&
        degrees.every((d, i) => Math.abs(d - i * 100) < 1e-6);
    }

    get size() { return this.degrees.length; }

    /**
     * Point the 12-note subset at a key. Without this the subset is a fixed
     * chain of fifths around C, which is a meantone temperament WITH A WOLF —
     * great in the eight keys the chain reaches, sour in the four it doesn't.
     * That is a real historical instrument, not a bug, but it means the quality
     * of your thirds depends on what key you happen to be in. Anchoring slides
     * the same 12-note window along the chain so the good thirds follow the
     * music and the wolf stays behind it.
     *
     * The tuning of C never moves: the subset is still built outward from
     * chain position 0, only the window's edges change. So switching key
     * retunes the accidentals, not the whole instrument.
     */
    setKey(tonic, mode) {
      const t = mod(Math.round(tonic) || 0, 12);
      const m = mode === 'minor' ? 'minor' : 'major';
      if (this.key && this.key.tonic === t && this.key.mode === m) return false;
      this.key = { tonic: t, mode: m };
      this._subset = null;
      return true;
    }

    /**
     * The 12 keys per octave as a chain of fifths centred on the key.
     * `cents` is what each key SOUNDS at (what the audio path wants) and
     * `steps` is which scale degree it IS (what the labels want) — they part
     * company because of the tonic shift below. Null for scales with no chain
     * of fifths to build from; those fall back to nearest-degree snapping.
     */
    subset() {
      if (this._subset) return this._subset;
      if (this.size < 12 || Math.abs(this.period - 1200) > 1) return (this._subset = null);
      const { fifth } = this.lattice();
      const n = this.size;
      const tonic = this.key ? this.key.tonic : 0;
      // Where the tonic sits on the chain of fifths, in fifths from C. Seven is
      // its own inverse mod 12, so multiplying by 7 inverts "up a fifth = +7
      // semitones". Folded to ±6 so F reads as one fifth below C, not eleven above.
      let tp = mod(tonic * 7, 12);
      if (tp > 6) tp -= 12;
      const base = tp + SUBSET_WINDOW;
      const cents = new Array(12), steps = new Array(12);
      for (let k = 0; k < 12; k++) {
        const f = base + mod(mod(k * 7, 12) - base, 12);   // chain position in the window
        // Land each key NEAR ITS OWN 12-TET position rather than folding into
        // [0,period). In a remote key the window runs past the octave — in F♯
        // the note under the C key is B♯, which is a step BELOW C, not a step
        // below the octave above it. Reducing that to a positive degree would
        // make the C key sound higher than the C♯ next to it.
        let d = f * fifth;
        d -= Math.round((d - (k * n) / 12) / n) * n;
        steps[k] = d;
        const oct = Math.floor(d / n);
        cents[k] = oct * this.period + this.degrees[d - oct * n];
      }
      // Sit the tonic on its 12-TET pitch. The subset is built outward from C,
      // so a remote key would otherwise leave the whole instrument a few cents
      // off — and since this app follows key changes mid-song, that would make a
      // modulation audibly shift the instrument rather than just retune it. In C
      // the shift is zero and C keeps its exact pitch.
      const shift = tonic * 100 - cents[tonic];
      if (shift) for (let k = 0; k < 12; k++) cents[k] += shift;
      this._subset = { cents, steps };
      return this._subset;
    }

    /**
     * How the tonic triad actually comes out in the current 12-key subset,
     * as cents of error against just intonation. Worth asking before offering a
     * tuning: 53-EDO's chain subset is Pythagorean BY CONSTRUCTION — near-perfect
     * fifths and thirds 21¢ sharp, which is worse than 12-TET's 13.7¢ — and no
     * choice of window fixes it, because in 53-EDO the good third simply isn't
     * four fifths away. That tuning wants one key per step, not twelve per octave.
     */
    subsetQuality() {
      const sub = this.subset();
      if (!sub) return null;
      const t = this.key ? this.key.tonic : 0;
      const iv = (semis) => mod(sub.cents[mod(t + semis, 12)] - sub.cents[t], 1200);
      return { majThird: iv(4) - JI_MAJ3, fifth: iv(7) - JI_FIFTH };
    }

    // Cents above the reference note. The one function everything else uses.
    centsOf(midi) {
      if (this.mode === 'linear') {
        const d = midi - this.refMidi, n = this.degrees.length;
        const p = Math.floor(d / n);
        return p * this.period + this.degrees[d - p * n];
      }
      const sub = this.subset();
      if (sub) {
        const d = midi - this.refMidi;
        const oct = Math.floor(d / 12);
        return oct * this.period + sub.cents[d - oct * 12];
      }
      // No chain of fifths to build a subset from: snap to the closest degree.
      const target = (midi - this.refMidi) * 100;
      const p = Math.floor(target / this.period);
      const rem = target - p * this.period;
      let best = this.degrees[0], bestD = Math.abs(rem - this.degrees[0]);
      for (const d of this.degrees) {
        const dist = Math.abs(rem - d);
        if (dist < bestD) { bestD = dist; best = d; }
      }
      // The next period's degree 0 can be the closer neighbour near the top.
      if (Math.abs(rem - this.period) < bestD) best = this.period;
      return p * this.period + best;
    }

    freqOf(midi) { return this.refFreq * Math.pow(2, this.centsOf(midi) / 1200); }

    // The 12-TET note number this pitch actually sounds at (fractional). The
    // sampler picks its sample by THIS, not the MIDI number — otherwise
    // 'linear' mode would grab a sample an octave-plus away and pitch-shift it
    // into mush.
    pitchMidi(midi) { return this.refMidi + this.centsOf(midi) / 100; }

    // Absolute degree index (period-extended), for display.
    stepOf(midi) {
      // In a 12-key subset the degree is known outright, and must be read rather
      // than inferred from the sounding pitch: the tonic shift moves every note
      // off its exact degree, by up to half a step in a remote key, which is
      // enough to make a nearest-degree guess name the wrong note.
      const sub = this.mode === 'linear' ? null : this.subset();
      if (sub) {
        const d = midi - this.refMidi;
        const oct = Math.floor(d / 12);
        return oct * this.degrees.length + sub.steps[d - oct * 12];
      }
      const c = this.centsOf(midi);
      const p = Math.floor(c / this.period);
      const rem = c - p * this.period;
      let bestI = 0, bestD = Infinity;
      this.degrees.forEach((d, i) => {
        const dist = Math.abs(rem - d);
        if (dist < bestD) { bestD = dist; bestI = i; }
      });
      return p * this.degrees.length + bestI;
    }

    // Nearest degree (as a step count) to an interval given in cents.
    stepsFor(cents) {
      let bestI = 0, bestD = Infinity;
      this.degrees.forEach((d, i) => {
        const dist = Math.abs(cents - d);
        if (dist < bestD) { bestD = dist; bestI = i; }
      });
      // The period itself can be nearer than any listed degree.
      if (Math.abs(cents - this.period) < bestD) return this.degrees.length;
      return bestI;
    }

    // Hex-lattice steps for the isomorphic keyboard. The grid only stays
    // isomorphic if minor3 + major3 == fifth exactly, so the fifth and major
    // third are chosen by nearest degree and the minor third is DERIVED — in
    // 31-EDO that gives 18/10/8, in 53-EDO 31/17/14, both of which happen to
    // agree with their nearest-degree values anyway.
    lattice() {
      const fifth = this.stepsFor(JI_FIFTH);
      const majThird = this.stepsFor(JI_MAJ3);
      return { fifth, majThird, minThird: fifth - majThird };
    }
  }

  // --------------------------------------------------------------- spelling
  // Note names for any EDO, derived from the lattice rather than hardcoded per
  // tuning. The whole system falls out of one fact: the chain of fifths IS the
  // spelling system. Position 0 is C, +1 G, +2 D … −1 F, −2 B♭, and the letter
  // plus its accidental is a pure function of that position:
  //
  //     chain −6 … −2   G♭ D♭ A♭ E♭ B♭      (the five flats)
  //     chain −1 … +5   F C G D A E B       (the seven naturals)
  //     chain +6 … +10  F♯ C♯ G♯ D♯ A♯      (the five sharps)
  //
  // That's 17 names. A 12-tone EDO has nothing left over (C♯ and D♭ collide);
  // a bigger one does, and every leftover degree is a step or two away from one
  // of the 17 — which is exactly how microtonal notation is written in practice.
  // 31-EDO's remaining 14 degrees land one step either side of a natural, so it
  // needs precisely the ‡/d pair seen on the reference layouts, and 17+14 = 31
  // with nothing spare.
  //
  // Which mark to use is decided by the lattice, not by a per-EDO table. A major
  // third is four fifths in any meantone tuning, so `4·fifth − majThird` is the
  // syntonic comma measured in steps: zero means meantone (use ‡/d), non-zero
  // means the grid drifts by a comma per column and the notation needs arrows.
  // Measured: 12→0, 19→0, 31→0, 41→1, 53→1 — which is why the 41 and 53 layouts
  // sprout arrows and 31 never does.
  const FIFTH_LETTERS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
  const MARKS = {
    meantone: { up: '‡', down: 'd' },   // raised/lowered one step
    comma: { up: '↑', down: '↓' },
  };

  // Letter + accidental for a chain-of-fifths position. Every 7 steps sharpward
  // adds a sharp, every 7 flatward adds a flat.
  function chainName(p) {
    const acc = Math.floor((p + 1) / 7);
    const letter = FIFTH_LETTERS[mod(p + 1, 7)];
    if (acc === 0) return letter;
    return letter + (acc > 0 ? '♯'.repeat(acc) : '♭'.repeat(-acc));
  }

  // Signed distance from a to b around a circle of n — the shortest way round,
  // so degree 30 of 31 is one step BELOW C, not thirty above it.
  function circDist(a, b, n) {
    let d = mod(b - a, n);
    if (d > n / 2) d -= n;
    return d;
  }

  const spellCache = new WeakMap();

  /**
   * Name every degree of a scale.
   * @returns {{comma:number, marks:{up:string,down:string}, table:Array<
   *   {label:string, category:'natural'|'sharp'|'flat'|'up'|'down', offset:number}>}}
   *   `table` is indexed by degree; `offset` is how many marks the label carries
   *   (signed). Returns null for scales with no usable fifth (period != octave,
   *   too few degrees) — the caller falls back to step numbers.
   */
  function spellings(scale) {
    if (spellCache.has(scale)) return spellCache.get(scale);
    const n = scale.size;
    // A non-octave period has no chain of fifths to speak of, and under 12
    // degrees there aren't enough distinct names to go round.
    if (n < 12 || Math.abs(scale.period - 1200) > 1) return null;

    const { fifth, majThird } = scale.lattice();
    let comma = mod(4 * fifth - majThird, n);
    if (comma > n / 2) comma -= n;
    const marks = comma === 0 ? MARKS.meantone : MARKS.comma;

    const table = new Array(n).fill(null);
    // Seed the 17 chain names. Naturals go down last so they win ties on the
    // degrees they share — in 12-TET every sharp/flat collides with something.
    const seeds = [];
    for (let p = 6; p <= 10; p++) seeds.push([p, 'sharp']);
    for (let p = -6; p <= -2; p++) seeds.push([p, 'flat']);
    for (let p = -1; p <= 5; p++) seeds.push([p, 'natural']);
    const anchors = [];   // [degree, category, |chain|] for the leftovers to attach to
    for (const [p, category] of seeds) {
      const deg = mod(p * fifth, n);
      table[deg] = { label: chainName(p), category, offset: 0 };
      anchors.push([deg, category, Math.abs(p)]);
    }

    // Everything else is a marked version of its nearest anchor. Ties prefer a
    // natural (C‡ reads better than D♭d), then the name closer to C.
    for (let deg = 0; deg < n; deg++) {
      if (table[deg]) continue;
      let best = null, bestD = Infinity;
      for (const [aDeg, category, rank] of anchors) {
        const d = circDist(aDeg, deg, n);
        const ad = Math.abs(d);
        const better = ad < bestD ||
          (ad === bestD && best && (
            (category === 'natural' && best.category !== 'natural') ||
            (category === best.category && rank < best.rank)));
        if (better) { bestD = ad; best = { deg: aDeg, category, rank, d }; }
      }
      const k = best.d;
      const mark = k > 0 ? marks.up : marks.down;
      table[deg] = {
        label: table[best.deg].label + mark.repeat(Math.abs(k)),
        category: k > 0 ? 'up' : 'down',
        offset: k,
      };
    }

    const out = { comma, marks, table };
    spellCache.set(scale, out);
    return out;
  }

  // -------------------------------------------------------------- roughness
  // How grating two notes sound together, by the Plomp–Levelt curve: two partials
  // beat worst when they sit about a quarter of a critical band apart, and the
  // band widens as you go down, which is why a third that's fine at the top of
  // the staff turns to mud in the bass. Summed over the partials of a harmonic
  // timbre this produces the classic dissonance curve, with valleys exactly on
  // the simple ratios — so a 387¢ third sits in the bottom of the 5/4 valley and
  // a 426¢ wolf sits on the slope above it, without anyone hardcoding either.
  //
  // In a fixed scale this is a LOOKUP, not DSP: intervals can only take so many
  // values, so the whole curve is precomputed once per tuning and never
  // recalculated. The register axis is baked in the same way.
  const PARTIALS = 8;         // enough to place the 7th-harmonic valleys
  const ROLLOFF = 0.88;       // amplitude of each successive partial
  const REG_LO = 24, REG_HI = 108, REG_SPAN = 12;
  const OCTAVES = 3;          // intervals wider than this are effectively smooth
  const ROUGH_REF_MIDI = 52;  // one register for judging intervals against each other

  function partialRough(f1, f2) {
    const lo = f1 < f2 ? f1 : f2, hi = f1 < f2 ? f2 : f1;
    const d = (hi - lo) * (0.24 / (0.0207 * lo + 18.96));
    return Math.exp(-3.5 * d) - Math.exp(-5.75 * d);
  }

  function toneRough(f1, f2) {
    let sum = 0;
    for (let i = 1; i <= PARTIALS; i++) {
      const ai = Math.pow(ROLLOFF, i - 1);
      for (let j = 1; j <= PARTIALS; j++) {
        sum += ai * Math.pow(ROLLOFF, j - 1) * partialRough(f1 * i, f2 * j);
      }
    }
    return sum;
  }

  // The intervals a listener hears as "supposed to be in tune". Sevenths and
  // seconds are left out on purpose: they are dissonances by design, so a
  // meantone minor seventh landing 37¢ off the harmonic 7/4 is not a defect,
  // it's just what a minor seventh is. Only these get judged against their ideal.
  const JUST_CONSONANCES = [
    0,        // unison
    315.641,  // 6/5  minor third
    386.314,  // 5/4  major third
    498.045,  // 4/3  fourth
    701.955,  // 3/2  fifth
    813.686,  // 8/5  minor sixth
    884.359,  // 5/3  major sixth
    1200,     // octave
  ];
  const CONSONANCE_NEAR = 45;   // beyond this it isn't that interval at all
  const IN_TUNE = 1;            // within a cent, nothing to answer for

  const roughCache = new WeakMap();

  /**
   * Roughness table for a scale: `pair(lowMidi, steps)` returns 0..1 for two
   * notes `steps` scale degrees apart with the lower one at `lowMidi`.
   * Precomputed across register bands and interval widths; nothing is computed
   * at play time.
   */
  function roughness(scale) {
    if (roughCache.has(scale)) return roughCache.get(scale);
    const n = scale.size;
    const maxSteps = Math.min(n * OCTAVES, 200);
    const bands = Math.ceil((REG_HI - REG_LO) / REG_SPAN) + 1;
    const table = [];
    let peak = 0;
    for (let b = 0; b < bands; b++) {
      const lowMidi = REG_LO + b * REG_SPAN;
      const f1 = 440 * Math.pow(2, (lowMidi - 69) / 12);
      const row = new Float64Array(maxSteps + 1);
      for (let d = 0; d <= maxSteps; d++) {
        const p = Math.floor(d / n);
        const cents = p * scale.period + scale.degrees[d - p * n];
        row[d] = toneRough(f1, f1 * Math.pow(2, cents / 1200));
        if (row[d] > peak) peak = row[d];
      }
      table.push(row);
    }
    if (peak > 0) for (const row of table) for (let i = 0; i < row.length; i++) row[i] /= peak;

    // How much roughness each interval adds by being an OUT-OF-TUNE consonance,
    // rather than by being dissonant on purpose. This is the number the
    // harmoniser actually wants: raw roughness would mark down a major seventh
    // for doing its job, while this stays at zero for every interval that is
    // either in tune or not pretending to be a consonance at all. It reads
    // straight off the same curve, so a mistuned fifth automatically costs more
    // than a mistuned third — the 3/2 valley is the deeper one to fall out of.
    const refFreq = 440 * Math.pow(2, (ROUGH_REF_MIDI - 69) / 12);
    const mistune = new Float64Array(maxSteps + 1);
    for (let d = 0; d <= maxSteps; d++) {
      const p = Math.floor(d / n);
      const cents = p * scale.period + scale.degrees[d - p * n];
      const oct = Math.floor(cents / 1200);
      const reduced = cents - oct * 1200;
      let target = null, dev = Infinity;
      for (const t of JUST_CONSONANCES) {
        const e = Math.abs(reduced - t);
        if (e < dev) { dev = e; target = t; }
      }
      if (dev > CONSONANCE_NEAR || dev < IN_TUNE) continue;
      const actual = toneRough(refFreq, refFreq * Math.pow(2, cents / 1200));
      const ideal = toneRough(refFreq, refFreq * Math.pow(2, (oct * 1200 + target) / 1200));
      mistune[d] = Math.max(0, (actual - ideal) / (peak || 1));
    }

    const out = {
      maxSteps,
      // Excess roughness from mistuning a consonance; 0 for anything clean.
      mistune(steps) {
        const d = Math.abs(Math.round(steps));
        return d > maxSteps ? 0 : mistune[d];
      },
      pair(lowMidi, steps) {
        const d = Math.abs(Math.round(steps));
        if (d > maxSteps) return 0;                 // beyond three octaves, smooth
        let b = Math.round((lowMidi - REG_LO) / REG_SPAN);
        if (b < 0) b = 0; else if (b >= table.length) b = table.length - 1;
        return table[b][d];
      },
    };
    roughCache.set(scale, out);
    return out;
  }

  // n equal divisions of the octave.
  function edo(n, opts = {}) {
    const degrees = [];
    for (let i = 0; i < n; i++) degrees.push((1200 * i) / n);
    return new Scale({ name: `${n}-EDO`, degrees, period: 1200, ...opts });
  }

  function fromScl(text, opts = {}) {
    return new Scale({ ...parseScl(text), ...opts });
  }

  const TWELVE_TET = edo(12, { name: '12-TET' });

  return {
    Scale, parseScl, fromScl, edo, TWELVE_TET, spellings, chainName, roughness,
    REF_MIDI, REF_FREQ, JI_FIFTH, JI_MAJ3, JI_MIN3,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Tuning;
