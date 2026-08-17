// enharmonic.js
// Intelligent enharmonic spelling engine for the chord detector.
//
//   MIDI → Chord Detection → [EnharmonicSpeller] → Staff Layout → Rendering
//
// The speller is independent of the renderer. Given the raw MIDI notes, the
// detected chord, and a user-selected key signature, it produces correctly
// spelled notes — e.g. Bbmaj7 → Bb D F A, C#dim7 → C# E G Bb — by stacking
// interval *letter names* from the root rather than mapping pitch classes to a
// fixed sharp table. Accidentals fall out of (letter vs. required pitch class).
//
// Design notes:
//   • No pitch-class→name lookup table. Every spelling is derived arithmetically
//     from the 7 letters (C D E F G A B) and their natural pitch classes.
//   • The root spelling is chosen by scoring each enharmonic candidate against
//     the key signature (circle-of-fifths distance) plus the accidental
//     complexity of the resulting chord. Cleanest, key-appropriate spelling wins.
//   • Extensible: contextual spelling (previous chord / voice leading) can be
//     layered on later by adjusting the scorer — no structural change needed.

'use strict';

const Enharmonic = (() => {

  const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
  const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const LETTER_FIFTHS = { F: -1, C: 0, G: 1, D: 2, A: 3, E: 4, B: 5 };

  const ACC_NAME  = { '-2': 'double-flat', '-1': 'flat', '0': 'natural', '1': 'sharp', '2': 'double-sharp' };
  const ACC_GLYPH = { '-2': '𝄫', '-1': '♭', '0': '', '1': '♯', '2': '𝄪' };
  const ACC_ASCII = { '-2': 'bb', '-1': 'b', '0': '', '1': '#', '2': '##' };

  // Key name → position on the circle of fifths (C=0, sharps +, flats −).
  const KEY_FIFTHS = {
    C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
    F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7
  };
  const KEY_NAMES = ['C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#', 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb'];

  // ---- small arithmetic helpers (no lookup tables) ------------------------
  const mod12 = (n) => ((n % 12) + 12) % 12;
  const naturalPc = (letter) => LETTER_PC[letter];
  const fifthsOf = (letter, alter) => LETTER_FIFTHS[letter] + alter * 7;

  // Signed accidental so that (naturalPc(letter) + alter) ≡ targetPc (mod 12),
  // chosen in the range [-6, 5] then used directly (valid chord tones give ±0..2).
  function alterFor(letter, targetPc) {
    let d = mod12(targetPc - naturalPc(letter));
    if (d > 6) d -= 12;
    return d;
  }

  function advanceLetter(letter, steps) {
    return LETTERS[(LETTERS.indexOf(letter) + steps + 7 * 4) % 7];
  }

  // A spelled note. `octave` is derived from the actual MIDI number so a Cb4
  // (sounding as B3) still lands on the C-space in octave 4.
  function makeNote(letter, alter, midi) {
    const octave = Math.round((midi - alter - naturalPc(letter)) / 12) - 1;
    const key = String(alter);
    return {
      step: letter,                       // A–G, for staff placement
      alter,                              // numeric −2..2
      accidental: ACC_NAME[key],          // 'flat' | 'sharp' | 'natural' | …
      glyph: ACC_GLYPH[key],              // ♭ ♯ 𝄪 𝄫 (empty for natural)
      name: letter + ACC_ASCII[key],      // ascii, e.g. "Bb", "F#"
      octave,
      midi
    };
  }

  // Accidental complexity penalty used when scoring a spelling.
  const penalty = (alter) => (alter === 0 ? 0 : Math.abs(alter) === 1 ? 1 : 4);

  // ==========================================================================
  class KeySignature {
    constructor(name = 'C') {
      this.name = KEY_FIFTHS[name] !== undefined ? name : 'C';
      this.fifths = KEY_FIFTHS[this.name];
    }
    prefersFlat() { return this.fifths < 0; }

    // Letters altered by the signature, e.g. Eb major → { B:-1, E:-1, A:-1 }.
    alteredLetters() {
      const sharps = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
      const flats  = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
      const order = this.fifths >= 0 ? sharps : flats;
      const sign = this.fifths >= 0 ? 1 : -1;
      const map = {};
      for (let i = 0; i < Math.abs(this.fifths); i++) map[order[i]] = sign;
      return map;
    }
  }

  // ==========================================================================
  class EnharmonicSpeller {
    /**
     * @param {number[]} midiNotes           the sounding notes
     * @param {object|null} detectedChord     { root, quality, pattern } or null
     * @param {KeySignature|string} keySignature
     * @returns {SpelledNote[]} sorted by pitch
     */
    spellChord(midiNotes, detectedChord, keySignature) {
      const key = keySignature instanceof KeySignature ? keySignature : new KeySignature(keySignature);
      const notes = [...new Set(midiNotes)].sort((a, b) => a - b);
      if (!notes.length) return [];
      if (!detectedChord || detectedChord.root === undefined) return this.spellByKey(notes, key);

      const rootPc = mod12(detectedChord.root);
      const patternIntervals = detectedChord.pattern || detectedChord.intervals || [];
      const present = new Set(patternIntervals.map(mod12));
      const quality = detectedChord.quality || '';

      let best = null, bestScore = Infinity;
      for (const cand of this.rootCandidates(rootPc)) {
        const spelled = notes.map((m) => {
          const semi = mod12(mod12(m) - rootPc);
          const off = this.letterOffset(semi, present, quality);
          const letter = advanceLetter(cand.letter, off);
          return makeNote(letter, alterFor(letter, mod12(m)), m);
        });
        const score = Math.abs(fifthsOf(cand.letter, cand.alter) - key.fifths) +
                      spelled.reduce((s, n) => s + penalty(n.alter), 0);
        if (score < bestScore) { bestScore = score; best = spelled; }
      }
      return best;
    }

    // Enharmonic spellings of a pitch class as (letter, alter) with |alter| ≤ 2.
    rootCandidates(pc) {
      const out = [];
      for (const L of LETTERS) {
        const alt = alterFor(L, pc);
        if (Math.abs(alt) <= 2) out.push({ letter: L, alter: alt });
      }
      return out;
    }

    // Which generic interval (letter offset 0–6 from the root) a semitone maps
    // to. The four musically ambiguous semitones (3, 6, 8, 9) are resolved by
    // the chord's quality and which other tones are present.
    letterOffset(semi, present, quality) {
      switch (semi) {
        case 0:  return 0;                                   // root
        case 1:  return 1;                                   // ♭9  (a 2nd)
        case 2:  return 1;                                   // 9   (a 2nd)
        case 3:  return present.has(4) ? 1 : 2;              // ♯9 vs ♭3
        case 4:  return 2;                                   // 3rd
        case 5:  return 3;                                   // 11  (a 4th)
        case 6:  return present.has(7) ? 3 : 4;              // ♯11 (4th) vs ♭5 (5th)
        case 7:  return 4;                                   // 5th
        case 8:  return present.has(7) ? 5 : 4;              // ♭13 (6th) vs ♯5 (5th)
        case 9:  return (!present.has(7) && present.has(6) && /diminished/.test(quality)) ? 6 : 5; // °7 vs 6/13
        case 10: return 6;                                   // ♭7
        case 11: return 6;                                   // 7
        default: return 0;
      }
    }

    // No chord context: spell each note from the key's sharp/flat preference.
    spellByKey(notes, key) {
      const flat = key.prefersFlat();
      return notes.map((m) => {
        const pc = mod12(m);
        const nat = LETTERS.find((L) => naturalPc(L) === pc);
        if (nat) return makeNote(nat, 0, m);
        if (flat) return makeNote(LETTERS.find((L) => naturalPc(L) === mod12(pc + 1)), -1, m);
        return makeNote(LETTERS.find((L) => naturalPc(L) === mod12(pc - 1)), 1, m);
      });
    }
  }

  return { EnharmonicSpeller, KeySignature, KEY_NAMES, KEY_FIFTHS };
})();

// Dual export: browser global + Node (for the test runner).
if (typeof module !== 'undefined' && module.exports) module.exports = Enharmonic;
