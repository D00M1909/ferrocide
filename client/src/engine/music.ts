// FERROCIDE's original soundtrack, composed and synthesised live with Web Audio.
//
// Four pieces in D minor, written in the spirit of ULTRAKILL-style arena music
// (industrial metal riffs, breakcore drums, choir pads, melancholic piano) but
// with no borrowed melodies or samples. Every piece is built from stems that the
// game fades in and out with intensity:
//   pad   – choir/strings, always present (tension between waves)
//   perc  – hats/shakers, comes in first
//   drums – kick/snare/breaks, the fight has started
//   bass  – distorted riff / reese, the fight is on
//   lead  – arps & melody, reserved for high style ranks and the boss
//
// A lookahead scheduler (Chris Wilson's "tale of two clocks") queues notes ~120 ms
// ahead so timing is sample-accurate regardless of frame rate.

export type TrackId = 'menu' | 'combat1' | 'combat2' | 'boss';
type Layer = 'pad' | 'perc' | 'drums' | 'bass' | 'lead';
const LAYERS: Layer[] = ['pad', 'perc', 'drums', 'bass', 'lead'];

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

interface Chord { root: number; tones: number[] } // midi root + semitone offsets

// chord helpers (offsets from root)
const MIN = [0, 3, 7];
const MAJ = [0, 4, 7];
const SUS = [0, 5, 7];

interface Piece {
  bpm: number;
  bars: Chord[]; // one chord per bar, loops
  step(ctx: StepCtx): void;
  thresholds: Record<Layer, number>; // intensity at which each stem fades in
  swing?: number;
}

interface StepCtx {
  t: number; // audio time of this 16th
  s: number; // step in bar 0..15
  bar: number; // absolute bar counter
  chord: Chord;
  next: Chord;
  dur16: number;
  inst: Instruments;
  rnd: () => number;
}

// ------------------------------------------------------------------ instruments

class Instruments {
  noise: AudioBuffer;
  private drive: WaveShaperNode['curve'];
  private softclip: WaveShaperNode['curve'];

  constructor(private ctx: AudioContext, public out: Record<Layer, AudioNode>, public delay: AudioNode, public verb: AudioNode) {
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.drive = makeCurve(18);
    this.softclip = makeCurve(3);
  }

  private env(g: GainNode, t: number, a: number, peak: number, decay: number, sustain = 0.0001, release = 0.05): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustain), t + a + decay);
    if (sustain > 0.0002) g.gain.exponentialRampToValueAtTime(0.0001, t + a + decay + release);
  }

  private noiseSrc(t: number, dur: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.start(t, Math.random() * 1.5);
    s.stop(t + dur + 0.02);
    return s;
  }

  kick(t: number, vel = 1, dest: AudioNode = this.out.drums): void {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(155, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    const g = this.ctx.createGain();
    this.env(g, t, 0.002, 0.7 * vel, 0.26);
    const ws = this.ctx.createWaveShaper();
    ws.curve = this.softclip;
    o.connect(ws).connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.4);
    // beater click
    const n = this.noiseSrc(t, 0.02);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3000;
    const ng = this.ctx.createGain();
    this.env(ng, t, 0.001, 0.25 * vel, 0.015);
    n.connect(hp).connect(ng).connect(dest);
  }

  snare(t: number, vel = 1, metal = false, dest: AudioNode = this.out.drums): void {
    const n = this.noiseSrc(t, 0.25);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = metal ? 2600 : 1700;
    bp.Q.value = 0.8;
    const ng = this.ctx.createGain();
    this.env(ng, t, 0.001, 0.55 * vel, metal ? 0.13 : 0.18);
    n.connect(bp).connect(ng).connect(dest);
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(210, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.08);
    const og = this.ctx.createGain();
    this.env(og, t, 0.001, 0.35 * vel, 0.08);
    o.connect(og).connect(dest);
    o.start(t);
    o.stop(t + 0.12);
    if (metal) {
      // clangy industrial ring
      const r = this.ctx.createOscillator();
      r.type = 'square';
      r.frequency.value = 540 + Math.random() * 40;
      const rg = this.ctx.createGain();
      this.env(rg, t, 0.001, 0.07 * vel, 0.09);
      r.connect(rg).connect(dest);
      r.start(t);
      r.stop(t + 0.12);
    }
    const send = this.ctx.createGain();
    send.gain.value = 0.25 * vel;
    ng.connect(send).connect(this.verb);
  }

  hat(t: number, vel = 1, open = false): void {
    const n = this.noiseSrc(t, open ? 0.25 : 0.06);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6200;
    const g = this.ctx.createGain();
    this.env(g, t, 0.001, 0.26 * vel, open ? 0.22 : 0.04);
    n.connect(hp).connect(g).connect(this.out.perc);
  }

  crash(t: number, vel = 1): void {
    const n = this.noiseSrc(t, 1.6);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4200;
    const g = this.ctx.createGain();
    this.env(g, t, 0.002, 0.2 * vel, 1.4);
    n.connect(hp).connect(g).connect(this.out.perc);
    const send = this.ctx.createGain();
    send.gain.value = 0.4;
    g.connect(send).connect(this.verb);
  }

  /** Distorted palm-muted-guitar-ish bass: twin saws → drive → envelope filter. */
  chug(t: number, midi: number, dur: number, vel = 1, open = false): void {
    const f = mtof(midi);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 1.5;
    lp.frequency.setValueAtTime(open ? 2400 : 1500, t);
    lp.frequency.exponentialRampToValueAtTime(open ? 900 : 260, t + (open ? dur : 0.09));
    const ws = this.ctx.createWaveShaper();
    ws.curve = this.drive;
    const g = this.ctx.createGain();
    this.env(g, t, 0.003, 0.26 * vel, Math.max(0.05, dur - 0.02), 0.0001);
    for (const det of [-9, 9]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(ws);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    // sub
    const sub = this.ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = f / 2;
    const sg = this.ctx.createGain();
    this.env(sg, t, 0.003, 0.13 * vel, dur);
    sub.connect(sg).connect(this.out.bass);
    sub.start(t);
    sub.stop(t + dur + 0.05);
    ws.connect(lp).connect(g).connect(this.out.bass);
  }

  /** Reese bass for the drum & bass sections: detuned saws, slow filter sweep. */
  reese(t: number, midi: number, dur: number, vel = 1): void {
    const f = mtof(midi);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 3;
    lp.frequency.setValueAtTime(260, t);
    lp.frequency.linearRampToValueAtTime(900, t + dur * 0.5);
    lp.frequency.linearRampToValueAtTime(320, t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, 0.02, 0.2 * vel, dur, 0.12 * vel, 0.08);
    for (const det of [-14, 0, 13]) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.12);
    }
    const sub = this.ctx.createOscillator();
    sub.frequency.value = f / 2;
    const sg = this.ctx.createGain();
    this.env(sg, t, 0.02, 0.15 * vel, dur, 0.1 * vel, 0.08);
    sub.connect(sg).connect(this.out.bass);
    sub.start(t);
    sub.stop(t + dur + 0.12);
    const ws = this.ctx.createWaveShaper();
    ws.curve = this.softclip;
    lp.connect(ws).connect(g).connect(this.out.bass);
  }

  /** Choir-ish pad: saw + triangle stack through two vowel formants. */
  choir(t: number, midis: number[], dur: number, vel = 1, vowel: 'ah' | 'oo' = 'ah'): void {
    const f1 = this.ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = vowel === 'ah' ? 760 : 380;
    f1.Q.value = 3;
    const f2 = this.ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = vowel === 'ah' ? 1180 : 900;
    f2.Q.value = 5;
    const g = this.ctx.createGain();
    const atk = Math.min(0.7, dur * 0.35);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.13 * vel, t + atk);
    g.gain.setValueAtTime(0.13 * vel, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 0.6);
    for (const m of midis) {
      for (const det of [-7, 6]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = det + (Math.random() - 0.5) * 4;
        const vib = this.ctx.createOscillator();
        vib.frequency.value = 4.5 + Math.random();
        const vg = this.ctx.createGain();
        vg.gain.value = 5;
        vib.connect(vg).connect(o.detune);
        o.connect(f1);
        o.connect(f2);
        o.start(t);
        vib.start(t);
        o.stop(t + dur + 0.7);
        vib.stop(t + dur + 0.7);
      }
    }
    f1.connect(g);
    f2.connect(g);
    g.connect(this.out.pad);
    const send = this.ctx.createGain();
    send.gain.value = 0.7;
    g.connect(send).connect(this.verb);
  }

  /** Dark string pad (menu / calm sections). */
  strings(t: number, midis: number[], dur: number, vel = 1): void {
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.09 * vel, t + Math.min(1.2, dur * 0.4));
    g.gain.setValueAtTime(0.09 * vel, t + dur - 0.05);
    g.gain.linearRampToValueAtTime(0.0001, t + dur + 1.2);
    for (const m of midis) {
      for (const det of [-10, 0, 9]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(m);
        o.detune.value = det;
        o.connect(lp);
        o.start(t);
        o.stop(t + dur + 1.3);
      }
    }
    lp.connect(g).connect(this.out.pad);
    const send = this.ctx.createGain();
    send.gain.value = 0.8;
    g.connect(send).connect(this.verb);
  }

  /** Soft felt-piano-ish tone for the melancholic motifs. */
  piano(t: number, midi: number, vel = 1, dest: AudioNode = this.out.lead): void {
    const f = mtof(midi);
    const g = this.ctx.createGain();
    this.env(g, t, 0.004, 0.16 * vel, 1.8);
    for (const [mult, amp, type] of [[1, 1, 'triangle'], [2, 0.35, 'sine'], [3, 0.12, 'sine']] as [number, number, OscillatorType][]) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = f * mult;
      const og = this.ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 2);
    }
    g.connect(dest);
    const send = this.ctx.createGain();
    send.gain.value = 0.6;
    g.connect(send).connect(this.verb);
    const d = this.ctx.createGain();
    d.gain.value = 0.3;
    g.connect(d).connect(this.delay);
  }

  /** Bright arp/lead: square through a resonant filter into the delay. */
  arp(t: number, midi: number, dur: number, vel = 1): void {
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = mtof(midi);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 6;
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + dur);
    const g = this.ctx.createGain();
    this.env(g, t, 0.003, 0.06 * vel, dur);
    o.connect(lp).connect(g).connect(this.out.lead);
    const d = this.ctx.createGain();
    d.gain.value = 0.45;
    g.connect(d).connect(this.delay);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Screaming saw lead for the boss melody. */
  scream(t: number, midi: number, dur: number, vel = 1): void {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(mtof(midi - 1), t);
    o.frequency.exponentialRampToValueAtTime(mtof(midi), t + 0.05);
    const vib = this.ctx.createOscillator();
    vib.frequency.value = 6;
    const vg = this.ctx.createGain();
    vg.gain.setValueAtTime(0, t);
    vg.gain.linearRampToValueAtTime(18, t + dur * 0.6);
    vib.connect(vg).connect(o.detune);
    const ws = this.ctx.createWaveShaper();
    ws.curve = this.softclip;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    const g = this.ctx.createGain();
    this.env(g, t, 0.02, 0.07 * vel, dur, 0.05 * vel, 0.12);
    o.connect(ws).connect(lp).connect(g).connect(this.out.lead);
    const d = this.ctx.createGain();
    d.gain.value = 0.3;
    g.connect(d).connect(this.delay);
    o.start(t);
    vib.start(t);
    o.stop(t + dur + 0.2);
    vib.stop(t + dur + 0.2);
  }

  /** Deep toll for the menu and boss intro. */
  bell(t: number, midi: number, vel = 1): void {
    const f = mtof(midi);
    const g = this.ctx.createGain();
    this.env(g, t, 0.003, 0.12 * vel, 3.5);
    for (const [ratio, amp] of [[1, 1], [2.76, 0.4], [5.4, 0.2]]) {
      const o = this.ctx.createOscillator();
      o.frequency.value = f * ratio;
      const og = this.ctx.createGain();
      og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 3.6);
    }
    g.connect(this.out.pad);
    const send = this.ctx.createGain();
    send.gain.value = 0.9;
    g.connect(send).connect(this.verb);
  }
}

function makeCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * amount) / Math.tanh(amount);
  }
  return c;
}

// ------------------------------------------------------------------ the pieces

const hit = (pattern: string, s: number) => pattern[s] === 'x' || pattern[s] === 'X';
const accent = (pattern: string, s: number) => pattern[s] === 'X';

/** "Ashes Over the Crucible" — menu. Tolling bells, strings, a lonely piano line. */
const MENU: Piece = {
  bpm: 66,
  bars: [
    { root: 50, tones: MIN }, { root: 46, tones: MAJ }, { root: 43, tones: MIN }, { root: 45, tones: MAJ },
    { root: 50, tones: MIN }, { root: 48, tones: MAJ }, { root: 46, tones: MAJ }, { root: 45, tones: SUS },
  ],
  thresholds: { pad: 0, perc: 2, drums: 2, bass: 0, lead: 0 },
  step({ t, s, bar, chord, dur16, inst, rnd }) {
    if (s === 0) {
      inst.strings(t, [chord.root - 12, chord.root + chord.tones[1], chord.root + chord.tones[2]], dur16 * 16);
      if (bar % 4 === 0) inst.bell(t, 38, 0.9);
    }
    // descending, hesitant piano motif
    const motif = [74, null, 72, null, 69, null, null, 70, null, 69, null, 65, null, null, 62, null];
    const m = motif[s];
    if (m !== null && (bar % 2 === 0 || s < 8) && rnd() < 0.85) inst.piano(t, m - (bar % 4 === 3 ? 1 : 0), 0.8);
  },
};

/** "Rivets and Marrow" — waves 1-4. Industrial metal: chugging D Phrygian riff. */
const COMBAT1: Piece = {
  bpm: 146,
  bars: [
    { root: 38, tones: MIN }, { root: 38, tones: MIN }, { root: 34, tones: MAJ }, { root: 36, tones: MAJ },
    { root: 38, tones: MIN }, { root: 39, tones: MAJ }, { root: 34, tones: MAJ }, { root: 33, tones: MAJ },
  ],
  thresholds: { pad: 0, perc: 0.12, drums: 0.3, bass: 0.42, lead: 0.74 },
  step({ t, s, bar, chord, dur16, inst, rnd }) {
    const section = Math.floor(bar / 8) % 2; // A / B
    const kick = section ? 'x.x.x..xx.x.x..x' : 'x..xx...x..x.x..';
    const snare = '....x.......x...';
    if (hit(kick, s)) inst.kick(t, 1);
    if (hit(snare, s)) inst.snare(t, 1, true);
    if (bar % 4 === 3 && s >= 12) inst.snare(t, 0.4 + (s - 12) * 0.15, true); // fill
    inst.hat(t, s % 4 === 2 ? 1 : 0.45, s % 8 === 6 && rnd() < 0.5);
    if (s === 0 && bar % 8 === 0) inst.crash(t);
    // the riff: palm-muted chugs with a flat-2 stab
    const riff = section ? 'XxX.xXx.XxX.x.X.' : 'Xx.xXx.xXx.xX.x.';
    const flat2 = s === 14 && bar % 2 === 1;
    if (hit(riff, s)) inst.chug(t, chord.root - 12 + (flat2 ? 1 : 0), dur16 * (accent(riff, s) ? 1.6 : 0.9), accent(riff, s) ? 1 : 0.8, accent(riff, s) && s % 8 === 0);
    if (s === 0) inst.choir(t, [chord.root + 12, chord.root + 12 + chord.tones[1], chord.root + 12 + chord.tones[2]], dur16 * 16, 0.8);
    // lead: rising minor arps over the top
    const arp = [0, 3, 7, 12, 7, 3, 10, 7];
    if (s % 2 === 0) inst.arp(t, chord.root + 36 + arp[(s / 2) % 8] - (chord.tones === MAJ ? 0 : 0), dur16 * 1.5, 0.9);
  },
};

/** "Saints of the Slag" — waves 5-7. Breakcore / drum & bass with choir and reese. */
const COMBAT2: Piece = {
  bpm: 172,
  bars: [
    { root: 38, tones: MIN }, { root: 34, tones: MAJ }, { root: 41, tones: MAJ }, { root: 36, tones: MAJ },
    { root: 38, tones: MIN }, { root: 34, tones: MAJ }, { root: 43, tones: MIN }, { root: 45, tones: MAJ },
  ],
  thresholds: { pad: 0, perc: 0.12, drums: 0.28, bass: 0.4, lead: 0.72 },
  step({ t, s, bar, chord, dur16, inst, rnd }) {
    // an amen-flavoured break, chopped and re-sequenced every few bars
    const breaks = ['x.x.......xx....', 'x.x.......x..x..', 'x...x.x...xx..x.', 'xx........x.x...'];
    const snares = ['....x..x.x..x..x', '....x..x.x.xx...', '....x.....x.x..x', '....x..xx...x.xx'];
    const pick = (bar * 7 + Math.floor(bar / 4)) % 4;
    const stutter = bar % 8 === 7 && s >= 8; // breakcore stutter roll at phrase ends
    if (stutter) {
      inst.snare(t, 0.5 + (s - 8) * 0.06);
      inst.snare(t + dur16 / 2, 0.4 + (s - 8) * 0.06);
    } else {
      if (hit(breaks[pick], s)) inst.kick(t, 0.95);
      if (hit(snares[pick], s)) inst.snare(t, s % 4 === 0 ? 1 : 0.55);
    }
    inst.hat(t, s % 2 ? 0.35 : 0.7, s === 14 && rnd() < 0.4);
    if (s === 0 && bar % 4 === 0) inst.crash(t, 0.8);
    // half-time reese: one long note per half bar
    if (s === 0 || s === 8) inst.reese(t, chord.root - 12 + (s === 8 && bar % 2 ? 7 : 0), dur16 * 8, 1);
    if (s === 0) inst.choir(t, [chord.root + 12, chord.root + 12 + chord.tones[1], chord.root + 12 + chord.tones[2], chord.root + 24], dur16 * 16, 1, bar % 2 ? 'oo' : 'ah');
    // falling piano cascade answers the choir
    const cascade = [24, 19, 15, 12, 19, 15, 12, 7];
    if (s % 2 === 0) inst.piano(t, chord.root + 24 + cascade[(s / 2) % 8] - 12, 0.7);
  },
};

/** "The Colossus Wakes" — boss. Andalusian cadence, double-time breaks, screaming lead. */
const BOSS: Piece = {
  bpm: 180,
  bars: [
    { root: 38, tones: MIN }, { root: 36, tones: MAJ }, { root: 34, tones: MAJ }, { root: 33, tones: MAJ },
    { root: 38, tones: MIN }, { root: 36, tones: MAJ }, { root: 34, tones: MAJ }, { root: 33, tones: [0, 4, 7, 10] },
  ],
  thresholds: { pad: 0, perc: 0.05, drums: 0.15, bass: 0.25, lead: 0.5 },
  step({ t, s, bar, chord, dur16, inst, rnd }) {
    const kick = bar % 2 ? 'x.x...x.x.x...x.' : 'x..x..x.x..x..x.';
    const snare = '....x.......x...';
    if (hit(kick, s)) inst.kick(t, 1);
    if (hit(snare, s)) inst.snare(t, 1, bar % 4 >= 2);
    if (bar % 4 === 3 && s >= 8) inst.snare(t + dur16 / 2, 0.35 + (s - 8) * 0.07, true);
    inst.hat(t, s % 2 ? 0.4 : 0.8);
    if (s === 0 && bar % 4 === 0) { inst.crash(t, 1); inst.bell(t, 26, 0.7); }
    // gallop chugs
    const gallop = 'Xx.Xx.Xx.Xx.Xxx.';
    if (hit(gallop, s)) inst.chug(t, chord.root - 12, dur16 * (accent(gallop, s) ? 1.4 : 0.8), accent(gallop, s) ? 1 : 0.75);
    if (s === 0) inst.choir(t, [chord.root + 12, chord.root + 12 + chord.tones[1], chord.root + 12 + chord.tones[2], chord.root + 24], dur16 * 16, 1.1);
    // the lead: a slow, anguished line over the storm
    const line = [[74, 8], [72, 4], [70, 4]];
    const phrase = bar % 4;
    if (phrase < 3) {
      let pos = 0;
      for (const [n, len] of line) {
        if (s === pos) inst.scream(t, n - phrase * 2 + (chord.tones.length === 4 ? 1 : 0), dur16 * len * 0.95, 1);
        pos += len;
      }
    } else if (s % 2 === 0) inst.arp(t, chord.root + 36 + [0, 4, 7, 10, 12, 10, 7, 4][(s / 2) % 8], dur16 * 1.2, 1);
    void rnd;
  },
};

const PIECES: Record<TrackId, Piece> = { menu: MENU, combat1: COMBAT1, combat2: COMBAT2, boss: BOSS };

// ------------------------------------------------------------------ engine

interface Playing {
  id: TrackId;
  piece: Piece;
  master: GainNode;
  layers: Record<Layer, GainNode>;
  inst: Instruments;
  nextTime: number;
  step: number;
  stopAt: number;
}

export class MusicEngine {
  private playing: Playing[] = [];
  private intensity = 0.3;
  private timer: ReturnType<typeof setInterval> | null = null;
  private seed = 1;

  constructor(private ctx: AudioContext, private out: AudioNode, private verb: AudioNode) {}

  private rnd = (): number => {
    this.seed = (this.seed * 16807) % 2147483647;
    return (this.seed - 1) / 2147483646;
  };

  play(id: TrackId | null, fade = 2): void {
    const now = this.ctx.currentTime;
    const cur = this.playing.find((p) => p.stopAt === Infinity);
    if (cur && cur.id === id) return;
    if (cur) {
      cur.master.gain.cancelScheduledValues(now);
      cur.master.gain.setValueAtTime(cur.master.gain.value, now);
      cur.master.gain.linearRampToValueAtTime(0, now + fade);
      cur.stopAt = now + fade;
    }
    if (!id) return;
    const piece = PIECES[id];
    const master = this.ctx.createGain();
    master.gain.setValueAtTime(0, now);
    master.gain.linearRampToValueAtTime(1, now + fade);
    master.connect(this.out);
    const layers = {} as Record<Layer, GainNode>;
    for (const l of LAYERS) {
      const g = this.ctx.createGain();
      g.gain.value = this.layerGain(piece, l);
      if (l === 'bass' || l === 'drums') {
        // tame the sub so the score doesn't turn to mud under the gunfire
        const hp = this.ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = l === 'bass' ? 38 : 32;
        const shelf = this.ctx.createBiquadFilter();
        shelf.type = 'lowshelf';
        shelf.frequency.value = 120;
        shelf.gain.value = -4;
        g.connect(hp).connect(shelf).connect(master);
      } else g.connect(master);
      layers[l] = g;
    }
    // tempo-synced dotted-eighth delay for arps and piano
    const delay = this.ctx.createDelay(2);
    delay.delayTime.value = (60 / piece.bpm) * 0.75;
    const fb = this.ctx.createGain();
    fb.gain.value = 0.32;
    const dlp = this.ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 2500;
    delay.connect(dlp).connect(fb).connect(delay);
    dlp.connect(layers.lead);
    const inst = new Instruments(this.ctx, layers, delay, this.verb);
    this.playing.push({ id, piece, master, layers, inst, nextTime: now + 0.12, step: 0, stopAt: Infinity });
    if (!this.timer) this.timer = setInterval(() => this.schedule(), 25);
  }

  /** 0 = calm (pads only) … 1 = everything. Stems fade in at their thresholds. */
  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
    const now = this.ctx.currentTime;
    for (const p of this.playing) {
      for (const l of LAYERS) p.layers[l].gain.setTargetAtTime(this.layerGain(p.piece, l), now, 0.6);
    }
  }

  private layerGain(piece: Piece, l: Layer): number {
    const th = piece.thresholds[l];
    if (th >= 1) return 0;
    const x = Math.max(0, Math.min(1, (this.intensity - th) / 0.12));
    // pads step back a little once the band kicks in
    if (l === 'pad') return 0.9 - Math.max(0, this.intensity - 0.4) * 0.5;
    const level = l === 'lead' ? 0.8 : l === 'perc' ? 0.7 : 1;
    return x * level;
  }

  private schedule(): void {
    const now = this.ctx.currentTime;
    for (const p of [...this.playing]) {
      if (now > p.stopAt + 0.5) {
        p.master.disconnect();
        this.playing.splice(this.playing.indexOf(p), 1);
        continue;
      }
      const dur16 = 60 / p.piece.bpm / 4;
      while (p.nextTime < now + 0.12 && p.nextTime < p.stopAt) {
        const s = p.step % 16;
        const bar = Math.floor(p.step / 16);
        const chord = p.piece.bars[bar % p.piece.bars.length];
        const next = p.piece.bars[(bar + 1) % p.piece.bars.length];
        try {
          p.piece.step({ t: p.nextTime, s, bar, chord, next, dur16, inst: p.inst, rnd: this.rnd });
        } catch (e) {
          console.warn('music step failed', e);
        }
        p.nextTime += dur16;
        p.step++;
      }
    }
    if (!this.playing.length && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
