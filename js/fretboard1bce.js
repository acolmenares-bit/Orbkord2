// fretboard.js
// Self-contained guitar-fretboard component. The renderer just calls
// Fretboard.draw(ctx, state, x, y, w, h); all neck geometry + note-mapping
// logic lives here so it can evolve independently (alt tunings, voicing
// search, etc.). Highlights every position whose pitch class is currently
// sounding — root accented, other chord tones green.

'use strict';

const Fretboard = (() => {

  // Palette fallback if the renderer's shared COLORS isn't present. `C` is
  // refreshed from COLORS at the top of every draw() so theme switches apply.
  const FALLBACK = {
    panel: '#121317', border: '#252833', borderLight: '#2a3040',
    accent: '#5bd1e0', accentDim: '#2e9cad', label: '#5c6273',
    textDim: '#8c90a1', ledOn: '#00ff88', ledOnRing: '#a6ffa6'
  };
  let C = FALLBACK;

  // Default tuning (used when state.tuning is absent). MIDI note numbers,
  // high-e (top of the board) down to low-E (bottom). state.tuning overrides it.
  const DEFAULT_TUNING = [64, 59, 55, 50, 45, 40];   // e B G D A E
  const FRET_COUNT = 15;
  const INLAYS = [3, 5, 7, 9, 15];            // single-dot inlays (12 is doubled)

  const pcOf = (m) => ((m % 12) + 12) % 12;

  // Physically-accurate fret position: a real neck compresses toward the
  // bridge. Distance from the nut to fret n as a fraction of scale length is
  // 1 − 2^(−n/12); we normalise so FRET_COUNT fills the available width.
  const scaleRatio = (n) => 1 - Math.pow(2, -n / 12);

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function panel(ctx, x, y, w, h) {
    ctx.fillStyle = C.panel;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  function draw(ctx, state, x, y, w, h) {
    C = (typeof COLORS !== 'undefined') ? COLORS : FALLBACK;
    panel(ctx, x, y, w, h);

    // Active tuning (from app state) + a low→high letter readout for the header.
    const TUNING = (state.tuning && state.tuning.length >= 3) ? state.tuning : DEFAULT_TUNING;
    const tuningName = state.tuningName || 'Standard';
    const tuningLetters = TUNING.slice().reverse().map((m) => ChordEngine.getNoteName(pcOf(m))).join(' ');

    // Resolve the current voicing up front (memoized) so the header can show
    // its index and the neck can render it.
    let voicingInfo = null;
    if (state.fretMode === 'voicing' && state.chord && typeof Voicing !== 'undefined') {
      const vs = Voicing.findVoicings(state.chord);
      if (vs.length) {
        const n = vs.length;
        const idx = (((state.voicingIndex || 0) % n) + n) % n;
        voicingInfo = { v: vs[idx], idx, count: n };
      } else {
        voicingInfo = { v: null, idx: 0, count: 0 };
      }
    }

    // Header
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = C.label;
    ctx.font = '700 19px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('FRETBOARD', x + 26, y + 26);

    // Mode tag
    const modeLabel = state.fretMode === 'voicing'
      ? (voicingInfo && voicingInfo.count ? `VOICING ${voicingInfo.idx + 1}/${voicingInfo.count}` : 'VOICING')
      : (state.fretMode === 'pitch' ? 'PLAYED PITCHES' : 'ALL POSITIONS');
    ctx.fillStyle = C.textDim;
    ctx.font = '600 13px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('· ' + modeLabel + (tuningName !== 'Standard' ? '   ·   ' + tuningName.toUpperCase() : ''),
      x + 158, y + 27);

    if (state.chord) {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.accent;
      ctx.font = '700 22px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText(state.chord.chordName, x + w - 26, y + 26);
    } else {
      ctx.textAlign = 'right';
      ctx.fillStyle = C.textDim;
      ctx.font = '600 15px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText(tuningName.toUpperCase() + ' TUNING  ' + tuningLetters, x + w - 26, y + 26);
    }

    // Geometry
    const nStrings = TUNING.length;
    const ix = x + 26, iw = w - 52;
    const gutter = 46;                                   // open-note column
    const boardTop = y + 52, boardBottom = y + h - 34;
    const boardH = boardBottom - boardTop;
    const nutX = ix + gutter;
    const fretAreaW = iw - gutter;
    const norm = scaleRatio(FRET_COUNT);
    const fretX = (f) => nutX + fretAreaW * (scaleRatio(f) / norm);
    const dotX = (f) => (f === 0 ? ix + gutter / 2 : (fretX(f - 1) + fretX(f)) / 2);
    const stringGap = boardH / (nStrings - 1);
    const stringY = (i) => boardTop + i * stringGap;
    const rightX = fretX(FRET_COUNT);

    // Inlays (behind strings)
    ctx.fillStyle = C.borderLight;
    const midY = (boardTop + boardBottom) / 2;
    for (const f of INLAYS) { ctx.beginPath(); ctx.arc(dotX(f), midY, 5, 0, Math.PI * 2); ctx.fill(); }
    if (FRET_COUNT >= 12) {
      ctx.beginPath(); ctx.arc(dotX(12), boardTop + stringGap * 1.5, 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(dotX(12), boardBottom - stringGap * 1.5, 5, 0, Math.PI * 2); ctx.fill();
    }

    // Fret wires (unevenly spaced)
    ctx.strokeStyle = C.borderLight;
    ctx.lineWidth = 1.5;
    for (let f = 1; f <= FRET_COUNT; f++) {
      ctx.beginPath(); ctx.moveTo(fretX(f), stringY(0)); ctx.lineTo(fretX(f), stringY(nStrings - 1)); ctx.stroke();
    }
    // Nut
    ctx.strokeStyle = C.label;
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(nutX, stringY(0) - 2); ctx.lineTo(nutX, stringY(nStrings - 1) + 2); ctx.stroke();

    // Strings (thicker toward low E at the bottom)
    ctx.strokeStyle = C.textDim;
    for (let i = 0; i < nStrings; i++) {
      ctx.lineWidth = 1 + i * 0.5;
      ctx.beginPath(); ctx.moveTo(nutX, stringY(i)); ctx.lineTo(rightX, stringY(i)); ctx.stroke();
    }

    // Fret numbers
    ctx.fillStyle = C.label;
    ctx.font = '600 13px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let f = 1; f <= FRET_COUNT; f++) ctx.fillText(String(f), dotX(f), boardBottom + 18);

    // What lights up. Mode 'all' = every position of the sounding pitch
    // classes; mode 'pitch' = only the exact played pitches (specific octave).
    const active = state.activeNotes || [];
    const highlight = new Set(active.map(pcOf));
    const activeMidi = new Set(active);
    const isLit = (midi) => (state.fretMode === 'pitch' ? activeMidi.has(midi) : highlight.has(pcOf(midi)));
    const chord = state.chord;
    const rootPC = (chord && highlight.has(((chord.root % 12) + 12) % 12)) ? ((chord.root % 12) + 12) % 12
      : (active.length ? pcOf(Math.min(...active)) : null);

    const avgFretW = fretAreaW / FRET_COUNT;
    const r = Math.min(stringGap * 0.4, avgFretW * 0.6, 15);
    const nameOf = ChordEngine.getNoteName;

    const marker = (cx, cy, pc) => {
      const isRoot = pc === rootPC;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = isRoot ? C.accent : C.ledOn;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isRoot ? C.accentDim : C.ledOnRing;
      ctx.stroke();
      ctx.fillStyle = '#06222b';
      ctx.font = `700 ${Math.round(r * 0.95)}px "Helvetica Neue", Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(nameOf(pc), cx, cy + 1);
    };

    if (state.fretMode === 'voicing') {
      // Show one playable shape: ✕ = muted, colored dot = fretted/open.
      if (!voicingInfo || !voicingInfo.v) {
        ctx.fillStyle = C.textDim;
        ctx.font = '600 15px "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(state.chord ? 'No playable voicing within 15 frets' : 'Play a chord to see its voicing',
          (nutX + rightX) / 2, (boardTop + boardBottom) / 2);
      } else {
        const v = voicingInfo.v;
        for (let i = 0; i < nStrings; i++) {
          const f = v.frets[i];
          const cx0 = ix + gutter / 2, cy = stringY(i);
          if (f === null) {
            ctx.fillStyle = C.textDim;
            ctx.font = `700 ${Math.round(r * 1.1)}px "Helvetica Neue", Arial, sans-serif`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText('✕', cx0, cy);
          } else if (f === 0) {
            marker(cx0, cy, pcOf(TUNING[i]));
          } else {
            marker(dotX(f), cy, pcOf(TUNING[i] + f));
          }
        }
      }
    } else {
      // Open strings (fret 0)
      for (let i = 0; i < nStrings; i++) {
        const pc = pcOf(TUNING[i]);
        const cx = ix + gutter / 2, cy = stringY(i);
        if (isLit(TUNING[i])) {
          marker(cx, cy, pc);
        } else {
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.strokeStyle = C.border; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = C.label;
          ctx.font = `600 ${Math.round(r * 0.9)}px "Helvetica Neue", Arial, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(nameOf(pc), cx, cy + 1);
        }
      }

      // Fretted positions
      for (let i = 0; i < nStrings; i++) {
        for (let f = 1; f <= FRET_COUNT; f++) {
          if (isLit(TUNING[i] + f)) marker(dotX(f), stringY(i), pcOf(TUNING[i] + f));
        }
      }
    }
  }

  return { draw, DEFAULT_TUNING, FRET_COUNT };
})();
