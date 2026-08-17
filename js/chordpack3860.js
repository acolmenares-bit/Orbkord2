// chordpack.js
// Runtime lookup over data/harmonypack.json — the distilled free-midi-chords /
// free-midi-progressions packs (built by tools/build-harmonypack.js). Everything
// in the JSON is C-tonic; this module transposes chords, progressions and their
// voicings into the user's key on demand.
//
//   • palette(keyPc, mode)      chord vocabulary as harmonizer-compatible chords
//   • findProgressions(filter)  dataset progressions by category / mood
//   • realizeProgression(...)   a progression's actual voicings in the user key
//   • rhythm(style)             comping patterns extracted from the style packs
//
// Pure logic + fetch. Dual export (browser global + Node test runner).

'use strict';

const ChordPack = (() => {

  const pc = (n) => ((n % 12) + 12) % 12;
  const NOTE_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const NOTE_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];

  let data = null;

  function use(d) { data = d; return data; }
  function isLoaded() { return !!data; }

  async function load(url) {
    if (data) return data;
    const res = await fetch(url || 'data/harmonypack.json');
    if (!res.ok) throw new Error('harmonypack fetch failed: ' + res.status);
    return use(await res.json());
  }

  // Semitone shift from C to the target tonic, folded to −6…+6 so transposed
  // voicings stay in a pianistic register instead of drifting up an octave.
  const delta = (toPc) => (pc(toPc) <= 6 ? pc(toPc) : pc(toPc) - 12);

  function flatKey(keyPc, mode) {
    const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]);
    const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);
    return (mode === 'minor' ? FLAT_MINOR : FLAT_MAJOR).has(pc(keyPc));
  }

  // "I-III" / "vii-ii" / "IV" → major-scale degree index 0…6 (first token).
  const DEG_IDX = { i: 0, ii: 1, iii: 2, iv: 3, v: 4, vi: 5, vii: 6 };
  function degreeIndex(deg, mode) {
    const tok = deg.split('-')[0].toLowerCase().replace(/[^iv]/g, '');
    let d = DEG_IDX[tok] ?? 0;
    if (mode === 'minor') d = (d + 2) % 7;   // relabel relative to the minor tonic
    return d;
  }

  // The voicing's pitch offsets above the root, ordered for stacking: chord
  // tones ascending, then 2nds pushed up an octave to ride on top as tensions.
  function intervalsOf(root, up) {
    const ivs = [...new Set(up.map((m) => pc(m - root)))].sort((a, b) => a - b);
    if (ivs[0] !== 0) ivs.unshift(0);
    const tones = ivs.filter((v) => v === 0 || v > 2);
    const tens = ivs.filter((v) => v === 1 || v === 2).map((v) => v + 12);
    return [...tones, ...tens];
  }

  /**
   * The pack's chord vocabulary transposed into a key, shaped so that
   * Harmonizer.chooseChord can score it directly (root / pitchClasses /
   * dominant / degree / symbol) — plus the pack's own voicing (bass/up).
   * @param {number} keyPc  tonic pitch class of the USER key
   * @param {string} mode   'major' | 'minor' — minor keys transpose from the
   *                        relative major (the pack's C folder covers A minor)
   */
  function palette(keyPc, mode) {
    if (!data) return [];
    const majPc = mode === 'minor' ? pc(keyPc + 3) : pc(keyPc);   // relative major tonic
    const dl = delta(majPc);
    const names = flatKey(keyPc, mode) ? NOTE_FLAT : NOTE_SHARP;
    return data.vocab.map((v) => {
      const root = pc(v.root + dl);
      const up = v.up.map((m) => m + dl);
      const pcs = [...new Set(up.map((m) => pc(m)))];
      const suffix = v.name.replace(/^[A-G][#b]?/, '');
      return {
        root,
        quality: suffix,
        dominant: pcs.includes(pc(root + 4)) && pcs.includes(pc(root + 10)),
        degree: degreeIndex(v.deg, mode),
        roman: v.deg,
        intervals: intervalsOf(v.root, v.up),
        pitchClasses: pcs,
        symbol: names[root] + suffix,
        packBass: v.bass + dl,
        packUp: up
      };
    });
  }

  function moods() { return data ? data.moods : []; }

  /**
   * @param {object} f { cat: 'Major'|'Minor'|'Modal', mood: tag or '' }
   * @returns dataset progressions (untransposed refs — feed to realizeProgression)
   */
  function findProgressions(f = {}) {
    if (!data) return [];
    return data.progressions.filter((p) =>
      (!f.cat || p.cat === f.cat) &&
      (!f.mood || p.moods.includes(f.mood)));
  }

  /**
   * Transpose a progression's ground-truth voicings into the user's key.
   * @returns [{ bass, up, root, pcs, symbol }] one per chord slot
   */
  function realizeProgression(prog, keyPc, mode) {
    const dl = delta(keyPc);   // progression files are C-TONIC (C major / C minor)
    const names = flatKey(keyPc, mode) ? NOTE_FLAT : NOTE_SHARP;
    return prog.chords.map((c) => {
      const bass = c.b + dl;
      const up = c.u.map((m) => m + dl);
      const pcs = [...new Set(up.map((m) => pc(m)))];
      const root = pc(bass);
      let symbol = names[root];
      if (typeof ChordEngine !== 'undefined') {
        const det = ChordEngine.detectChord(up, 'never');
        if (det && det.chordName) symbol = det.chordName;
      }
      return { bass, up, root, pcs, symbol, intervals: intervalsOf(root, up) };
    });
  }

  function rhythm(style) {
    return (data && data.rhythms[style]) || null;
  }

  return { load, use, isLoaded, palette, moods, findProgressions, realizeProgression, rhythm, delta };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChordPack;
