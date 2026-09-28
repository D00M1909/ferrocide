// Authoritative world simulation: enemies, AI, projectiles, waves, player health.
// Runs inside the Colyseus room for co-op and inside the browser for solo play.
// Player movement is client-authoritative (instant, lag-free); everything that
// both players must agree on (enemies, damage, waves) is decided here, and every
// client claim is validated and capped before it touches the world.
import {
  AIR_SPAWNS, GROUND_SPAWNS, HEALTH_PICKUPS, LAVA, PLAYER_SPAWNS, TOWER_SPAWNS, blockedAt, inZone, lineOfSight, moveBody, raycastWorld,
} from './arena';
import {
  ENEMIES, ENEMY_ATTACKS, HEALTH_PICKUP, PLAYER, PROJECTILES, PUNCH, SLAM, WEAPONS, type EnemyKind, type ProjectileKind,
} from './constants';
import { angleDiff, clamp, dist, distXZ, rng, type Vec3 } from './math';
import {
  ENEMY_KINDS, ENEMY_STATES, PROJ_KINDS, r2,
  type EnemyState, type FxMsg, type GameEvent, type HitKind, type HurtSource, type Phase,
  type PlayerSnap, type PlayerStats, type Snapshot, type V,
} from './protocol';
import { MAX_ALIVE, WAVES } from './waves';

interface SimPlayer {
  id: string;
  name: string;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  flags: number;
  weapon: number;
  hp: number;
  hard: number; // hp that can't be healed until it decays
  hardT: number;
  alive: boolean;
  connected: boolean;
  respawnAt: number;
  stats: PlayerStats;
  hurtIds: Set<number>;
  budget: number; // damage-per-second token bucket (anti-cheat)
  boomTokens: number;
  healBudget: number; // blood-heal rate limiter
  deathPos: Vec3;
  revive: number; // 0..REVIVE_TIME progress while a partner stands on the corpse
}

interface SimEnemy {
  id: number;
  kind: EnemyKind;
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  hp: number;
  maxHp: number;
  state: EnemyState;
  stateT: number;
  target: string | null;
  retargetT: number;
  cooldown: number;
  attack: string;
  grounded: boolean;
  burstLeft: number;
  strafeDir: number;
  phase: number;
  summonT: number;
  cycle: number;
  shots: number;
  lastStrikeT: number;
  lastStrikeAid: number;
  lastStrikeDmg: number;
  invulnT: number;
  blinkCd: number;
}

interface SimProjectile {
  id: number;
  kind: ProjectileKind;
  pos: Vec3;
  vel: Vec3;
  damage: number;
  born: number;
  owner: string; // enemy id as string, or player id when reflected
}

const vv = (p: Vec3): V => [r2(p.x), r2(p.y), r2(p.z)];

// ------------------------------------------------------------ input validation

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const vec = (v: unknown): Vec3 | null => {
  if (!Array.isArray(v) || v.length < 3) return null;
  const x = num(v[0], NaN), y = num(v[1], NaN), z = num(v[2], NaN);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
};
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Largest damage a single legitimate hit of each kind can do. */
const HIT_CAP: Partial<Record<HitKind, number>> = {
  revolver: WEAPONS.revolver.damage * WEAPONS.revolver.headshotMult + 1,
  ricoshot: WEAPONS.revolver.damage * WEAPONS.revolver.headshotMult * WEAPONS.revolver.ricochetMult ** 4 + 1,
  shotgun: WEAPONS.shotgun.pellets * WEAPONS.shotgun.pelletDamage * WEAPONS.shotgun.closeMult * 1.25 + 1,
  punch: PUNCH.damage + 1,
  rocket: WEAPONS.launcher.directDamage + 1,
};
const BOOM_CAP: Partial<Record<HitKind, { r: number; d: number }>> = {
  rocket: { r: WEAPONS.launcher.splashRadius * WEAPONS.launcher.airburstRadiusMult + 0.1, d: WEAPONS.launcher.splashDamage },
  core: { r: WEAPONS.shotgun.coreShotRadius, d: WEAPONS.shotgun.coreShotDamage },
  slam: { r: SLAM.radius, d: SLAM.baseDamage + SLAM.damagePerMeter * 40 },
};
/** Own-property lookup only: "toString"/"constructor" must never resolve to a cap. */
function capOf<T>(table: Partial<Record<HitKind, T>>, k: unknown): T | undefined {
  return typeof k === 'string' && Object.hasOwn(table, k) ? table[k as HitKind] : undefined;
}
const HURT_SOURCES: HurtSource[] = ['proj', 'melee', 'shock', 'beam', 'boom', 'lava', 'self'];
const HIT_RANGE = 110; // arena diagonal is ~100 m
// damage budget ~1.5x the best legitimate sustained DPS (swap-cancel rotation ~350)
const BUDGET_MAX = 700;
const BUDGET_REFILL = 520; // per second
const BOOM_TOKENS = 5; // explosion claims: bursts allowed, sustained rate capped
const BOOM_REFILL = 3;
const BLOOD_HEAL_RATE = 35; // hp/s ceiling on blood healing
const REVIVE_TIME = 2; // seconds a partner must stand on your corpse
const REVIVE_RADIUS = 3;

/** Rebuild an fx relay message from validated fields only (never forward raw client objects). */
function cleanFx(m: Record<string, unknown>): FxMsg | null {
  const V = (v: unknown): V | null => { const p = vec(v); return p ? [r2(p.x), r2(p.y), r2(p.z)] : null; };
  const list = (v: unknown): V[] | null => {
    if (!Array.isArray(v) || v.length > 16) return null;
    const out: V[] = [];
    for (const x of v) { const p = V(x); if (!p) return null; out.push(p); }
    return out;
  };
  const id = num(m.id, NaN);
  switch (m.t) {
    case 'shot': {
      const from = V(m.from), to = list(m.to);
      return from && to && (m.w === 'revolver' || m.w === 'shotgun') ? { t: 'shot', w: m.w, from, to } : null;
    }
    case 'coin': case 'rocket': case 'core': {
      const p = V(m.p), v = V(m.v);
      return p && v && Number.isFinite(id) ? { t: m.t, id, p, v } : null;
    }
    case 'coinhit': case 'rocketdie': case 'coredie':
      return Number.isFinite(id) ? { t: m.t, id } : null;
    case 'punch':
      return { t: 'punch' };
    case 'ricochet': {
      const pts = list(m.pts);
      return pts && pts.length >= 2 ? { t: 'ricochet', pts } : null;
    }
  }
  return null;
}

export class GameSim {
  time = 0;
  phase: Phase = 'lobby';
  wave = 0; // 1-based once started
  phaseTimer = 0;
  players = new Map<string, SimPlayer>();
  enemies = new Map<number, SimEnemy>();
  projectiles = new Map<number, SimProjectile>();
  private events: GameEvent[] = [];
  private queue: { kind: EnemyKind; at: number; where: 'ground' | 'tower' | 'air' }[] = [];
  private nextId = 1;
  private nextAid = 1;
  private rand: () => number;
  private runStart = 0;
  private waveLeft = 0;
  private pickupAt = HEALTH_PICKUPS.map(() => 0); // time each pickup is next available

  constructor(seed = Date.now()) {
    this.rand = rng(seed);
  }

  // ------------------------------------------------------------------ players

  addPlayer(id: string, name: string): void {
    const idx = this.players.size % PLAYER_SPAWNS.length;
    const sp = PLAYER_SPAWNS[idx];
    const inProgress = this.phase === 'combat' || this.phase === 'intermission';
    this.players.set(id, {
      id, name,
      pos: { ...sp }, vel: { x: 0, y: 0, z: 0 },
      yaw: 0, pitch: 0, flags: 0, weapon: 0,
      hp: PLAYER.maxHealth, hard: 0, hardT: 0, alive: true, connected: true, respawnAt: 0,
      stats: { id, name, kills: 0, damage: 0, deaths: 0, taken: 0, style: 0, parries: 0 },
      hurtIds: new Set(),
      budget: BUDGET_MAX,
      boomTokens: BOOM_TOKENS,
      healBudget: BLOOD_HEAL_RATE,
      deathPos: { ...sp },
      revive: 0,
    });
    this.emit({ t: 'join', pid: id, name });
    if (inProgress) this.emit({ t: 'prespawn', pid: id, p: vv(sp) });
  }

  removePlayer(id: string): void {
    if (!this.players.delete(id)) return;
    this.emit({ t: 'leave', pid: id });
    for (const e of this.enemies.values()) if (e.target === id) e.target = null;
    if (this.players.size === 0) this.phase = 'lobby';
    else this.checkDefeat();
  }

  /** A dropped player keeps their slot (and stats) while they try to reconnect. */
  setConnected(id: string, connected: boolean): void {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = connected;
    if (!connected) for (const e of this.enemies.values()) if (e.target === id) e.target = null;
  }

  start(wave = 1): void {
    if (this.phase !== 'lobby') return;
    this.runStart = this.time;
    this.beginIntermission(clamp(Math.floor(num(wave, 1)), 1, WAVES.length), 2.5);
  }

  playerState(id: string, raw: unknown): void {
    const p = this.players.get(id);
    const m = obj(raw);
    if (!p || !p.alive || !m) return;
    const pos = vec(m.p), vel = vec(m.v);
    if (!pos || !vel) return;
    p.pos.x = clamp(pos.x, -40, 40);
    p.pos.y = clamp(pos.y, -2, 60);
    p.pos.z = clamp(pos.z, -40, 40);
    p.vel.x = clamp(vel.x, -150, 150); p.vel.y = clamp(vel.y, -150, 150); p.vel.z = clamp(vel.z, -150, 150);
    p.yaw = num(m.yaw); p.pitch = clamp(num(m.pitch), -1.6, 1.6);
    p.flags = num(m.f) | 0; p.weapon = clamp(num(m.w) | 0, 0, 2);
    p.stats.style = Math.max(p.stats.style, Math.floor(clamp(num(m.s), 0, 1e7)));
  }

  private spend(p: SimPlayer, dmg: number): number {
    const d = Math.min(dmg, p.budget);
    p.budget -= d;
    return d;
  }

  playerHit(id: string, raw: unknown): void {
    const p = this.players.get(id);
    const m = obj(raw);
    if (!p || !p.alive || !m) return;
    const e = this.enemies.get(num(m.e, -1));
    const k = m.k as HitKind;
    const cap = capOf(HIT_CAP, k);
    if (!e || e.hp <= 0 || cap === undefined) return;
    const def = ENEMIES[e.kind];
    if (dist(p.pos, e.pos) > HIT_RANGE) return;
    if (k === 'punch' && dist(p.pos, e.pos) > PUNCH.range + def.radius + 3) return;
    // hitscan needs a clear line from the shooter's eye to some part of the target
    if (k === 'revolver' || k === 'shotgun') {
      const eye = { x: p.pos.x, y: p.pos.y + 1.5, z: p.pos.z };
      const mid = { x: e.pos.x, y: e.pos.y + (def.flying ? 0 : def.height * 0.5), z: e.pos.z };
      const head = { x: e.pos.x, y: e.pos.y + (def.flying ? 0 : def.headY), z: e.pos.z };
      if (!lineOfSight(eye, mid) && !lineOfSight(eye, head)) return;
    }
    let dmg = this.spend(p, clamp(num(m.d), 0, cap));
    const hs = m.hs === true;
    // punching a husk/brute/stalker at the end of its swing parries it; a small grace
    // after the strike covers the punch's network trip (and refunds the hit it landed)
    const melee = e.attack === 'swipe' || e.attack === 'smash' || e.attack === 'slash';
    const lateGrace = e.state === 'recover' && melee && this.time - e.lastStrikeT < 0.15;
    if (k === 'punch' && melee && ((e.state === 'windup' && e.stateT < ENEMY_ATTACKS.husk.parryWindow + 0.1) || lateGrace)) {
      if (lateGrace && e.lastStrikeAid) {
        if (p.hurtIds.has(e.lastStrikeAid)) this.healPlayer(p, e.lastStrikeDmg, true);
        else p.hurtIds.add(e.lastStrikeAid);
      }
      e.state = 'stun';
      e.stateT = e.kind === 'brute' ? 1.1 : 1.6;
      p.stats.parries++;
      this.healPlayer(p, PUNCH.parryHeal, true);
      this.emit({ t: 'mparry', id: e.id, by: id });
      dmg *= 3;
    } else if ((k === 'revolver' || k === 'ricoshot') && e.state === 'windup' && (e.kind === 'warden' || e.kind === 'drone' || e.kind === 'stalker')) {
      // a precise shot into a telegraphed ranged attack staggers it
      e.state = 'stun';
      e.stateT = 1.1;
      this.emit({ t: 'stun', id: e.id, by: id });
      dmg *= 1.5;
    } else if (k === 'shotgun' && dmg >= WEAPONS.shotgun.staggerDamage && e.state === 'windup' && !ENEMIES[e.kind].heavy) {
      // a point-blank blast knocks a light enemy out of its attack
      e.state = 'stun';
      e.stateT = 0.7;
      this.emit({ t: 'stun', id: e.id, by: id });
    }
    this.damageEnemy(e, dmg, id, k, hs, p);
  }

  playerBoom(id: string, raw: unknown, localFx = true): void {
    const p = this.players.get(id);
    const m = obj(raw);
    if (!p || !p.alive || !m) return;
    const c = vec(m.p);
    const k = m.k as HitKind;
    const cap = localFx ? capOf(BOOM_CAP, k) : { r: 4, d: 45 };
    if (!c || !cap || dist(c, p.pos) > (k === 'slam' ? 8 : 70)) return;
    if (localFx) {
      if (p.boomTokens < 1) return;
      p.boomTokens -= 1;
    }
    const r = clamp(num(m.r), 0, cap.r);
    const base = clamp(num(m.d), 0, cap.d);
    for (const e of this.enemies.values()) {
      if (e.hp <= 0) continue;
      const def = ENEMIES[e.kind];
      const centre = { x: e.pos.x, y: e.pos.y + (def.flying ? 0 : def.height * 0.5), z: e.pos.z };
      const d = Math.max(0, dist(c, centre) - def.radius);
      if (d > r) continue;
      const falloff = 1 - (d / Math.max(r, 0.01)) * 0.6;
      // area damage is rate-limited by boom tokens instead of the per-hit budget
      this.damageEnemy(e, base * falloff, id, k, false, p);
      if (!def.heavy) {
        const dir = { x: centre.x - c.x, y: 0, z: centre.z - c.z };
        const l = Math.hypot(dir.x, dir.z) || 1;
        e.vel.x += (dir.x / l) * 12 * falloff;
        e.vel.z += (dir.z / l) * 12 * falloff;
        if (!def.flying) e.vel.y += 7 * falloff;
      }
    }
    this.emit({ t: 'boom', p: vv(c), r, d: 0, hostile: false, aid: 0, k, by: localFx ? id : undefined });
  }

  playerParry(id: string, raw: unknown): void {
    const p = this.players.get(id);
    const m = obj(raw);
    if (!p || !p.alive || !m) return;
    const pr = this.projectiles.get(num(m.id, -1));
    if (!pr || pr.kind === 'reflected' || !PROJECTILES[pr.kind].parryable) return;
    if (dist(p.pos, pr.pos) > PUNCH.parryRange + 4) return;
    // aim from the projectile's real position at what the player was looking at
    const at = vec(m.at);
    let dir = at ? { x: at.x - pr.pos.x, y: at.y - pr.pos.y, z: at.z - pr.pos.z } : vec(m.dir);
    if (!dir) return;
    const l = Math.hypot(dir.x, dir.y, dir.z) || 1;
    dir = { x: dir.x / l, y: dir.y / l, z: dir.z / l };
    pr.kind = 'reflected';
    pr.vel = { x: dir.x * PUNCH.parrySpeed, y: dir.y * PUNCH.parrySpeed, z: dir.z * PUNCH.parrySpeed };
    pr.damage = pr.damage * PUNCH.parryDamageMult + 40;
    pr.owner = id;
    pr.born = this.time;
    p.stats.parries++;
    this.healPlayer(p, PUNCH.parryHeal, true);
    this.emit({ t: 'parried', id: pr.id, by: id });
  }

  playerHurt(id: string, raw: unknown): void {
    const p = this.players.get(id);
    const m = obj(raw);
    if (!p || !p.alive || !m || this.phase === 'over' || this.phase === 'victory') return;
    const src = m.src as HurtSource;
    if (!HURT_SOURCES.includes(src)) return;
    let dmg = clamp(num(m.d), 0, 100);
    const aid = m.id === undefined ? undefined : num(m.id, -1);
    if (src === 'proj' && aid !== undefined) {
      const pr = this.projectiles.get(aid);
      if (!pr || pr.kind === 'reflected') return;
      dmg = pr.damage;
      this.projectiles.delete(pr.id);
      if (pr.kind === 'mortar') this.emit({ t: 'boom', p: vv(pr.pos), r: 2.5, d: 0, hostile: false, aid: 0, k: 'mortar' });
    } else if (aid !== undefined && src !== 'beam' && src !== 'lava' && src !== 'self') {
      if (p.hurtIds.has(aid)) return; // each attack instance hurts once
      p.hurtIds.add(aid);
      if (p.hurtIds.size > 96) p.hurtIds.delete(p.hurtIds.values().next().value!);
    }
    if (dmg <= 0) return;
    p.hp -= dmg;
    // part of every hit stays "hard": it can't be healed back until it decays
    p.hard = Math.min(PLAYER.maxHealth - Math.max(0, p.hp), p.hard + dmg * PLAYER.hardDamageFraction);
    p.hardT = PLAYER.hardDamageDelay;
    p.stats.taken += dmg;
    this.emit({ t: 'phurt', pid: id, d: r2(dmg), hp: r2(Math.max(0, p.hp)), hard: r2(p.hard), src });
    if (p.hp <= 0) {
      p.hp = 0;
      p.hard = 0;
      p.alive = false;
      p.deathPos = { ...p.pos };
      p.revive = 0;
      p.stats.deaths++;
      p.respawnAt = this.time + PLAYER.respawnTime;
      this.emit({ t: 'pdie', pid: id });
      this.checkDefeat();
    }
  }

  playerFx(id: string, raw: unknown): void {
    const m = obj(raw);
    if (!this.players.has(id) || !m) return;
    const fx = cleanFx(m);
    if (fx) this.emit({ t: 'fx', from: id, fx });
  }

  retry(): void {
    if (this.phase !== 'over') return;
    this.enemies.clear();
    this.projectiles.clear();
    this.queue = [];
    let i = 0;
    for (const p of this.players.values()) {
      const sp = PLAYER_SPAWNS[i++ % PLAYER_SPAWNS.length];
      p.pos = { ...sp };
      p.vel = { x: 0, y: 0, z: 0 };
      p.hp = PLAYER.maxHealth;
      p.hard = 0;
      p.alive = true;
      this.emit({ t: 'prespawn', pid: p.id, p: vv(sp) });
    }
    this.pickupAt.fill(0);
    this.emit({ t: 'reset', wave: this.wave });
    this.beginIntermission(this.wave, 3);
  }

  // ----------------------------------------------------------------- stepping

  step(dt: number): void {
    this.time += dt;
    this.updatePhase(dt);
    for (const p of this.players.values()) {
      p.budget = Math.min(BUDGET_MAX, p.budget + BUDGET_REFILL * dt);
      p.boomTokens = Math.min(BOOM_TOKENS, p.boomTokens + BOOM_REFILL * dt);
      p.healBudget = Math.min(BLOOD_HEAL_RATE, p.healBudget + BLOOD_HEAL_RATE * dt);
      // co-op revive: a living partner standing on your corpse brings you back early
      if (!p.alive && p.respawnAt > 0 && this.phase !== 'over' && this.phase !== 'victory') {
        let helping = false;
        for (const o of this.players.values()) {
          if (o !== p && o.alive && o.connected && dist(o.pos, p.deathPos) < REVIVE_RADIUS) helping = true;
        }
        p.revive = helping ? p.revive + dt : Math.max(0, p.revive - dt * 0.5);
        if (p.revive >= REVIVE_TIME) {
          const by = [...this.players.values()].find((o) => o !== p && o.alive && dist(o.pos, p.deathPos) < REVIVE_RADIUS);
          this.respawn(p, p.deathPos, 50);
          this.emit({ t: 'revive', pid: p.id, by: by?.id ?? '' });
          continue;
        }
      }
      if (p.hard > 0) {
        p.hardT -= dt;
        if (p.hardT <= 0) p.hard = Math.max(0, p.hard - PLAYER.hardDamageDecay * dt);
      }
      if (!p.alive && this.phase !== 'over' && this.phase !== 'victory' && this.time >= p.respawnAt && p.respawnAt > 0) this.respawn(p);
    }
    this.updatePickups();
    for (const e of this.enemies.values()) this.updateEnemy(e, dt);
    for (const pr of this.projectiles.values()) this.updateProjectile(pr, dt);
  }

  /** Walk over a health pickup to take it; it's left alone if you're already full. */
  private updatePickups(): void {
    for (let i = 0; i < HEALTH_PICKUPS.length; i++) {
      if (this.time < this.pickupAt[i]) continue;
      const spot = HEALTH_PICKUPS[i];
      const def = spot.large ? HEALTH_PICKUP.large : HEALTH_PICKUP.small;
      for (const p of this.players.values()) {
        if (!p.alive || !p.connected || p.hp >= PLAYER.maxHealth) continue;
        if (distXZ(p.pos, spot.pos) > HEALTH_PICKUP.radius || p.pos.y < spot.pos.y - 0.5 || p.pos.y > spot.pos.y + 2) continue;
        // pickups restore hard damage too (small ones only as much as they heal)
        p.hard = Math.max(0, p.hard - (spot.large ? PLAYER.maxHealth : def.heal));
        const before = p.hp;
        p.hp = Math.min(PLAYER.maxHealth - p.hard, p.hp + def.heal);
        this.pickupAt[i] = this.time + def.respawn;
        this.emit({ t: 'pickup', i, pid: p.id });
        this.emit({ t: 'heal', pid: p.id, hp: r2(p.hp), amt: r2(p.hp - before), hard: r2(p.hard) });
        break;
      }
    }
  }

  drainEvents(): GameEvent[] {
    const ev = this.events;
    this.events = [];
    return ev;
  }

  snapshot(): Snapshot {
    const e = [...this.enemies.values()].map(
      (x) => [x.id, ENEMY_KINDS.indexOf(x.kind), r2(x.pos.x), r2(x.pos.y), r2(x.pos.z), r2(x.yaw), ENEMY_STATES.indexOf(x.state), Math.ceil(x.hp)] as Snapshot['e'][number],
    );
    const pr = [...this.projectiles.values()].map(
      (x) => [x.id, PROJ_KINDS.indexOf(x.kind), r2(x.pos.x), r2(x.pos.y), r2(x.pos.z), r2(x.vel.x), r2(x.vel.y), r2(x.vel.z), x.kind === 'reflected' ? 1 : 0] as Snapshot['pr'][number],
    );
    const pl = [...this.players.values()].map(
      (p) => [p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.vel.x), r2(p.vel.y), r2(p.vel.z), r2(p.yaw), r2(p.pitch), p.flags, p.weapon, Math.ceil(p.hp), p.alive ? 1 : 0, Math.floor(p.hard), p.connected ? 1 : 0, r2(p.revive / REVIVE_TIME), r2(p.deathPos.x), r2(p.deathPos.y), r2(p.deathPos.z)] as PlayerSnap,
    );
    return { t: r2(this.time), e, pr, pl, wave: this.wave, phase: this.phase, left: this.waveLeft, timer: r2(this.phaseTimer), pk: this.pickupMask() };
  }

  private pickupMask(): number {
    let m = 0;
    for (let i = 0; i < this.pickupAt.length; i++) if (this.time >= this.pickupAt[i]) m |= 1 << i;
    return m;
  }

  // -------------------------------------------------------------------- waves

  private beginIntermission(wave: number, delay: number): void {
    this.phase = 'intermission';
    this.wave = wave;
    this.phaseTimer = delay;
  }

  private startWave(n: number): void {
    const def = WAVES[n - 1];
    this.phase = 'combat';
    this.wave = n;
    const coop = Math.max(1, this.connectedCount());
    this.queue = [];
    for (const g of def.groups) {
      const count = g.kind === 'colossus' || g.kind === 'brute' ? g.count : Math.round(g.count * (1 + 0.5 * (coop - 1)));
      for (let i = 0; i < count; i++) this.queue.push({ kind: g.kind, at: this.time + g.delay + i * 0.45, where: g.where });
    }
    this.queue.sort((a, b) => a.at - b.at);
    this.waveLeft = this.queue.length;
    this.emit({ t: 'wave', n, total: WAVES.length, title: def.title, boss: !!def.boss });
  }

  private updatePhase(dt: number): void {
    if (this.phase === 'intermission') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.startWave(this.wave);
    } else if (this.phase === 'combat') {
      let alive = 0;
      for (const e of this.enemies.values()) if (e.hp > 0) alive++;
      const cap = this.wave > 4 ? MAX_ALIVE + 4 : MAX_ALIVE;
      while (this.queue.length && this.queue[0].at <= this.time && alive < cap) {
        const q = this.queue.shift()!;
        this.spawnEnemy(q.kind, q.where);
        alive++;
      }
      // if the arena is empty, pull the next group forward so pacing never stalls
      if (alive === 0 && this.queue.length) this.queue[0].at = Math.min(this.queue[0].at, this.time + 0.6);
      if (alive === 0 && this.queue.length === 0) {
        this.emit({ t: 'clear', n: this.wave });
        if (this.wave >= WAVES.length) this.finish(true);
        else {
          for (const p of this.players.values()) if (!p.alive) this.respawn(p);
          this.beginIntermission(this.wave + 1, 5);
        }
      }
    }
  }

  private finish(win: boolean): void {
    this.phase = win ? 'victory' : 'over';
    this.projectiles.clear();
    this.emit({
      t: 'over', win, wave: this.wave, time: r2(this.time - this.runStart),
      stats: [...this.players.values()].map((p) => ({ ...p.stats, damage: Math.round(p.stats.damage), taken: Math.round(p.stats.taken) })),
    });
  }

  private checkDefeat(): void {
    if (this.phase !== 'combat' && this.phase !== 'intermission') return;
    if (this.players.size === 0) return;
    for (const p of this.players.values()) if (p.alive && p.connected) return;
    this.finish(false);
  }

  private respawn(p: SimPlayer, at?: Vec3, hp: number = PLAYER.maxHealth): void {
    const sp = at ?? PLAYER_SPAWNS[Math.floor(this.rand() * PLAYER_SPAWNS.length)];
    p.pos = { ...sp };
    p.vel = { x: 0, y: 0, z: 0 };
    p.hp = hp;
    p.hard = 0;
    p.alive = true;
    p.respawnAt = 0;
    p.revive = 0;
    this.emit({ t: 'prespawn', pid: p.id, p: vv(sp) });
  }

  /** Players still in the room (dropped players waiting to reconnect don't count). */
  private connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  private spawnEnemy(kind: EnemyKind, where: 'ground' | 'tower' | 'air'): void {
    const def = ENEMIES[kind];
    const list = kind === 'colossus' ? [{ x: 0, y: 0, z: -24 }] : where === 'tower' ? TOWER_SPAWNS : where === 'air' ? AIR_SPAWNS : GROUND_SPAWNS;
    // prefer spawn points away from players
    let best = list[0], bestScore = -1;
    for (let i = 0; i < 4; i++) {
      const c = list[Math.floor(this.rand() * list.length)];
      let near = 1e9;
      for (const p of this.players.values()) near = Math.min(near, distXZ(p.pos, c));
      const score = Math.min(near, 30) + this.rand() * 6;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    const jitter = kind === 'colossus' ? 0 : 2.5;
    const pos = { x: best.x + (this.rand() - 0.5) * jitter, y: best.y, z: best.z + (this.rand() - 0.5) * jitter };
    const coopHp = (kind === 'colossus' || kind === 'brute') && this.connectedCount() > 1 ? 1.5 : 1;
    const e: SimEnemy = {
      id: this.nextId++, kind, pos, vel: { x: 0, y: 0, z: 0 }, yaw: Math.atan2(pos.x, pos.z),
      hp: def.hp * coopHp, maxHp: def.hp * coopHp, state: 'spawn', stateT: kind === 'colossus' ? 2.5 : 0.9,
      target: null, retargetT: 0, cooldown: 1 + this.rand() * 1.5, attack: '', grounded: false,
      burstLeft: 0, strafeDir: this.rand() < 0.5 ? -1 : 1, phase: 1,
      summonT: ENEMY_ATTACKS.colossus.summonEvery, cycle: 0, shots: 0,
      lastStrikeT: -9, lastStrikeAid: 0, lastStrikeDmg: 0, invulnT: 0, blinkCd: 2 + this.rand() * 2,
    };
    this.enemies.set(e.id, e);
    this.emit({ t: 'spawn', id: e.id, k: kind, p: vv(pos) });
  }

  // ------------------------------------------------------------------ damage

  private damageEnemy(e: SimEnemy, dmg: number, by: string, how: string, hs: boolean, p: SimPlayer): void {
    if (e.hp <= 0 || dmg <= 0 || e.invulnT > 0) return;
    // phase gates: the colossus can't be burst through a phase in one volley
    if (e.kind === 'colossus') {
      const nextGate = e.phase === 1 ? (e.maxHp * 2) / 3 : e.phase === 2 ? e.maxHp / 3 : 0;
      if (nextGate > 0 && e.hp - dmg < nextGate) dmg = e.hp - nextGate + 1;
    }
    const dealt = Math.min(dmg, e.hp);
    e.hp -= dmg;
    p.stats.damage += dealt;
    // blood heals the aggressive: damage dealt up close restores (soft) health,
    // rate-limited, and armoured heavies bleed less
    if (p.alive && dist(p.pos, e.pos) < PLAYER.bloodHealRange + ENEMIES[e.kind].radius) {
      const want = dealt * PLAYER.bloodHealFactor * (ENEMIES[e.kind].heavy ? 0.5 : 1);
      const amt = Math.min(want, p.healBudget);
      p.healBudget -= amt;
      this.healPlayer(p, amt, false);
    }
    this.emit({ t: 'dmg', id: e.id, d: r2(dealt), by, hs, k: how, p: vv(e.pos) });
    if (e.kind === 'colossus') {
      const ph = e.hp < e.maxHp / 3 + 2 ? 3 : e.hp < (e.maxHp * 2) / 3 + 2 ? 2 : 1;
      if (ph > e.phase && e.hp > 0) {
        e.phase = ph;
        e.cooldown = 0.4;
        e.invulnT = 2;
        e.summonT = Math.min(e.summonT, 2);
        this.emit({ t: 'enrage', id: e.id });
      }
    }
    if (e.hp <= 0) {
      p.stats.kills++;
      this.enemies.delete(e.id);
      this.waveLeft = Math.max(0, this.waveLeft - 1);
      this.emit({ t: 'kill', id: e.id, k: e.kind, by, how, p: vv(e.pos), hs });
    }
  }

  /** Healing can't restore hard damage; parries are the exception and burn it off. */
  private healPlayer(p: SimPlayer, amt: number, clearsHard: boolean): void {
    if (!p.alive || amt <= 0) return;
    if (clearsHard) p.hard = Math.max(0, p.hard - amt * 0.5);
    const cap = PLAYER.maxHealth - p.hard;
    if (p.hp >= cap) return;
    const before = p.hp;
    p.hp = Math.min(cap, p.hp + amt);
    this.emit({ t: 'heal', pid: p.id, hp: r2(p.hp), amt: r2(p.hp - before), hard: r2(p.hard) });
  }

  private emit(e: GameEvent): void {
    this.events.push(e);
  }

  private aid(): number {
    return this.nextAid++;
  }

  // ---------------------------------------------------------------------- AI

  private pickTarget(e: SimEnemy): SimPlayer | null {
    let cur = e.target ? this.players.get(e.target) : undefined;
    if (cur && (!cur.alive || !cur.connected)) cur = undefined;
    if (!cur || this.time > e.retargetT) {
      let best: SimPlayer | null = null, bd = 1e9;
      for (const p of this.players.values()) {
        if (!p.alive || !p.connected) continue;
        // sticky: small bias toward the current target to stop flip-flopping
        const d = dist(p.pos, e.pos) - (p.id === e.target ? 4 : 0);
        if (d < bd) { bd = d; best = p; }
      }
      e.target = best ? best.id : null;
      e.retargetT = this.time + 1.2;
      return best;
    }
    return cur;
  }

  private face(e: SimEnemy, to: Vec3, dt: number, rate = 8): void {
    const want = Math.atan2(-(to.x - e.pos.x), -(to.z - e.pos.z));
    e.yaw += clamp(angleDiff(e.yaw, want), -rate * dt, rate * dt);
  }

  private setState(e: SimEnemy, s: EnemyState, t: number, attack = ''): void {
    e.state = s;
    e.stateT = t;
    if (attack) e.attack = attack;
  }

  private updateEnemy(e: SimEnemy, dt: number): void {
    const def = ENEMIES[e.kind];
    e.stateT -= dt;
    e.cooldown -= dt;
    e.invulnT = Math.max(0, e.invulnT - dt);
    e.blinkCd -= dt;
    if (e.state === 'spawn') {
      if (e.stateT <= 0) this.setState(e, 'move', 0);
      if (!def.flying) this.physics(e, dt, 0, 0);
      return;
    }
    const tgt = this.phase === 'combat' || this.phase === 'intermission' ? this.pickTarget(e) : null;
    switch (e.kind) {
      case 'husk': this.aiHusk(e, tgt, dt); break;
      case 'stalker': this.aiStalker(e, tgt, dt); break;
      case 'eye': this.aiEye(e, tgt, dt); break;
      case 'warden': this.aiWarden(e, tgt, dt); break;
      case 'drone': this.aiDrone(e, tgt, dt); break;
      case 'brute': this.aiBrute(e, tgt, dt); break;
      case 'colossus': this.aiColossus(e, tgt, dt); break;
    }
    if (e.pos.y < -5) { e.pos.y = 1; e.vel.y = 0; }
  }

  /** Ground locomotion with separation + wall sliding. wishX/wishZ is desired velocity. */
  private physics(e: SimEnemy, dt: number, wishX: number, wishZ: number, accel = 30): void {
    const def = ENEMIES[e.kind];
    for (const o of this.enemies.values()) {
      if (o === e) continue;
      const dx = e.pos.x - o.pos.x, dz = e.pos.z - o.pos.z;
      const min = def.radius + ENEMIES[o.kind].radius;
      const d2 = dx * dx + dz * dz;
      if (d2 < min * min && d2 > 1e-6) {
        const d = Math.sqrt(d2);
        wishX += (dx / d) * 6 * (1 - d / min);
        wishZ += (dz / d) * 6 * (1 - d / min);
      }
    }
    const k = Math.min(1, (accel * dt) / 10);
    e.vel.x += (wishX - e.vel.x) * k;
    e.vel.z += (wishZ - e.vel.z) * k;
    if (def.flying) {
      e.pos.x = clamp(e.pos.x + e.vel.x * dt, -34, 34);
      e.pos.y = clamp(e.pos.y + e.vel.y * dt, 1.5, 16);
      e.pos.z = clamp(e.pos.z + e.vel.z * dt, -34, 34);
      return;
    }
    e.vel.y -= PLAYER.gravity * dt;
    const res = moveBody(e.pos, e.vel, dt, def.radius * 0.7, def.height * 0.9, 0.7, e.grounded);
    e.grounded = res.onGround;
    if (res.wallNormal && (wishX || wishZ)) {
      const tx = -res.wallNormal.z * e.strafeDir, tz = res.wallNormal.x * e.strafeDir;
      e.vel.x += tx * 6;
      e.vel.z += tz * 6;
    }
  }

  /** Where a target will be after `t` seconds (ground-plane lead). */
  private lead(t: SimPlayer, time: number, frac = 1): Vec3 {
    return { x: t.pos.x + t.vel.x * time * frac, y: t.pos.y, z: t.pos.z + t.vel.z * time * frac };
  }

  private aiHusk(e: SimEnemy, t: SimPlayer | null, dt: number): void {
    const a = ENEMY_ATTACKS.husk;
    if (!t) { this.physics(e, dt, 0, 0); return; }
    const d = distXZ(e.pos, t.pos);
    const dy = t.pos.y - e.pos.y;
    const dx = t.pos.x - e.pos.x, dz = t.pos.z - e.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    switch (e.state) {
      case 'move': {
        this.face(e, t.pos, dt, 10);
        this.physics(e, dt, (dx / l) * ENEMIES.husk.speed, (dz / l) * ENEMIES.husk.speed);
        if (d < a.range && Math.abs(dy) < 2.2) {
          this.setState(e, 'windup', a.windup, 'swipe');
          this.emit({ t: 'atk', id: e.id, a: 'swipe', dur: a.windup });
        } else if (e.grounded && dy > 2.5 && d < 9 && e.cooldown <= 0) {
          // leap up at players camping on high ground
          e.vel.y = 19;
          e.vel.x = (dx / l) * 8;
          e.vel.z = (dz / l) * 8;
          e.cooldown = 3;
          this.emit({ t: 'atk', id: e.id, a: 'leap', dur: 0.6 });
        }
        break;
      }
      case 'windup': {
        // keeps tracking for the first 60% of the wind-up, then commits
        const tracking = e.stateT > a.windup * 0.4;
        if (tracking) this.face(e, t.pos, dt, 9);
        this.physics(e, dt, tracking ? (dx / l) * 5 : 0, tracking ? (dz / l) * 5 : 0);
        if (e.stateT <= 0) {
          // commit: lunge forward; the blow lands 0.08 s later wherever the lunge carried it
          const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
          e.vel.x = fx * a.lunge;
          e.vel.z = fz * a.lunge;
          this.setState(e, 'attack', 0.08);
        }
        break;
      }
      case 'attack':
        this.physics(e, dt, e.vel.x, e.vel.z, 60);
        if (e.stateT <= 0) {
          this.strike(e, 1.4, 1.8, a.damage);
          this.setState(e, 'recover', a.recover);
        }
        break;
      case 'stun':
      case 'recover':
        this.physics(e, dt, 0, 0);
        if (e.stateT <= 0) this.setState(e, 'move', 0);
        break;
      default:
        this.setState(e, 'move', 0);
    }
  }

  /** Emit a melee hit volume in front of an enemy and remember it for late parries. */
  private strike(e: SimEnemy, reach: number, r: number, d: number): void {
    const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
    const hit = { x: e.pos.x + fx * reach, y: e.pos.y + 1, z: e.pos.z + fz * reach };
    const aid = this.aid();
    e.lastStrikeT = this.time;
    e.lastStrikeAid = aid;
    e.lastStrikeDmg = d;
    this.emit({ t: 'melee', id: e.id, aid, p: vv(hit), r, d });
  }

  /** Stalker: a fast flanker that blinks behind its target and slashes. Interrupt or dash. */
  private aiStalker(e: SimEnemy, t: SimPlayer | null, dt: number): void {
    const a = ENEMY_ATTACKS.stalker;
    if (!t) { this.physics(e, dt, 0, 0); return; }
    const d = distXZ(e.pos, t.pos);
    const dx = t.pos.x - e.pos.x, dz = t.pos.z - e.pos.z;
    const l = Math.hypot(dx, dz) || 1;
    switch (e.state) {
      case 'move': {
        this.face(e, t.pos, dt, 12);
        // weave while closing in so it's hard to track
        const weave = Math.sin(this.time * 4 + e.id) * 0.6;
        const sp = ENEMIES.stalker.speed;
        this.physics(e, dt, ((dx / l) + (-dz / l) * weave) * sp, ((dz / l) + (dx / l) * weave) * sp);
        if (d < a.range && Math.abs(t.pos.y - e.pos.y) < 2.2) {
          this.setState(e, 'windup', a.windup, 'slash');
          this.emit({ t: 'atk', id: e.id, a: 'slash', dur: a.windup });
        } else if (e.blinkCd <= 0 && d < 28 && t.pos.y < 3) {
          // blink to the target's flank/back
          const side = this.rand() < 0.5 ? 1 : -1;
          const back = -1;
          const fwdX = -Math.sin(t.yaw), fwdZ = -Math.cos(t.yaw);
          const to = {
            x: clamp(t.pos.x + fwdX * back * a.blinkDist + -fwdZ * side * 2, -34, 34),
            y: t.pos.y,
            z: clamp(t.pos.z + fwdZ * back * a.blinkDist + fwdX * side * 2, -34, 34),
          };
          if (!blockedAt(to.x, to.y + 0.05, to.z, 0.4, 1.8)) {
            this.emit({ t: 'atk', id: e.id, a: 'blink', dur: 0.1, target: vv(e.pos) });
            e.pos = to;
            e.vel = { x: 0, y: 0, z: 0 };
            this.face(e, t.pos, 1, 100);
            this.setState(e, 'windup', a.windup + 0.1, 'slash');
            this.emit({ t: 'atk', id: e.id, a: 'slash', dur: a.windup + 0.1 });
          }
          e.blinkCd = a.blinkEvery * (0.8 + this.rand() * 0.5);
        }
        break;
      }
      case 'windup':
        if (e.stateT > 0.12) this.face(e, t.pos, dt, 10);
        this.physics(e, dt, 0, 0);
        if (e.stateT <= 0) {
          this.strike(e, 1.5, 1.9, a.damage);
          this.setState(e, 'recover', 0.45);
        }
        break;
      default:
        this.physics(e, dt, 0, 0);
        if (e.stateT <= 0) this.setState(e, 'move', 0);
    }
  }

  private aiEye(e: SimEnemy, t: SimPlayer | null, dt: number): void {
    const a = ENEMY_ATTACKS.eye;
    if (!t) { this.physics(e, dt, 0, 0); e.vel.y *= 0.9; return; }
    const eyeTarget = { x: t.pos.x, y: t.pos.y + 1.2, z: t.pos.z };
    this.face(e, eyeTarget, dt, 10);
    switch (e.state) {
      case 'move': {
        const wob = Math.sin(this.time * 3 + e.id) * 4;
        const dx = eyeTarget.x - e.pos.x, dy = eyeTarget.y + 2 - e.pos.y, dz = eyeTarget.z - e.pos.z;
        const l = Math.hypot(dx, dy, dz) || 1;
        const sp = ENEMIES.eye.speed;
        e.vel.y += ((dy / l) * sp - e.vel.y) * Math.min(1, 3 * dt);
        this.physics(e, dt, (dx / l) * sp + (-dz / l) * wob, (dz / l) * sp + (dx / l) * wob);
        if (l < 8 && e.cooldown <= 0) {
          this.setState(e, 'windup', a.windup, 'dive');
          this.emit({ t: 'atk', id: e.id, a: 'dive', dur: a.windup });
        }
        break;
      }
      case 'windup':
        e.vel.x *= 0.85; e.vel.y *= 0.85; e.vel.z *= 0.85;
        this.physics(e, dt, e.vel.x, e.vel.z);
        if (e.stateT <= 0) {
          const lp = this.lead(t, 0.3, 0.8);
          const dx = lp.x - e.pos.x, dy = lp.y + 0.8 - e.pos.y, dz = lp.z - e.pos.z;
          const l = Math.hypot(dx, dy, dz) || 1;
          e.vel = { x: (dx / l) * a.diveSpeed, y: (dy / l) * a.diveSpeed, z: (dz / l) * a.diveSpeed };
          this.setState(e, 'dive', 0.75);
        }
        break;
      case 'dive': {
        e.pos.x += e.vel.x * dt; e.pos.y += e.vel.y * dt; e.pos.z += e.vel.z * dt;
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (dist({ x: p.pos.x, y: p.pos.y + 1, z: p.pos.z }, e.pos) < a.range + 0.6) {
            this.emit({ t: 'melee', id: e.id, aid: this.aid(), p: vv(e.pos), r: 2.4, d: a.damage });
            this.emit({ t: 'boom', p: vv(e.pos), r: 2.4, d: 0, hostile: false, aid: 0, k: 'eye' });
            e.hp = 0;
            this.enemies.delete(e.id);
            this.waveLeft = Math.max(0, this.waveLeft - 1);
            this.emit({ t: 'kill', id: e.id, k: e.kind, by: '', how: 'self', p: vv(e.pos), hs: false });
            return;
          }
        }
        if (e.pos.y < 0.6 || e.stateT <= 0) {
          e.pos.y = Math.max(e.pos.y, 0.8);
          e.cooldown = 1.6;
          this.setState(e, 'move', 0);
        }
        break;
      }
      default:
        if (e.stateT <= 0) this.setState(e, 'move', 0);
        this.physics(e, dt, 0, 0);
    }
  }

  private aiWarden(e: SimEnemy, t: SimPlayer | null, dt: number): void {
    const a = ENEMY_ATTACKS.warden;
    if (!t) { this.physics(e, dt, 0, 0); return; }
    const head = { x: e.pos.x, y: e.pos.y + ENEMIES.warden.headY, z: e.pos.z };
    const tp = { x: t.pos.x, y: t.pos.y + 1.1, z: t.pos.z };
    const d = distXZ(e.pos, t.pos);
    switch (e.state) {
      case 'move': {
        this.face(e, t.pos, dt, 6);
        const dx = t.pos.x - e.pos.x, dz = t.pos.z - e.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        let fwd = 0;
        if (d > a.preferredMax) fwd = 1;
        else if (d < a.preferredMin) fwd = -1;
        const sp = ENEMIES.warden.speed;
        if (this.rand() < dt * 0.3) e.strafeDir *= -1;
        this.physics(e, dt, ((dx / l) * fwd + (-dz / l) * e.strafeDir * 0.6) * sp, ((dz / l) * fwd + (dx / l) * e.strafeDir * 0.6) * sp);
        if (e.cooldown <= 0 && d < 45 && lineOfSight(head, tp)) {
          this.setState(e, 'windup', a.windup, 'orb');
          this.emit({ t: 'atk', id: e.id, a: 'orb', dur: a.windup });
        }
        break;
      }
      case 'windup':
        this.face(e, t.pos, dt, 8);
        this.physics(e, dt, 0, 0);
        if (e.stateT <= 0) {
          // alternate between a direct shot and a fully-led one so strafing alone won't save you
          const flight = dist(head, tp) / a.orbSpeed;
          const frac = e.shots++ % 2 === 0 ? 1 : 0.35;
          const aimP = { x: tp.x + t.vel.x * flight * frac, y: tp.y, z: tp.z + t.vel.z * flight * frac };
          this.fireProjectile('orb', head, aimP, a.orbSpeed, a.orbDamage, e);
          e.cooldown = a.cooldown * (0.8 + this.rand() * 0.5);
          this.setState(e, 'recover', 0.4);
        }
        break;
      default:
        this.physics(e, dt, 0, 0);
        if (e.stateT <= 0) this.setState(e, 'move', 0);
    }
  }

  private aiDrone(e: SimEnemy, t: SimPlayer | null, dt: number): void {
    const a = ENEMY_ATTACKS.drone;
    if (!t) { this.physics(e, dt, 0, 0); return; }
    const tp = { x: t.pos.x, y: t.pos.y + 1.1, z: t.pos.z };
    this.face(e, tp, dt, 8);
    const ang = Math.atan2(e.pos.z - t.pos.z, e.pos.x - t.pos.x) + e.strafeDir * 0.6 * dt * 2;
    const radius = 14 + Math.sin(this.time * 0.7 + e.id) * 3;
    const want = { x: t.pos.x + Math.cos(ang) * radius, y: t.pos.y + 6 + Math.sin(this.time + e.id) * 1.5, z: t.pos.z + Math.sin(ang) * radius };
    const sp = ENEMIES.drone.speed;
    const dx = want.x - e.pos.x, dy = want.y - e.pos.y, dz = want.z - e.pos.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    const k = Math.min(1, l / 3);
    e.vel.y += ((dy / l) * sp * k - e.vel.y) * Math.min(1, 3 * dt);
    const moving = e.state === 'move';
    this.physics(e, dt, moving ? (dx / l) * sp * k : e.vel.x * 0.9, moving ? (dz / l) * sp * k : e.vel.z * 0.9);
    if (this.rand() < dt * 0.25) e.strafeDir *= -1;
    const muzzle = { x: e.pos.x, y: e.pos.y + 0.5, z: e.pos.z };
    switch (e.state) {
      case 'move':
        if (e.cooldown <= 0 && lineOfSight(muzzle, tp)) {
          this.setState(e, 'windup', a.windup, 'burst');
          this.emit({ t: 'atk', id: e.id, a: 'burst', dur: a.windup });
        }
        break;
      case 'windup':
        if (e.stateT <= 0) { e.burstLeft = a.burst; this.setState(e, 'attack', 0); }
        break;
      case 'attack':
        if (e.stateT <= 0) {
          if (e.burstLeft-- > 0) {
            const flight = dist(muzzle, tp) / a.boltSpeed;
            const aim = { x: tp.x + t.vel.x * flight * a.lead + (this.rand() - 0.5), y: tp.y + (this.rand() - 0.5) * 0.6, z: tp.z + t.vel.z * flight * a.lead + (this.rand() - 0.5) };
            this.fireProjectile('bolt', muzzle, aim, a.boltSpeed, a.boltDamage, e);
            e.stateT = a.burstGap;
          } else {
            e.cooldown = a.cooldown * (0.8 + this.rand() * 0.5);
            this.setState(e, 'move', 0);
          }
        }
        break;
      default:
        if (e.stateT <= 0) this.setState(e, 'move', 0);
    }
  }

  private aiBrute(e: SimEnemy, t: SimPlayer | null, dt: number): void {
    const a = ENEMY_ATTACKS.brute;
    if (!t) { this.physics(e, dt, 0, 0); return; }
    const d = distXZ(e.pos, t.pos);
    switch (e.state) {
      case 'move': {
        this.face(e, t.pos, dt, 3);
        const dx = t.pos.x - e.pos.x, dz = t.pos.z - e.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        const sp = ENEMIES.brute.speed * (d > 14 ? 1.3 : 1);
        this.physics(e, dt, (dx / l) * sp, (dz / l) * sp, 12);
        if (d < a.meleeRange && Math.abs(t.pos.y - e.pos.y) < 3) {
          this.setState(e, 'windup', 0.65, 'smash');
          this.emit({ t: 'atk', id: e.id, a: 'smash', dur: 0.65 });
        } else if (e.cooldown <= 0) {
          const stomp = d < 18 ? this.rand() < 0.65 : this.rand() < 0.25;
          if (stomp) {
            this.setState(e, 'windup', a.stompWindup, 'stomp');
            this.emit({ t: 'atk', id: e.id, a: 'stomp', dur: a.stompWindup });
          } else {
            this.setState(e, 'windup', a.mortarWindup, 'mortar');
            this.emit({ t: 'atk', id: e.id, a: 'mortar', dur: a.mortarWindup, target: vv(t.pos) });
          }
        }
        break;
      }
      case 'windup':
        this.face(e, t.pos, dt, e.attack === 'smash' ? 4 : 2);
        this.physics(e, dt, 0, 0, 12);
        if (e.stateT <= 0) {
          this.bruteStrike(e, t, e.attack, 1, 1);
          e.cooldown = a.cooldown * (0.8 + this.rand() * 0.5);
          this.setState(e, 'recover', 0.8);
        }
        break;
      default:
        this.physics(e, dt, 0, 0, 12);
        if (e.stateT <= 0) this.setState(e, 'move', 0);
    }
  }

  private bruteStrike(e: SimEnemy, t: SimPlayer, attack: string, sizeMul: number, mortars: number): void {
    const a = ENEMY_ATTACKS.brute;
    const def = ENEMIES[e.kind];
    if (attack === 'smash') {
      const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
      const p = { x: e.pos.x + fx * 2.4 * sizeMul, y: e.pos.y + 1, z: e.pos.z + fz * 2.4 * sizeMul };
      const aid = this.aid();
      e.lastStrikeT = this.time;
      e.lastStrikeAid = aid;
      e.lastStrikeDmg = a.meleeDamage;
      this.emit({ t: 'melee', id: e.id, aid, p: vv(p), r: 2.6 * sizeMul, d: a.meleeDamage });
      this.emit({ t: 'boom', p: vv({ x: p.x, y: e.pos.y, z: p.z }), r: 2, d: 0, hostile: false, aid: 0, k: 'dust' });
    } else if (attack === 'stomp') {
      this.emit({ t: 'shock', id: e.id, aid: this.aid(), p: vv(e.pos), speed: a.waveSpeed * (sizeMul > 1 ? 1.2 : 1), range: a.waveRange * sizeMul, d: a.stompDamage });
    } else if (attack === 'mortar') {
      for (let i = 0; i < mortars; i++) {
        const T = 1.25 + i * 0.15;
        const spread = i === 0 ? 0 : 5;
        // lead the full flight time: standing still or running straight both get punished
        const lp = this.lead(t, T, 1);
        const land = { x: lp.x + (this.rand() - 0.5) * spread * 2, y: t.pos.y, z: lp.z + (this.rand() - 0.5) * spread * 2 };
        const from = { x: e.pos.x, y: e.pos.y + def.height * 0.85, z: e.pos.z };
        const g = PROJECTILES.mortar.gravity;
        const vel = { x: (land.x - from.x) / T, y: (land.y - from.y) / T + 0.5 * g * T, z: (land.z - from.z) / T };
        this.spawnProjectile('mortar', from, vel, a.mortarDamage, e);
      }
    }
  }

  private aiColossus(e: SimEnemy, t: SimPlayer | null, dt: number): void {
    const c = ENEMY_ATTACKS.colossus;
    if (!t) { this.physics(e, dt, 0, 0, 8); return; }
    const d = distXZ(e.pos, t.pos);
    const rage = e.phase === 3 ? 1.6 : e.phase === 2 ? 1.3 : 1;
    const head = { x: e.pos.x, y: e.pos.y + ENEMIES.colossus.headY, z: e.pos.z };
    e.summonT -= dt;
    switch (e.state) {
      case 'move': {
        this.face(e, t.pos, dt, 1.6 * rage);
        const dx = t.pos.x - e.pos.x, dz = t.pos.z - e.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        const sp = d > 10 ? ENEMIES.colossus.speed * rage : 0;
        this.physics(e, dt, (dx / l) * sp, (dz / l) * sp, 8);
        if (e.summonT <= 0) {
          e.summonT = c.summonEvery / rage;
          this.setState(e, 'windup', 1.0, 'summon');
          this.emit({ t: 'atk', id: e.id, a: 'summon', dur: 1.0 });
        } else if (e.cooldown <= 0) {
          // each phase adds a new trick to the rotation
          const moves = d < 7 ? ['smash', 'stomp']
            : e.phase === 1 ? ['stomp', 'mortar', 'beam', 'mortar']
            : e.phase === 2 ? ['ring', 'mortar', 'beam', 'stomp', 'ring']
            : ['ring', 'beam', 'mortar', 'ring', 'stomp', 'beam'];
          const next = moves[e.cycle++ % moves.length];
          const dur = next === 'beam' ? c.beamWindup / Math.sqrt(rage) : next === 'smash' ? 0.8 : next === 'ring' ? 0.9 : 1.0 / rage + 0.2;
          this.setState(e, 'windup', dur, next);
          this.emit({ t: 'atk', id: e.id, a: next, dur, target: vv(t.pos) });
        }
        break;
      }
      case 'windup':
        this.face(e, t.pos, dt, e.attack === 'beam' ? 3 : 2);
        this.physics(e, dt, 0, 0, 8);
        if (e.stateT <= 0) {
          if (e.attack === 'summon') {
            const eyes = e.phase === 3 ? 4 : 3;
            for (let i = 0; i < eyes; i++) this.spawnEnemy('eye', 'air');
            this.spawnEnemy('husk', 'ground');
            if (e.phase >= 2) this.spawnEnemy('warden', 'tower');
            this.waveLeft += eyes + 1 + (e.phase >= 2 ? 1 : 0);
            e.cooldown = 1.5;
            this.setState(e, 'recover', 0.6);
          } else if (e.attack === 'beam') {
            const toT = { x: t.pos.x - head.x, y: t.pos.y + 1 - head.y, z: t.pos.z - head.z };
            const yawTo = Math.atan2(-toT.x, -toT.z);
            const pitch = Math.atan2(toT.y, Math.hypot(toT.x, toT.z));
            const dir = this.rand() < 0.5 ? 1 : -1;
            const sweep = c.beamSweep * dir * (e.phase === 3 ? 1.6 : 1);
            const dur = c.beamTime * (e.phase === 3 ? 1.3 : 1);
            this.emit({ t: 'beam', id: e.id, aid: this.aid(), p: vv(head), yaw0: r2(yawTo - sweep / 2), sweep: r2(sweep), pitch: r2(pitch), dur, dps: c.beamDps });
            this.setState(e, 'beam', dur);
          } else if (e.attack === 'ring') {
            // a parryable ring of orbs: jump it, dash it, or punch one back
            const n = c.ringOrbs + (e.phase === 3 ? 6 : 0);
            const off = this.rand() * Math.PI * 2;
            for (let i = 0; i < n; i++) {
              const a = off + (i / n) * Math.PI * 2;
              const from = { x: head.x, y: e.pos.y + 1.4, z: head.z };
              this.spawnProjectile('orb', from, { x: Math.cos(a) * c.ringSpeed, y: 0, z: Math.sin(a) * c.ringSpeed }, 18, e);
            }
            e.cooldown = 1.6 / rage;
            this.setState(e, 'recover', 0.5);
          } else {
            this.bruteStrike(e, t, e.attack, 1.8, e.phase >= 2 ? 3 : 2);
            e.cooldown = (2.2 + this.rand()) / rage;
            this.setState(e, 'recover', 0.7 / rage);
          }
        }
        break;
      case 'beam':
        this.physics(e, dt, 0, 0, 8);
        if (e.stateT <= 0) {
          e.cooldown = 2 / rage;
          this.setState(e, 'recover', 0.6);
        }
        break;
      default:
        this.physics(e, dt, 0, 0, 8);
        if (e.stateT <= 0) this.setState(e, 'move', 0);
    }
  }

  // -------------------------------------------------------------- projectiles

  private fireProjectile(kind: ProjectileKind, from: Vec3, at: Vec3, speed: number, damage: number, e: SimEnemy): void {
    const dx = at.x - from.x, dy = at.y - from.y, dz = at.z - from.z;
    const l = Math.hypot(dx, dy, dz) || 1;
    this.spawnProjectile(kind, from, { x: (dx / l) * speed, y: (dy / l) * speed, z: (dz / l) * speed }, damage, e);
  }

  private spawnProjectile(kind: ProjectileKind, from: Vec3, vel: Vec3, damage: number, e: SimEnemy): void {
    const id = this.nextId++;
    this.projectiles.set(id, { id, kind, pos: { ...from }, vel, damage, born: this.time, owner: String(e.id) });
  }

  private updateProjectile(pr: SimProjectile, dt: number): void {
    const def = PROJECTILES[pr.kind];
    if (this.time - pr.born > def.life) { this.projectiles.delete(pr.id); return; }
    pr.vel.y -= def.gravity * dt;
    const step = Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z) * dt;
    const dir = { x: (pr.vel.x * dt) / (step || 1), y: (pr.vel.y * dt) / (step || 1), z: (pr.vel.z * dt) / (step || 1) };
    const wall = raycastWorld(pr.pos, dir, step + def.radius * 0.5);
    if (pr.kind === 'reflected') {
      const owner = this.players.get(pr.owner);
      for (const e of this.enemies.values()) {
        const ed = ENEMIES[e.kind];
        const c = { x: e.pos.x, y: e.pos.y + (ed.flying ? 0 : ed.height * 0.55), z: e.pos.z };
        if (dist(c, pr.pos) < ed.radius + (ed.flying ? 0.3 : ed.height * 0.3) + def.radius + step * 0.5) {
          if (owner) this.damageEnemy(e, pr.damage, owner.id, 'parry', false, owner);
          this.explodeReflected(pr, owner);
          return;
        }
      }
      if (wall) { this.explodeReflected(pr, owner); return; }
    } else if (wall) {
      pr.pos.x += dir.x * wall.dist; pr.pos.y += dir.y * wall.dist; pr.pos.z += dir.z * wall.dist;
      this.projectiles.delete(pr.id);
      const hostile = pr.kind === 'mortar';
      this.emit({ t: 'boom', p: vv(pr.pos), r: hostile ? ENEMY_ATTACKS.brute.mortarRadius : 1, d: hostile ? pr.damage : 0, hostile, aid: hostile ? this.aid() : 0, k: pr.kind });
      return;
    }
    pr.pos.x += pr.vel.x * dt; pr.pos.y += pr.vel.y * dt; pr.pos.z += pr.vel.z * dt;
    if (Math.abs(pr.pos.x) > 45 || Math.abs(pr.pos.z) > 45 || pr.pos.y > 70) this.projectiles.delete(pr.id);
  }

  private explodeReflected(pr: SimProjectile, owner: SimPlayer | undefined): void {
    this.projectiles.delete(pr.id);
    if (owner) this.playerBoom(owner.id, { p: vv(pr.pos), r: 4, d: 45, k: 'parry' }, false);
    else this.emit({ t: 'boom', p: vv(pr.pos), r: 4, d: 0, hostile: false, aid: 0, k: 'parry' });
  }

  inLava(p: Vec3): boolean {
    return LAVA.some((z) => inZone(p, z));
  }
}
