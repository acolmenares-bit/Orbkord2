  // app.js
  // Wires together: MIDI file playback, live MIDI capture, chord detection,
  // canvas rendering, and video export (canvas stream + synth audio → MediaRecorder).

  'use strict';

  (() => {
    const canvas = document.getElementById('stage');
    const renderer = new Renderer(canvas);
    const synth = new Synth();
    synth.loadReverb("assets/irs/s1_r4_b.wav")
      .then(() => console.log('Reverb IR loaded'))
      .catch(err => console.warn("Failed to load reverb:", err));


    // ------------------------------------------------------------------ state
    const state = {
      mode: 'live',            // 'live' | 'file'
      activeNotes: [],
      chord: null,
      midiActivity: false,
      recording: false,
      fileName: '',
      currentTime: 0,
      duration: 0,
      statusText: '',
      showFretboard: false,    // toggles the fretboard strip on/off
      fretMode: 'all',         // 'all' | 'pitch' | 'voicing'
      voicingIndex: 0,         // which voicing is shown in 'voicing' mode
      keySignature: 'C',       // EFFECTIVE key used for spelling (may follow keyframes)
      baseKey: 'C',            // key chosen in the dropdown (before any keyframe)
      midiNotes: null,         // ref to loaded MIDI notes, for the timeline
      markers: [],             // key-change keyframes: [{ time, key }]
      theme: 'dark',           // 'dark' | 'light' (canvas + chrome)
      progression: null,       // generated sequence: [{ symbol, start, end }] or null
      splitMode: 'off',        // 'off' | 'slash' | 'separate' — bass/chord key split
      splitPoint: 48,          // MIDI note; notes below this are the bassline
      bassNote: null,          // bass note name shown when split mode is 'separate'
      isoKeyboard: false,      // harmonic-table hex keyboard instead of the piano
      pitchTuning: null,       // active microtonal system's label (null = 12-TET)
      pitchScale: null,        // the Tuning.Scale itself, for roughness scoring
      isoLattice: null,        // hex step counts when the scale isn't 12-TET
      isoRange: null,          // hex note range/period for a microtonal lattice
      isoLabel: 'names',       // 'names' | 'steps' for hex cell text
      isoNames: null,          // midi → {label, category} in the active tuning
      harmMode: 'free',        // 'free' (improvise + record take) | 'sequencer'
      tuning: [64, 59, 55, 50, 45, 40],  // fretboard tuning, high→low (E A D G B E)
      tuningName: 'Standard',
      tuningStr: 'E A D G B E',
      tuningKey: 'standard'
    };

    let midiData = null;         // parsed file
    let playing = false;
    let playbackRate = 1.0;
    let startCtxTime = 0;        // AudioContext time when playback (re)started
    let startOffset = 0;         // song time at that moment
    let schedulePointer = 0;     // index into midiData.notes for audio scheduling
    let scheduledVoices = [];
    let exporting = false;

    // Harmoniser loop transport: when a recorded sequence is playing it loops, and
    // a metronome clicks each beat. beatTimes are song-time beat positions.
    let looping = false;
    let metronomeOn = false;
    let beatTimes = [];
    let clickPointer = 0;

    // Live input state
    const heldNotes = new Set();
    const sustainedNotes = new Set();
    let sustainPedal = false;
    let lastActivity = 0;

    // Chord detection debounce: update the label only after the note set has
    // been stable for a short window, so staggered onsets don't flicker.
    const DETECT_DEBOUNCE_MS = 45;
    let lastSetKey = '';
    let setChangedAt = 0;
    let detectPending = false;
    let lastVoicingChordName = '';   // reset voicing cycle when the chord changes

    // ------------------------------------------------------------- DOM refs
    const $ = (id) => document.getElementById(id);
    const fileInput = $('file-input');
    const btnFretboard = $('btn-fretboard');
    const btnFretMode = $('btn-fretmode');
    const btnVoicing = $('btn-voicing');
    const keySelect = $('key-select');
    const btnAddKey = $('btn-add-key');
    const btnTheme = $('btn-theme');
    const btnPlay = $('btn-play');
    const btnStop = $('btn-stop');
    const btnLive = $('btn-live');
    const btnRecord = $('btn-record');
    const btnExport = $('btn-export');
    const seekBar = $('seek');
    const rateSel = $('rate');
    const midiStatus = $('midi-status');

    // ------------------------------------------------------- control chrome
    // Buttons hold an <svg class="ico"> next to a <span class="btn-label">, so
    // a state change rewrites the label only and leaves the icon in place.
    // Assigning btn.textContent directly would wipe the icon out.
    function setBtn(btn, icon, text) {
      if (!btn) return;
      const label = btn.querySelector('.btn-label');
      if (label) label.textContent = text;
      else btn.textContent = text;
      const use = btn.querySelector('.ico use');
      if (use && icon) use.setAttribute('href', '#i-' + icon);
    }

    // Sliders light up the travelled part of their track. WebKit's
    // ::-webkit-slider-runnable-track can't see the input's value, so the
    // position is mirrored onto --fill as a 0..1 ratio and the CSS works out
    // where the colour must break. Firefox uses ::-moz-range-progress and
    // ignores this. Anything that sets .value in code must call this too —
    // assigning .value does not fire 'input'.
    function paintRange(el) {
      if (!el) return;
      const min = parseFloat(el.min) || 0;
      const max = parseFloat(el.max);
      const span = (isNaN(max) ? 100 : max) - min;
      const ratio = span > 0 ? (parseFloat(el.value) - min) / span : 0;
      el.style.setProperty('--fill', String(Math.max(0, Math.min(1, ratio))));
    }
    document.querySelectorAll('input[type="range"]').forEach(el => {
      paintRange(el);
      el.addEventListener('input', () => paintRange(el));
    });
    // Harmoniser controls
    const btnHarmonize = $('btn-harmonize');
    const harmKey = $('harm-key');
    const harmMode = $('harm-mode');
    const harmApproach = $('harm-approach');
    const harmGrid = $('harm-grid');
    const harmBars = $('harm-bars');
    const harmBpm = $('harm-bpm');
    const btnHarmRec = $('btn-harm-rec');
    const splitModeSel = $('split-mode');
    const splitPointSel = $('split-point');
    // ChordPack / progression-pack controls
    const harmSource = $('harm-source');
    const harmStyle = $('harm-style');
    const harmMood = $('harm-mood');
    const btnReroll = $('btn-harm-reroll');
    const harmSpread = $('harm-spread');
    const harmLowestMidi = $('harm-lowest-midi');
    const harmLowestLabel = $('harm-lowest-label');
    const harmChordset = $('harm-chordset');
    const harmVariety = $('harm-variety');
    // Dynamics: computer-keyboard velocity + generated-chord velocity (+humanise)
    const kbVelocity = $('kb-velocity');
    const kbHumanize = $('kb-humanize');
    const chordVelocity = $('chord-velocity');
    const chordHumanize = $('chord-humanize');
    const clampVel = (v) => Math.max(1, Math.min(127, Math.round(v)));
    // Humanise spread scales with the level: a soft passage wanders a little, a
    // loud one wanders more — matching how a real player's dynamics vary.
    function jitterVel(base, humanize) {
      if (!humanize) return clampVel(base);
      const range = Math.max(4, base * 0.22);
      return clampVel(base + (Math.random() * 2 - 1) * range);
    }
    // A connected MIDI keyboard supplies its own velocity; these only apply to
    // computer-keyboard notes and to generated chords respectively.
    const kbVel = () => jitterVel(kbVelocity ? +kbVelocity.value : 78,
      kbHumanize && kbHumanize.checked);
    const chordVel = () => jitterVel(chordVelocity ? +chordVelocity.value : 68,
      chordHumanize && chordHumanize.checked);
    const btnExportMidi = $('btn-export-midi');
    // Harmoniser mode toggle + free-play Record Take controls
    const btnModeFree = $('btn-mode-free');
    const btnModeSeq = $('btn-mode-seq');
    const harmGroups = document.querySelectorAll('[data-harm-group]');
    const takeBpmSel = $('take-bpm');
    const takeMetro = $('take-metro');
    const btnTake = $('btn-take');
    const btnIso = $('btn-iso');
    const fretTuning = $('fret-tuning');

    // Notes struck a hair before the click lands (human timing) still count —
    // they're clamped to the top of the loop instead of being dropped. Shared
    // by Record Take and Record Melody.
    const NOTE_PREROLL = 0.12;   // seconds

    // ------------------------------------------------------------ access gate
    // Always allow access for local use without authentication.
    function accessOk() {
      return true;
    }

    // -------------------------------------------------------------- helpers
    function songTime() {
      if (!playing) return startOffset;
      return startOffset + (synth.ctx.currentTime - startCtxTime) * playbackRate;
    }

    function midiName(midi) {
      const names = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
      const pc = ((midi % 12) + 12) % 12;
      const octave = Math.floor(midi / 12) - 1;
      return names[pc] + octave;
    }

    function syncLowestLabel() {
      if (!harmLowestMidi || !harmLowestLabel) return;
      harmLowestLabel.textContent = midiName(parseInt(harmLowestMidi.value, 10));
    }
    syncLowestLabel();

    // notes are sorted by start; early-exit scan
    function activeNotesAt(t) {
      if (!midiData) return [];
      const act = new Set();
      for (const n of midiData.notes) {
        if (n.start > t) break;
        if (n.end > t) act.add(n.midi);
      }
      return [...act];
    }

    // Key split: read the CHORD from notes at/above the split point, and treat the
    // lowest note below it as the bass. This keeps a moving/walking bassline from
    // scrambling the chord name. Returns { chord, bassNote }. When split is off, or
    // there's nothing to split, it detects on the full set as usual.
    function detectWithSplit(notes) {
      if (state.splitMode === 'off') return { chord: ChordEngine.detectChord(notes), bassNote: null };

      const lower = notes.filter((m) => m < state.splitPoint);
      const upper = notes.filter((m) => m >= state.splitPoint);
      if (upper.length >= 2 && lower.length >= 1) {
        // 'never' → clean root-position chord name (no auto-slash from the upper
        // structure's own lowest note); we append our OWN bass instead.
        const chord = ChordEngine.detectChord(upper, 'never');
        if (chord) {
          const bass = Math.min(...lower);
          const bassName = ChordEngine.getNoteName(ChordEngine.midiToPitchClass(bass));
          if (state.splitMode === 'slash') {
            return { chord: { ...chord, chordName: chord.chordName + '/' + bassName }, bassNote: null };
          }
          return { chord, bassNote: bassName };   // 'separate'
        }
      }
      return { chord: ChordEngine.detectChord(notes), bassNote: null };
    }

    function updateChordDetection(notes, nowMs) {
      const key = notes.join(',');
      if (key !== lastSetKey) {
        lastSetKey = key;
        setChangedAt = nowMs;
        detectPending = true;
      }
      if (detectPending && nowMs - setChangedAt >= DETECT_DEBOUNCE_MS) {
        detectPending = false;
        const { chord: result, bassNote } = detectWithSplit(notes);
        if (result) {
          state.chord = result;                     // new chord
          state.bassNote = bassNote;
        } else if (notes.length === 0 && !playing && state.mode === 'live') {
          // keep last chord on screen during playback gaps; live mode keeps it too
        }
      }
    }

    // ----------------------------------------------------------- audio sched
    const LOOKAHEAD = 0.25; // seconds of song time scheduled ahead

    function scheduleAudio(t) {
      if (!midiData || !playing) return;
      const horizon = t + LOOKAHEAD * playbackRate;
      while (schedulePointer < midiData.notes.length &&
            midiData.notes[schedulePointer].start < horizon) {
        const n = midiData.notes[schedulePointer++];
        if (n.end <= t) continue;
        const when = startCtxTime + (n.start - startOffset) / playbackRate;
        const dur = (n.end - n.start) / playbackRate;
        scheduledVoices.push(synth.playNote(n.midi, n.velocity, when, dur));
      }
      // Metronome clicks on the beat grid, in lockstep with note scheduling.
      if (metronomeOn) {
        while (clickPointer < beatTimes.length && beatTimes[clickPointer] < horizon) {
          const bt = beatTimes[clickPointer];
          const when = startCtxTime + (bt - startOffset) / playbackRate;
          if (when >= synth.now - 0.02) synth.click(when, clickPointer % 4 === 0);
          clickPointer++;
        }
      }
      // Drop finished voices so the array doesn't grow unbounded
      if (scheduledVoices.length > 256) {
        scheduledVoices = scheduledVoices.filter(v => !v.released);
      }
    }

    function killScheduledAudio() {
      for (const v of scheduledVoices) synth.releaseVoice(v);
      scheduledVoices = [];
    }

    // -------------------------------------------------------------- playback
    function play() {
      if (!midiData || !accessOk()) return;
      synth.resume();
      if (startOffset >= midiData.duration) startOffset = 0;
      startCtxTime = synth.ctx.currentTime;
      // Reset the scheduler pointer to the first note that ends after now
      schedulePointer = midiData.notes.findIndex(n => n.end > startOffset);
      if (schedulePointer < 0) schedulePointer = midiData.notes.length;
      clickPointer = beatTimes.findIndex(bt => bt >= startOffset);
      if (clickPointer < 0) clickPointer = beatTimes.length;
      playing = true;
      setBtn(btnPlay, 'pause', 'Pause');
    }

    function pause() {
      startOffset = songTime();
      playing = false;
      killScheduledAudio();
      setBtn(btnPlay, 'play', 'Play');
    }

    function stop() {
      playing = false;
      startOffset = 0;
      state.currentTime = 0;
      state.chord = null;
      lastSetKey = '';
      looping = false;
      metronomeOn = false;
      clickPointer = 0;
      recPhase = 'idle';
      takePhase = 'idle';
      killScheduledAudio();
      setBtn(btnPlay, 'play', 'Play');
      if (btnHarmRec) { btnHarmRec.classList.remove('on'); setBtn(btnHarmRec, 'record', 'Record melody'); }
      if (btnTake) { btnTake.classList.remove('on'); setBtn(btnTake, 'record', 'Record take'); }
      if (exporting) finishExport();
    }

    function seekTo(t) {
      const wasPlaying = playing;
      if (playing) pause();
      startOffset = Math.max(0, Math.min(t, midiData ? midiData.duration : 0));
      state.chord = null;
      lastSetKey = '';
      if (wasPlaying) play();
    }

    // -------------------------------------------------------------- recording
    let mediaRecorder = null;
    let recordedChunks = [];

    function pickMimeType() {
      const candidates = [
        'video/mp4;codecs="avc1.640028,mp4a.40.2"',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ];
      for (const c of candidates) {
        if (MediaRecorder.isTypeSupported(c)) return c;
      }
      return '';
    }

    function startRecording() {
      if (!accessOk()) return;
      synth.resume();
      const videoStream = canvas.captureStream(60);
      const stream = new MediaStream([
        ...videoStream.getVideoTracks(),
        ...synth.recorderDestination.stream.getAudioTracks()
      ]);
      const mimeType = pickMimeType();
      mediaRecorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
        videoBitsPerSecond: 20_000_000,
        audioBitsPerSecond: 256_000
      });
      recordedChunks = [];
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      mediaRecorder.onstop = saveRecording;
      mediaRecorder.start(250);
      state.recording = true;
      setBtn(btnRecord, 'stop', 'Stop recording');
      btnRecord.classList.add('rec');
    }

    function stopRecording() {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
      state.recording = false;
      setBtn(btnRecord, 'record', 'Capture');
      btnRecord.classList.remove('rec');
    }

    function saveRecording() {
      const type = mediaRecorder.mimeType || 'video/webm';
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(recordedChunks, { type });
      const base = (state.fileName || 'chord-detector').replace(/\.(mid|midi)$/i, '');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${base}-playthrough.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }

    // Export = restart from 0, record while playing, auto-stop at the end.
    function startExport() {
      if (!accessOk()) return;
      if (!midiData) {
        flashStatus('Load a MIDI file first to export a playthrough video.');
        return;
      }
      exporting = true;
      setBtn(btnExport, 'close', 'Cancel export');
      if (playing) pause();
      startOffset = 0;
      state.chord = null;
      lastSetKey = '';
      startRecording();
      // Small lead-in so the video doesn't start mid-attack
      setTimeout(() => { if (exporting) play(); }, 600);
    }

    function finishExport() {
      exporting = false;
      setBtn(btnExport, 'download', 'Export');
      stopRecording();
    }

    function flashStatus(msg) {
      state.statusText = msg;
      setTimeout(() => { state.statusText = ''; }, 4000);
    }

    // -------------------------------------------------------------- live MIDI
    function refreshLiveActive() {
      // Include harmoniser chord tones so the label / staff / keyboard show the
      // full harmony, not just the melody note you played.
      const all = new Set([...heldNotes, ...sustainedNotes, ...harmonyActive]);
      return [...all].sort((a, b) => a - b);
    }

    function onMidiMessage(e) {
      if (!accessOk()) return;
      const [status, d1, d2] = e.data;
      const type = status & 0xf0;
      if (type === 0x90 && d2 > 0) {
        heldNotes.add(d1);
        sustainedNotes.delete(d1);
        // Air Brass: breath sets the note-on velocity (soft blow → soft brass
        // layer); the take then records what actually sounded.
        const vel = airbrassOn() ? breathVel() : d2;
        synth.noteOn(d1, vel);
        if (harmonizeOn) harmonizeNoteOn(d1, vel);
        recordNoteOn(d1);
        takeNoteOn(d1, vel);
        lastActivity = performance.now();
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        heldNotes.delete(d1);
        if (sustainPedal) sustainedNotes.add(d1);
        else synth.noteOff(d1);
        if (harmonizeOn) harmonizeNoteOff(d1);
        recordNoteOff(d1);
        takeNoteOff(d1);
        lastActivity = performance.now();
      } else if (type === 0xb0 && d1 === 64) {
        sustainPedal = d2 >= 64;
        if (!sustainPedal) {
          for (const n of sustainedNotes) synth.noteOff(n);
          sustainedNotes.clear();
        }
      }
    }

    async function initLiveMidi() {
      if (!navigator.requestMIDIAccess) {
        midiStatus.textContent = 'Web MIDI not supported in this browser (use Chrome/Edge)';
        return;
      }
      try {
        const access = await navigator.requestMIDIAccess();
        const attach = () => {
          let count = 0;
          for (const input of access.inputs.values()) {
            input.onmidimessage = onMidiMessage;
            count++;
          }
          midiStatus.textContent = count
            ? `MIDI: ${count} input${count > 1 ? 's' : ''} connected`
            : 'MIDI: no devices found (connect a keyboard, or use computer keys A-L)';
        };
        access.onstatechange = attach;
        attach();
      } catch (err) {
        midiStatus.textContent = 'MIDI access denied';
      }
    }

    // Computer keyboard fallback (Ableton-style): A row = white keys from C4
    const KEYMAP = {
      'a': 0, 'w': 1, 's': 2, 'e': 3, 'd': 4, 'f': 5, 't': 6,
      'g': 7, 'y': 8, 'h': 9, 'u': 10, 'j': 11, 'k': 12, 'o': 13,
      'l': 14, 'p': 15, ';': 16
    };
    let kbOctave = 4; // C4 base
    const kbDown = new Set();

    // b / n walk the harmoniser key down and up a semitone. In a microtonal
    // tuning the key is what the 12-note subset is anchored to, so it changes
    // what the instrument IS, not just what the harmoniser thinks — and
    // reaching for the mouse mid-phrase to find that out ends the phrase.
    // Dispatching a real change event means every listener already wired to the
    // select fires too: notation key, subset anchor, reranked progressions.
    function stepHarmKey(dir) {
      if (!harmKey || !harmKey.options.length) return;
      const n = harmKey.options.length;
      harmKey.selectedIndex = ((harmKey.selectedIndex + dir) % n + n) % n;
      harmKey.dispatchEvent(new Event('change'));
      flashStatus(`Key: ${harmKey.options[harmKey.selectedIndex].textContent} ` +
        `${harmMode && harmMode.value === 'minor' ? 'minor' : 'major'}`);
    }

    window.addEventListener('keydown', (e) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.target.tagName === 'INPUT') return;
      const k = e.key.toLowerCase();
      // Skipped while a dropdown has focus, where the browser's own type-ahead
      // owns the keystroke and would step the key twice.
      if ((k === 'b' || k === 'n') && e.target.tagName !== 'SELECT') {
        e.preventDefault();
        stepHarmKey(k === 'b' ? -1 : 1);
        return;
      }
      if (k === 'z') { kbOctave = Math.max(0, kbOctave - 1); return; }
      if (k === 'x') { kbOctave = Math.min(7, kbOctave + 1); return; }
      if (k === ' ') { e.preventDefault(); if (midiData) (playing ? pause() : play()); return; }
      if (k in KEYMAP && !kbDown.has(k)) {
        kbDown.add(k);
        const midi = (kbOctave + 1) * 12 + KEYMAP[k];
        onMidiMessage({ data: [0x90, midi, kbVel()] });
      }
    });
    window.addEventListener('keyup', (e) => {
      const k = e.key.toLowerCase();
      if (kbDown.has(k)) {
        kbDown.delete(k);
        const midi = (kbOctave + 1) * 12 + KEYMAP[k];
        onMidiMessage({ data: [0x80, midi, 0] });
      }
    });

    // ------------------------------------------------------------ MIDI loading
    // Install a parsed/generated MIDI object into the file-playback pipeline. Both
    // the file picker and the sequence generator route through here, so playback,
    // the staff, the timeline, the fretboard and chord detection all work the same.
    function installMidi(data, name) {
      midiData = data;
      state.mode = 'file';
      state.fileName = name;
      state.duration = midiData.duration;
      state.midiNotes = midiData.notes;   // feed the timeline piano-roll
      state.markers = [];                  // key-change keyframes are per-file
      state.chord = null;
      lastSetKey = '';
      stopLiveNotes();
      stop();
      seekBar.max = String(midiData.duration);
      seekBar.value = '0';
      paintRange(seekBar);
      seekBar.disabled = false;
      btnPlay.disabled = false;
      btnStop.disabled = false;
      btnExport.disabled = false;
    }

    // Shared by the "Load MIDI" picker and the audio-transcription flow.
    function loadMidiBuffer(buf, name) {
      if (harmonizeOn) setHarmonize(false);   // harmonising is a live-input feature
      installMidi(MidiFile.parse(buf), name);
      state.progression = null;
      flashStatus(`Loaded ${name} — ${midiData.notes.length} notes, ${midiData.duration.toFixed(1)}s`);
    }

    // ------------------------------------------------------------- Harmoniser
    // Real-time mode: every note you play (live MIDI or A–L keys) gets a chord
    // voiced under it, using the harmonizer.js rule engine. The chord tones are
    // added to the live note set so the big label / staff / keyboard show the
    // full harmony. `harmVoices` maps each played melody note → its chord voices
    // so we can release them on note-off. `harmPrev` threads voice leading.
    const KEYPC_MAJ = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
    let harmonizeOn = false;
    let harmPrev = null;
    const harmRecent = [];          // last few chosen chords — anti-repetition memory
    const harmVoices = new Map();   // melodyMidi → { midis:[], voices:[] }
    const harmonyActive = new Set(); // chord-tone midis currently sounding

    // Voicing controls: the clustering slider drives PianoVoicing's clustered↔
    // spread axis; the bass toggle adds/removes the low root under the voicing.
    function voicingOpts() {
      const lowestMidi = harmLowestMidi ? parseInt(harmLowestMidi.value, 10) : 48;

      return {
        spread: harmSpread ? parseFloat(harmSpread.value) : 0.15,

        // Instead of a bass toggle, the user chooses the lowest allowed harmony note.
        // We can still add a bass root internally, but it will be clipped by lowestMidi.
        addBass: true,
        lowestMidi,

        // Prevent muddy low-register clusters.
        lowSpacing: true,

        // Register-aware minimum gap rules.
        // Rule means: if the LOWER note is below `below`, require at least `min`
        // semitones between it and the note above.
        lowSpacingRules: [
          { below: 36, min: 12 },
          { below: 43, min: 11 },
          { below: 48, min: 10 },
          { below: 53, min: 8  },
          { below: 128, min: 1 }
        ],

        // Keep rescued colour tones no lower than the user floor.
        minColourMidi: Math.max(53, lowestMidi),

        // Lets the voicer open an interval that grinds in the active tuning.
        // Null in 12-TET, where the voicing path is untouched.
        tuning: state.pitchScale
      };
    }



    function harmCtx() {
      const keyPc = parseInt(harmKey.value, 10);
      const mode = harmMode.value;
      // `tuning` lets the chord scorer mark down candidates that land on a rough
      // interval in the active scale. Absent in 12-TET, where scoring is unchanged.
      const ctx = { keyPc, mode, approach: harmApproach.value, prev: harmPrev, recent: harmRecent, voicing: voicingOpts(), tuning: state.pitchScale };
      // Chord set for FREE harmonise: our 7-chord jazz palette, or slices of the
      // free-midi-chords vocabulary (triads only / 7ths+9ths / all 147 qualities).
      const set = harmChordset ? harmChordset.value : 'pack';
      if (set !== 'classic' && ChordPack.isLoaded()) {
        let pal = ChordPack.palette(keyPc, mode);
        if (set === 'triads') pal = pal.filter((c) => c.pitchClasses.length === 3);
        else if (set === 'sevenths') pal = pal.filter((c) => c.pitchClasses.length >= 4 && /7|9/.test(c.quality));
        ctx.palette = pal;
      }
      return ctx;
    }

    // Grey out sequencer controls that do nothing under the current source:
    // the mood filter only applies to the progression packs. (The functional/
    // non-functional select lives in the FREE HARMONISE section — it always
    // steers live harmonising, and the rule-engine sequencer too.)
    function syncHarmUI() {
      const src = harmSource ? harmSource.value : 'rules';
      if (harmMood) harmMood.disabled = src === 'rules';
    }
    syncHarmUI();

    // Free Play vs Sequencer: show only the relevant sidebar groups + record
    // button, so "record my performance" and "record a melody to harmonise"
    // never read as the same control.
    function syncHarmModeUI() {
      const mode = state.harmMode;
      harmGroups.forEach((g) => { g.hidden = g.dataset.harmGroup !== mode; });
      if (btnModeFree) btnModeFree.classList.toggle('on', mode === 'free');
      if (btnModeSeq) btnModeSeq.classList.toggle('on', mode === 'sequencer');
    }
    function setHarmMode(mode) {
      if (state.harmMode === mode) return;
      // Switching modes stops anything in flight so the two workflows never bleed.
      if (mode === 'sequencer' && harmonizeOn) setHarmonize(false);
      if (looping || takePhase !== 'idle' || recPhase !== 'idle') stop();
      state.harmMode = mode;
      localStorage.setItem('orbkord.harmMode', mode);
      syncHarmModeUI();
    }
    const savedMode = localStorage.getItem('orbkord.harmMode');
    if (savedMode === 'sequencer' || savedMode === 'free') state.harmMode = savedMode;
    syncHarmModeUI();

    // ------------------- ChordPack: the distilled free-midi-chords/progressions
    // dataset (built once by tools/build-harmonypack.js). Loaded async at start;
    // everything degrades to the rule engine if the fetch fails.
    let packRanked = [];   // progressions ranked against the last recording
    let packPick = 0;      // which ranked progression is playing (reroll cycles)
    let lastRec = null;    // { notes, opts } — kept so reroll can re-harmonise

    ChordPack.load('data/harmonypack.json').then(() => {
      if (harmMood) {
        for (const m of ChordPack.moods()) {
          const o = document.createElement('option');
          o.value = m; o.textContent = m;
          harmMood.appendChild(o);
        }
      }
      console.log('[chordpack] loaded:', ChordPack.palette(0, 'major').length, 'chords,',
        ChordPack.findProgressions({}).length, 'progressions');
    }).catch((err) => console.warn('[chordpack] unavailable — rule engine only:', err.message));

    // The two key controls are one setting wearing two hats: the harmoniser
    // picks a tonic and a mode, the staff shows the resulting key signature, and
    // in a microtonal tuning the same choice anchors the 12-note subset. So they
    // follow each other in both directions.
    //
    // The staff selector spells more keys than the harmoniser has pitch classes
    // (G♭ and C♭ are there, and KEYPC_MAJ never produces either), so a round trip
    // would silently rewrite a chosen G♭ as F♯. `syncingKeys` marks a change as
    // already-handled so the return leg leaves the spelling alone.
    const KEYNAME_PC = {
      C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5,
      'F#': 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11, Cb: 11,
    };
    let syncingKeys = false;

    // Point the staff's key signature at the harmoniser key (minor→relative major).
    function syncNotationKey(keyPc, mode) {
      if (syncingKeys) return;
      const name = KEYPC_MAJ[mode === 'minor' ? (keyPc + 3) % 12 : keyPc];
      if (keySelect) keySelect.value = name;
      state.baseKey = name;
    }

    // …and the other way. A key signature is shared by a major and its relative
    // minor, so which tonic it means depends on the mode already selected:
    // picking C major reads as C with the mode on major, A with it on minor.
    function syncHarmKeyFromNotation() {
      if (syncingKeys || !harmKey || !keySelect) return;
      const namePc = KEYNAME_PC[keySelect.value];
      if (namePc === undefined) return;
      const minor = harmMode && harmMode.value === 'minor';
      const want = String(minor ? (namePc + 9) % 12 : namePc);
      if (harmKey.value === want) return;
      harmKey.value = want;
      syncingKeys = true;
      try { harmKey.dispatchEvent(new Event('change')); } finally { syncingKeys = false; }
    }

    // "Vary repeated notes": hitting the same note again cycles through the
    // top-ranked alternative harmonies instead of replaying the same chord.
    let lastFreePc = -1, freeAlt = 0;

    function harmonizeNoteOn(melodyMidi, velocity) {
      if (harmVoices.has(melodyMidi)) return;
      const notePc = ((melodyMidi % 12) + 12) % 12;
      if (harmVariety && harmVariety.checked && notePc === lastFreePc) freeAlt++;
      else freeAlt = 0;
      lastFreePc = notePc;
      const ev = Harmonizer.harmonizeNote(melodyMidi, { ...harmCtx(), altRank: freeAlt });
      harmPrev = ev.chord;
      harmRecent.push(ev.chord);
      if (harmRecent.length > 4) harmRecent.shift();
      // Generated chords use the Dynamics chord-velocity, not the played note's
      // velocity — real soundfonts sound harsh when comped at full velocity.
      // Capture the per-note velocity so a Record Take logs exactly what sounded.
      const chordNotes = ev.chordMidis.map((m) => {
        // Air Brass: harmonizer chords breathe with the melody — same breath
        // velocity at onset, same ExpressionBus shaping them all afterwards.
        const v = airbrassOn() ? breathVel() : chordVel();
        return { midi: m, vel: v, voice: synth.playNote(m, v, synth.now) };
      });
      for (const m of ev.chordMidis) harmonyActive.add(m);
      harmVoices.set(melodyMidi, { midis: ev.chordMidis, voices: chordNotes.map((c) => c.voice) });
      takeChordOn(melodyMidi, chordNotes);
    }

    function harmonizeNoteOff(melodyMidi) {
      const h = harmVoices.get(melodyMidi);
      if (!h) return;
      for (const v of h.voices) synth.releaseVoice(v);
      for (const m of h.midis) harmonyActive.delete(m);
      harmVoices.delete(melodyMidi);
      takeChordOff(melodyMidi);
    }

    function clearHarmony() {
      for (const h of harmVoices.values()) for (const v of h.voices) synth.releaseVoice(v);
      harmVoices.clear();
      harmonyActive.clear();
      harmPrev = null;
      harmRecent.length = 0;
    }

    function setHarmonize(on) {
      harmonizeOn = on;
      btnHarmonize.classList.toggle('on', on);
      if (on) {
        // Harmonising is a live-input feature; make sure we're in live mode.
        if (playing) pause();
        state.mode = 'live';
        state.progression = null;
        syncNotationKey(parseInt(harmKey.value, 10), harmMode.value);
        synth.resume();
        flashStatus('Harmoniser on. play a melody (MIDI or A-L keys).');
      } else {
        clearHarmony();
      }
    }

    // -------------------------------------- Harmoniser step sequencer (record)
    // Count in one bar of metronome, record N bars of live melody, then harmonise
    // it on the grid and loop it back with the metronome.
    let recPhase = 'idle';                 // 'idle' | 'countin' | 'recording'
    let recStartCtx = 0, recEndCtx = 0;    // AudioContext times: recording window
    let recBpm = 100, recBars = 4, recGrid = 'half';
    const recOpen = new Map();             // midi → onset time (sec, from recStart)
    let recNotes = [];

    function startHarmRecord() {
      if (!accessOk()) return;
      if (harmonizeOn) setHarmonize(false);   // no live-harmony while recording
      stop();
      synth.resume();
      recBpm = parseInt(harmBpm.value, 10);
      recBars = parseInt(harmBars.value, 10);
      recGrid = harmGrid.value;
      state.mode = 'live';
      state.progression = null;
      state.chord = null;
      syncNotationKey(parseInt(harmKey.value, 10), harmMode.value);

      const secBeat = 60 / recBpm;
      const now = synth.now + 0.15;           // small lead-in
      recStartCtx = now + 4 * secBeat;        // after a one-bar count-in
      recEndCtx = recStartCtx + recBars * 4 * secBeat;
      // Click every beat through the count-in AND the recording.
      const totalBeats = 4 + recBars * 4;
      for (let i = 0; i < totalBeats; i++) synth.click(now + i * secBeat, i % 4 === 0);

      recOpen.clear();
      recNotes = [];
      recPhase = 'countin';
      btnHarmRec.classList.add('on');
      setBtn(btnHarmRec, 'stop', 'Stop');
      flashStatus('Count-in… get ready to play.');
    }

    function stopHarmRecord() {
      recPhase = 'idle';
      recOpen.clear();
      btnHarmRec.classList.remove('on');
      setBtn(btnHarmRec, 'record', 'Record melody');
    }

    // Called each frame to advance the record state machine off the audio clock.
    function updateRecorder() {
      if (recPhase === 'countin' && synth.now >= recStartCtx) {
        recPhase = 'recording';
        flashStatus(`Recording ${recBars} bars — play your melody.`);
      } else if (recPhase === 'recording' && synth.now >= recEndCtx) {
        finishHarmRecord();
      }
    }

    // Live note-on/off during recording capture onsets relative to recStart.
    function recordNoteOn(midi) {
      // Capture during recording, plus a short pre-roll at the tail of the
      // count-in so the first chord isn't lost when your hand lands early.
      const armed = recPhase === 'recording' ||
        (recPhase === 'countin' && synth.now >= recStartCtx - NOTE_PREROLL);
      if (!armed) return;
      recOpen.set(midi, Math.max(0, synth.now - recStartCtx));
    }
    function recordNoteOff(midi) {
      if (!recOpen.has(midi)) return;
      const start = recOpen.get(midi);
      recNotes.push({ midi, time: start, duration: Math.max(0.1, (synth.now - recStartCtx) - start) });
      recOpen.delete(midi);
    }

    function finishHarmRecord() {
      const secBeat = 60 / recBpm;
      const total = recBars * 4 * secBeat;
      // Close any notes still held at the end of the window.
      for (const [midi, start] of recOpen) recNotes.push({ midi, time: start, duration: Math.max(0.1, total - start) });
      recOpen.clear();
      stopHarmRecord();

      if (recNotes.length === 0) {
        flashStatus('No notes recorded — try again.');
        return;
      }

      // NO quantisation — the melody keeps the feel it was played with (triplets,
      // push/pull, whatever). Harmonisation reads the grid; the notes don't move.
      recNotes = recNotes
        .filter((n) => n.time >= 0 && n.time < total)
        .sort((a, b) => a.time - b.time);

      // Only bpm/bars are frozen with the recording (they define the loop length);
      // every other parameter is re-read from the UI on each (re)harmonise, so
      // changing key / grid / approach / mood and hitting ↻ actually applies it.
      lastRec = { notes: recNotes.slice(), bpm: recBpm, bars: recBars };
      packRanked = [];
      packPick = 0;
      harmoniseRecording();
    }

    // Turn the last recording into a harmonised loop. Called after recording and
    // again by the ↻ reroll button (which just steps to the next-best progression).
    function harmoniseRecording() {
      if (!lastRec) return;
      const mel = lastRec.notes;
      const opts = {
        keyPc: parseInt(harmKey.value, 10),
        mode: harmMode.value,
        approach: harmApproach.value,
        bpm: lastRec.bpm, bars: lastRec.bars,
        grid: harmGrid.value,
        voicing: voicingOpts(),
        variation: packPick          // reroll counter — re-deals rule-engine picks
      };
      const source = harmSource ? harmSource.value : 'rules';
      let events;

      if (source !== 'rules' && ChordPack.isLoaded()) {
        // DATASET MODE: pick a human-written progression from the pack that best
        // fits the melody (filtered by mood; Major/Minor follows the key, or the
        // Modal set for modern colour), then lay its chords over the grid.
        if (!packRanked.length) {
          const cat = source === 'packmodal' ? 'Modal' : (opts.mode === 'minor' ? 'Minor' : 'Major');
          const mood = harmMood ? harmMood.value : '';
          let list = ChordPack.findProgressions({ cat, mood });
          if (!list.length) list = ChordPack.findProgressions({ cat });
          const cands = list.map((p) => ({ prog: p, chords: ChordPack.realizeProgression(p, opts.keyPc, opts.mode) }));
          packRanked = Harmonizer.rankProgressions(cands, mel, opts).slice(0, 24);
        }
        const pick = packRanked[packPick % packRanked.length];
        events = Harmonizer.harmonizeGridFromProgression(mel, pick.chords, opts);
        flashStatus(`Progression ${(packPick % packRanked.length) + 1}/${packRanked.length}: ` +
          `${pick.prog.romans}  (${pick.prog.moods.join(', ')})`);
      } else {
        events = Harmonizer.harmonizeGrid(mel, opts);
        flashStatus('Harmonised: ' + events.map((e) => e.chord.symbol).join(' | '));
      }
      installHarmLoop(events, opts);
    }

    // Build + start the looping sequence: melody as played on top, chord voicings
    // under — comped with the selected style's rhythm pattern (from the pack).
    function installHarmLoop(events, opts) {
      const secBeat = 60 / opts.bpm;
      const total = opts.bars * 4 * secBeat;
      const style = harmStyle ? harmStyle.value : 'block';
      const patterns = style !== 'block' ? ChordPack.rhythm(style) : null;

      const notes = [];
      for (const n of lastRec.notes) {
        notes.push({ midi: n.midi, channel: 0, velocity: 100, start: n.time, end: Math.min(total, n.time + n.duration) });
      }
      events.forEach((e, i) => {
        // One sustained hit per slot, or the style's comping subdivision.
        const hits = (patterns && patterns.length)
          ? patterns[i % patterns.length].map(([on, du]) => [e.time + on * e.duration, Math.max(0.08, du * e.duration)])
          : [[e.time, e.duration * 0.98]];
        for (const [t, d] of hits) {
          for (const m of e.chordMidis) {
            notes.push({ midi: m, channel: 0, velocity: chordVel(), start: t, end: Math.min(total, t + d) });
          }
        }
      });
      notes.sort((a, b) => a.start - b.start);

      installMidi({
        format: 0, numTracks: 1, ticksPerQuarter: 480,
        notes, duration: total, bpm: opts.bpm, trackName: 'Harmonised'
      }, `Harmonised ${opts.bars}-bar`);
      state.progression = events.map((e) => ({ symbol: e.chord.symbol, start: e.time, end: e.time + e.duration }));

      // Beat grid for the metronome, then loop.
      beatTimes = [];
      for (let t = 0; t < total - 1e-6; t += secBeat) beatTimes.push(t);
      looping = true;
      metronomeOn = true;
      synth.resume();
      startOffset = 0;
      play();
      btnHarmRec.classList.add('on');
      setBtn(btnHarmRec, 'stop', 'Stop');   // now stops the loop
    }

    // ---------------------------------------- Free-Play "Record Take"
    // Capture a live free-harmonise performance (melody + generated chords) as an
    // editable, looping MIDI. Open-ended: count in one bar, then record until the
    // user stops. The metronome is a monitor guide only — never added to takeNotes,
    // so it can never reach the exported .mid.
    let takePhase = 'idle';        // 'idle' | 'countin' | 'recording'
    let takeStartCtx = 0;          // AudioContext time recording begins
    let takeBpm = 100, takeNextBeat = 0;
    const takeOpen = new Map();    // voiceKey → { midi, start, velocity }
    let takeNotes = [];            // { midi, start, end, velocity }

    const takeTime = () => Math.max(0, synth.now - takeStartCtx);
    // Same pre-roll idea as the melody recorder: a note struck just before the
    // downbeat is captured (clamped to t=0 by takeTime) instead of dropped.
    const takeCapturing = () => takePhase === 'recording' ||
      (takePhase === 'countin' && synth.now >= takeStartCtx - NOTE_PREROLL);

    function finalizeTake(key) {
      const o = takeOpen.get(key);
      if (!o) return;
      takeOpen.delete(key);
      const end = takeTime();
      if (end > o.start + 0.02) takeNotes.push({ midi: o.midi, start: o.start, end, velocity: o.velocity });
    }
    function takeNoteOn(midi, velocity) {
      if (!takeCapturing()) return;
      takeOpen.set('m' + midi, { midi, start: takeTime(), velocity });
    }
    function takeNoteOff(midi) { finalizeTake('m' + midi); }
    function takeChordOn(melodyMidi, chordNotes) {
      if (!takeCapturing()) return;
      const t = takeTime();
      for (const cn of chordNotes) {
        takeOpen.set('c' + melodyMidi + '-' + cn.midi, { midi: cn.midi, start: t, velocity: cn.vel });
      }
    }
    function takeChordOff(melodyMidi) {
      const prefix = 'c' + melodyMidi + '-';
      for (const key of [...takeOpen.keys()]) if (key.startsWith(prefix)) finalizeTake(key);
    }

    function startTake() {
      if (state.harmMode !== 'free') return;
      stop();
      if (!harmonizeOn) setHarmonize(true);   // a take captures the harmonised performance
      synth.resume();
      takeBpm = takeBpmSel ? parseInt(takeBpmSel.value, 10) : 100;
      takeNotes = [];
      takeOpen.clear();
      const secBeat = 60 / takeBpm;
      const now = synth.now + 0.15;
      takeStartCtx = now + 4 * secBeat;        // one-bar count-in
      takeNextBeat = takeStartCtx;             // rolling metronome begins at bar 1
      for (let i = 0; i < 4; i++) synth.click(now + i * secBeat, i % 4 === 0); // count-in
      takePhase = 'countin';
      btnTake.classList.add('on');
      setBtn(btnTake, 'stop', 'Stop');
      flashStatus('Count-in… then play freely.');
    }

    function updateTake() {
      const secBeat = 60 / takeBpm;
      if (takePhase === 'countin' && synth.now >= takeStartCtx) {
        takePhase = 'recording';
        flashStatus('Recording — play freely; hit Stop when done.');
      }
      if (takePhase === 'recording') {
        // Roll the click grid ~0.3s ahead (open-ended, can't front-load). Advance
        // the pointer even when muted so re-enabling doesn't backfill a burst.
        const clickOn = takeMetro ? takeMetro.checked : true;
        while (takeNextBeat < synth.now + 0.3) {
          if (clickOn) {
            const beatIdx = Math.round((takeNextBeat - takeStartCtx) / secBeat);
            synth.click(takeNextBeat, (((beatIdx % 4) + 4) % 4) === 0);
          }
          takeNextBeat += secBeat;
        }
      }
    }

    function stopTake() {
      if (takePhase === 'idle') return;
      const wasRecording = takePhase === 'recording';
      takePhase = 'idle';
      btnTake.classList.remove('on');
      setBtn(btnTake, 'record', 'Record take');
      for (const key of [...takeOpen.keys()]) finalizeTake(key); // close held notes
      if (!wasRecording || takeNotes.length === 0) {
        takeOpen.clear();
        flashStatus('Take discarded — nothing recorded.');
        return;
      }
      const secBeat = 60 / takeBpm;
      const barSec = secBeat * 4;
      const maxEnd = takeNotes.reduce((m, n) => Math.max(m, n.end), 0);
      const duration = Math.max(barSec, Math.ceil((maxEnd - 1e-6) / barSec) * barSec);
      const notes = takeNotes
        .map((n) => ({ midi: n.midi, channel: 0, velocity: n.velocity, start: n.start, end: Math.min(duration, n.end) }))
        .sort((a, b) => a.start - b.start);

      installMidi({
        format: 0, numTracks: 1, ticksPerQuarter: 480,
        notes, duration, bpm: takeBpm, trackName: 'OrbKord Take'
      }, 'OrbKord Take');

      beatTimes = [];
      for (let t = 0; t < duration - 1e-6; t += secBeat) beatTimes.push(t);
      looping = true;
      metronomeOn = takeMetro ? takeMetro.checked : false;
      synth.resume();
      startOffset = 0;
      play();
      flashStatus(`Take recorded (${notes.length} notes) — looping. Export MIDI to save.`);
    }

    // ------------------------------------------------------------ UI wiring
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      if (!file) return;
      try {
        loadMidiBuffer(await file.arrayBuffer(), file.name);
      } catch (err) {
        alert('Could not parse MIDI file: ' + err.message);
      }
    });

    // Key selector sets the BASE key (before any keyframe). The effective key is
    // computed each frame (it may follow a key-change marker during playback).
    if (keySelect) {
      keySelect.addEventListener('change', () => {
        state.baseKey = keySelect.value;
        syncHarmKeyFromNotation();
      });
    }

    // Drop a key-change keyframe at the playhead using the currently selected key.
    if (btnAddKey) {
      btnAddKey.addEventListener('click', () => {
        if (state.mode !== 'file' || !midiData) return;
        const t = Math.max(0, songTime());
        state.markers = state.markers.filter((m) => Math.abs(m.time - t) > 0.05); // replace nearby
        state.markers.push({ time: t, key: keySelect.value });
        state.markers.sort((a, b) => a.time - b.time);
      });
    }

    // ---- Timeline interaction: scrub the playhead, click a marker to remove it.
    let scrubbing = false, scrubWasPlaying = false;
    const toCanvas = (e) => {
      const rect = canvas.getBoundingClientRect();
      return {
        cx: (e.clientX - rect.left) / rect.width * canvas.width,
        cy: (e.clientY - rect.top) / rect.height * canvas.height
      };
    };
    const inTimeline = (cx, cy) =>
      cx >= TIMELINE.x && cx <= TIMELINE.x + TIMELINE.w && cy >= TIMELINE.y && cy <= TIMELINE.y + TIMELINE.h;
    const markerAt = (cx) => (state.markers || []).find(
      (m) => Math.abs(timelineXAt(m.time, midiData.duration) - cx) < 14);

    // Click a hex on the isomorphic keyboard to sound it (release on mouseup).
    let isoHeld = null;
    canvas.addEventListener('mousedown', (e) => {
      if (!state.isoKeyboard) return;
      const { cx, cy } = toCanvas(e);
      const m = IsoKeyboard.noteAt(cx, cy);
      if (m != null) { isoHeld = m; synth.resume(); onMidiMessage({ data: [0x90, m, 96] }); }
    });
    window.addEventListener('mouseup', () => {
      if (isoHeld != null) { onMidiMessage({ data: [0x80, isoHeld, 0] }); isoHeld = null; }
    });

    canvas.addEventListener('mousedown', (e) => {
      if (state.mode !== 'file' || !midiData) return;
      const { cx, cy } = toCanvas(e);
      if (!inTimeline(cx, cy)) return;
      scrubbing = true;
      scrubWasPlaying = playing;
      if (playing) pause();
      startOffset = timelineTimeAt(cx, midiData.duration);
      state.chord = null; lastSetKey = '';
    });
    // Right-click a key-change keyframe to remove it.
    canvas.addEventListener('contextmenu', (e) => {
      if (state.mode !== 'file' || !midiData) return;
      const { cx, cy } = toCanvas(e);
      if (!inTimeline(cx, cy)) return;
      const m = markerAt(cx);
      if (m) { e.preventDefault(); state.markers = state.markers.filter((x) => x !== m); }
    });
    window.addEventListener('mousemove', (e) => {
      if (!scrubbing) return;
      const { cx } = toCanvas(e);
      startOffset = timelineTimeAt(cx, midiData.duration);
      state.chord = null; lastSetKey = '';
    });
    window.addEventListener('mouseup', () => {
      if (!scrubbing) return;
      scrubbing = false;
      if (scrubWasPlaying) play();
    });

    function stopLiveNotes() {
      heldNotes.clear();
      sustainedNotes.clear();
      synth.allNotesOff();
    }

    btnPlay.addEventListener('click', () => { synth.resume(); playing ? pause() : play(); });
    btnStop.addEventListener('click', stop);
    btnFretboard.addEventListener('click', () => {
      state.showFretboard = !state.showFretboard;
      btnFretboard.classList.toggle('on', state.showFretboard);
    });
    const FRET_MODES = ['all', 'pitch', 'voicing'];
    const FRET_LABELS = { all: 'Frets: All', pitch: 'Frets: Played', voicing: 'Frets: Voicing' };
    btnFretMode.addEventListener('click', () => {
      state.fretMode = FRET_MODES[(FRET_MODES.indexOf(state.fretMode) + 1) % FRET_MODES.length];
      if (state.fretMode === 'voicing') state.voicingIndex = 0;
      btnFretMode.textContent = FRET_LABELS[state.fretMode];
    });
    btnVoicing.addEventListener('click', () => { state.voicingIndex++; });

    // ---- Fretboard tunings: presets + free-form custom. Stored high→low to
    // match how the fretboard draws strings (top string first).
    const TUNING_PRESETS = {
      standard: { name: 'Standard',    str: 'E A D G B E' },
      dropd:    { name: 'Drop D',      str: 'D A D G B E' },
      dadgad:   { name: 'DADGAD',      str: 'D A D G A D' },
      openg:    { name: 'Open G',      str: 'D G D G B D' },
      opend:    { name: 'Open D',      str: 'D A D F# A D' },
      fourths:  { name: 'All Fourths', str: 'E A D G C F' },
      halfstep: { name: '½-Step Down', str: 'Eb Ab Db Gb Bb Eb' }
    };
    const PC_MAP = { 'C':0,'C#':1,'DB':1,'D':2,'D#':3,'EB':3,'E':4,'FB':4,'E#':5,'F':5,
                     'F#':6,'GB':6,'G':7,'G#':8,'AB':8,'A':9,'A#':10,'BB':10,'B':11,'CB':11 };
    // Parse "low → high" note names into MIDI, returned high→low. Octaves are
    // assigned so each string sits just above the one below it (lowest ≈ E2).
    function parseTuning(str) {
      const toks = String(str).trim().split(/[\s,]+/).filter(Boolean);
      const lowToHigh = [];
      let prev = null;
      for (const raw of toks) {
        const m = raw.match(/^([A-Ga-g])([#b♯♭]?)/);
        if (!m) continue;
        const key = m[1].toUpperCase() + m[2].replace('♯', '#').replace('♭', 'B').toUpperCase();
        const p = PC_MAP[key];
        if (p == null) continue;
        if (prev == null) {
          let cand = 40 - (((40 - p) % 12) + 12) % 12;          // nearest pc to E2
          if (Math.abs(cand + 12 - 40) < Math.abs(cand - 40)) cand += 12;
          prev = cand;
        } else {
          let delta = (((p - (((prev % 12) + 12) % 12)) % 12) + 12) % 12;
          if (delta === 0) delta = 12;                          // ascend, never unison-stack
          prev += delta;
        }
        lowToHigh.push(prev);
      }
      return lowToHigh.length >= 3 ? lowToHigh.reverse() : null; // → high→low
    }
    function applyTuning(sel, silent) {
      if (sel === 'custom') {
        const inp = prompt('Custom tuning — enter notes low → high (e.g. D A D G A D):',
          state.tuningStr || 'E A D G B E');
        if (inp == null) { if (fretTuning) fretTuning.value = state.tuningKey; return; }
        const arr = parseTuning(inp);
        if (!arr) { flashStatus('Couldn’t read that tuning — use note names, e.g. “D A D G A D”.');
          if (fretTuning) fretTuning.value = state.tuningKey; return; }
        state.tuning = arr; state.tuningName = 'Custom'; state.tuningStr = inp.trim(); state.tuningKey = 'custom';
      } else {
        const p = TUNING_PRESETS[sel] || TUNING_PRESETS.standard;
        state.tuning = parseTuning(p.str); state.tuningName = p.name; state.tuningStr = p.str; state.tuningKey = sel;
      }
      localStorage.setItem('orbkord.tuning', state.tuningKey === 'custom' ? 'custom:' + state.tuningStr : state.tuningKey);
      if (!silent && !state.showFretboard) flashStatus('Tuning: ' + state.tuningName + ' — turn on the Fretboard to see it.');
    }
    if (fretTuning) {
      // Restore last tuning (preset key, or "custom:<notes>").
      const saved = localStorage.getItem('orbkord.tuning');
      if (saved && saved.startsWith('custom:')) {
        const arr = parseTuning(saved.slice(7));
        if (arr) { state.tuning = arr; state.tuningName = 'Custom'; state.tuningStr = saved.slice(7); state.tuningKey = 'custom'; }
        fretTuning.value = 'custom';
      } else if (saved && TUNING_PRESETS[saved]) {
        applyTuning(saved, true); fretTuning.value = saved;
      }
      fretTuning.addEventListener('change', () => {
        // One select, two orthogonal concerns: "pitch:*" entries retune the
        // whole instrument, everything else is the guitar's string tuning.
        // Both are remembered independently; the select just shows whichever
        // you touched last.
        const v = fretTuning.value;
        if (v.startsWith('pitch:')) applyPitchTuning(v.slice(6));
        else applyTuning(v);
      });
    }

    // ------------------------------------------------- Microtonal pitch system
    // The whole app keeps thinking in 12-TET note numbers — the harmonizer,
    // chord detection, the staff, chordpack are all untouched. Only the
    // FREQUENCY each note sounds at is remapped (js/tuning.js), which is why no
    // retuned soundfonts are needed: the sampler already shifts in cents.
    // The key mapping rides along as a ":linear" suffix on the option value
    // rather than a second control — the View group is full and an extra
    // select pushes the Iso button out of the row.
    const sclInput = $('scl-input');
    let pitchScale = null;      // active Tuning.Scale, or null for 12-TET
    let pitchKey = 'pitch:12';  // what the select shows

    // Label every key the hex grid can show with its name IN THE CURRENT TUNING.
    // Precomputed for the whole range rather than looked up per frame, and kept
    // as a plain midi→name map so isokeyboard.js needs no tuning knowledge.
    function buildIsoNames(scale, spell, rng) {
      const n = scale.size;
      const lo = rng ? rng.min : 24, hi = rng ? rng.max : 96;
      const out = {};
      for (let m = lo; m <= hi; m++) {
        out[m] = spell.table[((scale.stepOf(m) % n) + n) % n];
      }
      return out;
    }

    function syncIsoLattice() {
      // 'nearest' keeps 12-TET key numbers, so the hex grid keeps its classic
      // +4/+7 steps. 'linear' walks real scale degrees, so it needs the
      // tuning's own lattice and a note range widened by the scale size.
      if (!pitchScale || pitchScale.is12TET) {
        state.isoLattice = null;
        state.isoRange = null;
        state.isoLabel = 'names';
        state.isoNames = null;
        return;
      }
      const spell = Tuning.spellings(pitchScale);
      if (pitchScale.mode === 'linear') {
        const n = pitchScale.size;
        state.isoLattice = pitchScale.lattice();
        state.isoRange = { min: 60 - 3 * n, max: 60 + 3 * n, base: 60, period: n };
        // Without a chain of fifths to spell from, scale degrees are the only
        // honest label — a note name would claim a relationship that isn't there.
        state.isoLabel = spell ? 'names' : 'steps';
      } else {
        state.isoLattice = null;
        state.isoRange = null;
        state.isoLabel = 'names';
      }
      // A 12-key subset gets spelled too. Near home the names read ordinary
      // (C C♯ D E♭ …) and only the colouring tells you which side of the chain
      // each key sits on; in a remote key the window runs off the end of the
      // standard names and the marked layer shows up — in F♯ the C key really is
      // playing a step below C, and says so.
      state.isoNames = spell ? buildIsoNames(pitchScale, spell, state.isoRange) : null;
    }

    // Point the 12-note subset at the harmoniser's key. Without this the subset
    // is a fixed chain of fifths around C — a meantone temperament with a wolf,
    // so the tuning is lovely in the keys the chain reaches and sour in the ones
    // it doesn't. Anchoring slides the window so the good thirds follow the
    // music. Linear mode plays every degree, so it has no subset to anchor.
    function syncPitchKey() {
      if (!pitchScale || pitchScale.mode === 'linear' || !harmKey) return;
      const changed = pitchScale.setKey(parseInt(harmKey.value, 10) || 0,
        harmMode ? harmMode.value : 'major');
      if (!changed) return;
      syncIsoLattice();     // subset moved, so the hex labels moved with it
      renderer.draw(state);
    }

    function applyPitchScale(scale, label, key, silent) {
      pitchScale = scale;
      pitchKey = key;
      if (scale && scale.mode !== 'linear' && harmKey) {
        scale.setKey(parseInt(harmKey.value, 10) || 0, harmMode ? harmMode.value : 'major');
      }
      synth.setTuning(scale);
      state.pitchTuning = scale ? label : null;
      state.pitchScale = scale;   // read by harmCtx/voicingOpts for roughness scoring
      syncIsoLattice();
      renderer.draw(state);
      if (silent) return;
      // Some tunings simply can't do triads on twelve keys. 53-EDO's chain
      // subset is Pythagorean by construction — its thirds are worse than
      // 12-TET's, and no key anchoring changes that — so say so rather than let
      // it sound quietly wrong.
      const q = scale && scale.subsetQuality();
      if (q && Math.abs(q.majThird) > 13.7) {
        flashStatus(`Pitch: ${label}. Try 1 key per step, its thirds are rough on 12 keys.`);
        return;
      }
      flashStatus(scale
        ? `Pitch: ${label} — chords are voiced in ${label} (note names stay 12-TET).`
        : 'Pitch: 12-TET (normal tuning).');
    }

    // `which` is "12" | "31" | "31:linear" | "scl" | "scl:linear" — the scale
    // and its key mapping in one token.
    function applyPitchTuning(which, silent) {
      const [what, suffix] = which.split(':');
      const mode = suffix === 'linear' ? 'linear' : 'nearest';
      const keys = mode === 'linear' ? ' · 1 key/step' : '';

      if (what === 'scl') {
        pendingSclMode = mode;
        if (sclInput) sclInput.click();
        fretTuning.value = pitchKey;   // keep the select honest until it loads
        return;
      }
      if (what === '12') {
        localStorage.removeItem('orbkord.pitch');
        applyPitchScale(null, '12-TET', 'pitch:12', silent);
        return;
      }
      const n = parseInt(what, 10);
      if (!Number.isFinite(n) || n < 2) return;
      localStorage.setItem('orbkord.pitch', which);
      applyPitchScale(Tuning.edo(n, { mode }), `${n}-EDO${keys}`, `pitch:${which}`, silent);
    }
    let pendingSclMode = 'nearest';   // mapping chosen when the picker opened

    if (sclInput) {
      sclInput.addEventListener('change', async () => {
        const file = sclInput.files && sclInput.files[0];
        sclInput.value = '';                  // let the same file be re-picked
        if (!file) return;
        try {
          const text = await file.text();
          const mode = pendingSclMode;
          const scale = Tuning.fromScl(text, { mode });
          const key = mode === 'linear' ? 'pitch:scl:linear' : 'pitch:scl';
          localStorage.setItem('orbkord.pitch', mode === 'linear' ? 'scl:linear' : 'scl');
          localStorage.setItem('orbkord.pitchscl', text);
          // The load entry takes the scale's name once something is loaded.
          const opt = fretTuning.querySelector(`option[value="${key}"]`);
          if (opt) opt.textContent = `Pitch: ${scale.name}`;
          applyPitchScale(scale, `${scale.name} (${scale.size} notes)`, key);
          fretTuning.value = key;
        } catch (err) {
          console.warn('[tuning] bad .scl', err);
          flashStatus(`Couldn’t read that .scl file — ${err.message}`);
        }
      });
    }

    // Restore the last pitch system ("31", "31:linear", "scl", "scl:linear";
    // the .scl text itself lives under its own key).
    {
      const saved = localStorage.getItem('orbkord.pitch');
      if (saved && saved.startsWith('scl')) {
        const text = localStorage.getItem('orbkord.pitchscl');
        const mode = saved.endsWith(':linear') ? 'linear' : 'nearest';
        const key = mode === 'linear' ? 'pitch:scl:linear' : 'pitch:scl';
        try {
          const scale = Tuning.fromScl(text, { mode });
          const opt = fretTuning && fretTuning.querySelector(`option[value="${key}"]`);
          if (opt) opt.textContent = `Pitch: ${scale.name}`;
          applyPitchScale(scale, `${scale.name} (${scale.size} notes)`, key, true);
          if (fretTuning) fretTuning.value = key;
        } catch (_) { localStorage.removeItem('orbkord.pitch'); }
      } else if (saved) {
        // Anyone left on 41- or 53-EDO's 12-key mode is on a setting that is
        // now known to be worse than 12-TET — those subsets come out
        // Pythagorean, thirds and all — so move them to the 1-key-per-step
        // mapping the tuning was always meant for rather than silently dropping
        // to a select with no matching option.
        const migrated = /^(41|53)$/.test(saved) ? `${saved}:linear` : saved;
        if (migrated !== saved) localStorage.setItem('orbkord.pitch', migrated);
        applyPitchTuning(migrated, true);
        if (fretTuning) fretTuning.value = `pitch:${migrated}`;
      }
    }
    // ------------------------------------------ Air Brass (blow into phone)
    // The brass soundfont behind a breath controller: a phone (paired via QR)
    // streams a 0..1 breath value (BreathLink), which drives the ExpressionBus
    // inserted after the synth's voiceBus — so every sounding voice, including
    // ALL harmonizer-generated notes, breathes together. Fully polyphonic;
    // this is expression, not an EWI-style mono emulation.
    const breathModal = $('breath-modal');
    const breathQrBox = $('breath-qr');
    const breathModalStatus = $('breath-modal-status');
    const breathCountdown = $('breath-countdown');
    const breathPill = $('breath-pill');
    const breathPillDot = $('breath-pill-dot');
    const breathPillFill = $('breath-pill-fill');
    let breathBus = null;       // ExpressionBus (created once, reused)
    let breathLink = null;      // active BreathLink session
    let breathVal = 1;          // neutral until the phone speaks
    let breathTimer = null;     // QR countdown interval
    const airbrassOn = () => soundSelect && soundSelect.value === 'air_brass';
    // Breath doubles as note-on velocity, so soft blowing also picks the soft
    // brass velocity layer (intra-note dynamics are the ExpressionBus' job).
    const breathVel = () => Math.max(1, Math.min(127, Math.round(30 + 97 * breathVal)));

    // Output limiter. Past roughly 0.6 a new note stacks velocity 127 + gain
    // 1.0 + drive 1.9 on top of whatever is already sounding, and the bus
    // clips on the attack. BREATH_CEIL is the loudest level that stays clean.
    //
    // This is a limiter, not a trim: everything below BREATH_KNEE passes
    // through untouched, and only KNEE..1 is compressed into KNEE..CEIL. Plain
    // scaling would have made soft playing quieter too (b^1.6 is already steep
    // down there); this way only the top is tamed, so blowing harder always
    // still does something — it just can no longer reach the clipping zone.
    //
    // Applies to touch mode as well, since both input modes arrive here.
    // 0.58 was safe but cost ~7.6 dB — too quiet to play. The headroom comes
    // back from DRIVE_MAX in expression.js instead: that was pushing the tanh
    // saturator hard on every attack, which is what the "clip impact" was.
    // Level lives here; harshness lives there.
    const BREATH_CEIL = 0.60;   // ← raise toward 1.0 for more level
    const BREATH_KNEE = 0.45;   // below this, no limiting at all
    const limitBreath = (b) => {
      b = Math.max(0, Math.min(1, b));
      if (b <= BREATH_KNEE) return b;
      return BREATH_KNEE + (b - BREATH_KNEE) *
             (BREATH_CEIL - BREATH_KNEE) / (1 - BREATH_KNEE);
    };

    function breathModalMsg(msg, cls = '') {
      if (!breathModalStatus) return;
      breathModalStatus.textContent = msg;
      breathModalStatus.className = `breath-status${cls ? ' ' + cls : ''}`;
    }

    function stopBreathCountdown() {
      if (breathTimer) { clearInterval(breathTimer); breathTimer = null; }
      if (breathCountdown) breathCountdown.textContent = '';
    }

    function startBreathCountdown(expiresAt) {
      stopBreathCountdown();
      const tick = () => {
        const left = Math.max(0, expiresAt - Date.now());
        const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
        breathCountdown.textContent = left > 0
          ? `Code expires in ${m}:${String(s).padStart(2, '0')}`
          : '';
        if (left <= 0) stopBreathCountdown();
      };
      tick();
      breathTimer = setInterval(tick, 1000);
    }

    async function startBreathSession() {
      const supabase = window.OrbkordSupabase;
      if (!supabase) { breathModalMsg('Connection unavailable reload the app.', 'err'); return; }
      if (breathLink) breathLink.stop();
      breathLink = new BreathLink({ supabase });
      breathLink.on('breath', (b) => {
        // Limit once, here, so note-on velocity and the expression bus agree.
        breathVal = limitBreath(b);
        if (breathBus) breathBus.setBreath(breathVal);
        // The meter still shows RAW breath — it is feedback on how hard you are
        // actually blowing, which is what you need to set mic sensitivity by.
        if (breathPillFill) breathPillFill.style.width = `${Math.round(b * 100)}%`;
      });
      breathLink.on('status', (s) => {
        if (s === 'waiting') {
          breathModalMsg('Waiting for phone…');
          breathPillDot.className = 'breath-pill-dot';
        } else if (s === 'connected') {
          breathModalMsg('Phone connected — blow to play.', 'ok');
          breathPillDot.className = 'breath-pill-dot ok';
          stopBreathCountdown();
          setTimeout(() => { if (breathLink && breathLink.status === 'connected') breathModal.hidden = true; }, 900);
        } else if (s === 'lost') {
          // Phone dropped mid-take: glide to neutral so the instrument keeps
          // playing like a normal soundfont instead of going silent.
          breathVal = BREATH_CEIL;   // neutral = loudest CLEAN, not full scale
          if (breathBus) breathBus.setBreath(BREATH_CEIL);
          breathModalMsg('Phone connection lost now waiting for it to return…', 'err');
          breathPillDot.className = 'breath-pill-dot warn';
        } else if (s === 'expired') {
          breathModalMsg('Code expired.', 'err');
          stopBreathCountdown();
        }
      });
      try {
        breathModalMsg('Starting session…');
        const { url, expiresAt } = await breathLink.start();
        const qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        breathQrBox.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0 });
        startBreathCountdown(expiresAt);
        if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
          breathModalMsg('Heads-up: phones can\'t reach localhost use the deployed site to pair.', 'err');
        }
      } catch (err) {
        console.warn('[airbrass] session start failed', err);
        breathModalMsg('Could not start a session — try New code.', 'err');
      }
    }

    function enterAirBrass() {
      if (!breathBus) {
        breathBus = new ExpressionBus(synth.ctx);
        pushBreathAttack();   // apply the saved attack/glide to the new bus
        pushBreathGlide();
      }
      breathVal = BREATH_CEIL;   // neutral until a phone speaks — clean, not clipping
      breathBus.setBreath(BREATH_CEIL);
      synth.setExpression(breathBus);
      breathPill.hidden = false;
      breathModal.hidden = false;
      startBreathSession();
    }

    function exitAirBrass() {
      synth.setExpression(null);
      if (breathLink) { breathLink.stop(); breathLink = null; }
      stopBreathCountdown();
      breathVal = 1;
      breathModal.hidden = true;
      breathPill.hidden = true;
    }

    // Attack + Glide are live sound-design controls: attack is how long each
    // note takes to swell in from silence (the anti-punch), glide is the
    // portamento into pitch from the previous chord. Persisted, and applied to
    // the bus the moment it exists.
    function wireBreathParam(id, key, def, apply) {
      const el = $(id), out = $(`${id}-val`);
      if (!el) return () => {};
      const saved = localStorage.getItem(key);
      if (saved !== null) el.value = saved;
      const push = () => {
        out.textContent = `${el.value} ms`;
        paintRange(el);
        if (breathBus) apply(breathBus, +el.value / 1000);
      };
      el.addEventListener('input', () => { localStorage.setItem(key, el.value); push(); });
      push();
      return push;
    }
    const pushBreathAttack = wireBreathParam('breath-attack', 'orbkord.breath.attack', 70,
      (bus, s) => bus.setAttack(s));
    const pushBreathGlide = wireBreathParam('breath-glide', 'orbkord.breath.glide', 50,
      (bus, s) => bus.setGlide(s));

    if ($('breath-close')) $('breath-close').addEventListener('click', () => { breathModal.hidden = true; });
    if ($('breath-regen')) $('breath-regen').addEventListener('click', () => startBreathSession());
    if (breathPill) breathPill.addEventListener('click', () => { breathModal.hidden = false; });

    // Sound source: built-in synth or a lazy-loaded SoundFont sample set.
    const soundSelect = $('sound-select');
    if (soundSelect) {
      soundSelect.addEventListener('change', async () => {
        const val = soundSelect.value;
        // Air Brass = the 'air_brass' sample set + breath control on top.
        const name = val === 'synth' ? null : val;
        soundSelect.disabled = true;
        soundSelect.classList.add('busy');
        try {
          await synth.setInstrument(name);
          if (val === 'airbrass') enterAirBrass(); else exitAirBrass();
        } catch (err) {
          console.warn('[sound] failed to load', name, err);
          soundSelect.value = 'synth';
          await synth.setInstrument(null);
          exitAirBrass();
        }
        soundSelect.disabled = false;
        soundSelect.classList.remove('busy');
      });
    }
    // Master volume — persisted across sessions.
    const volumeSlider = $('master-volume');
    if (volumeSlider) {
      const savedVol = localStorage.getItem('orbkord.volume');
      if (savedVol !== null) volumeSlider.value = savedVol;
      paintRange(volumeSlider);   // restored in code, so no 'input' fires
      synth.setVolume(+volumeSlider.value / 100);
      volumeSlider.addEventListener('input', () => {
        synth.setVolume(+volumeSlider.value / 100);
        localStorage.setItem('orbkord.volume', volumeSlider.value);
      });
    }
    const reverbSlider = document.getElementById('reverb-amount');

    if (reverbSlider) {
      const saved = localStorage.getItem('orbkord.reverb');

      if (saved !== null)
        reverbSlider.value = saved;

      paintRange(reverbSlider);   // restored in code, so no 'input' fires
      synth.setReverb(+reverbSlider.value);

      reverbSlider.addEventListener('input', () => {
        synth.setReverb(+reverbSlider.value);
        localStorage.setItem('orbkord.reverb', reverbSlider.value);
      });
    }
    // Light / dark theme — swaps the canvas palette (renderer) and the CSS chrome.
    if (btnTheme) {
      btnTheme.addEventListener('click', () => {
        state.theme = state.theme === 'dark' ? 'light' : 'dark';
        setCanvasTheme(state.theme);
        document.body.classList.toggle('light', state.theme === 'light');
        setBtn(btnTheme, state.theme === 'dark' ? 'sun' : 'moon',
                        state.theme === 'dark' ? 'Light' : 'Dark');
      });
    }
    btnLive.addEventListener('click', () => {
      if (playing) pause();
      if (exporting) finishExport();
      state.mode = 'live';
      state.chord = null;
      state.progression = null;
      lastSetKey = '';
      synth.resume();
    });
    // Harmoniser: toggle on/off; changing key/mode resets the voice-leading chain
    // and re-points the staff key signature.
    if (btnHarmonize) btnHarmonize.addEventListener('click', () => setHarmonize(!harmonizeOn));
    if (btnModeFree) btnModeFree.addEventListener('click', () => setHarmMode('free'));
    if (btnModeSeq) btnModeSeq.addEventListener('click', () => setHarmMode('sequencer'));
    // Any parameter change invalidates the ranked list; if a loop is playing,
    // re-harmonise on the spot so the change is heard immediately.
    const rerank = () => { packRanked = []; packPick = 0; if (looping && lastRec) harmoniseRecording(); };
    const onHarmKeyChange = () => {
      harmPrev = null;
      harmRecent.length = 0;
      // Unconditional: the staff signature follows the key whether or not
      // harmonise is armed, so the two selectors can never sit out of step.
      syncNotationKey(parseInt(harmKey.value, 10), harmMode.value);
      syncPitchKey();   // the 12-note microtonal subset follows the key
      rerank();   // key/mode change means the ranked progressions are stale
    };
    if (harmKey) harmKey.addEventListener('change', onHarmKeyChange);
    if (harmMode) harmMode.addEventListener('change', onHarmKeyChange);
    if (harmApproach) harmApproach.addEventListener('change', () => { harmPrev = null; harmRecent.length = 0; rerank(); });
    if (harmGrid) harmGrid.addEventListener('change', rerank);
    // Record button: idle → start count-in/record; otherwise stop everything.
    if (btnHarmRec) btnHarmRec.addEventListener('click', () => {
      if (recPhase === 'idle' && !looping) startHarmRecord();
      else { stopHarmRecord(); stop(); }
    });
    // Record Take: capture the free-harmonise performance as an editable MIDI loop.
    if (btnTake) btnTake.addEventListener('click', () => {
      if (takePhase === 'idle') startTake();
      else stopTake();
    });
    // ↻ Reroll: step to the next-best progression for the same recording.
    if (btnReroll) btnReroll.addEventListener('click', () => {
      if (!lastRec) { flashStatus('Record a sequence first.'); return; }
      packPick++;
      harmoniseRecording();
    });
    // Changing the sequencer source or mood re-ranks; style just re-comps; the
    // source also flips which secondary controls make sense (approach vs mood).
    if (harmSource) harmSource.addEventListener('change', () => { syncHarmUI(); rerank(); });
    if (harmMood) harmMood.addEventListener('change', rerank);
    if (harmStyle) harmStyle.addEventListener('change', () => { if (looping && lastRec) harmoniseRecording(); });
    // Clustering / bass changes re-voice a playing loop on the spot; in live
    // harmonise mode they simply apply to the next note (via harmCtx).
    const revoice = () => { if (looping && lastRec) harmoniseRecording(); };

    if (harmSpread) harmSpread.addEventListener('input', revoice);

    if (harmLowestMidi) {
      harmLowestMidi.addEventListener('input', () => {
        syncLowestLabel();
        revoice();
      });
    }

    // Isomorphic (harmonic table) keyboard toggle.
    if (btnIso) btnIso.addEventListener('click', () => {
      state.isoKeyboard = !state.isoKeyboard;
      btnIso.classList.toggle('on', state.isoKeyboard);
    });
    // Export the loaded / harmonised sequence as a .mid download.
    if (btnExportMidi) btnExportMidi.addEventListener('click', () => {
      if (!accessOk()) { flashStatus('Log in to use OrbKord.'); return; }
      if (!midiData) { flashStatus('Nothing to export — load or record something first.'); return; }
      // In a microtonal system the note numbers alone would import as plain
      // 12-TET, so the tuning goes along and the file is written as MPE.
      const bytes = MidiWriter.build(
        midiData.notes.map((n) => ({ midi: n.midi, start: n.start, end: n.end, velocity: n.velocity })),
        { bpm: midiData.bpm || 100, name: state.fileName || 'OrbKord', tuning: pitchScale });
      const blob = new Blob([bytes], { type: 'audio/midi' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (state.fileName || 'orbkord').replace(/\.midi?$/i, '').replace(/\s+/g, '_')
        + (pitchScale ? '_mpe' : '') + '.mid';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      flashStatus(pitchScale
        ? `Exported ${a.download} as MPE — set the track to MPE mode and the instrument's bend range to ±48.`
        : 'Exported ' + a.download);
    });
    // Key split: how the bassline is separated from the chord, and where.
    if (splitModeSel) splitModeSel.addEventListener('change', () => {
      state.splitMode = splitModeSel.value;
      if (state.splitMode === 'off') state.bassNote = null;
      lastSetKey = '';   // force a re-detect under the new setting
    });
    if (splitPointSel) splitPointSel.addEventListener('change', () => {
      state.splitPoint = parseInt(splitPointSel.value, 10);
      lastSetKey = '';
    });
    btnRecord.addEventListener('click', () => {
      state.recording ? stopRecording() : startRecording();
    });
    btnExport.addEventListener('click', () => {
      exporting ? (stop(), finishExport()) : startExport();
    });
    rateSel.addEventListener('change', () => {
      const wasPlaying = playing;
      if (playing) pause();
      playbackRate = parseFloat(rateSel.value);
      if (wasPlaying) play();
    });
    let seeking = false;
    seekBar.addEventListener('input', () => { seeking = true; });
    seekBar.addEventListener('change', () => {
      seeking = false;
      seekTo(parseFloat(seekBar.value));
    });

    // ------------------------------------------------------------ main loop
    function frame() {
      const nowMs = performance.now();

      if (recPhase !== 'idle') updateRecorder();
      if (takePhase !== 'idle') updateTake();
      // Header badge: make the current harmoniser mode unmissable.
      state.harmBadge = (recPhase !== 'idle' || takePhase !== 'idle') ? '● RECORDING'
                      : looping ? 'SEQUENCE LOOP'
                      : harmonizeOn ? 'FREE HARMONISE'
                      : state.harmMode === 'sequencer' ? 'SEQUENCER' : 'FREE PLAY';

      if (state.mode === 'file' && midiData) {
        const t = songTime();
        state.currentTime = Math.min(t, midiData.duration);
        if (!seeking) { seekBar.value = String(state.currentTime); paintRange(seekBar); }

        if (playing) {
          scheduleAudio(t);
          if (looping && t >= midiData.duration) {
            // Seamless loop: rewind the transport and re-arm the schedulers.
            startOffset = 0;
            startCtxTime = synth.ctx.currentTime;
            schedulePointer = 0;
            clickPointer = 0;
          } else if (!looping && t >= midiData.duration + 1.0) {
            if (exporting) {
              stop();               // stop() calls finishExport()
            } else {
              pause();
              startOffset = midiData.duration;
            }
          }
        }
        state.activeNotes = activeNotesAt(t);
        state.midiActivity = state.activeNotes.length > 0 && playing;
        updateChordDetection(state.activeNotes, nowMs);
      } else {
        state.activeNotes = refreshLiveActive();
        state.midiActivity = nowMs - lastActivity < 150 || state.activeNotes.length > 0;
        updateChordDetection(state.activeNotes, nowMs);
      }

      // Reset the voicing cycle whenever the detected chord changes.
      const chordName = state.chord ? state.chord.chordName : '';
      if (chordName !== lastVoicingChordName) { lastVoicingChordName = chordName; state.voicingIndex = 0; }

      // Effective key: during file playback it follows key-change keyframes.
      if (state.mode === 'file' && state.markers.length) {
        let k = state.baseKey;
        for (const m of state.markers) { if (m.time <= state.currentTime) k = m.key; else break; }
        state.keySignature = k;
      } else {
        state.keySignature = state.baseKey;
      }

      renderer.draw(state);
      requestAnimationFrame(frame);
    }

    initLiveMidi();
    requestAnimationFrame(frame);
  })();
