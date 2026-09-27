// Web Audio engine: sample playback with pitch variance, stereo placement and a
// shared reverb send; procedural synth layers (gun thumps, enemy growls, UI);
// adaptive music with true per-track crossfades, gapless loops, and a
// low-pass that opens up in combat. Everything ends in a master limiter.
import type { Vec3 } from '../../../shared/math';

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
  blip: ['ui_blip.ogg'],
  door: ['door.ogg'],
  clank: ['clank.ogg'],
};

export const MUSIC = {
  menu: 'menu_dark_ambient.mp3',
  combat1: 'combat_heavy_industrial_metal.mp3',
  combat2: 'combat_industrial_jent_metal.mp3',
  boss: 'boss_runaway_breakcore.mp3',
} as const;
export type MusicId = keyof typeof MUSIC;

export interface PlayOpts {
  volume?: number;
  pitch?: number;
  variance?: number;
  at?: Vec3;
  maxDist?: number;
  reverb?: number; // send amount 0..1
}

type SynthKind = 'tick' | 'kill' | 'rankup' | 'jump' | 'land' | 'heal' | 'dash' | 'denied' | 'charge' | 'beep' | 'thump' | 'boom';

export class Audio {
  ctx: AudioContext;
  master: GainNode;
  sfxBus: GainNode;
  musicBus: GainNode;
  private reverbSend: GainNode;
  private musicFilter: BiquadFilterNode;
  private buffers = new Map<string, AudioBuffer[]>();
  private musicBuffers = new Map<string, AudioBuffer>();
  private musicLoads = new Map<string, Promise<void>>();
  private current: { id: MusicId; src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private wantMusic: MusicId | null = null;
  private listener = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  private recent = new Map<string, number>();
  private noiseBuf: AudioBuffer;
  private musicVolume = 1;

  constructor() {
    this.ctx = new AudioContext();
    // master chain: bus -> glue compressor -> brickwall-ish limiter -> out
    this.master = this.ctx.createGain();
    const glue = this.ctx.createDynamicsCompressor();
    glue.threshold.value = -14;
    glue.ratio.value = 4;
    glue.attack.value = 0.005;
    glue.release.value = 0.2;
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    this.master.connect(glue).connect(limiter).connect(this.ctx.destination);

    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
    // shared reverb: a short industrial room built from decaying noise
    const conv = this.ctx.createConvolver();
    conv.buffer = this.makeImpulse(1.6, 2.6);
    this.reverbSend = this.ctx.createGain();
    this.reverbSend.gain.value = 0.35;
    this.reverbSend.connect(conv).connect(this.master);

    this.musicBus = this.ctx.createGain();
    this.musicFilter = this.ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 20000;
    this.musicFilter.Q.value = 0.5;
    this.musicFilter.connect(this.musicBus);
    this.musicBus.connect(this.master);

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
    this.master.gain.value = master;
    this.musicVolume = music;
    this.musicBus.gain.value = music;
    this.sfxBus.gain.value = sfx;
  }

  async loadAll(onProgress?: (f: number) => void): Promise<void> {
    const jobs: Promise<void>[] = [];
    let done = 0;
    const entries = Object.entries(SFX_FILES);
    const total = entries.reduce((n, [, f]) => n + f.length, 0);
    for (const [name, files] of entries) {
      const list: AudioBuffer[] = [];
      this.buffers.set(name, list);
      for (const f of files) {
        jobs.push(
          this.fetchBuffer(`/assets/sfx/${f}`)
            .then((b) => { if (b) list.push(b); })
            .finally(() => onProgress?.(++done / total)),
        );
      }
    }
    await Promise.all(jobs);
    // stream every music track in the background so wave transitions never stall
    for (const id of Object.keys(MUSIC) as MusicId[]) void this.loadMusic(id);
  }

  loadMusic(id: MusicId): Promise<void> {
    let p = this.musicLoads.get(id);
    if (!p) {
      p = this.fetchBuffer(`/assets/music/${MUSIC[id]}`).then((b) => {
        if (b) this.musicBuffers.set(id, trimSilence(this.ctx, b));
      });
      this.musicLoads.set(id, p);
    }
    return p;
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
    const src = this.ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    const variance = o.variance ?? 0.08;
    src.playbackRate.value = (o.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * variance);
    const g = this.ctx.createGain();
    let vol = o.volume ?? 1;
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
    src.connect(g);
    out.connect(this.sfxBus);
    if (rev > 0.01) {
      const send = this.ctx.createGain();
      send.gain.value = rev * vol;
      src.connect(send).connect(this.reverbSend);
    }
    src.start();
  }

  /** Procedural layers: gun thumps, UI, movement feedback. */
  synth(kind: SynthKind, vol = 1): void {
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.connect(this.sfxBus);
    const osc = (type: OscillatorType, f0: number, f1: number, dur: number, v: number, delay = 0) => {
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
    g.connect(pan).connect(this.sfxBus);
    const send = this.ctx.createGain();
    send.gain.value = 0.4;
    g.connect(send).connect(this.reverbSend);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.05);
    lfo.stop(t + dur + 0.05);
  }

  /** Crossfade to a track; each track has its own gain so both can overlap. */
  async playMusic(id: MusicId | null, fade = 1.5): Promise<void> {
    if (id === this.wantMusic) return;
    this.wantMusic = id;
    const t = this.ctx.currentTime;
    const old = this.current;
    if (old) {
      old.gain.gain.cancelScheduledValues(t);
      old.gain.gain.setValueAtTime(old.gain.gain.value, t);
      old.gain.gain.linearRampToValueAtTime(0, t + fade);
      old.src.stop(t + fade + 0.05);
      this.current = null;
    }
    if (!id) return;
    await this.loadMusic(id);
    if (this.wantMusic !== id) return;
    const buf = this.musicBuffers.get(id);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = this.ctx.createGain();
    src.connect(gain).connect(this.musicFilter);
    const now = this.ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(id === 'menu' ? 0.75 : 0.6, now + fade);
    src.start();
    this.current = { id, src, gain };
  }

  /** 0 = calm (muffled), 1 = full intensity. Combat sits around 10 kHz+. */
  setIntensity(v: number): void {
    const x = Math.max(0, Math.min(1, v));
    const f = 500 * Math.pow(20000 / 500, x);
    this.musicFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.4);
  }

  /** Duck music briefly (big hits, parries). */
  duck(amount = 0.4, time = 0.25): void {
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    this.musicBus.gain.setValueAtTime(this.musicVolume * amount, t);
    this.musicBus.gain.linearRampToValueAtTime(this.musicVolume, t + time);
  }
}

/** Strip encoder padding/silence at both ends so loops are seamless. */
function trimSilence(ctx: AudioContext, b: AudioBuffer): AudioBuffer {
  const ch = b.getChannelData(0);
  const thr = 0.002;
  let s = 0;
  while (s < ch.length && Math.abs(ch[s]) < thr) s++;
  let e = ch.length - 1;
  while (e > s && Math.abs(ch[e]) < thr) e--;
  if (s === 0 && e === ch.length - 1) return b;
  const len = Math.max(1, e - s + 1);
  const out = ctx.createBuffer(b.numberOfChannels, len, b.sampleRate);
  for (let c = 0; c < b.numberOfChannels; c++) out.copyToChannel(b.getChannelData(c).subarray(s, s + len), c);
  return out;
}
