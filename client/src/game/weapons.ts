// The arsenal: PIERCER revolver (+ coin ricochets), SCATTERHAMMER shotgun
// (+ detonatable core), SLAGTHROWER rocket launcher (+ remote detonation) and the
// parry punch. Hitscan and local projectiles are resolved on this client against
// what the player sees; the server applies the damage.
import * as THREE from 'three';
import { lineOfSight, raycastWorld } from '../../../shared/arena';
import { PUNCH, WEAPONS, WEAPON_ORDER, type WeaponId } from '../../../shared/constants';
import { raySphere, type Vec3 } from '../../../shared/math';
import type { FxMsg, HitKind, V } from '../../../shared/protocol';
import { sprite, staticModel } from '../engine/assets';
import type { Audio } from '../engine/audio';
import type { Input } from '../engine/input';
import type { Motor } from '../../../shared/movement';
import type { EnemyHit, Enemies, EnemyView } from './enemies';
import { COLORS, type FX } from './fx';
import type { Hazards } from './hazards';

export interface WeaponCtx {
  now: number;
  eye: THREE.Vector3;
  fwd: THREE.Vector3;
  right: THREE.Vector3;
  up: THREE.Vector3;
  motor: Motor;
  alive: boolean;
  enemies: Enemies;
  hazards: Hazards;
  fx: FX;
  audio: Audio;
  /** Apply damage to an enemy (prediction, blood, hitmarker, network). */
  damage(v: EnemyView, dmg: number, kind: HitKind, head: boolean, point: Vec3, dir: Vec3, extra?: { rc?: number }): void;
  /** Area damage + knockback on the local player. */
  explode(p: Vec3, r: number, dmg: number, kind: HitKind, selfForce: number, selfDmg: number): void;
  parry(id: number, dir: Vec3): void;
  sendFx(m: FxMsg): void;
  style(label: string, pts: number, big?: boolean): void;
}

interface Coin { id: number; pos: THREE.Vector3; vel: THREE.Vector3; life: number; mesh: THREE.Object3D; local: boolean; owner: string }
interface Core { id: number; pos: THREE.Vector3; vel: THREE.Vector3; life: number; mesh: THREE.Object3D; local: boolean; owner: string; bounces: number }
interface Rocket { id: number; pos: THREE.Vector3; vel: THREE.Vector3; life: number; mesh: THREE.Object3D; local: boolean; owner: string }

const v3 = (p: Vec3): V => [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100];

interface ViewDef { model: 'revolver_a' | 'shotgun_b' | 'rocket_launcher'; length: number; offset: THREE.Vector3; rot: THREE.Euler; muzzle: THREE.Vector3; kick: number }

const VIEW: Record<WeaponId, ViewDef> = {
  revolver: { model: 'revolver_a', length: 0.42, offset: new THREE.Vector3(0.24, -0.22, -0.46), rot: new THREE.Euler(0, Math.PI / 2, 0), muzzle: new THREE.Vector3(0, 0.035, -0.26), kick: 1 },
  shotgun: { model: 'shotgun_b', length: 0.78, offset: new THREE.Vector3(0.26, -0.26, -0.52), rot: new THREE.Euler(0, Math.PI / 2, 0), muzzle: new THREE.Vector3(0, 0.03, -0.45), kick: 1.6 },
  launcher: { model: 'rocket_launcher', length: 0.85, offset: new THREE.Vector3(0.3, -0.24, -0.5), rot: new THREE.Euler(0, Math.PI / 2, 0), muzzle: new THREE.Vector3(0, 0.05, -0.48), kick: 1.3 },
};

export class Weapons {
  readonly vmScene = new THREE.Scene();
  readonly vmCam: THREE.PerspectiveCamera;
  current: WeaponId = 'revolver';
  private last: WeaponId = 'shotgun';
  private models: Record<WeaponId, THREE.Object3D>;
  private holder = new THREE.Object3D();
  private arm = new THREE.Object3D();
  private muzzleFlash: THREE.Sprite;
  private flashT = 0;
  private switchT = 0;
  private cooldown = 0;
  private punchCd = 0;
  punchT = 0;
  coins: number = WEAPONS.revolver.coinCharges;
  private coinRegen = 0;
  coreCd = 0;
  private recoil = 0;
  private recoilRot = 0;
  private sway = new THREE.Vector2();
  private bobT = 0;
  private tilt = 0;
  private spin = 0; // revolver cylinder / shotgun pump animation
  private coinList: Coin[] = [];
  private cores: Core[] = [];
  private rockets: Rocket[] = [];
  private nextId = 1;
  private coinGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.03, 8);
  private coinMat = new THREE.MeshBasicMaterial({ color: 0xffd040 });
  private coreMat = new THREE.MeshBasicMaterial({ color: 0x60d0ff });
  private rocketMat = new THREE.MeshBasicMaterial({ color: 0x3a3230 });
  private recentKillWeapons: { w: WeaponId; t: number }[] = [];
  shotsFired = 0;

  constructor(private world: THREE.Scene, private selfId: () => string) {
    this.vmCam = new THREE.PerspectiveCamera(62, 1, 0.01, 10);
    this.vmScene.add(new THREE.HemisphereLight(0xffb090, 0x301010, 1.4));
    const key = new THREE.DirectionalLight(0xffa060, 2.2);
    key.position.set(-1, 2, 1);
    this.vmScene.add(key);
    this.vmScene.add(this.holder);
    this.models = {
      revolver: this.buildView('revolver'),
      shotgun: this.buildView('shotgun'),
      launcher: this.buildView('launcher'),
    };
    this.muzzleFlash = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite('muzzle_02'), color: 0xffe0a0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false }));
    this.muzzleFlash.visible = false;
    this.muzzleFlash.renderOrder = 10;
    this.holder.add(this.muzzleFlash);
    this.buildArm();
    this.select('revolver', true);
  }

  private buildView(w: WeaponId): THREE.Object3D {
    const def = VIEW[w];
    const m = staticModel(def.model, def.length, { hue: w === 'launcher' ? -0.3 : 0, sat: 0.8, bright: 1.1 });
    m.rotation.copy(def.rot);
    const g = new THREE.Object3D();
    g.add(m);
    g.visible = false;
    this.holder.add(g);
    return g;
  }

  /** A chunky mechanical left arm for punches and parries. */
  private buildArm(): void {
    const metal = new THREE.MeshLambertMaterial({ color: 0x5a4a46 });
    const dark = new THREE.MeshLambertMaterial({ color: 0x241c1c });
    const glow = new THREE.MeshBasicMaterial({ color: 0xff4020 });
    const fore = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, 0.42), metal);
    fore.position.z = 0.1;
    const fist = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.14, 0.14), dark);
    fist.position.z = -0.17;
    const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.03), glow);
    knuckle.position.set(0, 0.05, -0.245);
    const piston = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 5).rotateX(Math.PI / 2), dark);
    piston.position.set(0.06, 0.06, 0.08);
    this.arm.add(fore, fist, knuckle, piston);
    this.arm.position.set(-0.3, -0.35, -0.3);
    this.arm.visible = false;
    this.vmScene.add(this.arm);
  }

  select(w: WeaponId, instant = false): void {
    if (w === this.current && !instant) return;
    if (w !== this.current) this.last = this.current;
    this.current = w;
    this.switchT = instant ? 0 : 0.22;
    for (const k of WEAPON_ORDER) this.models[k].visible = k === w;
  }

  get index(): number {
    return WEAPON_ORDER.indexOf(this.current);
  }

  resize(aspect: number): void {
    this.vmCam.aspect = aspect;
    this.vmCam.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ update

  update(dt: number, input: Input, ctx: WeaponCtx, mouse: [number, number]): void {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.punchCd = Math.max(0, this.punchCd - dt);
    this.coreCd = Math.max(0, this.coreCd - dt);
    this.switchT = Math.max(0, this.switchT - dt);
    if (this.coins < WEAPONS.revolver.coinCharges) {
      this.coinRegen += dt;
      if (this.coinRegen >= WEAPONS.revolver.coinRegen) { this.coinRegen = 0; this.coins++; }
    }

    if (ctx.alive) {
      if (input.wasPressed('w1')) this.select('revolver');
      if (input.wasPressed('w2')) this.select('shotgun');
      if (input.wasPressed('w3')) this.select('launcher');
      if (input.wasPressed('last')) this.select(this.last);
      if (input.wasPressed('next') || input.wasPressed('prev')) {
        const i = (this.index + (input.wasPressed('next') ? 1 : WEAPON_ORDER.length - 1)) % WEAPON_ORDER.length;
        this.select(WEAPON_ORDER[i]);
      }
      if (input.wasPressed('punch')) this.punch(ctx);
      if (this.switchT <= 0) {
        if (input.isDown('fire') && this.cooldown <= 0) this.fire(ctx);
        if (input.wasPressed('alt')) this.alt(ctx);
      }
    }

    this.updateCoins(dt, ctx);
    this.updateCores(dt, ctx);
    this.updateRockets(dt, ctx);
    this.animate(dt, ctx, mouse);
  }

  // ------------------------------------------------------------------ firing

  private muzzleWorld(ctx: WeaponCtx): THREE.Vector3 {
    return ctx.eye.clone().addScaledVector(ctx.fwd, 0.6).addScaledVector(ctx.right, 0.18).addScaledVector(ctx.up, -0.14);
  }

  private fire(ctx: WeaponCtx): void {
    this.shotsFired++;
    const w = this.current;
    if (w === 'revolver') {
      this.cooldown = WEAPONS.revolver.interval;
      this.recoil = 1; this.recoilRot = 1; this.spin += Math.PI / 3;
      ctx.audio.play('revolver', { volume: 0.85, variance: 0.05 });
      ctx.fx.shake(0.12);
      this.flash(0.05, 0.28);
      const to = this.hitscan(ctx, ctx.eye, ctx.fwd, WEAPONS.revolver.damage, 'revolver', WEAPONS.revolver.pierce, 0xfff0a0, 0.035);
      ctx.sendFx({ t: 'shot', w: 'revolver', from: v3(this.muzzleWorld(ctx)), to: [v3(to)] });
    } else if (w === 'shotgun') {
      const S = WEAPONS.shotgun;
      this.cooldown = S.interval;
      this.recoil = 1.6; this.recoilRot = 1.6;
      ctx.audio.play('shotgun', { volume: 1, variance: 0.06 });
      setTimeout(() => ctx.audio.play('pump', { volume: 0.5 }), 380);
      ctx.fx.shake(0.28);
      this.flash(0.07, 0.5);
      const agg = new Map<EnemyView, { dmg: number; head: boolean; point: Vec3 }>();
      const tos: V[] = [];
      const muzzle = this.muzzleWorld(ctx);
      for (let i = 0; i < S.pellets; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * S.spread;
        const d = ctx.fwd.clone().addScaledVector(ctx.right, Math.cos(a) * r).addScaledVector(ctx.up, Math.sin(a) * r).normalize();
        const res = this.traceFirst(ctx, ctx.eye, d, S.range);
        if (res.core) { this.detonateCore(res.core, ctx, true); continue; }
        if (res.enemy) {
          const close = res.enemy.dist < 4 ? 1.35 : 1;
          const cur = agg.get(res.enemy.view) ?? { dmg: 0, head: false, point: res.enemy.point };
          cur.dmg += S.pelletDamage * close * (res.enemy.head ? 1.25 : 1);
          cur.head = cur.head || res.enemy.head;
          agg.set(res.enemy.view, cur);
        } else if (res.wall) {
          ctx.fx.sparks(res.end, 2, 5, COLORS.spark, 0.08);
          if (i % 3 === 0) ctx.fx.decal(res.end, res.wall.normal, 0.25, 'scorch');
        }
        if (i < 5) { ctx.fx.tracer(muzzle, res.end, 0xffd080, 0.02, 0.06); tos.push(v3(res.end)); }
      }
      for (const [view, h] of agg) ctx.damage(view, h.dmg, 'shotgun', h.head, h.point, ctx.fwd);
      ctx.sendFx({ t: 'shot', w: 'shotgun', from: v3(muzzle), to: tos });
    } else {
      const L = WEAPONS.launcher;
      this.cooldown = L.interval;
      this.recoil = 1.3; this.recoilRot = 0.8;
      ctx.audio.play('rocket', { volume: 0.9 });
      ctx.fx.shake(0.18);
      this.flash(0.08, 0.6);
      const p = this.muzzleWorld(ctx);
      // aim the rocket at what the crosshair points to
      const aim = this.aimPoint(ctx, 200);
      const dir = aim.sub(p).normalize();
      const id = this.nextId++;
      const vel = dir.multiplyScalar(L.rocketSpeed);
      this.spawnRocket(id, p, vel, true, this.selfId());
      ctx.sendFx({ t: 'rocket', id, p: v3(p), v: v3(vel) });
      ctx.fx.smoke(p, 4, 0.4);
    }
  }

  private alt(ctx: WeaponCtx): void {
    const w = this.current;
    if (w === 'revolver') {
      if (this.coins <= 0) { ctx.audio.synth('denied'); return; }
      this.coins--;
      const W = WEAPONS.revolver;
      const p = ctx.eye.clone().addScaledVector(ctx.fwd, 0.7).addScaledVector(ctx.up, -0.1);
      const vel = ctx.fwd.clone().multiplyScalar(W.coinThrowSpeed).add(new THREE.Vector3(0, W.coinUpSpeed, 0));
      vel.x += ctx.motor.vel.x * 0.6; vel.z += ctx.motor.vel.z * 0.6; vel.y += Math.max(0, ctx.motor.vel.y) * 0.4;
      const id = this.nextId++;
      this.spawnCoin(id, p, vel, true, this.selfId());
      ctx.audio.play('coin', { volume: 0.7 });
      ctx.sendFx({ t: 'coin', id, p: v3(p), v: v3(vel) });
      this.punchT = Math.max(this.punchT, 0.12);
    } else if (w === 'shotgun') {
      if (this.coreCd > 0) { ctx.audio.synth('denied'); return; }
      const S = WEAPONS.shotgun;
      this.coreCd = S.coreCooldown;
      this.recoil = 0.8;
      const p = this.muzzleWorld(ctx);
      const vel = ctx.fwd.clone().multiplyScalar(S.coreSpeed).add(new THREE.Vector3(0, 4, 0));
      vel.x += ctx.motor.vel.x * 0.5; vel.z += ctx.motor.vel.z * 0.5;
      const id = this.nextId++;
      this.spawnCore(id, p, vel, true, this.selfId());
      ctx.audio.play('laser_retro', { volume: 0.6, pitch: 0.7 });
      ctx.sendFx({ t: 'core', id, p: v3(p), v: v3(vel) });
    } else {
      // remote detonation of every rocket in flight
      const mine = this.rockets.filter((r) => r.local);
      if (!mine.length) { ctx.audio.synth('denied'); return; }
      for (const r of mine) this.explodeRocket(r, ctx, null, 1.15);
      if (mine.length >= 2) ctx.style('AIRBURST', 40 * mine.length);
    }
  }

  private punch(ctx: WeaponCtx): void {
    if (this.punchCd > 0) return;
    this.punchCd = PUNCH.interval;
    this.punchT = 0.28;
    ctx.sendFx({ t: 'punch' });
    // parry beats everything
    const cands = ctx.hazards.parryCandidates(ctx.eye, ctx.fwd, PUNCH.parryRange, PUNCH.parryCone);
    if (cands.length) {
      const pr = cands[0];
      const aim = this.aimPoint(ctx, 200);
      const dir = aim.sub(pr.pos).normalize();
      ctx.parry(pr.id, dir);
      ctx.hazards.hide(pr.id);
      ctx.fx.freeze(0.13);
      ctx.fx.glow(pr.pos, 3.5, COLORS.parry, 0.25);
      ctx.fx.sparks(pr.pos, 30, 14, COLORS.parry, 0.15);
      ctx.audio.play('parry', { volume: 1.1 });
      ctx.audio.duck(0.2, 0.35);
      ctx.fx.shake(0.4);
      ctx.style('PARRY', 150, true);
      return;
    }
    // punch the nearest enemy in front of us
    let target: EnemyView | null = null;
    let best = PUNCH.range + 1;
    for (const v of ctx.enemies.views.values()) {
      if (v.dead) continue;
      const c = v.centre();
      const to = c.clone().sub(ctx.eye);
      const d = to.length() - v.def.radius;
      if (d > PUNCH.range || d > best) continue;
      if (to.normalize().dot(ctx.fwd) < 0.55) continue;
      best = d;
      target = v;
    }
    if (target) {
      const c = target.centre();
      ctx.damage(target, PUNCH.damage, 'punch', false, c, ctx.fwd);
      ctx.fx.freeze(0.05);
      ctx.fx.shake(0.2);
      ctx.audio.play('armor', { volume: 0.9, pitch: 0.8 });
      ctx.audio.play('flesh', { volume: 0.6 });
    } else {
      ctx.audio.play('whoosh', { volume: 0.35, pitch: 1.3 });
    }
    // punching your own core launches it
    for (const core of this.cores) {
      if (!core.local) continue;
      if (core.pos.distanceTo(ctx.eye) < PUNCH.range + 0.5) {
        core.vel.copy(ctx.fwd).multiplyScalar(45);
        core.life = Math.max(core.life, 1);
        ctx.style('HOMERUN', 60);
      }
    }
  }

  // ------------------------------------------------------------------ hitscan

  private aimPoint(ctx: WeaponCtx, max: number): THREE.Vector3 {
    const wall = raycastWorld(ctx.eye, ctx.fwd, max);
    const eh = ctx.enemies.raycast(ctx.eye, ctx.fwd, wall ? wall.dist : max);
    const d = eh.length ? eh[0].dist : wall ? wall.dist : max;
    return ctx.eye.clone().addScaledVector(ctx.fwd, d);
  }

  /** First thing a ray touches: a detonatable core, an enemy, or a wall. */
  private traceFirst(ctx: WeaponCtx, o: Vec3, d: Vec3, max: number): { enemy: EnemyHit | null; core: Core | null; wall: ReturnType<typeof raycastWorld>; end: THREE.Vector3 } {
    const wall = raycastWorld(o, d, max);
    let limit = wall ? wall.dist : max;
    let core: Core | null = null;
    for (const c of this.cores) {
      if (!c.local) continue;
      const t = raySphere(o, d, c.pos, 0.9);
      if (t >= 0 && t < limit) { limit = t; core = c; }
    }
    const eh = ctx.enemies.raycast(o, d, limit);
    const enemy = eh.length ? eh[0] : null;
    if (enemy) core = null;
    const dist = enemy ? enemy.dist : limit;
    const end = new THREE.Vector3(o.x + d.x * dist, o.y + d.y * dist, o.z + d.z * dist);
    return { enemy, core, wall: enemy || core ? null : wall, end };
  }

  /** Piercing hitscan with coin interaction. Returns the tracer end point. */
  private hitscan(ctx: WeaponCtx, o: THREE.Vector3, d: THREE.Vector3, dmg: number, kind: HitKind, pierce: number, color: number, width: number): THREE.Vector3 {
    const wall = raycastWorld(o, d, 300);
    let limit = wall ? wall.dist : 300;
    // coins take priority if the shot passes through one first
    let coin: Coin | null = null;
    for (const c of this.coinList) {
      if (!c.local) continue;
      const t = raySphere(o, d, c.pos, WEAPONS.revolver.coinHitRadius + 0.25);
      if (t >= 0 && t < limit) { limit = t; coin = c; }
    }
    let core: Core | null = null;
    for (const c of this.cores) {
      if (!c.local) continue;
      const t = raySphere(o, d, c.pos, 0.9);
      if (t >= 0 && t < limit) { limit = t; core = c; coin = null; }
    }
    const hits = ctx.enemies.raycast(o, d, limit).slice(0, pierce);
    const muzzle = this.muzzleWorld(ctx);
    if (coin && (!hits.length || hits[0].dist > limit - 0.01)) {
      ctx.fx.tracer(muzzle, coin.pos, color, width, 0.12);
      this.ricochet(ctx, coin, dmg * WEAPONS.revolver.ricochetMult, 1, [muzzle.clone(), coin.pos.clone()]);
      return coin.pos.clone();
    }
    let end = o.clone().addScaledVector(d, limit);
    for (const h of hits) {
      ctx.damage(h.view, dmg * (h.head ? WEAPONS.revolver.headshotMult : 1), kind, h.head, h.point, d);
    }
    if (core && hits.length < pierce) {
      this.detonateCore(core, ctx, true);
      ctx.style('CORE SNIPE', 80);
    } else if (!core && hits.length < pierce && wall) {
      ctx.fx.sparks(end, 8, 6);
      ctx.fx.decal(end, wall.normal, 0.3, 'scorch');
      ctx.audio.play('metal_light', { at: end, volume: 0.5 });
    }
    if (hits.length && hits.length >= pierce) end = new THREE.Vector3(hits[hits.length - 1].point.x, hits[hits.length - 1].point.y, hits[hits.length - 1].point.z);
    ctx.fx.tracer(muzzle, end, color, width, 0.09);
    return end;
  }

  /** Coin ricochet: chain to other coins first, then snap to the best enemy head. */
  private ricochet(ctx: WeaponCtx, coin: Coin, dmg: number, chain: number, pts: THREE.Vector3[]): void {
    this.removeCoin(coin);
    ctx.sendFx({ t: 'coinhit', id: coin.id });
    ctx.audio.play('coin', { at: coin.pos, volume: 1, pitch: 1.4 + chain * 0.15 });
    ctx.fx.glow(coin.pos, 1.6, COLORS.gold, 0.2);
    ctx.fx.sparks(coin.pos, 12, 8, COLORS.gold, 0.1);
    ctx.fx.freeze(0.035);
    // next coin in range and sight
    let next: Coin | null = null, nd = 40;
    for (const c of this.coinList) {
      if (!c.local || c === coin) continue;
      const d = c.pos.distanceTo(coin.pos);
      if (d < nd && lineOfSight(coin.pos, c.pos)) { nd = d; next = c; }
    }
    if (next) {
      ctx.fx.tracer(coin.pos, next.pos, 0xffd040, 0.05, 0.25);
      pts.push(next.pos.clone());
      this.ricochet(ctx, next, dmg * WEAPONS.revolver.ricochetMult, chain + 1, pts);
      return;
    }
    // best enemy: prefer ones about to attack, then the closest
    let target: EnemyView | null = null, bestScore = -Infinity;
    for (const v of ctx.enemies.views.values()) {
      if (v.dead || v.spawnT > 0.5) continue;
      const h = v.headPos();
      const d = h.distanceTo(coin.pos);
      if (d > 70 || !lineOfSight(coin.pos, h)) continue;
      const score = -d + (v.telegraphT > 0 ? 25 : 0) + (v.def.heavy ? 10 : 0);
      if (score > bestScore) { bestScore = score; target = v; }
    }
    if (target) {
      const h = target.headPos();
      ctx.fx.tracer(coin.pos, h, 0xffe070, 0.07, 0.3);
      pts.push(h.clone());
      const dir = h.clone().sub(coin.pos).normalize();
      ctx.damage(target, dmg * WEAPONS.revolver.headshotMult, 'ricoshot', true, h, dir, { rc: chain });
      ctx.style(chain > 1 ? `RICOSHOT x${chain}` : 'RICOSHOT', 90 * chain, true);
    } else {
      const d = new THREE.Vector3(Math.random() - 0.5, -0.3, Math.random() - 0.5).normalize();
      const w = raycastWorld(coin.pos, d, 60);
      const end = coin.pos.clone().addScaledVector(d, w ? w.dist : 60);
      ctx.fx.tracer(coin.pos, end, 0xffe070, 0.05, 0.2);
      pts.push(end);
    }
    ctx.sendFx({ t: 'ricochet', pts: pts.map(v3) });
  }

  // ------------------------------------------------------------------ coins

  spawnCoin(id: number, p: Vec3, v: Vec3, local: boolean, owner: string): void {
    const mesh = new THREE.Object3D();
    const disc = new THREE.Mesh(this.coinGeo, this.coinMat);
    disc.rotation.x = Math.PI / 2;
    mesh.add(disc);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite('light_01'), color: 0xffc030, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.7 }));
    glow.scale.setScalar(0.9);
    mesh.add(glow);
    mesh.position.set(p.x, p.y, p.z);
    this.world.add(mesh);
    this.coinList.push({ id, pos: new THREE.Vector3(p.x, p.y, p.z), vel: new THREE.Vector3(v.x, v.y, v.z), life: WEAPONS.revolver.coinLife, mesh, local, owner });
  }

  private removeCoin(c: Coin): void {
    this.world.remove(c.mesh);
    const i = this.coinList.indexOf(c);
    if (i >= 0) this.coinList.splice(i, 1);
  }

  removeRemoteCoin(owner: string, id: number): void {
    const c = this.coinList.find((x) => x.owner === owner && x.id === id);
    if (c) this.removeCoin(c);
  }

  private updateCoins(dt: number, ctx: WeaponCtx): void {
    for (const c of [...this.coinList]) {
      c.life -= dt;
      c.vel.y -= 20 * dt;
      const step = c.vel.length() * dt;
      const dir = c.vel.clone().normalize();
      const w = raycastWorld(c.pos, dir, step + 0.1);
      if (w || c.life <= 0) {
        if (w) ctx.fx.sparks(c.pos, 4, 3, COLORS.gold, 0.06);
        this.removeCoin(c);
        continue;
      }
      c.pos.addScaledVector(c.vel, dt);
      c.mesh.position.copy(c.pos);
      c.mesh.rotation.y += dt * 25;
      c.mesh.rotation.x += dt * 9;
    }
  }

  // ------------------------------------------------------------------ cores

  spawnCore(id: number, p: Vec3, v: Vec3, local: boolean, owner: string): void {
    const mesh = new THREE.Object3D();
    mesh.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.16, 0), this.coreMat));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite('light_01'), color: 0x50b0ff, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(1.4);
    mesh.add(glow);
    mesh.position.set(p.x, p.y, p.z);
    this.world.add(mesh);
    this.cores.push({ id, pos: new THREE.Vector3(p.x, p.y, p.z), vel: new THREE.Vector3(v.x, v.y, v.z), life: WEAPONS.shotgun.coreFuse, mesh, local, owner, bounces: 0 });
  }

  private removeCore(c: Core): void {
    this.world.remove(c.mesh);
    const i = this.cores.indexOf(c);
    if (i >= 0) this.cores.splice(i, 1);
  }

  removeRemoteCore(owner: string, id: number): void {
    const c = this.cores.find((x) => x.owner === owner && x.id === id);
    if (c) this.removeCore(c);
  }

  private detonateCore(c: Core, ctx: WeaponCtx, shot: boolean): void {
    this.removeCore(c);
    const S = WEAPONS.shotgun;
    const r = shot ? S.coreShotRadius : S.coreRadius;
    ctx.explode(c.pos, r, shot ? S.coreShotDamage : S.coreDamage, 'core', shot ? 20 : 14, 0);
    ctx.fx.explosion(c.pos, r * 0.8, COLORS.blue);
    ctx.sendFx({ t: 'coredie', id: c.id });
    if (shot) { ctx.fx.freeze(0.06); ctx.style('CORE DETONATED', 60); }
  }

  private updateCores(dt: number, ctx: WeaponCtx): void {
    for (const c of [...this.cores]) {
      c.life -= dt;
      c.vel.y -= 20 * dt;
      const speed = c.vel.length();
      const dir = c.vel.clone().normalize();
      const w = raycastWorld(c.pos, dir, speed * dt + 0.18);
      if (w) {
        // bounce
        const n = new THREE.Vector3(w.normal.x, w.normal.y, w.normal.z);
        c.vel.reflect(n).multiplyScalar(0.45);
        c.bounces++;
        if (c.local) ctx.audio.play('clank', { at: c.pos, volume: 0.4, pitch: 1.5 });
      } else c.pos.addScaledVector(c.vel, dt);
      c.mesh.position.copy(c.pos);
      c.mesh.rotation.x += dt * 8;
      if (Math.random() < 0.6) ctx.fx.glow(c.pos, 0.5, COLORS.blue, 0.15, 0.6);
      if (!c.local) { if (c.life < -2) this.removeCore(c); continue; }
      let hitEnemy = false;
      for (const v of ctx.enemies.views.values()) {
        if (v.dead) continue;
        if (v.centre().distanceTo(c.pos) < v.def.radius + 0.4 + (v.def.flying ? 0.3 : v.def.height * 0.25)) { hitEnemy = true; break; }
      }
      if (hitEnemy || c.life <= 0) this.detonateCore(c, ctx, false);
    }
  }

  // ------------------------------------------------------------------ rockets

  spawnRocket(id: number, p: Vec3, v: Vec3, local: boolean, owner: string): void {
    const mesh = new THREE.Object3D();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 0.5, 6).rotateX(Math.PI / 2), this.rocketMat);
    mesh.add(body);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite('light_01'), color: 0xff8030, blending: THREE.AdditiveBlending, depthWrite: false }));
    glow.scale.setScalar(1.1);
    glow.position.z = 0.3;
    mesh.add(glow);
    mesh.position.set(p.x, p.y, p.z);
    mesh.lookAt(p.x + v.x, p.y + v.y, p.z + v.z);
    this.world.add(mesh);
    this.rockets.push({ id, pos: new THREE.Vector3(p.x, p.y, p.z), vel: new THREE.Vector3(v.x, v.y, v.z), life: WEAPONS.launcher.rocketLife, mesh, local, owner });
  }

  private removeRocket(r: Rocket): void {
    this.world.remove(r.mesh);
    const i = this.rockets.indexOf(r);
    if (i >= 0) this.rockets.splice(i, 1);
  }

  removeRemoteRocket(owner: string, id: number): void {
    const r = this.rockets.find((x) => x.owner === owner && x.id === id);
    if (r) this.removeRocket(r);
  }

  private explodeRocket(r: Rocket, ctx: WeaponCtx, direct: EnemyView | null, radiusMul = 1): void {
    this.removeRocket(r);
    const L = WEAPONS.launcher;
    if (direct) {
      ctx.damage(direct, L.directDamage, 'rocket', false, r.pos, r.vel.clone().normalize());
      if (!ctx.motor.grounded) ctx.style('AIRSHOT', 60);
    }
    ctx.explode(r.pos, L.splashRadius * radiusMul, L.splashDamage, 'rocket', L.selfKnockback, L.selfDamage);
    ctx.fx.explosion(r.pos, L.splashRadius * 0.8 * radiusMul);
    ctx.sendFx({ t: 'rocketdie', id: r.id });
  }

  private updateRockets(dt: number, ctx: WeaponCtx): void {
    for (const r of [...this.rockets]) {
      r.life -= dt;
      const step = r.vel.length() * dt;
      const dir = r.vel.clone().normalize();
      ctx.fx.fireTrail(r.pos, COLORS.fire, 0.35);
      if (!r.local) {
        const w = raycastWorld(r.pos, dir, step);
        if (w || r.life <= 0) this.removeRocket(r);
        else { r.pos.addScaledVector(r.vel, dt); r.mesh.position.copy(r.pos); }
        continue;
      }
      const wall = raycastWorld(r.pos, dir, step + 0.1);
      const eh = ctx.enemies.raycast(r.pos, dir, (wall ? wall.dist : step) + 0.4);
      // proximity fuse for fat targets
      let prox: EnemyView | null = null;
      if (!eh.length) {
        for (const v of ctx.enemies.views.values()) {
          if (v.dead) continue;
          if (v.centre().distanceTo(r.pos) < v.def.radius + 0.6) { prox = v; break; }
        }
      }
      if (eh.length || prox) {
        const hit = eh.length ? eh[0] : null;
        if (hit) r.pos.set(hit.point.x, hit.point.y, hit.point.z);
        this.explodeRocket(r, ctx, hit ? hit.view : prox);
        continue;
      }
      if (wall || r.life <= 0) {
        if (wall) r.pos.addScaledVector(dir, Math.max(0, wall.dist - 0.1));
        this.explodeRocket(r, ctx, null);
        continue;
      }
      r.pos.addScaledVector(r.vel, dt);
      r.mesh.position.copy(r.pos);
    }
  }

  // ------------------------------------------------------------------ remote fx

  remoteFx(from: string, m: FxMsg, fx: FX, audio: Audio): void {
    const P = (v: V) => ({ x: v[0], y: v[1], z: v[2] });
    switch (m.t) {
      case 'shot':
        for (const to of m.to) fx.tracer(P(m.from), P(to), m.w === 'revolver' ? 0xfff0a0 : 0xffd080, m.w === 'revolver' ? 0.035 : 0.02, 0.09);
        fx.muzzle(P(m.from), COLORS.spark, 0.8);
        audio.play(m.w, { at: P(m.from), volume: 0.8 });
        break;
      case 'coin': this.spawnCoin(m.id, P(m.p), P(m.v), false, from); audio.play('coin', { at: P(m.p), volume: 0.5 }); break;
      case 'coinhit': this.removeRemoteCoin(from, m.id); break;
      case 'ricochet':
        for (let i = 0; i + 1 < m.pts.length; i++) fx.tracer(P(m.pts[i]), P(m.pts[i + 1]), 0xffe070, 0.06, 0.25);
        audio.play('coin', { at: P(m.pts[Math.min(1, m.pts.length - 1)]), volume: 0.8, pitch: 1.5 });
        break;
      case 'rocket': this.spawnRocket(m.id, P(m.p), P(m.v), false, from); audio.play('rocket', { at: P(m.p), volume: 0.6 }); break;
      case 'rocketdie': this.removeRemoteRocket(from, m.id); break;
      case 'core': this.spawnCore(m.id, P(m.p), P(m.v), false, from); break;
      case 'coredie': this.removeRemoteCore(from, m.id); break;
      case 'punch': break;
    }
  }

  // ------------------------------------------------------------------ viewmodel

  private flash(time: number, size: number): void {
    this.flashT = time;
    const def = VIEW[this.current];
    this.muzzleFlash.position.copy(def.offset).add(def.muzzle);
    this.muzzleFlash.scale.setScalar(size * (0.8 + Math.random() * 0.4));
    this.muzzleFlash.material.rotation = Math.random() * Math.PI * 2;
    this.muzzleFlash.visible = true;
  }

  noteKill(): void {
    this.recentKillWeapons.push({ w: this.current, t: performance.now() / 1000 });
  }

  /** True if the last few kills used every weapon (the ARSENAL bonus). */
  arsenal(): boolean {
    const now = performance.now() / 1000;
    this.recentKillWeapons = this.recentKillWeapons.filter((k) => now - k.t < 6);
    const set = new Set(this.recentKillWeapons.map((k) => k.w));
    if (set.size >= 3) { this.recentKillWeapons = []; return true; }
    return false;
  }

  private animate(dt: number, ctx: WeaponCtx, mouse: [number, number]): void {
    const def = VIEW[this.current];
    const m = this.models[this.current];
    const mv = ctx.motor;
    const speed = Math.hypot(mv.vel.x, mv.vel.z);
    // sway lags behind mouse movement
    this.sway.x += (-mouse[0] * 0.00035 - this.sway.x) * Math.min(1, dt * 10);
    this.sway.y += (mouse[1] * 0.00035 - this.sway.y) * Math.min(1, dt * 10);
    this.sway.clampScalar(-0.05, 0.05);
    if (mv.grounded && !mv.sliding && speed > 1) this.bobT += dt * (6 + speed * 0.35);
    const bobAmt = mv.grounded && !mv.sliding ? Math.min(1, speed / 15) : 0;
    const bx = Math.sin(this.bobT) * 0.012 * bobAmt;
    const by = -Math.abs(Math.cos(this.bobT)) * 0.014 * bobAmt;
    const wantTilt = mv.sliding ? 0.25 : mv.dashing ? -0.12 : 0;
    this.tilt += (wantTilt - this.tilt) * Math.min(1, dt * 10);
    this.recoil = Math.max(0, this.recoil - dt * 7);
    this.recoilRot = Math.max(0, this.recoilRot - dt * 6);
    const sw = this.switchT > 0 ? this.switchT / 0.22 : 0;
    const air = mv.grounded ? 0 : Math.max(-0.03, Math.min(0.03, -mv.vel.y * 0.0015));
    m.position.set(def.offset.x + this.sway.x + bx, def.offset.y + this.sway.y + by - sw * 0.35 + air, def.offset.z + this.recoil * 0.07 * def.kick);
    m.rotation.set(this.recoilRot * 0.22 * def.kick - sw * 0.8, this.sway.x * 2, this.tilt);
    // revolver cylinder "spin" is faked with a quick roll twitch
    if (this.current === 'revolver') m.rotation.z += Math.sin(this.spin) * 0.02;
    this.flashT = Math.max(0, this.flashT - dt);
    this.muzzleFlash.visible = this.flashT > 0;
    if (this.muzzleFlash.visible) this.muzzleFlash.position.copy(m.position).add(def.muzzle.clone().applyEuler(m.rotation));
    // punch arm
    this.punchT = Math.max(0, this.punchT - dt);
    this.arm.visible = this.punchT > 0;
    if (this.arm.visible) {
      const k = this.punchT / 0.28;
      const ext = k > 0.6 ? (1 - k) / 0.4 : k / 0.6;
      this.arm.position.set(-0.24 + this.sway.x, -0.26 + this.sway.y, -0.28 - ext * 0.38);
      this.arm.rotation.set(0.05, 0.15 - ext * 0.1, this.tilt);
    }
    this.vmCam.rotation.z = 0;
  }

  clear(): void {
    for (const c of [...this.coinList]) this.removeCoin(c);
    for (const c of [...this.cores]) this.removeCore(c);
    for (const r of [...this.rockets]) this.removeRocket(r);
    this.coins = WEAPONS.revolver.coinCharges;
    this.coreCd = 0;
  }

  /** Bot helper: any of our coins currently airborne. */
  get liveCoins(): number {
    return this.coinList.filter((c) => c.local).length;
  }

  /** Bot helper: shoot at our own airborne coin if one exists. */
  coinAimPoint(): THREE.Vector3 | null {
    const c = this.coinList.find((x) => x.local && x.life < WEAPONS.revolver.coinLife - 0.25);
    return c ? c.pos.clone() : null;
  }
}
