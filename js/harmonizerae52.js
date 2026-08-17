// harmonizer.js
// Rule-based melody harmoniser. You play a melody; it puts a chord under each
// note. DETERMINISTIC (same melody + settings → same chords), so it can never
// wander into random garbage the way a stochastic generator can.
//
// THE CORE IDEA (why this doesn't sound like a 1940s saloon):
//   A melody note can belong to many chords. We pick the chord in which the
//   melody note is the *most colourful* member — a 9th, 3rd, 7th or 6th/13th —
//   NOT the root of a plain triad. Melody-as-root = hymn book. Melody-as-9th of
//   a maj9 = modern jazz. On top of that we PENALISE dominant chords hard, so
//   they only appear when the line genuinely asks for one. Those two rules do
//   most of the work.
//
// Two entry points, same brain (`chooseChord`):
//   • harmonizeNote(melodyMidi, ctx)   — real-time: one note in, one chord out.
//   • harmonize(melody, options)       — a recorded/gridded melody → chord track.
//
// Pure logic (uses PianoVoicing for spacing). Dual export (browser + Node).

'use strict';

const Harmonizer = (() => {

  const NOTE_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const NOTE_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const pc = (n) => ((n % 12) + 12) % 12;

  // ---- Chord vocabulary (jazzy on purpose — extensions baked in) -------------
  const QUAL = {
    maj9:  { intervals: [0, 4, 7, 11, 14], sym: 'maj9',  dominant: false },
    maj7:  { intervals: [0, 4, 7, 11],     sym: 'maj7',  dominant: false },
    '6/9': { intervals: [0, 4, 7, 9, 14],  sym: '6/9',   dominant: false },
    m9:    { intervals: [0, 3, 7, 10, 14], sym: 'm9',    dominant: false },
    m7:    { intervals: [0, 3, 7, 10],     sym: 'm7',    dominant: false },
    m6:    { intervals: [0, 3, 7, 9],      sym: 'm6',    dominant: false },
    m7b5:  { intervals: [0, 3, 6, 10],     sym: 'm7♭5',  dominant: false },
    dom9:  { intervals: [0, 4, 7, 10, 14], sym: '9',     dominant: true },
    dom7:  { intervals: [0, 4, 7, 10],     sym: '7',     dominant: true },
    dom7b9:{ intervals: [0, 4, 7, 10, 13], sym: '7♭9',   dominant: true },
    '13sus': { intervals: [0, 5, 9, 10, 14], sym: '13sus', dominant: false },
    // 'lydianBass': { intervals: [0, 6, 9, 14], sym: 'maj(♯11)/bass', dominant: false },

    'polyMaj7': { intervals: [0, 6, 9, 13, 14], sym: 'maj7/bass', dominant: false },
    'm11': { intervals: [0, 3, 5, 10, 14], sym: 'm11', dominant: false },
    'alt': { intervals: [0, 4, 8, 10, 15], sym: '7alt', dominant: false }
  };

  // ---- Diatonic palettes: one nice chord per scale degree --------------------
  // Roots are scale steps over the tonic; qualities chosen to sound modern.
  const MAJOR = [
    { step: 0,  q: 'maj9', roman: 'I' },
    { step: 2,  q: 'm9',   roman: 'ii' },
    { step: 4,  q: 'm7',   roman: 'iii' },
    { step: 5,  q: 'maj7', roman: 'IV' },
    { step: 7,  q: 'dom9', roman: 'V' },
    { step: 9,  q: 'm9',   roman: 'vi' },
    { step: 11, q: 'm7b5', roman: 'vii°' }
  ];
  const MINOR = [
    { step: 0,  q: 'm9',    roman: 'i' },
    { step: 2,  q: 'm7b5',  roman: 'ii°' },
    { step: 3,  q: 'maj7',  roman: '♭III' },
    { step: 5,  q: 'm7',    roman: 'iv' },
    { step: 7,  q: 'dom7b9', roman: 'V' },
    { step: 8,  q: 'maj7',  roman: '♭VI' },
    { step: 10, q: 'dom9',  roman: '♭VII' }
  ];

  // ---- Tunable scoring weights (this is where the taste lives) ----------------
  // How good is it for the melody to be THIS interval above the chord root,
  // when the note is an actual chord tone. Colour tones win.
  const ROLE_SCORE = {
    0: 1,   // root      — plain
    1: 3,   // ♭9        — spicy (rare as a real chord tone)
    2: 10,  // 9         — ★ the money note
    3: 7,   // ♭3 / ♯9
    4: 7,   // 3
    5: 4,   // 11
    6: 6,   // ♯11 / ♭5
    7: 2,   // 5         — plain
    8: 5,   // ♯5 / ♭13
    9: 8,   // 6 / 13    — lush
    10: 9,  // ♭7        — guide tone
    11: 9   // 7         — guide tone
  };
  // If the melody note is NOT a chord tone, it can still ride as a tension —
  // but only these are usable; anything else is an avoid-note.
  const TENSION_SCORE = { 2: 6, 14: 6, 9: 6, 6: 6, 1: 3, 3: 3, 8: 3 };
  const AVOID = -9;

  const FUNCTION_BONUS = { 0: 3, 1: 2, 2: 0, 3: 2, 4: 0, 5: 2, 6: -1 }; // by degree index
  const DOMINANT_PENALTY = -5;   // keep dominants rare — the anti-saloon rule
  const COMMON_TONE_BONUS = 1.4; // reward shared tones with the previous chord
  const REPEAT_PENALTY = -6;     // avoid the exact same chord twice in a row
  const RECENT_PENALTY = -3.5;   // …and discourage chords heard in the last few slots

  // --------------------------------------------------------------------------
  function flatKey(keyPc, mode) {
    const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]);
    const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);
    return (mode === 'minor' ? FLAT_MINOR : FLAT_MAJOR).has(pc(keyPc));
  }

  function makeChord(rootPc, q, roman, keyPc, mode, degree) {
    const spec = QUAL[q];
    const names = flatKey(keyPc, mode) ? NOTE_FLAT : NOTE_SHARP;
    return {
      root: pc(rootPc),
      quality: q,
      dominant: spec.dominant,
      degree,
      roman: roman || '',
      intervals: spec.intervals.slice(),
      pitchClasses: [...new Set(spec.intervals.map((iv) => pc(rootPc + iv)))],
      symbol: names[pc(rootPc)] + spec.sym
    };
  }

  function diatonicPalette(keyPc, mode) {
    const DEG = mode === 'minor' ? MINOR : MAJOR;
    return DEG.map((d, i) => makeChord(keyPc + d.step, d.q, d.roman, keyPc, mode, i));
  }

  const commonTones = (a, b) => {
    if (!a) return 0;
    const s = new Set(a.pitchClasses);
    return b.pitchClasses.filter((p) => s.has(p)).length;
  };

  // How well does a single melody note sit on a chord (chord tone → its colour
  // score; else a usable tension → lower; else an avoid note → big negative).
  function noteFit(ch, notePc) {
    const role = pc(notePc - ch.root);
    return ch.pitchClasses.includes(notePc) ? (ROLE_SCORE[role] ?? 0) : (TENSION_SCORE[role] ?? AVOID);
  }

  // Score a chord against a SET of melody notes (one grid slot may hold several).
  // Every note must fit; the top (melody) note is weighted more. Then the usual
  // function bias, dominant penalty and voice-leading terms.
  // `recent` (optional) is a short memory of the last few CHOSEN chords, newest
  // last — reusing one is penalised with a decaying weight so the same chord
  // doesn't keep boomeranging back every other slot.
  function scoreChord(ch, melodyPcs, topPc, prev, recent) {
    let s = 0;
    for (const p of melodyPcs) s += noteFit(ch, p) * (p === topPc ? 1.5 : 1);
    s += FUNCTION_BONUS[ch.degree] || 0;
    if (ch.dominant) s += DOMINANT_PENALTY;
    s += commonTones(prev, ch) * COMMON_TONE_BONUS;
    if (prev && prev.root === ch.root && prev.quality === ch.quality) s += REPEAT_PENALTY;
    if (recent && recent.length) {
      for (let age = 0; age < Math.min(3, recent.length); age++) {
        const r = recent[recent.length - 1 - age];
        if (r.root === ch.root && r.quality === ch.quality) {
          s += RECENT_PENALTY / (age + 1);
          break;
        }
      }
    }
    return s;
  }

  // ---------------------------------------------------------------- roughness
  // In a microtonal tuning the same chord symbol can come out sweet or sour
  // depending on where its notes land, and no voicing fixes that: if this key's
  // major third is 426¢ then every E major triad has a 426¢ third in it. What
  // the harmoniser CAN do is prefer the chords that don't step on one. So each
  // candidate is asked how rough its own interval content is and gently marked
  // down for it, which in practice steers planing away from the sour corners of
  // the scale without ever announcing itself.
  //
  // Silent by design: 12-TET is left completely alone (there is nothing to dodge
  // and Rahul's harmoniser is already tuned by ear), and nothing about this
  // surfaces in the UI.
  const ROUGH_WEIGHT = 30;     // a wolf fifth costs about a common-tone bonus
  const ROUGH_BASE = 48;       // build the test voicing from around C3

  function tuningLib() {
    return (typeof Tuning !== 'undefined') ? Tuning
      : (typeof require !== 'undefined' ? require('./tuning.js') : null);
  }

  const roughMemo = new WeakMap();

  // How much out-of-tune consonance a chord contains, summed over its intervals
  // (two wolves really are worse than one). Intervals are reduced within the
  // octave first, so this judges the chord's pitch-class relationships and not
  // whichever spacing the voicer happens to pick later.
  function chordMistuning(ch, scale) {
    const T = tuningLib();
    if (!T || !scale || scale.is12TET) return 0;
    let memo = roughMemo.get(scale);
    if (!memo) roughMemo.set(scale, (memo = new Map()));
    const memoKey = ch.root + '|' + ch.quality;
    const hit = memo.get(memoKey);
    if (hit !== undefined) return hit;

    const R = T.roughness(scale);
    const n = scale.size;
    const steps = ch.intervals.map((iv) => scale.stepOf(ROUGH_BASE + ch.root + iv));
    let sum = 0;
    for (let i = 0; i < steps.length; i++) {
      for (let j = i + 1; j < steps.length; j++) {
        sum += R.mistune(((steps[j] - steps[i]) % n + n) % n);
      }
    }
    memo.set(memoKey, sum);
    return sum;
  }

  // FUNCTIONAL: best diatonic chord for the note(s). Out-of-key notes simply ride
  // as tensions over whichever diatonic chord wears them best. `ctx.palette`
  // swaps the built-in 7-chord palette for a richer one (the ChordPack vocab).
  // `ctx.altRank` picks the Nth-best chord instead of the winner (cycled through
  // the top 4) — this powers "different harmony for the same note" and reroll.
  // Total roughness of an actual voicing (real MIDI notes, real spacing).
  function voicingRoughness(midis, scale) {
    const T = tuningLib();
    if (!T || !scale || scale.is12TET || midis.length < 2) return 0;
    const R = T.roughness(scale);
    const steps = midis.map((m) => scale.stepOf(m));
    let sum = 0;
    for (let i = 0; i < midis.length; i++) {
      for (let j = i + 1; j < midis.length; j++) sum += R.pair(midis[i], steps[j] - steps[i]);
    }
    return sum;
  }

  // The one move voicing can make against a sour interval. It can't retune the
  // third — E to G♯ is whatever this key says it is — but roughness falls off
  // steeply with width, so opening a grinding third into a tenth takes most of
  // the beating out of it while keeping the same chord. Tries the octave shifts
  // that stay in range and keeps whichever settles best, or leaves it alone.
  function openRoughest(notes, scale, lowestMidi, melodyMidi) {
    if (notes.length < 3) return notes;
    let best = notes, bestR = voicingRoughness(notes, scale);
    for (let i = 0; i < notes.length; i++) {
      for (const shift of [12, -12]) {
        const moved = notes[i] + shift;
        if (moved < lowestMidi || moved >= melodyMidi) continue;
        if (notes.includes(moved)) continue;
        const cand = notes.slice();
        cand[i] = moved;
        cand.sort((a, b) => a - b);
        // Never let the trick undercut the bass or invert the chord's footing.
        if (cand[0] < lowestMidi) continue;
        const r = voicingRoughness(cand, scale);
        if (r < bestR - 1e-9) { bestR = r; best = cand; }
      }
    }
    return best;
  }

  // Mark candidates down for the mistuning they carry. Deliberately a
  // TIEBREAKER, not a veto: the colour-tone rule is what makes this harmoniser
  // sound like itself, so the weight is set where a wolf costs about one
  // common-tone bonus. It decides between chords the melody likes equally and
  // otherwise gets out of the way.
  function applyRoughness(scored, scale) {
    if (!scale || scale.is12TET || scored.length < 2) return scored;
    for (const c of scored) c.s -= ROUGH_WEIGHT * chordMistuning(c.ch, scale);
    return scored;
  }

  function pickRanked(scored, altRank) {
    scored.sort((a, b) => b.s - a.s);
    const pool = Math.min(4, scored.length);
    return scored[(altRank || 0) % pool];
  }

  function chooseFunctional(melodyPcs, topPc, ctx) {
    const palette = ctx.palette && ctx.palette.length ? ctx.palette : diatonicPalette(ctx.keyPc, ctx.mode);
    const scored = palette.map((ch) => ({ ch, s: scoreChord(ch, melodyPcs, topPc, ctx.prev, ctx.recent) }));
    applyRoughness(scored, ctx.tuning);
    const win = pickRanked(scored, ctx.altRank);
    return { ...win.ch, role: pc(topPc - win.ch.root), score: win.s };
  }

  // NON-FUNCTIONAL: no key. Build maj7/m7/9/6 chords that make the TOP note a
  // 3rd/7th/9th/6th, score them against all the notes, and lean toward small root
  // motion (planing / constant-structure). Deterministic; never a dominant.
  const NF_TRY = [
    { below: 11, q: 'maj7' }, { below: 11, q: 'maj9' },
    { below: 10, q: 'm7' },   { below: 10, q: 'm9' },
    { below: 4,  q: 'maj7' }, { below: 4,  q: 'maj9' },
    { below: 3,  q: 'm7' },   { below: 3,  q: 'm9' },
    { below: 2,  q: 'maj9' }, { below: 2,  q: 'm9' },
    { below: 9,  q: '6/9' },
    { below: 14, q: '13sus' },
    { below: 5, q: '13sus' },
    // { below: 14, q: 'lydianBass' },
    // { below: 6, q: 'lydianBass' },
    { below: 5, q: 'm11' }
  ];
  function chooseNonFunctional(melodyPcs, topPc, ctx) {
    const scored = NF_TRY.map((c) => {
      const root = pc(topPc - c.below);
      const ch = makeChord(root, c.q, '', ctx.keyPc ?? 0, ctx.mode ?? 'major', -1);
      let s = scoreChord(ch, melodyPcs, topPc, ctx.prev, ctx.recent);
      if (ctx.prev) s -= Math.min(pc(root - ctx.prev.root), pc(ctx.prev.root - root)) * 0.3; // planing bias
      return { ch, s };
    });
    // This is where it earns its keep. Planing has no key to protect it, so it
    // wanders wherever the melody goes; roughness is the only thing steering it
    // off the scale's sour intervals.
    applyRoughness(scored, ctx.tuning);
    const win = pickRanked(scored, ctx.altRank);
    return { ...win.ch, role: pc(topPc - win.ch.root), score: win.s };
  }

  /**
   * The brain. Choose one chord for one or more melody notes.
   * @param {number[]} melodyPcs  pitch classes in the slot
   * @param {object} ctx { keyPc, mode, approach, prev, topPc }
   */
  // function chooseChord(melodyPcs, ctx = {}) {
  //   const pcs = melodyPcs.length ? melodyPcs : [ctx.topPc ?? 0];
  //   const topPc = ctx.topPc ?? pcs[0];
  //   return ctx.approach === 'nonfunctional'
  //     ? chooseNonFunctional(pcs, topPc, ctx)
  //     : chooseFunctional(pcs, topPc, ctx);
  // }
  function chooseChord(melodyPcs, ctx = {}) {
    const pcs = melodyPcs.length ? melodyPcs : [ctx.topPc ?? 0];
    const topPc = ctx.topPc ?? pcs[0];

    const isNonFunc =
      ctx.approach &&
      String(ctx.approach).toLowerCase().includes('non');

    // console.log(
    //   '%c[ORB-HARMONIZER ENTRY]',
    //   'color:#00e5ff;font-weight:bold',
    //   {
    //     approach: ctx.approach,
    //     isNonFunc,
    //     keyPc: ctx.keyPc,
    //     mode: ctx.mode,
    //     topPc,
    //     melodyPcs: pcs,
    //     prev: ctx.prev
    //       ? {
    //           symbol: ctx.prev.symbol,
    //           quality: ctx.prev.quality,
    //           root: ctx.prev.root
    //         }
    //       : null
    //   }
    // );

    const result = isNonFunc
      ? chooseNonFunctional(pcs, topPc, ctx)
      : chooseFunctional(pcs, topPc, ctx);

    // console.log(
    //   '%c[ORB-HARMONIZER RESULT]',
    //   'color:#ffcc00;font-weight:bold',
    //   {
    //     route: isNonFunc ? 'NONFUNCTIONAL' : 'FUNCTIONAL',
    //     symbol: result.symbol,
    //     quality: result.quality,
    //     root: result.root,
    //     dominant: result.dominant,
    //     intervals: result.intervals,
    //     pitchClasses: result.pitchClasses,
    //     score: result.score
    //   }
    // );

    return result;
  }

  function hasPc(notes, pitchClass) {
    return notes.some((n) => pc(n) === pc(pitchClass));
  }

  function nearestBelowMelody(pitchClass, melodyMidi, minMidi = 53) {
    let n = pc(pitchClass);

    // Bring it up into/above the colour-safe register.
    while (n < minMidi) n += 12;

    // Then bring it below the melody.
    while (n >= melodyMidi) n -= 12;

    return n >= minMidi ? n : null;
  }

  function spacingIsOk(notes, rules = DEFAULT_LOW_REGISTER_SPACING) {
    const sorted = [...new Set(notes)].sort((a, b) => a - b);

    for (let i = 0; i < sorted.length - 1; i++) {
      const lower = sorted[i];
      const upper = sorted[i + 1];
      const minGap = minGapForRegister(lower, rules);

      if (upper - lower < minGap) return false;
    }

    return true;
  }

  /**
   * After low-register spreading, restore any missing chord colours into a safer
   * upper register. This prevents the muddying rule from making chords too bare.
   *
   * Example:
   *   if the 9th got pushed below A0 and filtered out, re-add it around F3+
   *   where close colour tones are acceptable.
   */
  function rescueChordColours(notes, chord, melodyMidi, opts = {}) {
    const rules = opts.rules || DEFAULT_LOW_REGISTER_SPACING;
    const lowestMidi = opts.lowestMidi ?? 21;
    const minColourMidi = opts.minColourMidi ?? Math.max(53, lowestMidi); // F3 or user floor

    let out = [...new Set(notes)]
      .filter((n) => n >= lowestMidi && n < melodyMidi)
      .sort((a, b) => a - b);


    if (!chord || !chord.pitchClasses) return out;

    // Prefer rescuing colourful tones first: 9ths, 7ths, 6ths/13ths, 3rds.
    const rescuePriority = [2, 14, 10, 11, 9, 3, 4, 6, 1, 8, 5, 7, 0];

    const wantedPcs = [];

    for (const role of rescuePriority) {
      const wantedPc = pc(chord.root + role);
      if (chord.pitchClasses.includes(wantedPc) && !wantedPcs.includes(wantedPc)) {
        wantedPcs.push(wantedPc);
      }
    }

    // Also include any chord pitch classes not covered above.
    for (const p of chord.pitchClasses) {
      if (!wantedPcs.includes(p)) wantedPcs.push(p);
    }

    for (const p of wantedPcs) {
      if (hasPc(out, p)) continue;

      let candidate = nearestBelowMelody(p, melodyMidi, minColourMidi);
      if (candidate == null) continue;

      // Try this pitch class in nearby octaves, preferring upper-register colour.
      const candidates = [];
      for (let n = candidate; n >= lowestMidi; n -= 12) {
        if (n < melodyMidi) candidates.push(n);
      }
      for (let n = candidate + 12; n < melodyMidi; n += 12) {
        if (n >= lowestMidi) candidates.push(n);
      }


      candidates.sort((a, b) => {
        // Prefer F3+ colour tones, and prefer notes closer to the melody.
        const aGood = a >= minColourMidi ? 0 : 1;
        const bGood = b >= minColourMidi ? 0 : 1;
        if (aGood !== bGood) return aGood - bGood;
        return Math.abs(melodyMidi - a) - Math.abs(melodyMidi - b);
      });

      for (const c of candidates) {
        const trial = [...out, c]
          .filter((n) => n >= lowestMidi && n < melodyMidi)
          .sort((a, b) => a - b);


        if (spacingIsOk(trial, rules)) {
          out = trial;
          break;
        }
      }
    }

    return [...new Set(out)].sort((a, b) => a - b);
  }


  // --------------------------------------------------------------------------
  // Register-aware spacing cleanup.
  //
  // Low piano notes need wider intervals or they sound muddy:
  //   - below C2: require at least an octave
  //   - C2–B2:    require at least a minor 7th
  //   - C3–E3:    require at least a minor 6th
  //   - F3+:      allow tight colour tones, even minor 2nds
  //
  // MIDI reference:
  //   C2 = 36
  //   C3 = 48
  //   F3 = 53
  //
  // The rule is based on the LOWER note of each adjacent pair.
  const DEFAULT_LOW_REGISTER_SPACING = [
    { below: 36, min: 12 }, // below C2: octave minimum
    { below: 48, min: 10 }, // C2–B2: minor 7th minimum
    { below: 53, min: 8  }, // C3–E3: minor 6th minimum
    { below: 128, min: 1 }  // F3 and above: minor 2nds allowed
  ];

  function minGapForRegister(lowerMidi, rules = DEFAULT_LOW_REGISTER_SPACING) {
    for (const r of rules) {
      if (lowerMidi < r.below) return r.min;
    }
    return 1;
  }

  /**
   * Spread muddy low-register clusters by pushing LOWER notes down by octaves.
   * This preserves the top melody relationship because it never pushes notes up.
   *
   * @param {number[]} notes ascending MIDI chord notes, not including melody
   * @param {object} opts
   * @param {Array<{below:number,min:number}>} opts.rules
   * @param {number} opts.lowestMidi
   */
  function spreadLowRegister(notes, opts = {}) {
    const rules = opts.rules || DEFAULT_LOW_REGISTER_SPACING;
    const lowestMidi = opts.lowestMidi ?? 21;

    let out = [...new Set(notes)].sort((a, b) => a - b);

    // Work from top to bottom. For each pair, if the lower note is too close
    // to the note above, drop the lower note by octaves until it is wide enough.
    for (let i = out.length - 2; i >= 0; i--) {
      let lower = out[i];
      const upper = out[i + 1];

      let minGap = minGapForRegister(lower, rules);

      while (upper - lower < minGap) {
        lower -= 12;
        minGap = minGapForRegister(lower, rules);
      }

      out[i] = lower;
    }

    // Re-sort because octave drops can reorder notes.
    out = [...new Set(out)]
      .filter((n) => n >= lowestMidi)
      .sort((a, b) => a - b);

    return out;
  }


  // Voice the chord UNDER the melody so the played note stays on top. Reuses the
  // clustered↔spread axis from PianoVoicing, drops it below the melody, and
  // (optionally) grounds it with a low root. Returns MIDI notes, ascending.
  // @param {object} [opts] { spread: 0..1 clustering slider, addBass: boolean }

  function voiceChordUnder(chord, melodyMidi, opts = {}) {
    // console.log(
    //   '%c[VOICE INPUT]',
    //   'background:#7c3aed;color:white;font-weight:bold',
    //   {
    //     symbol: chord?.symbol,
    //     quality: chord?.quality,
    //     root: chord?.root,
    //     intervals: chord?.intervals,
    //     pitchClasses: chord?.pitchClasses,
    //     melodyMidi
    //   }
    // );
    const PV = (typeof PianoVoicing !== 'undefined')
      ? PianoVoicing
      : (typeof require !== 'undefined' ? require('./pianovoicing.js') : null);

    const spread = Math.max(0, Math.min(1, opts.spread ?? 0.15));
    const lowestMidi = opts.lowestMidi ?? 21;

    let notes = PV ? PV.realize(chord, { spread, addBass: false })
                  : chord.intervals.map((iv) => 52 + iv);

    // console.log(
    //   '%c[PV REALIZE OUTPUT]',
    //   'background:#dc2626;color:white;font-weight:bold',
    //   {
    //     symbol: chord?.symbol,
    //     quality: chord?.quality,
    //     intervals: chord?.intervals,
    //     notes: [...notes]
    //   }
    // );

    // Shift the whole voicing to sit just under the melody, within about
    // an octave by default.
    let top = notes[notes.length - 1];

    while (top > melodyMidi - 1) {
      notes = notes.map((n) => n - 12);
      top -= 12;
    }

    while (top < melodyMidi - 13) {
      notes = notes.map((n) => n + 12);
      top += 12;
    }

    // Ground it with a low root a fair bit below the voicing.
    if (opts.addBass !== false) {
      let bass = chord.root;

      while (bass > notes[0] - 4) bass -= 12;
      while (bass < melodyMidi - 32) bass += 12;

      // If the two bounds conflict, being BELOW the voicing wins.
      if (bass > notes[0] - 2) bass -= 12;

      notes.unshift(bass);
    }

    // Keep only playable notes below the melody.
    notes = [...new Set(notes)]
      .filter((n) => n >= lowestMidi && n < melodyMidi)
      .sort((a, b) => a - b);


    // New rule: prevent muddy low-register clusters.
    //
    // Can be disabled with:
    //   voicing: { lowSpacing: false }
    //
    // Can be customised with:
    //   voicing: {
    //     lowSpacingRules: [
    //       { below: 36, min: 12 },
    //       { below: 48, min: 10 },
    //       { below: 53, min: 8 },
    //       { below: 128, min: 1 }
    //     ]
    //   }
    if (opts.lowSpacing !== false) {
      notes = spreadLowRegister(notes, {
        rules: opts.lowSpacingRules,
        lowestMidi
      });


      // Important: the spacing pass may have pushed colourful tones below A0,
      // where the final MIDI-range filter removes them. Bring missing colour
      // notes back into the safer upper register instead of losing them.
      notes = rescueChordColours(notes, chord, melodyMidi, {
        rules: opts.lowSpacingRules,
        lowestMidi,
        minColourMidi: opts.minColourMidi ?? Math.max(53, lowestMidi)
      });

    }

    notes = notes
      .filter((n) => n >= lowestMidi && n < melodyMidi)
      .sort((a, b) => a - b);

    // Last, and only when a microtonal tuning is in play: open up whatever is
    // grinding. 12-TET keeps the voicing it has always had.
    if (opts.tuning && !opts.tuning.is12TET) {
      notes = openRoughest(notes, opts.tuning, lowestMidi, melodyMidi);
    }

    return notes;
  }


  /**
   * Real-time: harmonise a single played note.
   * @param {number} melodyMidi
   * @param {object} ctx { keyPc, mode, approach:'functional'|'nonfunctional', prev }
   * @returns {{ melodyMidi, chord, chordMidis, role }}
   */
  function harmonizeNote(melodyMidi, ctx = {}) {
    const chord = chooseChord([pc(melodyMidi)], { ...ctx, topPc: pc(melodyMidi) });
    return { melodyMidi, chord, chordMidis: voiceChordUnder(chord, melodyMidi, ctx.voicing), role: chord.role };
  }

  /**
   * Recorded melody → chord track, one chord per melody note.
   * `melody`: [{ midi, time, duration }]. Threads voice leading.
   */
  function harmonize(melody, options = {}) {
    const events = [];
    let prev = null;
    const recent = [];
    for (const note of melody) {
      const chord = chooseChord([pc(note.midi)], { ...options, topPc: pc(note.midi), prev, recent });
      events.push({
        time: note.time,
        duration: note.duration,
        melodyMidi: note.midi,
        chord,
        chordMidis: voiceChordUnder(chord, note.midi, options.voicing)
      });

      prev = chord;
      recent.push(chord);
      if (recent.length > 4) recent.shift();
    }
    return events;
  }

  /**
   * The step sequencer: harmonise a recorded melody on a fixed grid — ONE chord
   * per bar (or half-bar) that fits whatever notes fall in that slot.
   * @param {Array} notes   recorded melody [{ midi, time (sec), duration }]
   * @param {object} options { keyPc, mode, approach, bpm, bars, grid:'bar'|'half' }
   * @returns {Array<{ time, duration, melodyMidis, chord, chordMidis, held }>}
   *          one event per slot (empty slots hold the previous chord).
   */
  function harmonizeGrid(notes, options = {}) {
    const bpm = options.bpm || 100;
    const bars = options.bars || 4;
    const secBar = (60 / bpm) * 4;
    const slot = options.grid === 'half' ? secBar / 2 : secBar;
    const nSlots = Math.round((bars * secBar) / slot);

    const events = [];
    let prev = null, prevTop = 72;
    const recent = [];
    for (let i = 0; i < nSlots; i++) {
      const s = i * slot, e = s + slot;
      const inSlot = notes.filter((n) => n.time >= s - 1e-6 && n.time < e - 1e-6);
      if (inSlot.length === 0) {
        // Empty slot: sustain the previous chord so the loop stays harmonised.
        // Pass the voicing options through so the Low-bass-root / clustering
        // settings apply here too (they used to be silently dropped).
        if (prev) events.push({ time: s, duration: slot, melodyMidis: [], chord: prev, chordMidis: voiceChordUnder(prev, prevTop, options.voicing), held: true });
        continue;
      }
      const pcs = [...new Set(inSlot.map((n) => pc(n.midi)))];
      const topMidi = Math.max(...inSlot.map((n) => n.midi));
      // `variation` (the reroll counter) re-deals the slots across the top-4
      // choices so "next progression" means something in rule-engine mode too.
      const altRank = options.variation ? (options.variation + i) % 4 : 0;
      const chord = chooseChord(pcs, { ...options, topPc: pc(topMidi), prev, altRank, recent });
      events.push({ time: s, duration: slot, melodyMidis: inSlot.map((n) => n.midi), chord, chordMidis: voiceChordUnder(chord, topMidi, options.voicing), held: false });
      prev = chord; prevTop = topMidi;
      recent.push(chord);
      if (recent.length > 4) recent.shift();
    }
    return events;
  }

  // ------------------- dataset-driven sequencer (free-midi-progressions pack)
  // Instead of choosing chords note-by-note, pick a whole HUMAN-WRITTEN
  // progression from the pack that best fits the recorded melody, then lay its
  // chords across the grid. Machines lose at progressions; the dataset doesn't.

  // Split notes into grid slots → [{ time, duration, pcs, topMidi }].
  function gridSlots(notes, options) {
    const bpm = options.bpm || 100;
    const bars = options.bars || 4;
    const secBar = (60 / bpm) * 4;
    const slot = options.grid === 'half' ? secBar / 2 : secBar;
    const nSlots = Math.round((bars * secBar) / slot);
    const out = [];
    for (let i = 0; i < nSlots; i++) {
      const s = i * slot, e = s + slot;
      const inSlot = notes.filter((n) => n.time >= s - 1e-6 && n.time < e - 1e-6);
      out.push({
        time: s, duration: slot,
        melodyMidis: inSlot.map((n) => n.midi),
        pcs: [...new Set(inSlot.map((n) => pc(n.midi)))],
        topMidi: inSlot.length ? Math.max(...inSlot.map((n) => n.midi)) : null
      });
    }
    return out;
  }

  // How well one realized progression fits the melody: cycle its chords across
  // the slots and sum the noteFit of every melody pc (top note weighted).
  function scoreProgression(chords, slots) {
    let s = 0;
    for (let i = 0; i < slots.length; i++) {
      const ch = chords[i % chords.length];
      const topPc = slots[i].topMidi != null ? pc(slots[i].topMidi) : null;
      for (const p of slots[i].pcs) s += noteFit(ch, p) * (p === topPc ? 1.5 : 1);
    }
    return s;
  }

  /**
   * Rank dataset progressions against a recorded melody.
   * @param {Array} cands  [{ prog, chords }] — chords realized in the user key
   *                       (each chord: { root, pcs → pitchClasses ok too })
   * @param {Array} notes  recorded melody [{ midi, time, duration }]
   * @param {object} options { bpm, bars, grid }
   * @returns cands sorted best-first, each with .score
   */
  function rankProgressions(cands, notes, options = {}) {
    const slots = gridSlots(notes, options);
    return cands
      .map((c) => ({ ...c, score: scoreProgression(
        c.chords.map((ch) => ({ root: ch.root, pitchClasses: ch.pcs || ch.pitchClasses })), slots) }))
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Lay a realized progression across the grid: one chord per slot, cycling.
   * Voicing comes from the chord's own intervals via the clustering axis, seated
   * under the slot's top melody note (or a default register on empty slots).
   * @returns events shaped exactly like harmonizeGrid's.
   */
  function harmonizeGridFromProgression(notes, chords, options = {}) {
    const slots = gridSlots(notes, options);
    const events = [];
    let prevTop = 72;
    for (let i = 0; i < slots.length; i++) {
      const sl = slots[i];
      const ch = chords[i % chords.length];
      const top = sl.topMidi != null ? sl.topMidi : prevTop;
      const chord = {
        root: ch.root,
        intervals: ch.intervals || [...new Set(ch.up.map((m) => pc(m - ch.root)))].sort((a, b) => a - b),
        pitchClasses: ch.pcs || ch.pitchClasses,
        symbol: ch.symbol, quality: '', dominant: false, degree: -1, roman: ''
      };
      events.push({
        time: sl.time, duration: sl.duration, melodyMidis: sl.melodyMidis,
        chord, chordMidis: voiceChordUnder(chord, top, options.voicing),
        held: sl.topMidi == null
      });
      prevTop = top;
    }
    return events;
  }

  return { harmonizeNote, harmonize, harmonizeGrid, chooseChord, diatonicPalette, voiceChordUnder,
           rankProgressions, harmonizeGridFromProgression, QUAL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Harmonizer;
