// Web Audio engine: sample playback with pitch variance, stereo placement and a
// shared reverb send; procedural synth layers (gun thumps, enemy growls, UI);
// adaptive music with true per-track crossfades, gapless loops, and a
// low-pass that opens up in combat. Everything ends in a master limiter.
import type { Vec3 } from '../../../shared/math';
import { MusicEngine, type TrackId } from './music';

type SfxName = string;

const SFX_FILES: Record<string, string[]> = {
  revolver: ['revolver.mp3'],
  revolver_alt: ['revolver2.mp3'],
  shotgun: ['shotgun.mp3'],
  pump: ['shotgun_pump.mp3'],
  rocket: ['rocket.mp3'],
  explosion: ['explosion.mp3', 'explosion2.mp3'],
  explosion_small: ['explosion_crunch_0.ogg', 'explosion_crunch_1.ogg'],
  explosion_low: ['explosion_low.ogg'],
  coin: ['coin.mp3'],
  parry: ['parry.mp3'],
  whoosh: ['whoosh.mp3'],
  gore: ['gore.mp3'],
  flesh: ['flesh.mp3'],
  armor: ['armorhit.mp3'],
  glass: ['glass.mp3'],
  metal_heavy: [0, 1, 2, 3, 4].map((i) => `metal_heavy_${i}.ogg`),
  metal_light: [0, 1, 2, 3, 4].map((i) => `metal_light_${i}.ogg`),
  plate: [0, 1, 2, 3, 4].map((i) => `plate_heavy_${i}.ogg`),
  step: [0, 1, 2, 3, 4].map((i) => `step_${i}.ogg`),
  laser_large: ['laser_large.ogg'],
  laser_small: ['laser_small.ogg'],
  laser_retro: ['laser_retro.ogg'],
  forcefield: ['forcefield.ogg'],
  spawn: ['spawn.ogg'],
  thruster: ['thruster.ogg'],
  door: ['door.ogg'],
  clank: ['clank.ogg'],
  // creature vocals (Pixabay) — pitched per enemy, clipped to short barks
  growl: ['growl1.mp3', 'growl2.mp3', 'growl3.mp3', 'growl4.mp3'],
  scream: ['scream1.mp3'],
  roar: ['roar1.mp3'],
  edeath: ['death1.mp3', 'death2.mp3'],
  ping: ['ping.mp3'],
  ricochet: ['ricochet.mp3'],
};

// Every file is levelled on load so its loudest 50 ms sits here at volume 1; the source
// files span ~30 dB (explosions near 0 dB RMS, coins at -31), so without this the call-site
// volumes meant nothing. Boosts are capped so thin sounds don't drag noise up with them.
const SAMPLE_TARGET_DB = -14;
const MAX_BOOST_DB = 6;
const PEAK_CEIL_DB = -4; // a boost never pushes a sample's own peak past this
// Many source files are long takes (4-9 s); the game only wants the attack and a short tail.
const MAX_DUR: Record<string, number> = {
  revolver: 0.9, revolver_alt: 0.9, shotgun: 1.1, pump: 0.7, rocket: 1.0,
  explosion: 1.8, explosion_small: 1.0, explosion_low: 1.4, coin: 0.8, parry: 0.9,
  whoosh: 0.5, gore: 1.0, flesh: 0.6, armor: 0.6, glass: 1.2, laser_large: 0.7,
  forcefield: 0.7, spawn: 0.8, thruster: 0.9, growl: 0.8, scream: 0.5, roar: 1.6,
  edeath: 0.7, ping: 0.5, ricochet: 0.6,
};
// Overlapping copies of one sound: the oldest fades out when a new one would exceed this.
const MAX_VOICES = 3;
// Synth layers are raw oscillators at up to full scale; this seats them under the samples.
const SYNTH_TRIM = 0.18;

// Sliders are perceptual: gain = slider², so 50% is about -12 dB and 5% about -26 dB.
const taper = (v: number) => Math.max(0, Math.min(1, v)) ** 2;

export type MusicId = TrackId;

export interface PlayOpts {
  volume?: number;
  pitch?: number;
  variance?: number;
  at?: Vec3;
  maxDist?: number;
  reverb?: number; // send amount 0..1
  dur?: number; // cut the sample off (with a short fade) after this many seconds
  offset?: number; // start this far into the sample
}

type SynthKind = 'tick' | 'kill' | 'rankup' | 'jump' | 'land' | 'heal' | 'dash' | 'denied' | 'charge' | 'beep' | 'thump' | 'boom';

export class Audio {
  ctx: AudioContext;
  master: GainNode;
  sfxBus: GainNode;
  musicBus: GainNode;
  private synthBus: GainNode;
  private reverbSend: GainNode;
  private musicFilter: BiquadFilterNode;
  private buffers = new Map<string, { buf: AudioBuffer; gain: number }[]>();
  private music: MusicEngine;
  private listener = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  private recent = new Map<string, number>();
  private voices = new Map<string, { src: AudioBufferSourceNode; fade: GainNode }[]>();
  private noiseBuf: AudioBuffer;
  private musicVolume = 1;

  constructor() {
    this.ctx = new AudioContext();
    // mix -> safety limiter -> master volume -> out. The master slider sits AFTER the
    // limiter so turning it down is a clean attenuation; the limiter's automatic makeup
    // gain (Web Audio always applies some) is cancelled by the trim in front of it.
    const mix = this.ctx.createGain();
    mix.gain.value = 0.9;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    this.master = this.ctx.createGain();
    mix.connect(limiter).connect(this.master).connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(mix);
    this.synthBus = this.ctx.createGain();
    this.synthBus.gain.value = SYNTH_TRIM;
    this.synthBus.connect(this.sfxBus);
    // shared reverb: a short industrial room built from decaying noise. It returns into
    // the SFX bus so the effects slider turns the tails down with the sounds.
    const conv = this.ctx.createConvolver();
    conv.buffer = this.makeImpulse(1.6, 2.6);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.25;
    this.reverbSend.connect(conv).connect(this.sfxBus);

    this.musicBus = this.ctx.createGain();
    this.musicFilter = this.ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 20000;
    this.musicFilter.Q.value = 0.5;
    this.musicFilter.connect(this.musicBus);
    this.musicBus.connect(mix);
    // original soundtrack, composed + synthesised live (see music.ts); the engine's own
    // output level is modest so it sits under the gunfire instead of on top of it
    const musicOut = this.ctx.createGain();
    musicOut.gain.value = 1.1;
    musicOut.connect(this.musicFilter);
    const musicVerb = this.ctx.createConvolver();
    musicVerb.buffer = this.makeImpulse(2.8, 3.2); // a bigger, darker hall for the score
    const verbIn = this.ctx.createGain();
    verbIn.gain.value = 0.5;
    const verbLp = this.ctx.createBiquadFilter();
    verbLp.type = 'lowpass';
    verbLp.frequency.value = 4000;
    verbIn.connect(verbLp).connect(musicVerb).connect(musicOut);
    this.music = new MusicEngine(this.ctx, musicOut, verbIn);

    this.noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const len = Math.floor(this.ctx.sampleRate * seconds);
    const b = this.ctx.createBuffer(2, len, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay) * (i < 400 ? i / 400 : 1);
    }
    return b;
  }

  setVolumes(master: number, music: number, sfx: number): void {
    this.master.gain.value = taper(master);
    this.musicVolume = taper(music);
    this.musicBus.gain.value = this.musicVolume;
    this.sfxBus.gain.value = taper(sfx);
  }

  async loadAll(onProgress?: (f: number) => void): Promise<void> {
    const jobs: Promise<void>[] = [];
    let done = 0;
    const entries = Object.entries(SFX_FILES);
    const total = entries.reduce((n, [, f]) => n + f.length, 0);
    for (const [name, files] of entries) {
      const list: { buf: AudioBuffer; gain: number }[] = [];
      this.buffers.set(name, list);
      for (const f of files) {
        jobs.push(
          this.fetchBuffer(`/assets/sfx/${f}`)
            .then((b) => { if (b) list.push({ buf: b, gain: levelGain(b, MAX_DUR[name]) }); })
            .finally(() => onProgress?.(++done / total)),
        );
      }
    }
    await Promise.all(jobs);
  }

  private async fetchBuffer(url: string): Promise<AudioBuffer | null> {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      return await this.ctx.decodeAudioData(await res.arrayBuffer());
    } catch {
      return null;
    }
  }

  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  setListener(pos: Vec3, yaw: number): void {
    this.listener.pos = pos;
    this.listener.yaw = yaw;
  }

  play(name: SfxName, o: PlayOpts = {}): void {
    const list = this.buffers.get(name);
    if (!list || !list.length) return;
    const now = this.ctx.currentTime;
    const last = this.recent.get(name) ?? -1;
    if (now - last < 0.025) return;
    this.recent.set(name, now);
    const pick = list[Math.floor(Math.random() * list.length)];
    const src = this.ctx.createBufferSource();
    src.buffer = pick.buf;
    const variance = o.variance ?? 0.08;
    src.playbackRate.value = (o.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * variance);
    const g = this.ctx.createGain();
    let vol = (o.volume ?? 1) * pick.gain;
    let out: AudioNode = g;
    let rev = o.reverb ?? 0.25;
    if (o.at) {
      const dx = o.at.x - this.listener.pos.x, dy = o.at.y - this.listener.pos.y, dz = o.at.z - this.listener.pos.z;
      const dist = Math.hypot(dx, dy, dz);
      const max = o.maxDist ?? 60;
      if (dist > max) return;
      vol *= Math.max(0, 1 - dist / max) ** 1.4;
      rev = Math.min(0.9, rev + dist / max); // far sounds are wetter
      const pan = this.ctx.createStereoPanner();
      const rx = Math.cos(this.listener.yaw), rz = -Math.sin(this.listener.yaw);
      pan.pan.value = dist > 0.5 ? Math.max(-0.9, Math.min(0.9, (dx * rx + dz * rz) / dist)) : 0;
      g.connect(pan);
      out = pan;
    }
    g.gain.value = vol;
    const fade = this.ctx.createGain();
    src.connect(fade).connect(g);
    out.connect(this.sfxBus);
    if (rev > 0.01) {
      const send = this.ctx.createGain();
      send.gain.value = rev * vol;
      fade.connect(send).connect(this.reverbSend);
    }
    src.start(now, o.offset ?? 0);
    const dur = o.dur ?? MAX_DUR[name];
    if (dur) {
      fade.gain.setValueAtTime(1, now + dur * 0.6);
      fade.gain.linearRampToValueAtTime(0, now + dur);
      src.stop(now + dur + 0.02);
    }
    // voice cap: fade the oldest copy of this sound instead of stacking a wall of them
    const live = this.voices.get(name) ?? [];
    this.voices.set(name, live);
    live.push({ src, fade });
    src.onended = () => { const i = live.findIndex((v) => v.src === src); if (i >= 0) live.splice(i, 1); };
    if (live.length > MAX_VOICES) {
      const old = live.shift()!;
      old.fade.gain.cancelScheduledValues(now);
      old.fade.gain.setValueAtTime(old.fade.gain.value, now);
      old.fade.gain.linearRampToValueAtTime(0, now + 0.06);
      old.src.stop(now + 0.08);
    }
  }

  /** Procedural layers: gun thumps, UI, movement feedback. */
  synth(kind: SynthKind, vol = 1): void {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.connect(this.synthBus);
    const osc =(type: OscillatorType, f0: number, f1: number, dur: number, v: number, delay = 0) => {
      const o = this.ctx.createOscillator();
      const og = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t + delay);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + delay + dur);
      og.gain.setValueAtTime(v * vol, t + delay);
      og.gain.exponentialRampToValueAtTime(0.001, t + delay + dur);
      o.connect(og).connect(g);
      o.start(t + delay);
      o.stop(t + delay + dur + 0.02);
    };
    const noise = (dur: number, v: number, freq: number, q = 1, type: BiquadFilterType = 'bandpass') => {
      const s = this.ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      const f = this.ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const ng = this.ctx.createGain();
      ng.gain.setValueAtTime(v * vol, t);
      ng.gain.exponentialRampToValueAtTime(0.001, t + dur);
      s.connect(f).connect(ng).connect(g);
      s.start(t);
      s.stop(t + dur);
    };
    switch (kind) {
      case 'tick': osc('triangle', 2400, 1800, 0.05, 0.12); break;
      case 'kill': osc('sine', 110, 40, 0.2, 0.5); noise(0.12, 0.25, 900, 0.7); break;
      case 'rankup': [0, 0.07, 0.14].forEach((d, i) => osc('sawtooth', 220 * (1 + i * 0.5), 440 * (1 + i * 0.5), 0.14, 0.06, d)); break;
      case 'jump': noise(0.08, 0.18, 1400, 2); break;
      case 'land': osc('sine', 140, 50, 0.12, 0.45); noise(0.07, 0.2, 500, 1); break;
      case 'heal': osc('sine', 500, 900, 0.1, 0.1); break;
      case 'dash': noise(0.18, 0.35, 900, 0.8); break;
      case 'denied': osc('square', 180, 120, 0.1, 0.12); break;
      case 'charge': osc('sawtooth', 200, 1200, 0.5, 0.1); break;
      case 'beep': osc('square', 660, 660, 0.08, 0.1); break;
      case 'thump': osc('sine', 150, 42, 0.16, 0.9); noise(0.05, 0.4, 3000, 0.5, 'highpass'); break;
      case 'boom': osc('sine', 80, 25, 0.5, 1); noise(0.5, 0.6, 180, 0.6, 'lowpass'); break;
    }
  }

  /** A short monstrous vocal: formant-filtered sawtooth with vibrato (enemy barks). */
  growl(at: Vec3, pitch = 1, dur = 0.45, vol = 0.5): void {
    const dx = at.x - this.listener.pos.x, dz = at.z - this.listener.pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 50) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    const base = (70 + Math.random() * 30) * pitch;
    o.frequency.setValueAtTime(base * 1.4, t);
    o.frequency.exponentialRampToValueAtTime(base * 0.7, t + dur);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 18 + Math.random() * 10;
    const lfoG = this.ctx.createGain();
    lfoG.gain.value = base * 0.25;
    lfo.connect(lfoG).connect(o.frequency);
    const f1 = this.ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = 500 * pitch;
    f1.Q.value = 4;
    const f2 = this.ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = 1300 * pitch;
    f2.Q.value = 6;
    const g = this.ctx.createGain();
    const v = vol * Math.max(0, 1 - dist / 50);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(v, t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const pan = this.ctx.createStereoPanner();
    const rx = Math.cos(this.listener.yaw), rz = -Math.sin(this.listener.yaw);
    pan.pan.value = dist > 0.5 ? Math.max(-0.9, Math.min(0.9, (dx * rx + dz * rz) / dist)) : 0;
    o.connect(f1).connect(g);
    o.connect(f2).connect(g);
    g.connect(pan).connect(this.synthBus);
    const send = this.ctx.createGain();
    send.gain.value = 0.4;
    g.connect(send).connect(this.reverbSend);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  /** Crossfade to a piece of the procedural soundtrack. */
  async playMusic(id: MusicId | null, fade = 2): Promise<void> {
    this.music.play(id, fade);
  }

  /**
   * 0 = calm (pads only, slightly muffled) … 1 = full band. Stems fade in with
   * intensity, so the music builds with the fight instead of blasting constantly.
   */
  setIntensity(v: number): void {
    const x = Math.max(0, Math.min(1, v));
    this.music.setIntensity(x);
    const f = 2500 * Math.pow(20000 / 2500, Math.min(1, x * 1.6));
    this.musicFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.5);
  }

  /** Duck music briefly (big hits, parries). */
  duck(amount = 0.4, time = 0.25): void {
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(this.musicVolume * amount, t);
    this.musicBus.gain.linearRampToValueAtTime(this.musicVolume, t + time);
  }
}

/** Gain that brings the loudest 50 ms of the part the game actually plays to SAMPLE_TARGET_DB. */
function levelGain(b: AudioBuffer, maxDur?: number): number {
  const win = Math.floor(b.sampleRate * 0.05);
  const end = Math.min(b.length, maxDur ? Math.floor(b.sampleRate * maxDur) : b.length);
  const chans = [...Array(b.numberOfChannels)].map((_, c) => b.getChannelData(c));
  let loudest = 0, peak = 0;
  for (let s = 0; s + win <= end; s += win >> 1) {
    let sum = 0;
    for (const d of chans) for (let i = s; i < s + win; i++) { sum += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); }
    loudest = Math.max(loudest, sum / (win * chans.length));
  }
  if (loudest <= 0) return 1;
  let db = SAMPLE_TARGET_DB - 10 * Math.log10(loudest);
  // only boosts are limited; sharp transients that already reach the target are left alone
  if (db > 0) db = Math.min(db, MAX_BOOST_DB, Math.max(0, PEAK_CEIL_DB - 20 * Math.log10(peak)));
  return Math.pow(10, db / 20);
}
