// Hostile things that can hurt the local player: enemy projectiles (extrapolated
// from snapshots), melee strikes, stomp shockwaves, the colossus beam and mortar
// blasts. Being hit is detected here, against our exact local position, so
// dodging is always judged on what the player actually saw.
import * as THREE from 'three';
import { raycastWorld } from '../../../shared/arena';
import { PROJECTILES, type ProjectileKind } from '../../../shared/constants';
import { pointSegmentDist, type Vec3 } from '../../../shared/math';
import { PROJ_KINDS, type GameEvent, type HurtMsg, type Snapshot, type V } from '../../../shared/protocol';
import { sprite } from '../engine/assets';
import type { Audio } from '../engine/audio';
import { COLORS, type FX } from './fx';

interface ProjView {
  id: number;
  kind: ProjectileKind;
  base: THREE.Vector3;
  vel: THREE.Vector3;
  t0: number; // server time of base
  pos: THREE.Vector3;
  sprite: THREE.Sprite;
  core: THREE.Mesh | null;
  reported: boolean;
  seen: number;
}

interface Shock { aid: number; p: THREE.Vector3; speed: number; range: number; d: number; t: number; hit: boolean; mesh: THREE.Mesh }
interface Beam { aid: number; p: THREE.Vector3; yaw0: number; sweep: number; pitch: number; dur: number; dps: number; t: number; acc: number; mesh: THREE.Mesh; end: THREE.Vector3 }

export interface PlayerProbe {
  centre: Vec3;
  feetY: number;
  grounded: boolean;
  invulnerable: boolean;
  alive: boolean;
}

const PROJ_LOOK: Record<ProjectileKind, { color: number; size: number; tex: 'light_01' | 'flare_01' | 'circle_05' }> = {
  orb: { color: 0xffd060, size: 1.3, tex: 'light_01' },
  bolt: { color: 0xff3020, size: 0.7, tex: 'flare_01' },
  mortar: { color: 0xff6a10, size: 1.8, tex: 'light_01' },
  reflected: { color: 0xfff8d0, size: 1.6, tex: 'light_01' },
};

export class Hazards {
  projectiles = new Map<number, ProjView>();
  private shocks: Shock[] = [];
  private beams: Beam[] = [];
  private coreGeo = new THREE.IcosahedronGeometry(1, 0);
  private ringGeo = new THREE.RingGeometry(0.85, 1, 40, 1).rotateX(-Math.PI / 2);
  onHurt: ((m: HurtMsg, from: Vec3 | null) => void) | null = null;
  private parryPending = new Map<number, number>();
  private landMarkers = new Map<number, THREE.Mesh>();
  private markerGeo = new THREE.RingGeometry(0.75, 1, 24, 1).rotateX(-Math.PI / 2);

  constructor(private scene: THREE.Scene, private fx: FX, private audio: Audio, private selfId: () => string) {}

  applySnapshot(s: Snapshot, now: number): void {
    for (const p of s.pr) {
      let v = this.projectiles.get(p[0]);
      const kind = PROJ_KINDS[p[1]];
      if (!v) {
        const look = PROJ_LOOK[kind];
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite(look.tex), color: look.color, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
        spr.scale.setScalar(look.size);
        this.scene.add(spr);
        let core: THREE.Mesh | null = null;
        if (kind !== 'bolt') {
          core = new THREE.Mesh(this.coreGeo, new THREE.MeshBasicMaterial({ color: kind === 'mortar' ? 0x301008 : 0xfff0c0 }));
          core.scale.setScalar(PROJECTILES[kind].radius * 0.7);
          this.scene.add(core);
        }
        v = { id: p[0], kind, base: new THREE.Vector3(), vel: new THREE.Vector3(), t0: s.t, pos: new THREE.Vector3(p[2], p[3], p[4]), sprite: spr, core, reported: false, seen: now };
        this.projectiles.set(p[0], v);
        if (kind === 'orb') this.audio.play('laser_small', { at: v.pos, volume: 0.6, pitch: 0.6 });
        else if (kind === 'bolt') this.audio.play('laser_retro', { at: v.pos, volume: 0.35, pitch: 1.8 });
        else if (kind === 'mortar') {
          this.audio.play('thruster', { at: v.pos, volume: 0.5, pitch: 1.4 });
          this.addLandingMarker(p[0], new THREE.Vector3(p[2], p[3], p[4]), new THREE.Vector3(p[5], p[6], p[7]));
        }
      }
      if (v.kind !== kind) {
        // parried: restyle as a player projectile
        v.kind = kind;
        const look = PROJ_LOOK[kind];
        const m = v.sprite.material as THREE.SpriteMaterial;
        m.color.setHex(look.color);
        v.sprite.scale.setScalar(look.size);
        if (v.core) (v.core.material as THREE.MeshBasicMaterial).color.setHex(0xffffff);
      }
      v.base.set(p[2], p[3], p[4]);
      v.vel.set(p[5], p[6], p[7]);
      v.t0 = s.t;
      v.seen = now;
    }
    const alive = new Set(s.pr.map((p) => p[0]));
    for (const v of this.projectiles.values()) {
      if (!alive.has(v.id)) this.removeProj(v, true);
    }
  }

  /** Trace the mortar's ballistic arc and paint a warning ring where it will land. */
  private addLandingMarker(id: number, p0: THREE.Vector3, v0: THREE.Vector3): void {
    const g = PROJECTILES.mortar.gravity;
    const step = 0.04;
    let prev = p0.clone();
    for (let t = step; t < 4; t += step) {
      const p = new THREE.Vector3(p0.x + v0.x * t, p0.y + v0.y * t - 0.5 * g * t * t, p0.z + v0.z * t);
      const d = p.clone().sub(prev);
      const len = d.length();
      const hit = raycastWorld(prev, d.normalize(), len);
      if (hit) {
        const at = prev.clone().addScaledVector(d, hit.dist);
        const m = new THREE.Mesh(this.markerGeo, new THREE.MeshBasicMaterial({ color: 0xff2a10, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        m.position.set(at.x, at.y + 0.06, at.z);
        m.scale.setScalar(4.5);
        this.scene.add(m);
        this.landMarkers.set(id, m);
        return;
      }
      prev = p;
    }
  }

  private removeProj(v: ProjView, puff: boolean): void {
    const mk = this.landMarkers.get(v.id);
    if (mk) {
      this.scene.remove(mk);
      (mk.material as THREE.Material).dispose();
      this.landMarkers.delete(v.id);
    }
    if (puff) this.fx.sparks(v.pos, 6, 4, v.kind === 'reflected' ? COLORS.parry : COLORS.fire);
    this.scene.remove(v.sprite);
    if (v.core) this.scene.remove(v.core);
    (v.sprite.material as THREE.Material).dispose();
    this.projectiles.delete(v.id);
  }

  /** Hide a projectile immediately (we parried it or it hit us) until the server confirms. */
  hide(id: number): void {
    const v = this.projectiles.get(id);
    if (v) { v.reported = true; v.sprite.visible = false; if (v.core) v.core.visible = false; }
  }

  /**
   * We punched this projectile: it can't hurt us while the server confirms the parry
   * (it keeps flying visibly; if the parry is rejected it becomes dangerous again).
   */
  markParried(id: number): void {
    this.parryPending.set(id, performance.now() / 1000);
  }

  onEvent(e: GameEvent, probe: PlayerProbe): void {
    switch (e.t) {
      case 'melee': {
        const p = { x: e.p[0], y: e.p[1], z: e.p[2] };
        this.fx.tracer({ x: p.x - 0.8, y: p.y + 0.5, z: p.z }, { x: p.x + 0.8, y: p.y - 0.3, z: p.z }, 0xff5030, 0.06, 0.12);
        if (probe.alive && !probe.invulnerable && dist(probe.centre, p) < e.r + 0.5) {
          this.onHurt?.({ src: 'melee', id: e.aid, d: e.d }, p);
        }
        break;
      }
      case 'shock': {
        const mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xff5a20, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        mesh.position.set(e.p[0], e.p[1] + 0.12, e.p[2]);
        this.scene.add(mesh);
        this.shocks.push({ aid: e.aid, p: new THREE.Vector3(e.p[0], e.p[1], e.p[2]), speed: e.speed, range: e.range, d: e.d, t: 0, hit: false, mesh });
        this.fx.dust({ x: e.p[0], y: e.p[1] + 0.2, z: e.p[2] }, 30, 8);
        this.fx.shake(0.45);
        this.audio.play('explosion_low', { at: mesh.position, volume: 1.2 });
        this.audio.play('metal_heavy', { at: mesh.position, volume: 1, pitch: 0.5 });
        break;
      }
      case 'beam': {
        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.35, 0.35, 1, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5),
          new THREE.MeshBasicMaterial({ color: 0xff2a10, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        mesh.frustumCulled = false;
        this.scene.add(mesh);
        this.beams.push({ aid: e.aid, p: new THREE.Vector3(e.p[0], e.p[1], e.p[2]), yaw0: e.yaw0, sweep: e.sweep, pitch: e.pitch, dur: e.dur, dps: e.dps, t: 0, acc: 0, mesh, end: new THREE.Vector3() });
        this.audio.play('laser_large', { at: { x: e.p[0], y: e.p[1], z: e.p[2] }, volume: 1.4, pitch: 0.4, maxDist: 120 });
        break;
      }
      case 'boom': {
        const p = { x: e.p[0], y: e.p[1], z: e.p[2] };
        const big = e.r >= 4;
        if (e.k === 'dust') { this.fx.dust(p, 20, 5); this.fx.shake(0.25); break; }
        if (e.by && e.by === this.selfId()) break; // already shown locally when we detonated it
        const color = e.k === 'parry' ? COLORS.parry : e.k === 'core' ? COLORS.blue : COLORS.fire;
        this.fx.explosion(p, Math.max(1, e.r * 0.8), color);
        this.fx.decal(p, { x: 0, y: 1, z: 0 }, e.r * 0.9, 'scorch');
        this.audio.play(big ? 'explosion' : 'explosion_small', { at: p, volume: big ? 1.1 : 0.7 });
        const d = dist(probe.centre, p);
        this.fx.shake(Math.max(0, (big ? 0.7 : 0.35) * (1 - d / 30)));
        if (e.hostile && e.d > 0 && probe.alive && !probe.invulnerable && d < e.r + 0.4) {
          this.onHurt?.({ src: 'boom', id: e.aid, d: e.d * (1 - (d / (e.r + 0.4)) * 0.5) }, p);
        }
        break;
      }
    }
  }

  /** Per-frame: move projectiles, run hazards, and test them against the local player. */
  update(dt: number, serverNow: number, probe: PlayerProbe, now: number): void {
    for (const v of this.projectiles.values()) {
      if (now - v.seen > 1) { this.removeProj(v, false); continue; }
      const def = PROJECTILES[v.kind];
      const t = Math.max(0, Math.min(0.5, serverNow - v.t0));
      v.pos.set(v.base.x + v.vel.x * t, v.base.y + v.vel.y * t - 0.5 * def.gravity * t * t, v.base.z + v.vel.z * t);
      v.sprite.position.copy(v.pos);
      if (v.core) {
        v.core.position.copy(v.pos);
        v.core.rotation.x += dt * 5;
        v.core.rotation.y += dt * 7;
      }
      const pulse = 1 + Math.sin(now * 30 + v.id) * 0.15;
      v.sprite.scale.setScalar(PROJ_LOOK[v.kind].size * pulse);
      if (v.kind === 'mortar' || v.kind === 'reflected') this.fx.fireTrail(v.pos, v.kind === 'reflected' ? COLORS.parry : COLORS.fire, 0.45);
      else if (v.kind === 'orb' && Math.random() < 0.5) this.fx.glow(v.pos, 0.6, COLORS.gold, 0.12, 0.6);
      // hitting the local player
      const pendingAt = this.parryPending.get(v.id);
      const pending = pendingAt !== undefined && now - pendingAt < 0.5;
      if (!v.reported && !pending && v.kind !== 'reflected' && probe.alive && !probe.invulnerable) {
        if (dist(v.pos, probe.centre) < def.radius + 0.55) {
          this.hide(v.id);
          this.onHurt?.({ src: 'proj', id: v.id, d: 0 }, v.pos);
        }
      }
    }
    for (const [id, mk] of this.landMarkers) {
      const v = this.projectiles.get(id);
      if (v && v.kind !== 'mortar') { this.scene.remove(mk); this.landMarkers.delete(id); continue; }
      const s = 4.5 * (0.85 + Math.sin(now * 14) * 0.15);
      mk.scale.setScalar(s);
      mk.rotation.y += dt * 2;
    }
    // shockwaves
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i];
      s.t += dt;
      const r = s.t * s.speed;
      s.mesh.scale.set(r, 1, r);
      const m = s.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = Math.max(0, 1 - r / s.range);
      if (r > s.range) { this.scene.remove(s.mesh); m.dispose(); this.shocks.splice(i, 1); continue; }
      if (Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2;
        this.fx.sparks({ x: s.p.x + Math.cos(a) * r, y: s.p.y + 0.3, z: s.p.z + Math.sin(a) * r }, 1, 3, COLORS.fire, 0.3);
      }
      if (!s.hit && probe.alive && !probe.invulnerable) {
        const dx = probe.centre.x - s.p.x, dz = probe.centre.z - s.p.z;
        const pd = Math.hypot(dx, dz);
        if (Math.abs(pd - r) < 1.0 && probe.feetY - s.p.y < 0.8 && probe.grounded) {
          s.hit = true;
          this.onHurt?.({ src: 'shock', id: s.aid, d: s.d }, { x: s.p.x, y: s.p.y, z: s.p.z });
        }
      }
    }
    // beams
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.t += dt;
      if (b.t > b.dur) { this.scene.remove(b.mesh); (b.mesh.material as THREE.Material).dispose(); b.mesh.geometry.dispose(); this.beams.splice(i, 1); continue; }
      const yaw = b.yaw0 + b.sweep * (b.t / b.dur);
      const cp = Math.cos(b.pitch);
      const dir = { x: -Math.sin(yaw) * cp, y: Math.sin(b.pitch), z: -Math.cos(yaw) * cp };
      const hit = raycastWorld(b.p, dir, 120);
      const len = hit ? hit.dist : 120;
      b.end.set(b.p.x + dir.x * len, b.p.y + dir.y * len, b.p.z + dir.z * len);
      b.mesh.position.copy(b.p);
      b.mesh.lookAt(b.end);
      const w = 1 + Math.sin(now * 50) * 0.25;
      b.mesh.scale.set(w, w, len);
      this.fx.sparks(b.end, 3, 7, COLORS.hostile, 0.25);
      if (Math.random() < 0.3) this.fx.smoke(b.end, 1, 0.8, COLORS.smoke, 0.6);
      this.fx.flashLight(b.end, 0xff3010, 3, 10, 0.05);
      if (probe.alive && !probe.invulnerable) {
        const dd = pointSegmentDist(probe.centre, b.p, b.end);
        if (dd < 1.1) {
          b.acc += b.dps * dt;
          if (b.acc >= 8) {
            this.onHurt?.({ src: 'beam', id: b.aid, d: b.acc }, b.p);
            b.acc = 0;
          }
        }
      }
    }
  }

  /** Hostile, parryable projectiles in front of the player. */
  parryCandidates(eye: Vec3, fwd: Vec3, range: number, cone: number): ProjView[] {
    const out: ProjView[] = [];
    for (const v of this.projectiles.values()) {
      if (v.reported || v.kind === 'reflected' || !PROJECTILES[v.kind].parryable) continue;
      const dx = v.pos.x - eye.x, dy = v.pos.y - eye.y, dz = v.pos.z - eye.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > range) continue;
      if (d < 1.2 || (dx * fwd.x + dy * fwd.y + dz * fwd.z) / d > cone) out.push(v);
    }
    return out;
  }

  /** Nearest incoming projectile distance (for the bot's dodge logic). */
  nearestThreat(p: Vec3): number {
    let best = Infinity;
    for (const v of this.projectiles.values()) if (v.kind !== 'reflected') best = Math.min(best, dist(v.pos, p));
    return best;
  }

  /** Loading-screen warm-up: one of every hazard visual, silently, so the GPU compiles them now. */
  warm(p: Vec3): void {
    const audio = this.audio;
    const shake = this.fx.shake;
    this.audio = { play: () => undefined } as unknown as Audio;
    this.fx.shake = () => undefined;
    const probe: PlayerProbe = { centre: { x: 0, y: -100, z: 0 }, feetY: -100, grounded: true, invulnerable: true, alive: false };
    const at: V = [p.x, p.y, p.z];
    try {
      const pr = PROJ_KINDS.map((_k, i) => [-(i + 1), i, p.x + i, p.y, p.z, 0, 4, 0, 0]);
      this.applySnapshot({ t: 0, e: [], pr, pl: [], wave: 0, phase: 'lobby', left: 0, timer: 0, pk: 0 } as unknown as Snapshot, 0);
      this.onEvent({ t: 'shock', id: 0, aid: -1, p: at, speed: 1, range: 4, d: 0 }, probe);
      this.onEvent({ t: 'beam', id: 0, aid: -2, p: at, yaw0: 0, sweep: 0, pitch: 0, dur: 1, dps: 0 }, probe);
      this.onEvent({ t: 'boom', p: at, r: 3, d: 0, hostile: false, aid: 0, k: 'core' }, probe);
    } finally {
      this.audio = audio;
      this.fx.shake = shake;
    }
  }

  clear(): void {
    for (const v of [...this.projectiles.values()]) this.removeProj(v, false);
    for (const mk of this.landMarkers.values()) this.scene.remove(mk);
    this.landMarkers.clear();
    this.parryPending.clear();
    for (const s of this.shocks) this.scene.remove(s.mesh);
    for (const b of this.beams) this.scene.remove(b.mesh);
    this.shocks = [];
    this.beams = [];
  }
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
