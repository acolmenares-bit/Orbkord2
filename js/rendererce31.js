// renderer.js
// Canvas renderer for the Chord Detector UI. Everything inside the 1920x1080
// canvas is what gets exported to video. Color scheme mirrors the original
// JUCE plugin (dark navy panels, cyan accent).

'use strict';

// Two swappable canvas palettes. `COLORS` points at the active one; the theme
// toggle (app.js → global setCanvasTheme) reassigns it and the next frame
// repaints. Semantic keys (staffPaper/staffLine/ink/notehead/timelineNote)
// replace what used to be hard-coded so both themes stay consistent.
const THEMES = {
  dark: {
    bg: '#0d0e12', panel: '#121317', panelAlt: '#181b24',
    border: '#252833', borderLight: '#2a3040',
    accent: '#5bd1e0', accentDim: '#2e9cad',
    label: '#5c6273', textDim: '#8c90a1', text: '#abafbc', white: '#f5f6f9',
    ledOn: '#00ff88', ledOnRing: '#a6ffa6', ledOff: '#1c202a', ledOffRing: '#3a3f4d',
    keyWhite: '#e8eaee', keyWhiteDown: '#5bd1e0', keyBlack: '#16181f', keyBlackDown: '#3aa9ba',
    keyEdge: '#c9ccd4',
    recording: '#ff3b5c',
    staffPaper: '#0f1116', staffLine: '#9aa0ad', ink: '#dfe3ea', notehead: '#eef1f5',
    timelineNote: '#3a4256',
    chipBg: '#16292f', chipSub: '#2e9cad',
    // Microtonal hex categories. The reference layouts fill each hex with a
    // saturated hue; on this canvas that would be a wall of neon and would
    // outshout the accent, so the tint moves to the fill and the saturation to
    // the ink — same information, and an active note still wins the frame.
    iso: {
      fill: { natural: '#20242e', sharp: '#3a1e40', flat: '#152f45', up: '#3a2f1c', down: '#1b3524' },
      ink:  { natural: '#c8ccd6', sharp: '#e56be8', flat: '#5ab4f5', up: '#e8c48a', down: '#8fdc92' },
      period: '#bb143f'
    }
  },
  light: {
    bg: '#eef1f5', panel: '#ffffff', panelAlt: '#f4f6fa',
    border: '#d3d8e0', borderLight: '#c2c8d2',
    accent: '#2a93a5', accentDim: '#63bccb',
    label: '#8a90a0', textDim: '#5b616f', text: '#3a3f4a', white: '#1a1d24',
    ledOn: '#12b886', ledOnRing: '#0f9e77', ledOff: '#dfe3ea', ledOffRing: '#c2c8d2',
    keyWhite: '#fdfdfe', keyWhiteDown: '#2a93a5', keyBlack: '#2a2f3a', keyBlackDown: '#1d7181',
    keyEdge: '#c2c8d2',
    recording: '#e03050',
    staffPaper: '#ffffff', staffLine: '#4a4f5a', ink: '#20242c', notehead: '#20242c',
    timelineNote: '#9aa2b2',
    chipBg: '#ddeff3', chipSub: '#1d7181',
    iso: {
      fill: { natural: '#f0f2f6', sharp: '#fbe6fc', flat: '#e2f0fd', up: '#fbf0dd', down: '#e4f6e6' },
      ink:  { natural: '#4a4f5a', sharp: '#a821ad', flat: '#1c6fa8', up: '#94661a', down: '#2a7a3a' },
      period: '#bb143f'
    }
  }
};
let COLORS = THEMES.dark;
function setCanvasTheme(name) { COLORS = THEMES[name] || THEMES.dark; }

// Enharmonic spelling engine + speller instance, shared by the notation panel.
const speller = new Enharmonic.EnharmonicSpeller();

// MIDI timeline strip geometry (shown only in file mode). Shared with app.js
// for hit-testing scrubs and markers, so both agree on the same coordinates.
const TIMELINE = { x: 40, y: 948, w: 1840, h: 120, pad: 10, markH: 24 };
// x ↔ time mapping (same formula on both sides)
const timelineX0 = () => TIMELINE.x + TIMELINE.pad;
const timelineW = () => TIMELINE.w - TIMELINE.pad * 2;
const timelineXAt = (t, dur) => timelineX0() + (dur > 0 ? t / dur : 0) * timelineW();
const timelineTimeAt = (cx, dur) => Math.max(0, Math.min(1, (cx - timelineX0()) / timelineW())) * dur;

class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.W = canvas.width;   // 1920
    this.H = canvas.height;  // 1080
  }

  draw(state) {
    const ctx = this.ctx;
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, this.W, this.H);

    this.drawHeader(state);

    // Top panels start high (TOP) so there's no dead band under the header.
    const TOP = 84, PANEL_H = 380;
    this.drawChordPanel(state, 40, TOP, 1010, PANEL_H);
    this.drawNotationPanel(state, 1070, TOP, 810, PANEL_H);

    const hasTimeline = state.mode === 'file' && state.midiNotes && state.midiNotes.length > 0;
    let currentY = TOP + PANEL_H + 12; // 476
    const pad = 12;

    if (hasTimeline) {
      // --- MIDI FILE MODE ---
      let fbH = 0, kbH = 0, tlH = 0;

      if (state.showFretboard) {
        // FRETBOARD ON: give the neck room; the keyboard compresses to fit.
        fbH = 215;
        tlH = 120;
        kbH = this.H - currentY - fbH - tlH - (pad * 3) - 20;

        Fretboard.draw(this.ctx, state, 40, currentY, 1840, fbH);
        currentY += fbH + pad;
      } else {
        // FRETBOARD OFF: keyboard first, timeline takes the rest — but capped
        // (a 430px piano-roll is mostly air); the surplus goes to the keyboard,
        // which the iso hex grid especially appreciates.
        kbH = 260;
        tlH = this.H - currentY - kbH - (pad * 2) - 20;
        const tlMax = 300;
        if (tlH > tlMax) { kbH += tlH - tlMax; tlH = tlMax; }
      }

      // Draw Keyboard
      this.drawKeyboard(state, 40, currentY, 1840, kbH);
      currentY += kbH + pad;

      // CRITICAL: Update the global TIMELINE bounds so mouse scrubbing in app.js still works!
      TIMELINE.y = currentY;
      TIMELINE.h = tlH;
      this.drawTimeline(state, TIMELINE.x, TIMELINE.y, TIMELINE.w, TIMELINE.h);

    } else {
      // --- LIVE INPUT MODE ---
      if (state.showFretboard) {
        // Fretboard on: bigger neck, and the piano/iso below it shrinks so it
        // doesn't stretch into a church organ.
        const fbH = 250;
        Fretboard.draw(this.ctx, state, 40, currentY, 1840, fbH);
        currentY += fbH + pad;
        const kbH = Math.min(250, 1012 - currentY - 8);
        this.drawKeyboard(state, 40, currentY, 1840, kbH);
      } else {
        const anH = 86; // Active notes monitor
        this.drawActiveNotes(state, 40, currentY, 1840, anH);
        currentY += anH + pad;
        // Capped so the piano never looks like an organ — but the iso hex grid
        // can use all the height it can get.
        const kbH = Math.min(state.isoKeyboard ? 470 : 300, 1012 - currentY - 8);
        this.drawKeyboard(state, 40, currentY, 1840, kbH);
      }

      // Live mode footer
      this.drawFooter(state, 40, 1012, 1840, 48);
    }
  }

  // ------------------------------------------------------------- timeline
  // Compressed piano-roll of the loaded MIDI with a draggable playhead and a
  // marker track for key-change keyframes. Interaction lives in app.js; this
  // only renders. Coordinates come from the shared TIMELINE helpers.
  drawTimeline(state, x, y, w, h) {
    const ctx = this.ctx;
    this.panel(x, y, w, h, COLORS.panelAlt);

    const notes = state.midiNotes || [];
    const dur = state.duration || 1;
    const markH = TIMELINE.markH;
    const rollY = y + markH, rollH = h - markH - 6;

    // Marker-track divider
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + markH); ctx.lineTo(x + w, y + markH); ctx.stroke();

    // Pitch range for the roll
    let lo = 127, hi = 0;
    for (const n of notes) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
    if (hi <= lo) { lo = 48; hi = 72; }
    const pad = 2;
    const yOf = (m) => rollY + rollH - pad - ((m - lo) / (hi - lo)) * (rollH - pad * 2);

    // Notes (compressed piano roll). Currently-sounding notes glow cyan.
    const now = state.currentTime || 0;
    const rowH = Math.max(2, (rollH - pad * 2) / (hi - lo + 1));
    for (const n of notes) {
      const nx = timelineXAt(n.start, dur);
      const nw = Math.max(1.5, timelineXAt(n.end, dur) - nx);
      const sounding = n.start <= now && n.end > now;
      ctx.fillStyle = sounding ? COLORS.accent : COLORS.timelineNote;
      ctx.fillRect(nx, yOf(n.midi) - rowH / 2, nw, rowH);
    }

    // Generated-progression chord symbols (Sequences mode): one chip per chord,
    // centered over its span across the top of the roll; the current one glows.
    const prog = state.progression || [];
    if (prog.length) {
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      for (const ch of prog) {
        const cx0 = timelineXAt(ch.start, dur);
        const cx1 = timelineXAt(ch.end, dur);
        const active = ch.start <= now && ch.end > now;
        // faint divider at each chord boundary
        ctx.strokeStyle = COLORS.border;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(cx0, rollY); ctx.lineTo(cx0, y + h - 2); ctx.stroke();
        // symbol chip
        ctx.font = (active ? '700 15px' : '600 13px') + ' "Helvetica Neue", Arial, sans-serif';
        const tw = ctx.measureText(ch.symbol).width;
        const chipW = tw + 14, chipH = 20;
        const cxm = Math.min(Math.max((cx0 + cx1) / 2, cx0 + chipW / 2 + 1), cx1 - 1);
        ctx.fillStyle = active ? COLORS.accent : COLORS.panel;
        this.roundRect(cxm - chipW / 2, rollY + 2, chipW, chipH, 4); ctx.fill();
        ctx.fillStyle = active ? '#04222b' : COLORS.textDim;
        ctx.fillText(ch.symbol, cxm, rollY + 2 + chipH / 2 + 1);
      }
    }

    // Filename + time (top-left of the marker track)
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '600 13px "Helvetica Neue", Arial, sans-serif';
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    ctx.fillText(`${state.fileName || 'MIDI'}   ${fmt(now)} / ${fmt(dur)}`, x + 12, y + markH / 2);

    // Key-change markers (flags on the marker track)
    for (const m of (state.markers || [])) {
      const mx = timelineXAt(m.time, dur);
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(mx, y + 2); ctx.lineTo(mx, y + h - 2); ctx.stroke();
      // flag label
      const label = 'KEY ' + m.key;
      ctx.font = '700 12px "Helvetica Neue", Arial, sans-serif';
      const lw = ctx.measureText(label).width + 10;
      ctx.fillStyle = COLORS.accent;
      this.roundRect(mx + 2, y + 3, lw, 16, 3); ctx.fill();
      ctx.fillStyle = '#04222b';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, mx + 7, y + 11);
    }

    // Playhead
    const px = timelineXAt(now, dur);
    ctx.strokeStyle = COLORS.white;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, y + markH); ctx.lineTo(px, y + h - 2); ctx.stroke();
    // handle
    ctx.fillStyle = COLORS.white;
    ctx.beginPath();
    ctx.moveTo(px - 6, y + markH); ctx.lineTo(px + 6, y + markH); ctx.lineTo(px, y + markH + 8);
    ctx.closePath(); ctx.fill();
  }

  panel(x, y, w, h, fill = COLORS.panel) {
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // ---------------------------------------------------------------- header
  drawHeader(state) {
    const ctx = this.ctx;
    ctx.textBaseline = 'middle';

    ctx.fillStyle = COLORS.white;
    ctx.font = '700 32px "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('ORBKORD', 44, 46);

    ctx.fillStyle = COLORS.label;
    ctx.font = '500 17px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('MIDIMONITOR', 380, 48);

    // Harmoniser mode badge — so it's always obvious whether you're in free
    // harmonise, recording, or looping a harmonised sequence.
    if (state.harmBadge) {
      ctx.font = '700 15px "Helvetica Neue", Arial, sans-serif';
      const bw = ctx.measureText(state.harmBadge).width + 32;
      const bx = 560, by = 26, bh = 40;
      ctx.fillStyle = state.harmBadge.startsWith('●') ? 'rgba(255,59,92,0.12)' : 'rgba(0,212,255,0.10)';
      ctx.strokeStyle = state.harmBadge.startsWith('●') ? COLORS.recording : COLORS.accent;
      ctx.lineWidth = 1.5;
      this.roundRect(bx, by, bw, bh, 20);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = state.harmBadge.startsWith('●') ? COLORS.recording : COLORS.accent;
      ctx.textAlign = 'center';
      ctx.fillText(state.harmBadge, bx + bw / 2, by + bh / 2 + 1);
      ctx.textAlign = 'left';
    }

    // Mode chips, right side
    const chips = [
      { label: 'LIVE MIDI', active: state.mode === 'live' },
      { label: 'MIDI FILE', active: state.mode === 'file' }
    ];
    let cx = this.W - 44;
    ctx.font = '700 17px "Helvetica Neue", Arial, sans-serif';
    for (let i = chips.length - 1; i >= 0; i--) {
      const chip = chips[i];
      const w = ctx.measureText(chip.label).width + 44;
      cx -= w;
      const y = 26, h = 42;
      ctx.fillStyle = chip.active ? COLORS.chipBg : COLORS.panelAlt;
      ctx.strokeStyle = chip.active ? COLORS.accent : COLORS.borderLight;
      ctx.lineWidth = 1.5;
      this.roundRect(cx, y, w, h, 6);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = chip.active ? COLORS.accent : COLORS.textDim;
      ctx.textAlign = 'center';
      ctx.fillText(chip.label, cx + w / 2, y + h / 2 + 1);
      cx -= 14;
    }

    // Recording indicator
    if (state.recording) {
      const t = performance.now() / 1000;
      const pulse = 0.6 + 0.4 * Math.sin(t * 6);
      ctx.fillStyle = COLORS.recording;
      ctx.globalAlpha = pulse;
      ctx.beginPath();
      ctx.arc(cx - 60, 47, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.recording;
      ctx.textAlign = 'left';
      ctx.font = '700 16px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText('REC', cx - 42, 48);
    }
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ----------------------------------------------------------- chord panel
  drawChordPanel(state, x, y, w, h) {
    const ctx = this.ctx;
    this.panel(x, y, w, h);

    // MIDI activity LED
    const ledX = x + w - 26, ledY = y + 26;
    ctx.beginPath();
    ctx.arc(ledX, ledY, 8, 0, Math.PI * 2);
    ctx.fillStyle = state.midiActivity ? COLORS.ledOn : COLORS.ledOff;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ledX, ledY, 10.5, 0, Math.PI * 2);
    ctx.strokeStyle = state.midiActivity ? COLORS.ledOnRing : COLORS.ledOffRing;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const chord = state.chord;
    const name = chord ? chord.chordName : '--';
    const quality = chord ? this.qualityLabel(chord) : 'No kord yet';

    // Left zone: big chord name (56% width, like the plugin's split). Auto-fit:
    // measure and shrink the font until even long chord names fit inside the zone
    // (no more clipping on names like Cmaj7♯11 / dominant13♯9♭13).
    const leftW = w * 0.56;
    const maxNameW = leftW - 52;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const nameX = x + leftW / 2;
    const nameY = y + h * 0.46;

    let fontSize = 150;
    ctx.font = `700 ${fontSize}px "Helvetica Neue", Arial, sans-serif`;
    while (ctx.measureText(name).width > maxNameW && fontSize > 38) {
      fontSize -= 3;
      ctx.font = `700 ${fontSize}px "Helvetica Neue", Arial, sans-serif`;
    }

    // Cyan glow (plugin draws offset accent copies at 18% alpha)
    ctx.save();
    ctx.shadowColor = 'rgba(0, 212, 255, 0.45)';
    ctx.shadowBlur = 42;
    ctx.fillStyle = COLORS.white;
    ctx.fillText(name, nameX, nameY);
    ctx.restore();

    ctx.fillStyle = COLORS.accent;
    ctx.font = '700 30px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(quality, nameX, y + h * 0.74);

    // Bass note readout (key split, 'separate' mode): chord label stays clean,
    // the bassline shows on its own line underneath.
    if (state.splitMode === 'separate' && state.bassNote) {
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '700 20px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText('OVER ' + state.bassNote + ' BASS', nameX, y + h * 0.87);
    }

    // Divider
    const divX = x + leftW + 10;
    ctx.strokeStyle = COLORS.border;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(divX, y + 24);
    ctx.lineTo(divX, y + h - 24);
    ctx.stroke();

    // Right zone: info rows
    const labelX = divX + 34;
    const valueX = x + w - 44;
    let rowY = y + 52;
    const rowH = 56;   // 6 rows must land inside the 380px panel (no cropping)

    const rows = [
      ['POSITION', chord ? chord.position : 'N/A'],
      ['VOICING', chord ? chord.voicingType : 'N/A'],
      ['ROOT NOTE', chord ? chord.rootName : 'N/A', true],
      ['INTERVALS', chord ? chord.degrees.join(', ') : 'N/A'],
      ['PITCH HEADS', chord ? chord.noteNames.join(', ') : 'N/A'],
      ['NOTES HELD', String(state.activeNotes.length)]
    ];

    ctx.textBaseline = 'middle';
    for (const [label, value, accented] of rows) {
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.label;
      ctx.font = '700 19px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText(label, labelX, rowY);
      ctx.textAlign = 'right';
      ctx.fillStyle = accented ? COLORS.accent : COLORS.white;
      ctx.font = '700 22px "Helvetica Neue", Arial, sans-serif';
      let v = value;
      const maxW = valueX - labelX - 150;
      while (ctx.measureText(v).width > maxW && v.length > 3) v = v.slice(0, -2) + '…';
      ctx.fillText(v, valueX, rowY);
      rowY += rowH;
    }
  }

  qualityLabel(chord) {
    const q = chord.quality || '';
    if (chord.chordType.startsWith('sus') || chord.chordType.includes('sus'))
      return chord.chordType === 'sus2' ? 'Sus2' : chord.chordType === 'sus4' ? 'Sus4' : q.charAt(0).toUpperCase() + q.slice(1);
    return q.charAt(0).toUpperCase() + q.slice(1);
  }

  // -------------------------------------------------------- notation panel
  drawNotationPanel(state, x, y, w, h) {
    const ctx = this.ctx;
    this.panel(x, y, w, h);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.label;
    ctx.font = '700 19px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('NOTATION', x + 26, y + 30);

    // Key-signature indicator (drives the enharmonic spelling below)
    ctx.textAlign = 'right';
    ctx.fillStyle = COLORS.textDim;
    ctx.font = '600 15px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('KEY  ' + (state.keySignature || 'C'), x + w - 26, y + 30);
    ctx.textAlign = 'left';

    // Inner staff area. No border box: the staff sits at a fixed, proper size
    // and a very low note is just allowed to "shoot" off the bottom, where it's
    // clipped cleanly at the staff-paper edge (clip set up below). That reads
    // far better than squashing the whole staff to fit an outlier.
    const ix = x + 26, iy = y + 58, iw = w - 52, ih = h - 84;
    ctx.fillStyle = COLORS.staffPaper;
    ctx.fillRect(ix, iy, iw, ih);

    const LETTER_STEP = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
    const stepOfNote = (n) => n.octave * 7 + LETTER_STEP[n.step];
    const spelled = state.activeNotes.length
      ? speller.spellChord(state.activeNotes, state.chord, state.keySignature || 'C') : [];
    const S = 17;                      // fixed staff line spacing (never scales)
    const staffX = ix + 90;
    const staffW = iw - 130;
    const trebleTop = iy + ih * 0.5 - S * 4 - S * 2.6;   // top line of treble staff
    const bassTop = trebleTop + S * 4 + S * 3.2;         // top line of bass staff

    ctx.strokeStyle = COLORS.staffLine;
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 5; i++) {
      const yy = trebleTop + i * S;
      ctx.beginPath(); ctx.moveTo(staffX, yy); ctx.lineTo(staffX + staffW, yy); ctx.stroke();
      const yb = bassTop + i * S;
      ctx.beginPath(); ctx.moveTo(staffX, yb); ctx.lineTo(staffX + staffW, yb); ctx.stroke();
    }
    // System barline + brace
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(staffX, trebleTop);
    ctx.lineTo(staffX, bassTop + 4 * S);
    ctx.stroke();
    this.drawBrace(staffX - 16, trebleTop, bassTop + 4 * S);

    // Staff coordinate helpers (shared by clefs, key signature and notes).
    // LETTER_STEP / stepOfNote / spelled were computed above (near the fill).
    const ACC_GLYPH = { '-2': '𝄫', '-1': '♭', '0': '♮', '1': '♯', '2': '𝄪' };
    // y for a step on treble (bottom line E4 = step 30) / bass (bottom line G2 = step 18)
    const yForStep = (step, clef) => {
      const bottomY = clef === 'treble' ? trebleTop + 4 * S : bassTop + 4 * S;
      const bottomStep = clef === 'treble' ? 30 : 18;
      return bottomY - (step - bottomStep) * (S / 2);
    };

    // Clefs (sized to fill the staff, à la ChordieApp)
    ctx.fillStyle = COLORS.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `${S * 5.3}px serif`;
    ctx.fillText('\u{1D11E}', staffX + 8, trebleTop + 3.25 * S);   // G clef, spiral on line 2 (G4)
    ctx.font = `${S * 3.4}px serif`;
    ctx.fillText('\u{1D122}', staffX + 10, bassTop + 3.05 * S);    // F clef, dots around line 4 (F3)

    // Key-signature accidentals, right after the clefs. Returns the x where
    // notes may begin (so they never collide with the signature).
    const notesFromX = this.drawKeySignature(state.keySignature || 'C', staffX + 52, S, yForStep, ACC_GLYPH);

    if (!spelled.length) return;

    // Enharmonically spelled notes (computed above for the adaptive fit): correct
    // letters + accidentals derived from the detected chord and the selected key.
    const keyAltered = new Enharmonic.KeySignature(state.keySignature || 'C').alteredLetters();
    const noteCX = Math.max(staffX + staffW * 0.5, notesFromX + 30);

    // No clipping: a very low / high note is allowed to cross the staff-paper
    // edge and shoot past — it must stay fully visible (with its ledger lines),
    // never chopped off. Fixed staff size, so it always reads correctly.
    let prevStep = null, prevOffset = false, prevClef = null;
    for (const note of spelled) {
      const clef = note.midi >= 60 ? 'treble' : 'bass';
      const step = stepOfNote(note);
      const yy = yForStep(step, clef);

      // offset seconds (adjacent steps) to the right
      let offset = false;
      if (prevStep !== null && prevClef === clef && step - prevStep === 1 && !prevOffset) offset = true;
      const nx = noteCX + (offset ? S * 1.35 : 0);
      prevStep = step; prevOffset = offset; prevClef = clef;

      // Ledger lines
      const topStep = clef === 'treble' ? 38 : 26;
      const bottomStep = clef === 'treble' ? 30 : 18;
      ctx.strokeStyle = COLORS.staffLine;
      ctx.lineWidth = 1.6;
      const drawLedger = (ls) => {
        const ly = yForStep(ls, clef);
        ctx.beginPath();
        ctx.moveTo(nx - S * 1.1, ly);
        ctx.lineTo(nx + S * 1.1, ly);
        ctx.stroke();
      };
      if (step > topStep) {
        for (let ls = topStep + 2; ls <= step; ls += 2) drawLedger(ls);
      } else if (step < bottomStep) {
        for (let ls = bottomStep - 2; ls >= step; ls -= 2) drawLedger(ls);
      }

      // Whole-note head
      ctx.save();
      ctx.translate(nx, yy);
      ctx.fillStyle = COLORS.notehead;
      ctx.beginPath();
      ctx.ellipse(0, 0, S * 0.72, S * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.staffPaper;
      ctx.beginPath();
      ctx.ellipse(0, 0, S * 0.40, S * 0.28, -0.9, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Accidental glyph — only when it differs from the key signature. A note
      // that matches the signature shows nothing; one that cancels it shows ♮.
      const keyAlt = keyAltered[note.step] || 0;
      if (note.alter !== keyAlt) {
        ctx.fillStyle = COLORS.notehead;
        ctx.font = `700 ${S * 1.5}px serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(ACC_GLYPH[String(note.alter)], nx - S * (offset ? 2.6 : 1.7), yy);
      }
    }
  }

  // Draws the key-signature accidentals on both staves and returns the x
  // coordinate where notes may safely begin.
  drawKeySignature(keyName, startX, S, yForStep, ACC_GLYPH) {
    const ctx = this.ctx;
    const key = new Enharmonic.KeySignature(keyName);
    if (key.fifths === 0) return startX;

    const sharp = key.fifths > 0;
    // Conventional treble positions (steps); bass sits two octaves lower.
    const order  = sharp ? ['F', 'C', 'G', 'D', 'A', 'E', 'B'] : ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
    const treble = sharp ? [38, 35, 39, 36, 33, 37, 34]        : [34, 37, 33, 36, 32, 35, 31];
    const glyph = sharp ? ACC_GLYPH['1'] : ACC_GLYPH['-1'];
    const count = Math.abs(key.fifths);
    const spacing = S * 0.82;

    ctx.fillStyle = COLORS.ink;
    ctx.font = `700 ${S * 1.5}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < count; i++) {
      const gx = startX + i * spacing;
      ctx.fillText(glyph, gx, yForStep(treble[i], 'treble'));
      ctx.fillText(glyph, gx, yForStep(treble[i] - 14, 'bass'));
    }
    return startX + count * spacing;
  }

  drawBrace(x, yTop, yBottom) {
    const ctx = this.ctx;
    const mid = (yTop + yBottom) / 2;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(x, yTop);
    ctx.bezierCurveTo(x - 14, yTop + 20, x - 2, mid - 24, x - 12, mid);
    ctx.bezierCurveTo(x - 2, mid + 24, x - 14, yBottom - 20, x, yBottom);
    ctx.stroke();
  }

  // -------------------------------------------------------- active notes
  drawActiveNotes(state, x, y, w, h) {
    const ctx = this.ctx;
    this.panel(x, y, w, h, COLORS.panelAlt);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.label;
    ctx.font = '700 19px "Helvetica Neue", Arial, sans-serif';
    ctx.fillText('MIDI ACTIVE', x + 26, y + h / 2);

    const notes = [...state.activeNotes].sort((a, b) => a - b);
    let chipX = x + 330;
    const chipW = 96, chipH = 56, chipY = y + (h - chipH) / 2;
    for (const midi of notes) {
      if (chipX + chipW > x + w - 20) break;
      // Theme-aware chip: the old hard-coded dark navy made the (dark) light-
      // theme text invisible — note names looked missing in light mode.
      ctx.fillStyle = COLORS.chipBg;
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 1.5;
      this.roundRect(chipX, chipY, chipW, chipH, 6);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = COLORS.white;
      ctx.font = '700 20px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText(ChordEngine.midiNoteLabel(midi), chipX + chipW / 2, chipY + 20);
      ctx.fillStyle = COLORS.chipSub;
      ctx.font = '600 15px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText('#' + midi, chipX + chipW / 2, chipY + 41);
      chipX += chipW + 12;
      ctx.textAlign = 'left';
    }
  }

  // ------------------------------------------------------------- keyboard
  drawKeyboard(state, x, y, w, h) {
    // Isomorphic (harmonic table) view swaps in for the piano when toggled.
    if (state.isoKeyboard && typeof IsoKeyboard !== 'undefined') {
      IsoKeyboard.draw(this.ctx, state, x, y, w, h, COLORS);
      return;
    }
    const ctx = this.ctx;
    this.panel(x, y, w, h);
    const pad = 10;
    const kx = x + pad, ky = y + pad, kw = w - pad * 2, kh = h - pad * 2;

    const FIRST = 21, LAST = 108; // A0..C8
    const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
    const whiteCount = 52;
    const wkw = kw / whiteCount;
    const active = new Set(state.activeNotes);

    // White keys
    let wi = 0;
    const whiteIndex = new Map();
    for (let m = FIRST; m <= LAST; m++) {
      if (isBlack(m)) continue;
      whiteIndex.set(m, wi);
      const wxp = kx + wi * wkw;
      ctx.fillStyle = active.has(m) ? COLORS.keyWhiteDown : COLORS.keyWhite;
      ctx.fillRect(wxp + 1, ky, wkw - 2, kh);
      // Edge every white key. In light mode the keys and the panel are both
      // near-white, so without this the keyboard disappears into the panel.
      if (!active.has(m)) {
        ctx.strokeStyle = COLORS.keyEdge;
        ctx.lineWidth = 1;
        ctx.strokeRect(wxp + 1.5, ky + 0.5, wkw - 3, kh - 1);
      }
      if (active.has(m)) {
        const g = ctx.createLinearGradient(0, ky + kh * 0.4, 0, ky + kh);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(1, 'rgba(255,255,255,0.35)');
        ctx.fillStyle = g;
        ctx.fillRect(wxp + 1, ky, wkw - 2, kh);
      }
      // Octave labels on C keys
      if (((m % 12) + 12) % 12 === 0) {
        ctx.fillStyle = active.has(m) ? '#053241' : '#7c8291';
        ctx.font = '600 15px "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('C' + (Math.floor(m / 12) - 1), wxp + wkw / 2, ky + kh - 8);
      }
      wi++;
    }

    // Black keys
    const bkw = wkw * 0.62, bkh = kh * 0.62;
    for (let m = FIRST; m <= LAST; m++) {
      if (!isBlack(m)) continue;
      const leftWhite = whiteIndex.get(m - 1);
      const bx = kx + (leftWhite + 1) * wkw - bkw / 2;
      ctx.fillStyle = active.has(m) ? COLORS.keyBlackDown : COLORS.keyBlack;
      ctx.fillRect(bx, ky, bkw, bkh);
      ctx.strokeStyle = '#0a0b0e';
      ctx.lineWidth = 1;
      ctx.strokeRect(bx + 0.5, ky + 0.5, bkw - 1, bkh - 1);
      if (active.has(m)) {
        ctx.fillStyle = 'rgba(0,212,255,0.35)';
        ctx.fillRect(bx, ky, bkw, bkh);
      }
    }
  }

  // --------------------------------------------------------------- footer
  drawFooter(state, x, y, w, h) {
    const ctx = this.ctx;
    ctx.textBaseline = 'middle';

    const fmt = (s) => {
      s = Math.max(0, s);
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    };

    if (state.mode === 'file' && state.duration > 0) {
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '600 18px "Helvetica Neue", Arial, sans-serif';
      const name = state.fileName || 'MIDI FILE';
      ctx.fillText(name, x, y + h / 2);
      const nameW = Math.min(ctx.measureText(name).width, 420) + 30;

      const timeText = `${fmt(state.currentTime)} / ${fmt(state.duration)}`;
      ctx.textAlign = 'right';
      const timeW = ctx.measureText(timeText).width;
      ctx.fillStyle = COLORS.white;
      ctx.fillText(timeText, x + w, y + h / 2);

      // Progress bar
      const bx = x + nameW, bw = w - nameW - timeW - 30;
      const by = y + h / 2 - 4;
      ctx.fillStyle = COLORS.ledOff;
      this.roundRect(bx, by, bw, 8, 4);
      ctx.fill();
      const p = Math.min(1, state.currentTime / state.duration);
      if (p > 0) {
        ctx.fillStyle = COLORS.accent;
        this.roundRect(bx, by, Math.max(8, bw * p), 8, 4);
        ctx.fill();
      }
    } else {
      ctx.textAlign = 'left';
      ctx.fillStyle = COLORS.textDim;
      ctx.font = '600 18px "Helvetica Neue", Arial, sans-serif';
      ctx.fillText(state.statusText || 'LIVE MIDI INPUT', x, y + h / 2);
    }
  }
}
