// voicing.js
// Guitar chord-voicing search. Given a detected chord, generate *playable*
// fret shapes and rank them: full chord coverage, root in the bass, small
// fret span, open strings, low position. A hard fret-span limit keeps out
// impossible stretches (no Holdsworth hands required).
//
//   Chord (pitch classes) → generate candidates → filter (playability)
//                         → score → sort → top N
//
// Pure logic + memoized by chord, so the fretboard can recompute only when
// the chord changes. Dual export (browser global + Node test runner).

'use strict';

const Voicing = (() => {

  const TUNING = [64, 59, 55, 50, 45, 40];   // high-e … low-E (MIDI), matches fretboard
  const pcOf = (m) => ((m % 12) + 12) % 12;

  const DEFAULTS = {
    fretCount: 15,
    maxSpan: 4,        // max fret span for the fretted notes (fingers reach)
    maxFingers: 4,     // max distinct fretted frets (barre counts as one value)
    minStrings: 3,     // a chord needs at least 3 sounding strings
    topN: 12
  };

  const cache = new Map();

  /**
   * @param {{root:number, pitchClasses:number[]}} chord
   * @returns {Voicing[]} ranked best-first (each: {frets:(number|null)[], score, span, ...})
   */
  function findVoicings(chord, options = {}) {
    if (!chord || !chord.pitchClasses || !chord.pitchClasses.length) return [];
    const opt = { ...DEFAULTS, ...options };
    const root = pcOf(chord.root);
    const target = new Set(chord.pitchClasses.map(pcOf));

    const key = `${root}|${[...target].sort((a, b) => a - b).join(',')}|${opt.fretCount}.${opt.maxSpan}`;
    if (cache.has(key)) return cache.get(key);

    // The perfect 5th is droppable on chords of 4+ notes (keeps voicings sane).
    const fifth = pcOf(root + 7);
    const droppable = (target.size >= 4 && target.has(fifth)) ? fifth : null;
    const essential = new Set([...target].filter((pc) => pc !== droppable));

    const seen = new Set();
    const results = [];

    for (let pos = 0; pos <= opt.fretCount; pos++) {
      // Per-string options at this position: mute, open (if useful), or a
      // fretted note inside the window [pos, pos+maxSpan-1] that hits a tone.
      const perString = TUNING.map((open) => {
        const opts = [null]; // null = muted
        if (target.has(pcOf(open))) opts.push(0);
        const lo = Math.max(1, pos), hi = Math.min(opt.fretCount, pos + opt.maxSpan - 1);
        for (let f = lo; f <= hi; f++) if (target.has(pcOf(open + f))) opts.push(f);
        return opts;
      });

      // Depth-first product with pruning on span + finger count.
      const frets = new Array(6).fill(null);
      const search = (si, minF, maxF, fingers) => {
        if (si === 6) { evaluate(frets, results, seen, { root, target, essential, opt }); return; }
        for (const f of perString[si]) {
          frets[si] = f;
          if (f === null || f === 0) {
            search(si + 1, minF, maxF, fingers);
          } else {
            const nMin = Math.min(minF, f), nMax = Math.max(maxF, f);
            if (nMax - nMin <= opt.maxSpan - 1) {
              const nf = fingers.includes(f) ? fingers : [...fingers, f];
              if (nf.length <= opt.maxFingers) search(si + 1, nMin, nMax, nf);
            }
          }
        }
        frets[si] = null;
      };
      search(0, Infinity, -Infinity, []);
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, opt.topN);
    cache.set(key, top);
    return top;
  }

  function evaluate(frets, out, seen, ctx) {
    const { root, target, essential, opt } = ctx;

    const sounding = [];
    for (let si = 0; si < 6; si++) if (frets[si] !== null) sounding.push(si);
    if (sounding.length < opt.minStrings) return;

    // Coverage of the essential chord tones.
    const pcs = new Set(sounding.map((si) => pcOf(TUNING[si] + frets[si])));
    for (const pc of essential) if (!pcs.has(pc)) return;

    // Bass note = lowest sounding pitch.
    let bassPitch = Infinity;
    for (const si of sounding) bassPitch = Math.min(bassPitch, TUNING[si] + frets[si]);
    const rootInBass = pcOf(bassPitch) === root;

    // Interior muted strings (harder to play cleanly than edge mutes).
    let interiorMutes = 0;
    for (let si = sounding[0] + 1; si < sounding[sounding.length - 1]; si++) {
      if (frets[si] === null) interiorMutes++;
    }

    const fretted = sounding.map((si) => frets[si]).filter((f) => f > 0);
    const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0;
    const openCount = sounding.filter((si) => frets[si] === 0).length;
    const fullCoverage = [...target].every((pc) => pcs.has(pc));

    // Realistic finger count: one per fretted note, with a barre discount only
    // when several strings share the LOWEST fret (a real index-finger barre).
    const minFret = fretted.length ? Math.min(...fretted) : 0;
    const atMin = fretted.filter((f) => f === minFret).length;
    const fingers = fretted.length - Math.max(0, atMin - 1);
    if (fingers > opt.maxFingers) return;

    const sig = frets.join(',');
    if (seen.has(sig)) return;
    seen.add(sig);

    const score =
      (rootInBass ? 40 : 0) +
      (fullCoverage ? 18 : 0) +
      openCount * 10 +
      sounding.length * 4 -
      span * 6 -
      minFret * 2 -                 // prefer lower position on the neck
      interiorMutes * 12 -
      fingers * 5;

    out.push({ frets: frets.slice(), score, span, openCount, fingers, rootInBass, fullCoverage, interiorMutes });
  }

  return { findVoicings, TUNING, clearCache: () => cache.clear() };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Voicing;
