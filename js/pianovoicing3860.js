// pianovoicing.js
// Realize an abstract chord (root + interval stack) into concrete MIDI notes,
// along a single clustered ↔ spread axis.
//
//   spread 0  → close position (all voices packed inside ~an octave)
//   spread 1  → open voicing   (inner voices dropped an octave: drop-2 / drop-3…)
//
// This is the axis the geometric "voicing spacing mapper" (the spline UI) will
// later drive per chord. For now it's a plain scalar. Pure logic + testable.
// Dual export (browser global + Node test runner).

'use strict';

const PianoVoicing = (() => {

  const pc = (n) => ((n % 12) + 12) % 12;

  /**
   * @param {object} chord   { root: pitchClass, intervals: number[] }  (from Progression)
   * @param {object} [opts]
   * @param {number} [opts.spread=0.4]   0 close … 1 open
   * @param {number} [opts.base=52]      MIDI pitch to seat the bass voice near (E3≈52)
   * @param {boolean}[opts.addBass=true] double the root an octave below when spreading
   * @returns {number[]} MIDI note numbers, ascending
   */
  function realize(chord, opts = {}) {
    const spread  = Math.max(0, Math.min(1, opts.spread ?? 0.4));
    const base    = opts.base ?? 52;
    const addBass = opts.addBass !== false;
    if (!chord || !chord.intervals || !chord.intervals.length) return [];

    // Unique pitch classes in the chord's stacking order (root first, then up).
    const order = [];
    const seen = new Set();
    for (const iv of chord.intervals) {
      const p = pc(chord.root + iv);
      if (!seen.has(p)) { seen.add(p); order.push(p); }
    }

    // Close voicing: seat the root at/above `base`, then each next voice at the
    // lowest pitch of its pitch class strictly above the previous one. This packs
    // the chord into the tightest ascending shape (roughly one octave + tensions).
    let low = base + ((pc(order[0]) - pc(base) + 12) % 12);
    const close = [low];
    for (let i = 1; i < order.length; i++) {
      let n = close[i - 1] + 1;
      n += (order[i] - pc(n) + 12) % 12;
      close.push(n);
    }

    // Open it up by dropping inner voices an octave: drop-2 (2nd from top), then
    // drop-4, drop-3… — the classic close→drop voicing continuum. The number of
    // drops scales with spread.
    const notes = close.slice();
    const n = notes.length;
    const DROP_ORDER = [2, 4, 3, 5];   // voices from the top, in drop priority
    const maxDrops = Math.max(0, n - 1);
    const drops = Math.round(spread * maxDrops);
    for (let d = 0; d < drops; d++) {
      const fromTop = DROP_ORDER[d % DROP_ORDER.length];
      const idx = n - fromTop;         // index from the bottom
      if (idx > 0 && idx < n) notes[idx] -= 12;
    }

    // Optional low root reinforcement once the voicing has genuinely opened up.
    if (addBass && spread > 0.33) {
      notes.push(low - 12);
    }

    return [...new Set(notes)].sort((a, b) => a - b);
  }

  return { realize };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PianoVoicing;
