// chord-engine.js
// Faithful JS port of the Pattern-Based Interval Matching algorithm from
// midi-chord-detector-plugin (Source/chord_detection/detector/*).
// Constants, pattern database, scoring weights and ambiguity resolution
// mirror the C++ implementation exactly.

'use strict';

const ChordEngine = (() => {

  // ==========================================================================
  // CONSTANTS (ChordTypes.h)
  // ==========================================================================
  const PITCH_CLASS_COUNT = 12;
  const MAX_INTERVALS = 24;
  const MIN_NOTES = 2;
  const MIN_SCORE_THRESHOLD = 80.0;

  const NOTE_NAMES_SHARP = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const NOTE_NAMES_FLAT  = ['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];

  const DEGREE_MAP = {
    0:'R', 1:'♭9', 2:'9', 3:'♭3/♯9', 4:'3', 5:'11',
    6:'♭5/♯11', 7:'5', 8:'♯5/♭13', 9:'6/13', 10:'♭7',
    11:'7', 12:'R', 13:'♭9', 14:'9', 15:'♯9', 16:'m10',
    17:'11', 18:'♯11', 19:'m12', 20:'♭13', 21:'13',
    22:'m14', 23:'m15'
  };

  const VOICING = {
    Unknown: 'Unknown',
    Close: 'Close',
    Open: 'Open',
    Drop2: 'Drop 2',
    Drop3: 'Drop 3',
    Rootless: 'Rootless'
  };

  // ==========================================================================
  // PATTERN DATABASE (ChordPatterns.cpp)
  // [intervals, baseScore, required, optional, important, display, quality]
  // ==========================================================================
  const P = (intervals, baseScore, required, optional, important, display, quality) =>
    ({ intervals, baseScore, required, optional, important, display, quality });

  const PATTERNS = {
    // --- Triads ---
    'major':        P([0,4,7],100,[0,4,7],[],[4,7],'{root}','major'),
    'minor':        P([0,3,7],100,[0,3,7],[],[3,7],'{root}m','minor'),
    'diminished':   P([0,3,6],100,[0,3,6],[],[3,6],'{root}dim','diminished'),
    'augmented':    P([0,4,8],100,[0,4,8],[],[4,8],'{root}aug','augmented'),
    'sus2':         P([0,2,7],95,[0,2,7],[],[2,7],'{root}sus2','suspended'),
    'sus4':         P([0,5,7],95,[0,5,7],[],[5,7],'{root}sus4','suspended'),
    'power5':       P([0,7],80,[0,7],[],[7],'{root}5','power'),
    // --- Sevenths ---
    'major7':       P([0,4,7,11],115,[0,4,11],[7],[4,11],'{root}maj7','major'),
    'minor7':       P([0,3,7,10],115,[0,3,10],[7],[3,10],'{root}m7','minor'),
    'dominant7':    P([0,4,7,10],115,[0,4,10],[7],[4,10],'{root}7','dominant'),
    'diminished7':  P([0,3,6,9],115,[0,3,6,9],[],[3,6,9],'{root}dim7','diminished'),
    'half-diminished7': P([0,3,6,10],115,[0,3,6,10],[],[3,6,10],'{root}m7♭5','half-diminished'),
    'augmented7':   P([0,4,8,10],110,[0,4,8,10],[],[4,8,10],'{root}aug7','augmented'),
    'augmented-major7': P([0,4,8,11],110,[0,4,8,11],[],[4,8,11],'{root}+maj7','augmented'),
    'minor-major7': P([0,3,7,11],110,[0,3,11],[7],[3,11],'{root}m(maj7)','minor'),
    '7sus4':        P([0,5,7,10],108,[0,5,10],[7],[5,10],'{root}7sus4','suspended'),
    // --- Sixths ---
    'major6':       P([0,4,7,9],105,[0,4,9],[7],[4,9],'{root}6','major'),
    'minor6':       P([0,3,7,9],105,[0,3,9],[7],[3,9],'{root}m6','minor'),
    '6/9':          P([0,4,7,9,14],110,[0,4,9,14],[7],[4,9,14],'{root}6/9','major'),
    'minor6/9':     P([0,3,7,9,14],110,[0,3,9,14],[7],[3,9,14],'{root}m6/9','minor'),
    // --- Ninths ---
    'major9':       P([0,4,7,11,14],125,[0,4,11,14],[7],[4,11,14],'{root}maj9','major'),
    'minor9':       P([0,3,7,10,14],125,[0,3,10,14],[7],[3,10,14],'{root}m9','minor'),
    'dominant9':    P([0,4,7,10,14],125,[0,4,10,14],[7],[4,10,14],'{root}9','dominant'),
    'dominant7b9':  P([0,4,7,10,13],120,[0,4,10,13],[7],[4,10,13],'{root}7♭9','dominant'),
    'dominant7#9':  P([0,4,7,10,15],120,[0,4,10,15],[7],[4,10,15],'{root}7♯9','dominant'),
    'minor-major9': P([0,3,7,11,14],120,[0,3,11,14],[7],[3,11,14],'{root}m(maj9)','minor'),
    // --- Elevenths ---
    'major11':      P([0,4,7,11,14,17],130,[0,4,11,14,17],[7],[4,11,14,17],'{root}maj11','major'),
    'minor11':      P([0,3,7,10,14,17],130,[0,3,10,14,17],[7],[3,10,14,17],'{root}m11','minor'),
    'dominant11':   P([0,4,7,10,14,17],130,[0,4,10,14,17],[7],[4,10,14,17],'{root}11','dominant'),
    'dominant7#11': P([0,4,7,10,18],125,[0,4,10,18],[7],[4,10,18],'{root}7♯11','dominant'),
    'major7#11':    P([0,4,7,11,18],125,[0,4,11,18],[7],[4,11,18],'{root}maj7♯11','major'),
    'major9#11':    P([0,4,7,11,14,18],130,[0,4,11,14,18],[7],[4,11,14,18],'{root}maj9♯11','major'),
    'minor11b5':    P([0,3,6,10,14,17],125,[0,3,6,10,14,17],[],[3,6,10,14,17],'{root}m11♭5','half-diminished'),
    // --- Thirteenths ---
    'major13':      P([0,4,7,11,14,21],135,[0,4,11,21],[7,14],[4,11,21],'{root}maj13','major'),
    'minor13':      P([0,3,7,10,14,21],135,[0,3,10,21],[7,14],[3,10,21],'{root}m13','minor'),
    'dominant13':   P([0,4,7,10,14,21],135,[0,4,10,21],[7,14],[4,10,21],'{root}13','dominant'),
    'dominant13#11':P([0,4,7,10,18,21],135,[0,4,10,18,21],[7],[4,10,18,21],'{root}13♯11','dominant'),
    'dominant7b13': P([0,4,7,10,20],125,[0,4,10,20],[7],[4,10,20],'{root}7♭13','dominant'),
    'dominant13b9': P([0,4,7,10,13,21],130,[0,4,10,13,21],[7],[4,10,13,21],'{root}13♭9','dominant'),
    'dominant13#9': P([0,4,7,10,15,21],130,[0,4,10,15,21],[7],[4,10,15,21],'{root}13♯9','dominant'),
    // --- Altered dominants ---
    'dominant7b5':  P([0,4,6,10],118,[0,4,6,10],[],[4,6,10],'{root}7♭5','dominant'),
    'dominant7#5':  P([0,4,8,10],118,[0,4,8,10],[],[4,8,10],'{root}7♯5','dominant'),
    'dominant7b5b9':P([0,4,6,10,13],122,[0,4,6,10,13],[],[4,6,10,13],'{root}7♭5♭9','dominant'),
    'dominant7#5b9':P([0,4,8,10,13],122,[0,4,8,10,13],[],[4,8,10,13],'{root}7♯5♭9','dominant'),
    'dominant7b5#9':P([0,4,6,10,15],122,[0,4,6,10,15],[],[4,6,10,15],'{root}7♭5♯9','dominant'),
    'dominant7#5#9':P([0,4,8,10,15],122,[0,4,8,10,15],[],[4,8,10,15],'{root}7♯5♯9','dominant'),
    'altered':      P([0,4,6,10,13],120,[0,4,10],[6,8,13,15],[4,10],'{root}7alt','dominant'),
    'dominant7#5#9b13': P([0,4,8,10,15,20],128,[0,4,8,10,15,20],[],[4,8,10,15,20],'{root}7♯5♯9♭13','dominant'),
    'dominant9#11': P([0,4,7,10,14,18],130,[0,4,10,14,18],[7],[4,10,14,18],'{root}9♯11','dominant'),
    'dominant9b13': P([0,4,7,10,14,20],130,[0,4,10,14,20],[7],[4,10,14,20],'{root}9♭13','dominant'),
    'dominant7#9#11': P([0,4,7,10,15,18],128,[0,4,10,15,18],[7],[4,10,15,18],'{root}7♯9♯11','dominant'),
    'dominant7b9#11': P([0,4,7,10,13,18],128,[0,4,10,13,18],[7],[4,10,13,18],'{root}7♭9♯11','dominant'),
    'dominant7b9b13': P([0,4,7,10,13,20],128,[0,4,10,13,20],[7],[4,10,13,20],'{root}7♭9♭13','dominant'),
    'dominant7#9b13': P([0,4,7,10,15,20],128,[0,4,10,15,20],[7],[4,10,15,20],'{root}7♯9♭13','dominant'),
    // --- Add chords ---
    'add9':         P([0,4,7,14],105,[0,4,7,14],[],[4,7,14],'{root}add9','major'),
    'minor-add9':   P([0,3,7,14],105,[0,3,7,14],[],[3,7,14],'{root}m(add9)','minor'),
    'add11':        P([0,4,7,17],100,[0,4,7,17],[],[4,7,17],'{root}add11','major'),
    'add#11':       P([0,4,7,18],100,[0,4,7,18],[],[4,7,18],'{root}add♯11','major'),
    // --- Special ---
    'major7#5':     P([0,4,8,11],115,[0,4,8,11],[],[4,8,11],'{root}maj7♯5','augmented'),
    'minor7b5':     P([0,3,6,10],115,[0,3,6,10],[],[3,6,10],'{root}m7♭5','half-diminished'),
    'quartal':      P([0,5,10],90,[0,5,10],[],[5,10],'{root}quartal','quartal'),
    'quartal-7':    P([0,5,10,15],95,[0,5,10,15],[],[5,10,15],'{root}quartal7','quartal')
  };

  // Interval index for fast exact-match lookup (ChordPatterns::buildIntervalIndex)
  const INTERVAL_INDEX = new Map();
  for (const [type, pattern] of Object.entries(PATTERNS)) {
    const sig = [...new Set(pattern.intervals)].sort((a, b) => a - b).join(',');
    if (!INTERVAL_INDEX.has(sig)) INTERVAL_INDEX.set(sig, []);
    INTERVAL_INDEX.get(sig).push(type);
  }

  // ==========================================================================
  // NOTE UTILS (NoteUtils.h)
  // ==========================================================================
  const midiToPitchClass = (m) => ((m % 12) + 12) % 12;
  const intervalBetween = (from, to) => (to - from + 12) % 12;
  const getNoteName = (pc, preferSharp = true) => {
    const n = ((pc % 12) + 12) % 12;
    return preferSharp ? NOTE_NAMES_SHARP[n] : NOTE_NAMES_FLAT[n];
  };
  const getDegreeName = (interval) =>
    DEGREE_MAP[interval] !== undefined ? DEGREE_MAP[interval] : String(interval);
  const midiNoteLabel = (m) => getNoteName(midiToPitchClass(m)) + (Math.floor(m / 12) - 1);

  // ==========================================================================
  // VOICING ANALYZER (VoicingAnalyzer.cpp)
  // ==========================================================================
  function classifyVoicing(midiNotes) {
    if (midiNotes.length < 2) return VOICING.Unknown;
    const sorted = [...midiNotes].sort((a, b) => a - b);
    const span = sorted[sorted.length - 1] - sorted[0];
    if (span <= 12) return VOICING.Close;
    if (sorted.length >= 4) {
      const gaps = [];
      for (let i = 0; i < sorted.length - 1; i++) gaps.push(sorted[i + 1] - sorted[i]);
      if (gaps.length >= 2 && gaps[0] > 7) return VOICING.Drop2;
      if (gaps.length >= 3 && gaps[1] > 7) return VOICING.Drop3;
    }
    return VOICING.Open;
  }

  // ==========================================================================
  // SCORING (ChordScoring.cpp)
  // ==========================================================================
  function computeScore(intervals, pattern, bassPitchClass, potentialRoot, voicingType) {
    let score = pattern.baseScore;

    for (const req of pattern.required) {
      if (!intervals.includes(req)) return 0.0;
    }

    const intervalSet = new Set(intervals);
    const patternSet = new Set(pattern.intervals);

    // MASSIVE bonus for exact match
    const exact = intervalSet.size === patternSet.size &&
      [...intervalSet].every(i => patternSet.has(i));
    if (exact) score += 150.0;

    let requiredCount = 0;
    for (const i of intervals) if (pattern.required.includes(i)) requiredCount++;
    score += requiredCount * 30.0;

    let optionalCount = 0;
    for (const i of intervals) if (pattern.optional.includes(i)) optionalCount++;
    score += optionalCount * 10.0;

    if (bassPitchClass === potentialRoot) score += 25.0;

    let importantPresent = 0;
    for (const i of intervals) if (pattern.important.includes(i)) importantPresent++;
    score += importantPresent * 30.0;

    let matchedCount = 0;
    for (const i of intervals) if (patternSet.has(i)) matchedCount++;
    if (pattern.intervals.length > 0) {
      score += (matchedCount / pattern.intervals.length) * 80.0;
    }

    let extraCount = 0;
    for (const i of intervals) {
      if (!patternSet.has(i) && !pattern.optional.includes(i)) extraCount++;
    }
    score -= extraCount * 4.0;

    if (voicingType === VOICING.Rootless) score += 10.0;
    else if (voicingType === VOICING.Close) score += 5.0;

    if (!intervals.includes(0) && voicingType !== VOICING.Rootless) score -= 40.0;

    let hasThirdOrSus = false;
    for (const i of [2, 3, 4, 5]) {
      if (intervals.includes(i)) { hasThirdOrSus = true; break; }
    }
    if (!hasThirdOrSus) score -= 25.0;

    return score;
  }

  function computeConfidence(bestScore, secondBestScore, noteCount, exactMatch) {
    const marginConfidence = Math.min((bestScore - secondBestScore) / 100.0, 1.0);
    const absoluteConfidence = Math.min(bestScore / 250.0, 1.0);
    const noteConfidence = Math.min(noteCount / 6.0, 1.0);
    const exactConfidence = exactMatch ? 1.0 : 0.5;
    return 0.35 * marginConfidence +
           0.25 * absoluteConfidence +
           0.15 * noteConfidence +
           0.25 * exactConfidence;
  }

  // ==========================================================================
  // AMBIGUITY RESOLUTION (ChordDetector::resolveAmbiguity)
  // ==========================================================================
  function resolveAmbiguity(candidates, bassPitchClass) {
    if (candidates.length === 0) return null;
    if (candidates.length < 2) return candidates[0];

    const top = candidates[0];
    const second = candidates[1];
    if (top.score - second.score > 40.0) return top;

    const typeA = top.chordType, typeB = second.chordType;

    // C6 vs Am7 — whichever root matches the bass wins
    const isMajor6vsMinor7 = (typeA === 'major6' && typeB === 'minor7') ||
                             (typeA === 'minor7' && typeB === 'major6');
    if (isMajor6vsMinor7) {
      if (top.root === bassPitchClass) return top;
      if (second.root === bassPitchClass) return second;
      return typeA === 'major6' ? top : second;
    }

    // dim7 enharmonics — bass root wins
    if (typeA === 'diminished7' && typeB === 'diminished7') {
      if (top.root === bassPitchClass) return top;
      if (second.root === bassPitchClass) return second;
      return top;
    }

    // m6 vs m — prefer m6 when its root is the bass
    const isMinor6vsMinor = (typeA === 'minor6' && typeB === 'minor') ||
                            (typeA === 'minor' && typeB === 'minor6');
    if (isMinor6vsMinor) {
      const minor6cand = typeA === 'minor6' ? top : second;
      if (minor6cand.root === bassPitchClass) return minor6cand;
      return top;
    }

    return top;
  }

  // ==========================================================================
  // MAIN DETECTION (ChordDetector::detectChord)
  // ==========================================================================
  // slashMode: 'auto' | 'always' | 'never'
  function detectChord(midiNotes, slashMode = 'auto') {
    if (midiNotes.length < MIN_NOTES) return null;

    const sortedNotes = [...new Set(midiNotes)].sort((a, b) => a - b);
    const pitchClasses = sortedNotes.map(midiToPitchClass);
    const uniquePitchClasses = [...new Set(pitchClasses)].sort((a, b) => a - b);
    if (uniquePitchClasses.length < MIN_NOTES) return null;

    const bassPitchClass = pitchClasses[0];
    const voicingType = classifyVoicing(sortedNotes);
    const candidates = [];

    const buildCandidate = (root, chordType, pattern, intervals, score, vType, rootless) => {
      const c = {
        root,
        rootName: getNoteName(root),
        chordType,
        pattern: pattern.intervals,
        intervals,
        score,
        voicingType: vType,
        noteNumbers: sortedNotes,
        pitchClasses: uniquePitchClasses,
        quality: pattern.quality,
        position: '',
        chordName: '',
        degrees: intervals.map(getDegreeName),
        noteNames: pitchClasses.map(pc => getNoteName(pc)),
        confidence: 0
      };
      let slashNotation = '';
      if (rootless) {
        const bassName = getNoteName(bassPitchClass);
        c.position = 'Rootless/' + bassName;
        c.chordName = pattern.display.replace('{root}', c.rootName) + '/' + bassName;
        return c;
      }
      if (bassPitchClass === root) {
        c.position = 'Root Position';
      } else {
        const bassInterval = intervalBetween(root, bassPitchClass);
        const bassNoteName = getNoteName(bassPitchClass);
        const isStandardInversion = pattern.intervals.includes(bassInterval);
        let inversionName;
        if (bassInterval === 3 || bassInterval === 4) inversionName = '1st Inversion';
        else if (bassInterval >= 6 && bassInterval <= 8) inversionName = '2nd Inversion';
        else if (bassInterval >= 9 && bassInterval <= 11) inversionName = '3rd Inversion';
        else inversionName = 'Slash Chord';

        if (slashMode === 'always') {
          c.position = 'Slash/' + bassNoteName;
          slashNotation = '/' + bassNoteName;
        } else if (slashMode === 'never') {
          c.position = inversionName;
        } else {
          if (isStandardInversion) {
            c.position = inversionName + ' (/' + bassNoteName + ')';
            slashNotation = '/' + bassNoteName;
          } else {
            c.position = 'Slash/' + bassNoteName;
            slashNotation = '/' + bassNoteName;
          }
        }
      }
      c.chordName = pattern.display.replace('{root}', c.rootName) + slashNotation;
      return c;
    };

    const intervalsForRoot = (root, rootPresent) => {
      const intervals = [];
      for (const pc of uniquePitchClasses) {
        const interval = intervalBetween(root, pc);
        intervals.push(interval);
        if (sortedNotes.length > 3 && (!rootPresent || interval !== 0)) {
          const ext = interval + PITCH_CLASS_COUNT;
          if (ext <= MAX_INTERVALS) intervals.push(ext);
        }
      }
      return [...new Set(intervals)].sort((a, b) => a - b);
    };

    const candidateTypesFor = (intervals) => {
      const hit = INTERVAL_INDEX.get(intervals.join(','));
      return hit || Object.keys(PATTERNS);
    };

    // Pass 1: each present pitch class as potential root
    for (const potentialRoot of uniquePitchClasses) {
      const intervals = intervalsForRoot(potentialRoot, true);
      for (const chordType of candidateTypesFor(intervals)) {
        const pattern = PATTERNS[chordType];
        const score = computeScore(intervals, pattern, bassPitchClass, potentialRoot, voicingType);
        if (score > MIN_SCORE_THRESHOLD) {
          candidates.push(buildCandidate(potentialRoot, chordType, pattern, intervals, score, voicingType, false));
        }
      }
    }

    // Pass 2: rootless search — absent pitch classes as virtual roots
    const present = new Array(12).fill(false);
    for (const pc of uniquePitchClasses) present[pc] = true;
    for (let virtualRoot = 0; virtualRoot < 12; virtualRoot++) {
      if (present[virtualRoot]) continue;
      const intervals = intervalsForRoot(virtualRoot, false);
      for (const chordType of candidateTypesFor(intervals)) {
        const pattern = PATTERNS[chordType];
        const score = computeScore(intervals, pattern, bassPitchClass, virtualRoot, VOICING.Rootless);
        if (score > MIN_SCORE_THRESHOLD) {
          candidates.push(buildCandidate(virtualRoot, chordType, pattern, intervals, score, VOICING.Rootless, true));
        }
      }
    }

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => b.score - a.score);

    const best = candidates[0];
    const secondBestScore = candidates.length > 1 ? candidates[1].score : 0.0;
    const intervalSet = new Set(best.intervals);
    const patternSet = new Set(best.pattern);
    const exactMatch = intervalSet.size === patternSet.size &&
      [...intervalSet].every(i => patternSet.has(i));
    best.confidence = computeConfidence(best.score, secondBestScore, sortedNotes.length, exactMatch);

    let result = best;
    if (candidates.length > 1) {
      result = resolveAmbiguity(candidates.slice(0, 3), bassPitchClass);
      if (result !== best) {
        result.confidence = computeConfidence(result.score, secondBestScore, sortedNotes.length, exactMatch);
      }
    }
    return result;
  }

  return {
    detectChord,
    classifyVoicing,
    getNoteName,
    getDegreeName,
    midiToPitchClass,
    midiNoteLabel,
    PATTERNS,
    VOICING
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ChordEngine;
