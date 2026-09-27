// Web Audio engine: sample playback with pitch variance and 3D panning, a few
// procedural synth sounds, and adaptive music (low-pass when calm, open in combat).
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
}

export class Audio {
  ctx: AudioContext;
  master: GainNode;
  sfxBus: GainNode;
  musicBus: GainNode;
  private musicFilter: BiquadFilterNode;
  private musicGain: GainNode;
  private buffers = new Map<string, AudioBuffer[]>();
  private musicBuffers = new Map<string, AudioBuffer>();
  private musicSrc: AudioBufferSourceNode | null = null;
  private musicId: MusicId | null = null;
  private listener = { pos: { x: 0, y: 0, z: 0 }, yaw: 0 };
  private recent = new Map<string, number>();
  private noiseBuf: AudioBuffer;

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -10;
    comp.ratio.value = 6;
    comp.connect(this.master);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(comp);
    this.musicBus = this.ctx.createGain();
    this.musicFilter = this.ctx.createBiquadFilter();
    this.musicFilter.type = 'lowpass';
    this.musicFilter.frequency.value = 20000;
    this.musicGain = this.ctx.createGain();
    this.musicGain.connect(this.musicFilter);
    this.musicFilter.connect(this.musicBus);
    this.musicBus.connect(this.master);
    this.noiseBuf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  private musicVolume = 1;

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
  }

  async loadMusic(id: MusicId): Promise<void> {
    if (this.musicBuffers.has(id)) return;
    const b = await this.fetchBuffer(`/assets/music/${MUSIC[id]}`);
    if (b) this.musicBuffers.set(id, b);
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
    // avoid machine-gunning identical samples in the same frame
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
    if (o.at) {
      const dx = o.at.x - this.listener.pos.x, dy = o.at.y - this.listener.pos.y, dz = o.at.z - this.listener.pos.z;
      const dist = Math.hypot(dx, dy, dz);
      const max = o.maxDist ?? 60;
      if (dist > max) return;
      vol *= Math.max(0, 1 - dist / max) ** 1.4;
      const pan = this.ctx.createStereoPanner();
      // project onto listener's right vector
      const rx = Math.cos(this.listener.yaw), rz = -Math.sin(this.listener.yaw);
      pan.pan.value = dist > 0.5 ? Math.max(-0.9, Math.min(0.9, (dx * rx + dz * rz) / dist)) : 0;
      g.connect(pan);
      out = pan;
    }
    g.gain.value = vol;
    src.connect(g);
    out.connect(this.sfxBus);
    src.start();
  }

  /** Short procedural sounds for UI and movement feedback. */
  synth(kind: 'tick' | 'kill' | 'rankup' | 'jump' | 'land' | 'heal' | 'dash' | 'denied' | 'charge' | 'beep', vol = 1): void {
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
    const noise = (dur: number, v: number, freq: number, q = 1) => {
      const s = this.ctx.createBufferSource();
      s.buffer = this.noiseBuf;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass';
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
      case 'tick': osc('square', 1800, 1200, 0.04, 0.12); break;
      case 'kill': osc('square', 900, 300, 0.12, 0.18); osc('sine', 120, 40, 0.18, 0.4); break;
      case 'rankup': [0, 0.06, 0.12].forEach((d, i) => osc('square', 440 * (1 + i * 0.26), 880 * (1 + i * 0.26), 0.12, 0.1, d)); break;
      case 'jump': noise(0.08, 0.18, 1400, 2); break;
      case 'land': osc('sine', 140, 50, 0.12, 0.45); noise(0.07, 0.2, 500, 1); break;
      case 'heal': osc('sine', 500, 900, 0.1, 0.12); break;
      case 'dash': noise(0.18, 0.35, 900, 0.8); break;
      case 'denied': osc('square', 180, 120, 0.1, 0.15); break;
      case 'charge': osc('sawtooth', 200, 1200, 0.5, 0.12); break;
      case 'beep': osc('square', 660, 660, 0.08, 0.12); break;
    }
  }

  async playMusic(id: MusicId | null, fade = 1.2): Promise<void> {
    if (id === this.musicId) return;
    this.musicId = id;
    const old = this.musicSrc;
    const t = this.ctx.currentTime;
    if (old) {
      this.musicGain.gain.cancelScheduledValues(t);
      this.musicGain.gain.setValueAtTime(this.musicGain.gain.value, t);
      this.musicGain.gain.linearRampToValueAtTime(0, t + fade * 0.5);
      setTimeout(() => { try { old.stop(); } catch { /* already stopped */ } }, fade * 500 + 50);
      this.musicSrc = null;
    }
    if (!id) return;
    await this.loadMusic(id);
    if (this.musicId !== id) return;
    const buf = this.musicBuffers.get(id);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.musicGain);
    const now = this.ctx.currentTime;
    this.musicGain.gain.cancelScheduledValues(now);
    this.musicGain.gain.setValueAtTime(0, now);
    this.musicGain.gain.linearRampToValueAtTime(id === 'menu' ? 0.7 : 0.55, now + fade);
    src.start();
    this.musicSrc = src;
  }

  /** 0 = calm (muffled), 1 = full intensity. */
  setIntensity(v: number): void {
    const f = 350 * Math.pow(20000 / 350, Math.max(0, Math.min(1, v)));
    this.musicFilter.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.4);
  }

  /** Duck everything briefly (big hits, parries). */
  duck(amount = 0.4, time = 0.25): void {
    const t = this.ctx.currentTime;
    this.musicBus.gain.cancelScheduledValues(t);
    const base = this.musicVolume;
    this.musicBus.gain.setValueAtTime(base * amount, t);
    this.musicBus.gain.linearRampToValueAtTime(base, t + time);
  }
}
