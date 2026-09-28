// Client-side enemy presentation: re-skinned Quaternius models, animation state,
// interpolation, telegraph flashes, predicted deaths, gore, and hit testing.
import * as THREE from 'three';
import { ENEMIES, type EnemyKind } from '../../../shared/constants';
import { angleDiff, pointSegmentDist, raySphere, type Vec3 } from '../../../shared/math';
import { ENEMY_KINDS, ENEMY_STATES, type EnemySnap, type EnemyState, type GameEvent, type Snapshot } from '../../../shared/protocol';
import { instance, playClip, type ModelInstance, type ModelName } from '../engine/assets';
import type { Audio } from '../engine/audio';
import { COLORS, type FX } from './fx';

interface Skin {
  model: ModelName;
  hue: number;
  sat: number;
  bright: number;
  emissive?: number;
  rim: number;
  eyes: number; // glowing eye colour
  eyeSize: number;
  horns: number; // number of horn spikes (0 = none)
  bulk?: number; // non-uniform scale: widen the body
  metal?: boolean; // gib palette
  anims: Partial<Record<EnemyState | 'death' | 'idle' | 'leap' | 'hit', string[]>>;
  attackAnims?: Record<string, string[]>;
}

// Palette rule: the world is cold grey metal; enemies are bone/iron with hot red eyes
// and a red rim; saturated red is reserved for blood, yellow only for parryable shots.
const SKINS: Record<EnemyKind, Skin> = {
  husk: {
    model: 'enemy_large', hue: -2.25, sat: 0.12, bright: 1.2, rim: 0xff3020, eyes: 0xff2010, eyeSize: 0.22, horns: 2, bulk: 0.9,
    anims: { move: ['Run'], idle: ['Idle'], windup: ['Punch'], recover: ['Idle'], stun: ['HitReact'], death: ['Death'], leap: ['Jump'], spawn: ['Idle'], hit: ['HitReact'] },
  },
  eye: {
    model: 'enemy_small', hue: -2.3, sat: 0.35, bright: 1.05, emissive: 0x100000, rim: 0xff4020, eyes: 0xff3010, eyeSize: 0.3, horns: 3,
    anims: { move: ['Fast_Flying'], idle: ['Flying_Idle'], windup: ['Headbutt'], dive: ['Fast_Flying'], death: ['Death'], spawn: ['Flying_Idle'], stun: ['HitReact'] },
  },
  warden: {
    model: 'mech', hue: -2.05, sat: 0.14, bright: 0.8, rim: 0xff5a20, eyes: 0xff2a10, eyeSize: 0.35, horns: 0, metal: true,
    anims: { move: ['Walk'], idle: ['Idle'], windup: ['Shoot_Small'], recover: ['Idle'], stun: ['HitRecieve_1'], death: ['Death'], spawn: ['Idle'] },
  },
  drone: {
    model: 'robot_flying', hue: 0.3, sat: 0.1, bright: 0.95, rim: 0xff5a20, eyes: 0xff2010, eyeSize: 0.4, horns: 0, metal: true,
    anims: { move: ['Run'], idle: ['Idle'], windup: ['Shoot'], attack: ['Shoot'], death: ['Dead'], spawn: ['Idle'], stun: ['Idle'] },
  },
  brute: {
    model: 'enemy_large', hue: -2.0, sat: 0.3, bright: 0.55, emissive: 0x140202, rim: 0xff4a10, eyes: 0xff7a10, eyeSize: 0.45, horns: 4, bulk: 1.3,
    anims: { move: ['Walk'], idle: ['Idle'], recover: ['Idle'], death: ['Death'], spawn: ['Idle'], stun: ['HitReact'] },
    attackAnims: { smash: ['Punch'], stomp: ['Jump'], mortar: ['Weapon', 'Wave'] },
  },
  stalker: {
    // lean, near-black flanker with violet-white eyes (distinct from the bone husks)
    model: 'enemy_large', hue: -1.2, sat: 0.2, bright: 0.32, emissive: 0x0a0010, rim: 0xb040ff, eyes: 0xe0b0ff, eyeSize: 0.2, horns: 2, bulk: 0.75,
    anims: { move: ['Run'], idle: ['Idle'], windup: ['Punch'], recover: ['Idle'], stun: ['HitReact'], death: ['Death'], spawn: ['Idle'], hit: ['HitReact'] },
  },
  colossus: {
    model: 'mech', hue: -2.4, sat: 0.3, bright: 0.45, emissive: 0x2a0600, rim: 0xff6a10, eyes: 0xff8a10, eyeSize: 1.1, horns: 6, metal: true, bulk: 1.15,
    anims: { move: ['Walk'], idle: ['Idle'], recover: ['Idle'], beam: ['Shoot_Big'], death: ['Death'], spawn: ['Hello', 'Idle'] },
    attackAnims: { smash: ['Kick'], stomp: ['Jump_NoHeight', 'Jump'], mortar: ['Shoot_Big'], beam: ['Shoot_Big'], summon: ['Pickup', 'Yes'], ring: ['Shoot_Big'] },
  },
};

/** Vocal pitch per creature (metal enemies don't growl). */
const VOICE: Record<EnemyKind, number> = { husk: 1, eye: 1.8, warden: 1, drone: 1, brute: 0.55, colossus: 0.4, stalker: 1.35 };

const hornGeo = new THREE.ConeGeometry(0.5, 1, 4);
const hornMat = new THREE.MeshLambertMaterial({ color: 0x1a1614, emissive: 0x120200 });

const PARRYABLE_ATTACKS = new Set(['orb', 'mortar']);

export class EnemyView {
  inst: ModelInstance;
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  state: EnemyState = 'spawn';
  hp: number;
  predicted = 0; // damage we've dealt locally that the server hasn't confirmed yet
  predictedAt = 0;
  dead = false;
  deadT = 0;
  gibbed = false;
  flashT = 0;
  telegraphT = 0;
  telegraphDur = 0;
  telegraphColor = new THREE.Color();
  meleeTelegraph = false;
  blinkFx = 0;
  anim: THREE.AnimationAction | null = null;
  lockAnim = 0;
  spawnT = 0;
  lastSeen = 0;
  glow: THREE.Sprite;
  eyes: THREE.Sprite;
  headBone: THREE.Object3D | null = null;
  headWorld = new THREE.Vector3();
  headValid = false;
  horns = new THREE.Group();
  readonly skin: Skin;
  readonly def;

  constructor(public id: number, public kind: EnemyKind, scene: THREE.Scene, glowTex: THREE.Texture) {
    this.def = ENEMIES[kind];
    const skin = SKINS[kind];
    this.skin = skin;
    this.inst = instance(skin.model, {
      height: kind === 'eye' ? 1.0 : kind === 'drone' ? 1.2 : this.def.height,
      center: this.def.flying,
      hue: skin.hue,
      sat: skin.sat,
      bright: skin.bright,
      emissive: skin.emissive ? new THREE.Color(skin.emissive) : undefined,
      flashColor: new THREE.Color(1, 1, 1),
      rim: new THREE.Color(skin.rim).multiplyScalar(0.8),
      eyeless: skin.model === 'enemy_large' || skin.model === 'enemy_small',
    });
    if (skin.bulk) {
      this.inst.inner.scale.x *= skin.bulk;
      this.inst.inner.scale.z *= skin.bulk;
    }
    this.inst.inner.traverse((o) => { if (!this.headBone && /^head$/i.test(o.name)) this.headBone = o; });
    // hot glowing eyes (tracked to the head bone every frame)
    this.eyes = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: skin.eyes, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.eyes.scale.set(skin.eyeSize * 2.2, skin.eyeSize, 1);
    scene.add(this.eyes);
    // horn spikes on the skull
    for (let i = 0; i < skin.horns; i++) {
      const h = new THREE.Mesh(hornGeo, hornMat);
      const side = i % 2 === 0 ? 1 : -1;
      const row = Math.floor(i / 2);
      const sz = this.def.height * (this.def.flying ? 0.5 : 0.23);
      h.scale.set(sz * 0.35, sz * (1.4 - row * 0.25), sz * 0.35);
      h.position.set(side * sz * (0.45 + row * 0.25), sz * 0.35, sz * (0.1 + row * 0.35));
      h.rotation.set(-0.35 - row * 0.3, 0, -side * 0.45);
      this.horns.add(h);
    }
    scene.add(this.horns);
    this.hp = this.def.hp;
    scene.add(this.inst.root);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0, fog: false }));
    this.glow.scale.setScalar(this.def.heavy ? 3 : 1.6);
    this.inst.root.add(this.glow);
    this.glow.position.y = this.def.flying ? 0 : this.def.headY;
    this.play('spawn');
  }

  play(key: EnemyState | 'death' | 'idle' | 'leap' | 'hit', attack = '', once = false, speed = 1): void {
    const skin = SKINS[this.kind];
    const names = (attack && skin.attackAnims?.[attack]) || skin.anims[key] || skin.anims.idle || [];
    this.anim = playClip(this.inst, names, { current: this.anim, loop: !once, restart: once, speed, fade: 0.12 });
  }

  /** Centre of mass in world space. */
  centre(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.pos.x, this.pos.y + (this.def.flying ? 0 : this.def.height * 0.5), this.pos.z);
  }

  /** Head position: the animated head bone when available, so headshots match the visuals. */
  headPos(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.headValid && !this.def.flying) return out.copy(this.headWorld);
    return out.set(this.pos.x, this.pos.y + (this.def.flying ? 0 : this.def.headY), this.pos.z);
  }

  get alive(): boolean {
    return !this.dead;
  }

  get effectiveHp(): number {
    return this.hp - this.predicted;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.inst.root);
    scene.remove(this.eyes);
    scene.remove(this.horns);
    (this.eyes.material as THREE.Material).dispose();
    this.inst.mixer?.stopAllAction();
  }
}

export interface EnemyHit {
  view: EnemyView;
  dist: number;
  head: boolean;
  point: Vec3;
}

export class Enemies {
  views = new Map<number, EnemyView>();
  private glowTex: THREE.Texture;
  private tmp = new THREE.Vector3();
  onLocalKill: ((v: EnemyView, how: string) => void) | null = null;

  constructor(private scene: THREE.Scene, private fx: FX, private audio: Audio, private selfId: () => string, glowTex: THREE.Texture) {
    this.glowTex = glowTex;
  }

  private ensure(id: number, kind: EnemyKind, p: Vec3): EnemyView {
    let v = this.views.get(id);
    if (!v) {
      v = new EnemyView(id, kind, this.scene, this.glowTex);
      v.pos.set(p.x, p.y, p.z);
      v.inst.root.position.copy(v.pos);
      this.views.set(id, v);
    }
    return v;
  }

  applySnapshot(a: Snapshot, b: Snapshot, t: number, now: number, staleAfter = 1.5): void {
    const prev = new Map<number, EnemySnap>();
    for (const e of a.e) prev.set(e[0], e);
    for (const e of b.e) {
      const kind = ENEMY_KINDS[e[1]];
      const v = this.ensure(e[0], kind, { x: e[2], y: e[3], z: e[4] });
      v.lastSeen = now;
      if (v.dead) continue;
      const p = prev.get(e[0]) ?? e;
      const nx = p[2] + (e[2] - p[2]) * t, ny = p[3] + (e[3] - p[3]) * t, nz = p[4] + (e[4] - p[4]) * t;
      v.vel.set(e[2] - p[2], e[3] - p[3], e[4] - p[4]).multiplyScalar(b.t - a.t > 0 ? 1 / (b.t - a.t) : 0);
      v.pos.set(nx, ny, nz);
      v.yaw = p[5] + angleDiff(p[5], e[5]) * t;
      const st = ENEMY_STATES[e[6]];
      if (e[7] < v.hp) {
        // server confirmed damage: retire that much of our prediction
        v.predicted = Math.max(0, v.predicted - (v.hp - e[7]));
      }
      v.hp = e[7];
      if (st !== v.state) this.onState(v, st);
    }
    // enemies gone from the latest snapshot without a kill event (reset, kamikaze cleanup)
    for (const v of this.views.values()) {
      if (!v.dead && now - v.lastSeen > staleAfter) {
        v.dispose(this.scene);
        this.views.delete(v.id);
      }
    }
  }

  private onState(v: EnemyView, st: EnemyState): void {
    const was = v.state;
    v.state = st;
    if (v.lockAnim > 0 && st !== 'stun') return;
    if (st === 'move') v.play('move');
    else if (st === 'recover') v.play('recover');
    else if (st === 'stun') v.play('stun', '', true);
    else if (st === 'dive') v.play('dive', '', false, 2);
    else if (st === 'beam') v.play('beam', 'beam');
    else if (st === 'attack' && was !== 'attack') v.play('attack', '', false);
  }

  onEvent(e: GameEvent, now: number): void {
    const me = this.selfId();
    switch (e.t) {
      case 'spawn': {
        const v = this.ensure(e.id, e.k, { x: e.p[0], y: e.p[1], z: e.p[2] });
        v.lastSeen = now;
        v.spawnT = 1;
        const c = v.centre();
        const big = ENEMIES[e.k].heavy;
        this.fx.magic(c, big ? 60 : 24, COLORS.hostile, big ? 8 : 4, big ? 1 : 0.5);
        this.fx.glow(c, big ? 8 : 3.5, COLORS.hostile, 0.5);
        this.fx.flashLight(c, 0xff2010, big ? 10 : 5, big ? 30 : 14, 0.6);
        this.fx.tracer({ x: c.x, y: c.y + 40, z: c.z }, { x: c.x, y: v.pos.y, z: c.z }, 0xff3020, big ? 0.9 : 0.35, 0.5);
        this.audio.play('spawn', { at: c, volume: big ? 1.2 : 0.7, pitch: big ? 0.6 : 1 });
        if (!SKINS[e.k].metal) this.audio.play(big ? 'roar' : 'growl', { at: c, pitch: VOICE[e.k], volume: big ? 1 : 0.55, dur: big ? 1.6 : 0.8, reverb: 0.4 });
        if (big) this.fx.shake(0.4);
        break;
      }
      case 'dmg': {
        const v = this.views.get(e.id);
        if (!v || v.dead) break;
        v.flashT = 0.08;
        if (e.by !== me) {
          const c = v.centre();
          this.fx.blood(c, 6, null, 5);
        }
        break;
      }
      case 'kill': {
        const v = this.views.get(e.id);
        if (!v) break;
        if (!v.dead) this.kill(v, e.how, e.by === me);
        break;
      }
      case 'atk': {
        const v = this.views.get(e.id);
        if (!v || v.dead) break;
        const parry = PARRYABLE_ATTACKS.has(e.a);
        v.telegraphT = v.telegraphDur = e.dur;
        v.meleeTelegraph = e.a === 'swipe' || e.a === 'smash' || e.a === 'slash';
        if (e.a === 'blink') {
          // vanish in a violet burst at the old spot; reappear at the new one
          const from = e.target ? { x: e.target[0], y: e.target[1] + 1, z: e.target[2] } : v.centre();
          this.fx.magic(from, 26, COLORS.purple, 5, 0.5);
          this.fx.glow(from, 2.5, COLORS.purple, 0.25);
          this.audio.play('forcefield', { at: from, volume: 0.9, pitch: 1.8 });
          v.blinkFx = 0.25;
          break;
        }
        v.telegraphColor.set(parry ? 0xfff2a0 : e.a === 'beam' ? 0xff2020 : 0xff6a20);
        if (e.a === 'leap') v.play('leap', '', true);
        else {
          const key: EnemyState = 'windup';
          v.play(key, e.a, true, Math.max(0.6, 1 / Math.max(0.3, e.dur)) * 0.6);
          v.lockAnim = e.dur;
        }
        const head = v.headPos();
        if (e.a === 'orb' || e.a === 'mortar') this.audio.play('forcefield', { at: head, volume: 0.6, pitch: 1.3 });
        else if (e.a === 'beam' || e.a === 'summon') this.audio.play('laser_large', { at: head, volume: 1, pitch: 0.5 });
        else if (e.a === 'stomp') this.audio.play('metal_heavy', { at: head, volume: 0.8, pitch: 0.6 });
        else if (e.a === 'burst') this.audio.play('laser_retro', { at: head, volume: 0.5, pitch: 1.6 });
        else this.audio.play('whoosh', { at: head, volume: 0.5, pitch: 0.7 });
        if (!v.skin.metal && (e.a === 'swipe' || e.a === 'smash' || e.a === 'slash' || e.a === 'dive' || e.a === 'stomp' || e.a === 'leap')) {
          this.audio.play(e.a === 'dive' || e.a === 'slash' ? 'scream' : 'growl', { at: head, pitch: VOICE[v.kind] * 1.1, volume: 0.6, dur: 0.5, offset: 0.05 });
        }
        break;
      }
      case 'mparry': {
        const v = this.views.get(e.id);
        if (!v) break;
        v.telegraphT = 0;
        v.lockAnim = 0;
        v.play('stun', '', true);
        const h = v.headPos();
        this.fx.sparks(h, 40, 12, COLORS.parry, 0.14);
        this.fx.glow(h, 3, COLORS.parry, 0.2);
        this.fx.blood(h, 20, null, 8);
        break;
      }
      case 'stun': {
        const v = this.views.get(e.id);
        if (!v) break;
        v.telegraphT = 0;
        v.lockAnim = 0;
        const h = v.headPos();
        this.fx.sparks(h, 20, 9, COLORS.white);
        this.audio.play('clank', { at: h, volume: 0.9 });
        break;
      }
      case 'enrage': {
        const v = this.views.get(e.id);
        if (!v) break;
        for (const m of v.inst.materials) (m as THREE.MeshLambertMaterial).emissive?.setHex(0x601000);
        this.fx.explosion(v.headPos(), 4, COLORS.hostile);
        this.fx.shake(0.8);
        break;
      }
    }
  }

  /** Visual death. Local predicted kills call this immediately; others on the server event. */
  kill(v: EnemyView, how: string, mine: boolean): void {
    if (v.dead) return;
    v.dead = true;
    v.deadT = 0;
    v.telegraphT = 0;
    v.eyes.visible = false;
    v.horns.visible = false;
    const c = v.centre();
    const heavy = v.def.heavy;
    const gib = how === 'explosion' || how === 'rocket' || how === 'core' || how === 'parry' || how === 'slam' || v.kind === 'eye' || (how === 'shotgun' && Math.random() < 0.6);
    this.fx.blood(c, heavy ? 80 : 30, null, heavy ? 14 : 9);
    this.fx.bloodMist(c, heavy ? 14 : 6, heavy ? 2.5 : 1);
    this.fx.splatter(c, heavy ? 16 : 6, heavy ? 8 : 4, heavy ? 3 : 1.4);
    this.audio.play('gore', { at: c, volume: heavy ? 1.3 : 0.9, pitch: heavy ? 0.7 : 1 });
    if (!v.skin.metal) this.audio.play(heavy ? 'roar' : 'edeath', { at: c, pitch: VOICE[v.kind] * (heavy ? 0.8 : 1.2), volume: heavy ? 1 : 0.6, dur: heavy ? 1.8 : 0.7 });
    if (v.kind === 'drone' || v.kind === 'warden' || v.kind === 'colossus') {
      this.fx.explosion(c, heavy ? 6 : 2.2);
      this.fx.sparks(c, 30, 12);
      this.audio.play(heavy ? 'explosion' : 'explosion_small', { at: c, volume: 0.9 });
    }
    if (gib || heavy) {
      v.gibbed = true;
      this.fx.gibBurst(c, heavy ? 40 : 16, heavy ? 16 : 10, heavy ? 0.5 : 0.24, v.skin.metal ? 'metal' : 'flesh');
      v.inst.root.visible = false;
      v.eyes.visible = false;
      v.horns.visible = false;
    } else {
      v.play('death', '', true, 1.3);
    }
    if (mine) this.onLocalKill?.(v, how);
  }

  /** Record local damage; returns true if this hit is predicted to kill. */
  predictDamage(v: EnemyView, dmg: number, now: number): boolean {
    v.predicted += dmg;
    v.predictedAt = now;
    v.flashT = 0.07;
    return v.effectiveHp <= 0;
  }

  update(dt: number, now: number): void {
    for (const v of this.views.values()) {
      v.inst.mixer?.update(dt);
      v.lockAnim = Math.max(0, v.lockAnim - dt);
      if (v.lockAnim === 0 && v.anim && !v.dead && v.anim.getClip() && !v.anim.isRunning() && v.state !== 'stun') {
        this.onState(v, v.state === 'windup' ? 'move' : v.state);
      }
      // predicted damage that never got confirmed expires (missed packet / disagreement)
      if (v.predicted > 0 && now - v.predictedAt > 1.2) v.predicted = 0;
      if (v.dead) {
        v.deadT += dt;
        if (!v.gibbed && v.deadT > 1.4) v.inst.root.position.y -= dt * 1.2;
        if (v.deadT > 3) {
          v.dispose(this.scene);
          this.views.delete(v.id);
        }
        continue;
      }
      v.inst.root.position.copy(v.pos);
      if (v.def.flying) v.inst.root.position.y += Math.sin(now * 3 + v.id) * 0.08;
      v.inst.root.rotation.y = v.yaw + Math.PI;
      // track eyes + horns to the animated head
      if (v.headBone) {
        v.inst.root.updateMatrixWorld(true);
        v.headBone.getWorldPosition(v.headWorld);
        v.headValid = true;
      } else {
        v.headWorld.set(v.pos.x, v.pos.y + (v.def.flying ? 0 : v.def.headY), v.pos.z);
      }
      const hfx = -Math.sin(v.yaw), hfz = -Math.cos(v.yaw);
      const hs = v.def.flying ? v.def.radius : v.def.headR;
      v.eyes.position.set(v.headWorld.x + hfx * hs * 0.9, v.headWorld.y + hs * 0.15, v.headWorld.z + hfz * hs * 0.9);
      (v.eyes.material as THREE.SpriteMaterial).opacity = 0.75 + Math.sin(now * 9 + v.id) * 0.25;
      v.horns.position.copy(v.headWorld);
      v.horns.rotation.y = v.yaw;
      // eyes + horns grow in with the spawn scale-in
      v.horns.scale.copy(v.inst.root.scale);
      v.eyes.scale.set(v.skin.eyeSize * 2.2 * v.inst.root.scale.x, v.skin.eyeSize * v.inst.root.scale.y, 1);
      // spawn scale-in
      if (v.spawnT > 0) {
        v.spawnT = Math.max(0, v.spawnT - dt * 1.4);
        const s = 1 - v.spawnT;
        v.inst.root.scale.set(1 + v.spawnT * 0.6, Math.max(0.05, s), 1 + v.spawnT * 0.6);
      } else v.inst.root.scale.setScalar(1);
      // hit flash + telegraph glow
      v.flashT = Math.max(0, v.flashT - dt);
      let flash = v.flashT > 0 ? 0.85 : 0;
      const mat = v.glow.material as THREE.SpriteMaterial;
      if (v.telegraphT > 0) {
        v.telegraphT -= dt;
        const k = 1 - v.telegraphT / Math.max(0.01, v.telegraphDur);
        mat.opacity = 0.35 + k * 0.65 + Math.sin(now * 40) * 0.1;
        mat.color.copy(v.telegraphColor);
        // melee swings flash parry-yellow in the window where a punch counters them
        if (v.meleeTelegraph && v.telegraphT < 0.32) mat.color.setHex(0xfff2a0);
        v.glow.scale.setScalar((v.def.heavy ? 3 : 1.6) * (0.6 + k * 0.8));
        if (k > 0.75) flash = Math.max(flash, 0.35 * ((k - 0.75) * 4));
      } else mat.opacity = Math.max(0, mat.opacity - dt * 6);
      v.inst.flash.value = flash;
    }
  }

  /** Ray test against every living enemy (head sphere + body capsule). Sorted by distance. */
  raycast(o: Vec3, d: Vec3, maxDist: number): EnemyHit[] {
    const hits: EnemyHit[] = [];
    for (const v of this.views.values()) {
      if (v.dead || v.spawnT > 0.5) continue;
      const def = v.def;
      const head = v.headPos(this.tmp);
      const th = raySphere(o, d, head, def.headR * 1.15);
      let best = -1, isHead = false;
      if (th >= 0 && th <= maxDist) { best = th; isHead = true; }
      // body: capsule approximated by sampling closest approach
      const r = def.radius * (def.flying ? 1.1 : 0.9);
      const a = def.flying ? v.centre() : { x: v.pos.x, y: v.pos.y + r, z: v.pos.z };
      const b = def.flying ? a : { x: v.pos.x, y: v.pos.y + Math.max(r, def.height - def.headR * 2), z: v.pos.z };
      const tb = rayCapsule(o, d, a, b, r);
      if (tb >= 0 && tb <= maxDist && (best < 0 || tb < best - 0.05)) { best = tb; isHead = false; }
      if (best >= 0) hits.push({ view: v, dist: best, head: isHead, point: { x: o.x + d.x * best, y: o.y + d.y * best, z: o.z + d.z * best } });
    }
    hits.sort((x, y) => x.dist - y.dist);
    return hits;
  }

  nearest(p: Vec3, maxDist: number, filter?: (v: EnemyView) => boolean): EnemyView | null {
    let best: EnemyView | null = null, bd = maxDist;
    for (const v of this.views.values()) {
      if (v.dead || v.spawnT > 0.5 || (filter && !filter(v))) continue;
      const d = v.centre(this.tmp).distanceTo(p as THREE.Vector3);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  get boss(): EnemyView | null {
    for (const v of this.views.values()) if (v.kind === 'colossus' && !v.dead) return v;
    return null;
  }

  clear(): void {
    for (const v of this.views.values()) v.dispose(this.scene);
    this.views.clear();
  }
}

/** Ray vs capsule by marching the closest-approach parameter; good enough for hitscan. */
function rayCapsule(o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: number): number {
  // closest points between ray and segment
  const ux = d.x, uy = d.y, uz = d.z;
  const vx = b.x - a.x, vy = b.y - a.y, vz = b.z - a.z;
  const wx = o.x - a.x, wy = o.y - a.y, wz = o.z - a.z;
  const A = 1, B = ux * vx + uy * vy + uz * vz, Cc = vx * vx + vy * vy + vz * vz;
  const D = ux * wx + uy * wy + uz * wz, E = vx * wx + vy * wy + vz * wz;
  const den = A * Cc - B * B;
  let s = den > 1e-6 ? (B * E - Cc * D) / den : 0;
  let tt = Cc > 1e-6 ? (A * E - B * D) / den : 0;
  if (den <= 1e-6) tt = 0;
  tt = Math.max(0, Math.min(1, tt));
  // recompute s for clamped segment point
  const px = a.x + vx * tt, py = a.y + vy * tt, pz = a.z + vz * tt;
  s = Math.max(0, (px - o.x) * ux + (py - o.y) * uy + (pz - o.z) * uz);
  const q = { x: o.x + ux * s, y: o.y + uy * s, z: o.z + uz * s };
  const dist = pointSegmentDist(q, a, b);
  if (dist > r) return -1;
  // step back to the surface entry point
  const back = Math.sqrt(Math.max(0, r * r - dist * dist));
  return Math.max(0, s - back);
}
