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
  anims: Partial<Record<EnemyState | 'death' | 'idle' | 'leap' | 'hit', string[]>>;
  attackAnims?: Record<string, string[]>;
}

const SKINS: Record<EnemyKind, Skin> = {
  husk: {
    model: 'enemy_large', hue: -2.25, sat: 0.75, bright: 1.0, emissive: 0x100000,
    anims: { move: ['Run'], idle: ['Idle'], windup: ['Punch'], recover: ['Idle'], stun: ['HitReact'], death: ['Death'], leap: ['Jump'], spawn: ['Idle'], hit: ['HitReact'] },
  },
  eye: {
    model: 'enemy_small', hue: -2.3, sat: 1.1, bright: 1.0, emissive: 0x180000,
    anims: { move: ['Fast_Flying'], idle: ['Flying_Idle'], windup: ['Headbutt'], dive: ['Fast_Flying'], death: ['Death'], spawn: ['Flying_Idle'], stun: ['HitReact'] },
  },
  warden: {
    model: 'mech', hue: -2.05, sat: 0.55, bright: 0.8,
    anims: { move: ['Walk'], idle: ['Idle'], windup: ['Shoot_Small'], recover: ['Idle'], stun: ['HitRecieve_1'], death: ['Death'], spawn: ['Idle'] },
  },
  drone: {
    model: 'robot_flying', hue: 0.3, sat: 0.35, bright: 0.85, emissive: 0x140000,
    anims: { move: ['Run'], idle: ['Idle'], windup: ['Shoot'], attack: ['Shoot'], death: ['Dead'], spawn: ['Idle'], stun: ['Idle'] },
  },
  brute: {
    model: 'enemy_large', hue: -2.0, sat: 1.15, bright: 0.55, emissive: 0x220000,
    anims: { move: ['Walk'], idle: ['Idle'], recover: ['Idle'], death: ['Death'], spawn: ['Idle'], stun: ['HitReact'] },
    attackAnims: { smash: ['Punch'], stomp: ['Jump'], mortar: ['Weapon', 'Wave'] },
  },
  colossus: {
    model: 'mech', hue: -2.4, sat: 1.0, bright: 0.5, emissive: 0x250200,
    anims: { move: ['Walk'], idle: ['Idle'], recover: ['Idle'], beam: ['Shoot_Big'], death: ['Death'], spawn: ['Hello', 'Idle'] },
    attackAnims: { smash: ['Kick'], stomp: ['Jump_NoHeight', 'Jump'], mortar: ['Shoot_Big'], beam: ['Shoot_Big'], summon: ['Pickup', 'Yes'] },
  },
};

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
  anim: THREE.AnimationAction | null = null;
  lockAnim = 0;
  spawnT = 0;
  lastSeen = 0;
  glow: THREE.Sprite;
  readonly def;

  constructor(public id: number, public kind: EnemyKind, scene: THREE.Scene, glowTex: THREE.Texture) {
    this.def = ENEMIES[kind];
    const skin = SKINS[kind];
    this.inst = instance(skin.model, {
      height: kind === 'eye' ? 1.0 : kind === 'drone' ? 1.2 : this.def.height,
      center: this.def.flying,
      hue: skin.hue,
      sat: skin.sat,
      bright: skin.bright,
      emissive: skin.emissive ? new THREE.Color(skin.emissive) : undefined,
      flashColor: new THREE.Color(1, 1, 1),
      rim: new THREE.Color(kind === 'drone' || kind === 'warden' || kind === 'colossus' ? 0xff7a30 : 0xff4030).multiplyScalar(0.9),
    });
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

  headPos(out = new THREE.Vector3()): THREE.Vector3 {
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

  applySnapshot(a: Snapshot, b: Snapshot, t: number, now: number): void {
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
      if (!v.dead && now - v.lastSeen > 0.6) {
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
    const c = v.centre();
    const heavy = v.def.heavy;
    const gib = how === 'explosion' || how === 'rocket' || how === 'core' || how === 'parry' || how === 'slam' || v.kind === 'eye' || (how === 'shotgun' && Math.random() < 0.6);
    this.fx.blood(c, heavy ? 80 : 30, null, heavy ? 14 : 9);
    this.fx.bloodMist(c, heavy ? 14 : 6, heavy ? 2.5 : 1);
    this.fx.splatter(c, heavy ? 16 : 6, heavy ? 8 : 4, heavy ? 3 : 1.4);
    this.audio.play('gore', { at: c, volume: heavy ? 1.3 : 0.9, pitch: heavy ? 0.7 : 1 });
    if (v.kind === 'drone' || v.kind === 'warden' || v.kind === 'colossus') {
      this.fx.explosion(c, heavy ? 6 : 2.2);
      this.fx.sparks(c, 30, 12);
      this.audio.play(heavy ? 'explosion' : 'explosion_small', { at: c, volume: 0.9 });
    }
    if (gib || heavy) {
      v.gibbed = true;
      this.fx.gibBurst(c, heavy ? 40 : 14, heavy ? 16 : 10, heavy ? 0.5 : 0.22);
      v.inst.root.visible = false;
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
