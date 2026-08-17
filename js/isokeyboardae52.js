// isokeyboard.js
// Isomorphic "harmonic table" keyboard (C-Thru AXiS / Lumatone-style): flat-top
// hexes in vertical columns. Same shape = same chord ANYWHERE on the grid:
//
//        N  = +7  (perfect fifth)
//        NE = +4  (major third)          note(col, row) = base + 4·col + 7·row
//        SE = −3  (minor third)
//
// A major triad is always a tight upward-right triangle, a minor triad its
// mirror — that's the whole point. Draws into the region the renderer normally
// uses for the piano keyboard; app.js hit-tests clicks via noteAt().
//
// Microtonal: the geometry is tuning-independent — only the STEP COUNTS change
// (31-EDO is +18/+10/−8, 53-EDO +31/+17/−14), which is exactly why hex layouts
// are the microtonalist's instrument. app.js supplies them as state.isoLattice.
//
// Cell text comes from state.isoNames (midi → {label, category}), built by
// app.js from Tuning.spellings() — so a 31-EDO grid reads C, C‡, C♯, D♭, Dd, D…
// and the hex is tinted by accidental category, which is how you see at a glance
// which side of the chain of fifths you're standing on. The labels are FIXED:
// they never re-shuffle when the harmony moves, because the entire value of an
// isomorphic layout is that a shape means the same thing every time you play it.
// state.isoLabel === 'steps' is the fallback for scales the chain of fifths
// can't describe (non-octave periods), where any note name would be a lie.

'use strict';

const IsoKeyboard = (() => {

  const NOTE_SHARP = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const NOTE_FLAT  = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
  const pc = (n) => ((n % 12) + 12) % 12;

  const MIN_NOTE = 24, MAX_NOTE = 96;   // C1 … C7
  const BASE = 48;                      // C3 anchored low-left

  // Geometry of the last draw, kept for hit-testing.
  const geo = { cells: [], r: 0 };

  function hexPath(ctx, cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;               // flat-top
      const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
  }

  /**
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} state  reads activeNotes, keySignature
   * @param {object} C      renderer COLORS palette (theme-aware)
   */
  function draw(ctx, state, x, y, w, h, C) {
    // Panel chrome to match the rest of the canvas.
    ctx.fillStyle = C.panel;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, 12); } else { ctx.rect(x, y, w, h); }
    ctx.fill(); ctx.stroke();

    const flats = (state.keySignature || 'C').includes('b');
    const NAMES = flats ? NOTE_FLAT : NOTE_SHARP;
    // Lattice + note range come from the active tuning (12-TET defaults here),
    // since a 31-EDO grid walks different step counts over a wider note span.
    const lat = state.isoLattice || { majThird: 4, fifth: 7 };
    const rng = state.isoRange || { min: MIN_NOTE, max: MAX_NOTE, base: BASE };
    const byStep = state.isoLabel === 'steps';
    const names = state.isoNames || null;      // midi → {label, category}
    const ISO = C.iso;
    const active = new Set(state.activeNotes || []);
    const activePcs = new Set([...active].map(pc));

    // No label (anyone using an iso layout knows what it is) — hexes get almost
    // the whole panel, with a slim top inset. Only COMPLETE hexes are drawn, so
    // there are no half-cropped rows at the edges.
    const headerH = 10;
    const ay = y + headerH, ah = h - headerH - 10;

    // Hex radius sized to the usable area; flat-top: col pitch 1.5r, row √3·r.
    const r = Math.max(14, Math.min(ah / 6.2, w / 46));
    const colPitch = 1.5 * r, rowPitch = Math.sqrt(3) * r;
    const pad = r + 6;

    geo.cells = [];
    geo.r = r;

    ctx.save();
    const baseFont = `${Math.round(r * 0.62)}px 'SF Mono', Menlo, monospace`;
    ctx.font = baseFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const nCols = Math.floor((w - pad * 2) / colPitch) + 1;
    for (let c = 0; c < nCols; c++) {
      const cx = x + pad + c * colPitch;
      // Each column drifts down half a row vs its right neighbour; walk every
      // row position whose hex fits FULLY inside the area and is in range.
      for (let jPix = 0; jPix < (ah / rowPitch) + 1; jPix++) {
        const cy = ay + ah - pad - jPix * rowPitch + (c % 2 ? rowPitch / 2 : 0);
        if (cy - r < ay + 2 || cy + r > ay + ah - 2) continue;
        // Solve the note for this cell. With NE = (+1 col, −½ row) = +4 and
        // N = (+1 row) = +7, a cell at (col c, pixel-row jPix) works out to
        // j = jPix − ceil(c/2) whole-N steps — this exactly cancels the odd-
        // column half-row offset so the isomorphism holds across the grid.
        const j = jPix - Math.ceil(c / 2);
        const midi = rng.base + lat.majThird * c + lat.fifth * j;
        if (midi < rng.min || midi > rng.max) continue;

        const isOn = active.has(midi);
        // Step mode has no pitch classes to highlight; the "home" cell is the
        // period boundary instead of C.
        const period = rng.period || 12;       // scale degrees per octave
        const step = midi - rng.base;
        const spell = names ? names[midi] : null;
        const pcOn = !isOn && !byStep && !spell && activePcs.has(pc(midi));
        const isC = (byStep || spell) ? ((step % period) + period) % period === 0 : pc(midi) === 0;

        hexPath(ctx, cx, cy, r - 1.5);
        ctx.fillStyle = isOn ? C.accent
                     : pcOn ? C.accentDim
                     : spell ? ISO.fill[spell.category]
                     : isC  ? C.panelAlt
                            : C.ledOff;
        ctx.fill();
        // The anchor degree gets a red ring — the one landmark on a grid where
        // every other cell looks alike.
        ctx.strokeStyle = isOn ? C.accent : (spell && isC) ? ISO.period : C.border;
        ctx.lineWidth = isOn ? 2 : (spell && isC) ? 2 : 1;
        ctx.stroke();

        ctx.fillStyle = (isOn || pcOn) ? C.bg
                      : spell ? ISO.ink[spell.category]
                              : C.textDim;
        // In a microtonal layout the cell shows its real name in that tuning
        // (C‡, D♭, E↑↑ …); with no chain of fifths to spell from, the scale
        // degree is the only honest label left.
        const text = spell ? spell.label
                   : byStep ? String(((step % period) + period) % period)
                            : NAMES[pc(midi)];
        // Marked names run to four glyphs; shrink so they still fit the hex.
        if (text.length > 2) ctx.font = `${Math.round(r * (text.length > 3 ? 0.42 : 0.52))}px 'SF Mono', Menlo, monospace`;
        ctx.fillText(text, cx, cy);
        if (text.length > 2) ctx.font = baseFont;

        geo.cells.push({ cx, cy, midi });
      }
    }
    ctx.restore();
  }

  /** Hit-test a canvas-space point → MIDI note (or null). */
  function noteAt(cx, cy) {
    let best = null, bestD = Infinity;
    for (const cell of geo.cells) {
      const d = (cell.cx - cx) ** 2 + (cell.cy - cy) ** 2;
      if (d < bestD) { bestD = d; best = cell; }
    }
    return best && bestD <= geo.r * geo.r ? best.midi : null;
  }

  return { draw, noteAt };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = IsoKeyboard;
