// Authoritative world simulation: enemies, AI, projectiles, waves, player health.
// Runs inside the Colyseus room for co-op and inside the browser for solo play.
// Player movement is client-authoritative (instant, lag-free); everything that
// both players must agree on (enemies, damage, waves) is decided here, and every
// client claim is validated and capped before it touches the world.
import {
  AIR_SPAWNS, GROUND_SPAWNS, HEALTH_PICKUPS, LAVA, PLAYER_SPAWNS, TOWER_SPAWNS, blockedAt, inZone, lineOfSight, moveBody, raycastWorld,
} from './arena';
import {
  ENEMIES, ENEMY_ATTACKS, HEALTH_PICKUP, PLAYER, PROJECTILES, PUNCH, SLAM, VARIANTS, WEAPONS, type EnemyKind, type ProjectileKind,
} from './constants';
import { angleDiff, clamp, dist, distXZ, rng, type Vec3 } from './math';
import {
  ELITE_KINDS, ENEMY_KINDS, ENEMY_STATES, PROJ_KINDS, r2,
  type EnemyState, type FxMsg, type GameEvent, type GameMode, type HitKind, type HurtSource, type Phase,
  type PlayerSnap, type PlayerStats, type RunSnap, type Snapshot, type V,
} from './protocol';
import {
  ELITES, FINAL_DEPTH, GATE_RADIUS, GATE_SPOTS, RUN, enemyScale, isBossDepth, layerOf, planGates, planRoom,
  type Challenge, type Elite, type Gate, type Reward, type RoomPlan,
} from './run';
import { UPGRADES, UPGRADE_BY_ID, eligible } from './upgrades';
import { MAX_ALIVE, WAVES, type WaveDef } from './waves';

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
  ups: string[]; // run upgrades
  spent: number; // style spent at forges
  bonus: number; // style granted by caches
  forge: ForgeState | null;
}

interface ForgeState { offers: string[]; free: boolean; buys: number; rerolls: number; done: boolean; rare: boolean }

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
  elite: Elite | null;
  spdMul: number;
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
  beam: VARIANTS.beam.overDamage * WEAPONS.revolver.headshotMult + 1,
  spin: VARIANTS.spin.damage * VARIANTS.spin.bounceMult ** 3 * WEAPONS.revolver.headshotMult + 1,
  hammer: VARIANTS.hammer.tiers[2][1] * (1 + VARIANTS.hammer.pumpMult * 3) + 1,
  slide: VARIANTS.slide.damage + 1,
  burn: VARIANTS.burn.damage + 1,
};
const BOOM_CAP: Partial<Record<HitKind, { r: number; d: number }>> = {
  rocket: { r: WEAPONS.launcher.splashRadius * WEAPONS.launcher.airburstRadiusMult + 0.1, d: WEAPONS.launcher.splashDamage },
  core: { r: WEAPONS.shotgun.coreShotRadius, d: WEAPONS.shotgun.coreShotDamage },
  slam: { r: SLAM.radius, d: SLAM.baseDamage + SLAM.damagePerMeter * 40 },
  pump: { r: VARIANTS.pump.blastRadius, d: VARIANTS.pump.blastDamage },
};
/** Own-property lookup only: "toString"/"constructor" must never resolve to a cap. */
function capOf<T>(table: Partial<Record<HitKind, T>>, k: unknown): T | undefined {
  return typeof k === 'string' && Object.hasOwn(table, k) ? table[k as HitKind] : undefined;
}
const HURT_SOURCES: HurtSource[] = ['proj', 'melee', 'shock', 'beam', 'boom', 'lava', 'self'];
const HIT_RANGE = 110; // arena diagonal is ~100 m
// damage budget ~1.5x the best legitimate sustained DPS (swap-cancel rotation ~350)
const BUDGET_MAX = 1200; // run variants (an overcharged beam through a crowd) spike harder than classic
const BUDGET_REFILL = 700; // per second
const BOOM_TOKENS = 5; // explosion claims: bursts allowed, sustained rate capped
const BOOM_REFILL = 3;
const CLUSTER_TOKENS = 16; // cluster rockets: every rocket is four explosions
const CLUSTER_REFILL = 9;
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
      return from && to && (m.w === 'revolver' || m.w === 'shotgun' || m.w === 'beam') ? { t: 'shot', w: m.w, from, to } : null;
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
  private queue: { kind: EnemyKind; at: number; where: 'ground' | 'tower' | 'air'; el?: Elite }[] = [];
  private nextId = 1;
  private nextAid = 1;
  private rand: () => number;
  private runStart = 0;
  private waveLeft = 0;
  private pickupAt = HEALTH_PICKUPS.map(() => 0); // time each pickup is next available
  mode: GameMode = 'classic';
  /** The player who picks gates in a run (the room host; solo: the only player). */
  hostId = '';
  private runRand: () => number;
  private depth = 0;
  private plan: RoomPlan | null = null;
  private gates: Gate[] = [];
  private prize: Reward | null = null;
  private challenge: Challenge | null = null;
  private trialEnd = 0;
  private forgeEnd = 0;
  private hurtMul = 1; // enemy damage scaling (depth, glass)

  constructor(seed = Date.now()) {
    this.rand = rng(seed);
    this.runRand = rng(seed ^ 0x5eed);
  }

  private has(p: SimPlayer | undefined, id: string): boolean {
    return !!p && p.ups.includes(id);
  }

  /** Style a player can still spend at forges. */
  bank(p: SimPlayer): number {
    return Math.max(0, Math.floor(p.stats.style + p.bonus - p.spent));
  }

  private capMul(p: SimPlayer): number {
    return (this.has(p, 'g_styleengine') ? VARIANTS.styleEngine.mult : 1) * (this.challenge === 'glass' ? 1.5 : 1);
  }

  private hitCap(p: SimPlayer, k: unknown): number | undefined {
    let cap = capOf(HIT_CAP, k);
    if (cap === undefined) return undefined;
    if (k === 'shotgun' && this.has(p, 'v_pump')) cap *= VARIANTS.pump.pellets[2] / WEAPONS.shotgun.pellets;
    return cap * this.capMul(p);
  }

  private boomCap(p: SimPlayer, k: unknown): { r: number; d: number } | undefined {
    const c = capOf(BOOM_CAP, k);
    if (!c) return undefined;
    let { r, d } = c;
    if (k === 'core' && this.has(p, 'm_hotcore')) { r = Math.max(r, VARIANTS.hotCore.radius); d = Math.max(d, VARIANTS.hotCore.damage); }
    if (k === 'rocket' && this.has(p, 'm_cold')) { r *= VARIANTS.freeze.coldMult; d *= VARIANTS.freeze.coldMult; }
    if (k === 'slam' && this.has(p, 'g_kinetic')) { r *= VARIANTS.kinetic.radiusMul; d = SLAM.baseDamage + VARIANTS.kinetic.perMeter * 40; }
    return { r: r + 0.1, d: d * this.capMul(p) + 1 };
  }

  // ------------------------------------------------------------------ players

  addPlayer(id: string, name: string): void {
    const idx = this.players.size % PLAYER_SPAWNS.length;
    const sp = PLAYER_SPAWNS[idx];
    const inProgress = this.phase !== 'lobby' && this.phase !== 'over' && this.phase !== 'victory';
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
      ups: [],
      spent: 0,
      bonus: 0,
      forge: null,
    });
    this.emit({ t: 'join', pid: id, name });
    if (inProgress) this.emit({ t: 'prespawn', pid: id, p: vv(sp) });
    const p = this.players.get(id)!;
    if (this.phase === 'forge') this.openForgeFor(p, false);
    this.resync();
  }

  /** Re-announce run state (joins and reconnects): everyone's upgrades, open forges, gates. */
  resync(): void {
    if (this.mode !== 'run') return;
    for (const p of this.players.values()) {
      this.emit({ t: 'upg', pid: p.id, list: [...p.ups] });
      if (this.phase === 'forge' && p.forge) this.emitOffers(p);
    }
    if (this.phase === 'choice') this.emit({ t: 'gates', gates: this.gates });
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

  start(wave = 1, mode: unknown = 'classic', ups: string[] = []): void {
    if (this.phase !== 'lobby') return;
    this.runStart = this.time;
    this.mode = mode === 'run' ? 'run' : 'classic';
    if (this.mode === 'run') {
      // dev/test: start deeper, or with upgrades already owned
      for (const p of this.players.values()) for (const u of ups) if (UPGRADE_BY_ID.has(u) && !p.ups.includes(u)) p.ups.push(u);
      this.resync();
      this.beginRoom(clamp(Math.floor(num(wave, 1)), 1, FINAL_DEPTH), { reward: 'forge' });
      return;
    }
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
    const cap = this.hitCap(p, k);
    if (!e || e.hp <= 0 || cap === undefined) return;
    const def = ENEMIES[e.kind];
    if (dist(p.pos, e.pos) > HIT_RANGE) return;
    if ((k === 'punch' || k === 'slide') && dist(p.pos, e.pos) > PUNCH.range + def.radius + 3) return;
    if (k === 'hammer' && dist(p.pos, e.pos) > VARIANTS.hammer.range + def.radius + 3) return;
    const armored = e.elite === 'armored';
    // hitscan needs a clear line from the shooter's eye to some part of the target
    if (k === 'revolver' || k === 'shotgun' || k === 'beam') {
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
    if ((k === 'punch' || k === 'hammer') && melee && ((e.state === 'windup' && e.stateT < ENEMY_ATTACKS.husk.parryWindow + 0.1) || lateGrace)) {
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
    } else if ((k === 'revolver' || k === 'ricoshot' || k === 'spin' || k === 'beam') && !armored && e.state === 'windup' && (e.kind === 'warden' || e.kind === 'drone' || e.kind === 'stalker')) {
      // a precise shot into a telegraphed ranged attack staggers it
      e.state = 'stun';
      e.stateT = 1.1;
      this.emit({ t: 'stun', id: e.id, by: id });
      dmg *= 1.5;
    } else if ((k === 'shotgun' || k === 'hammer') && !armored && dmg >= WEAPONS.shotgun.staggerDamage && e.state === 'windup' && !ENEMIES[e.kind].heavy) {
      // a point-blank blast knocks a light enemy out of its attack
      e.state = 'stun';
      e.stateT = 0.7;
      this.emit({ t: 'stun', id: e.id, by: id });
    }
    // big hits shove light enemies (overcharged beams, hammer blows)
    if ((k === 'hammer' || (k === 'beam' && dmg > VARIANTS.beam.damage * 1.2)) && !def.heavy && !armored) {
      const dx = e.pos.x - p.pos.x, dz = e.pos.z - p.pos.z;
      const l = Math.hypot(dx, dz) || 1;
      const f = k === 'hammer' ? VARIANTS.hammer.knock * clamp(dmg / 110, 0.5, 1.5) : VARIANTS.beam.overKnock;
      e.vel.x += (dx / l) * f;
      e.vel.z += (dz / l) * f;
      if (!def.flying) e.vel.y += f * 0.45;
    }
    this.damageEnemy(e, dmg, id, k, hs, p);
  }

  playerBoom(id: string, raw: unknown, localFx = true): void {
    const p = this.players.get(id);
    const m = obj(raw);
    if (!p || !p.alive || !m) return;
    const c = vec(m.p);
    const k = m.k as HitKind;
    const cap = localFx ? this.boomCap(p, k) : { r: 4, d: 45 };
    if (!c || !cap || dist(c, p.pos) > (k === 'slam' ? 8 : k === 'pump' ? 9 : 70)) return;
    if (localFx) {
      if (p.boomTokens < 1) return;
      p.boomTokens -= 1;
    }
    let hits = 0;
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
      hits++;
      if (!def.heavy && e.elite !== 'armored') {
        const dir = { x: centre.x - c.x, y: 0, z: centre.z - c.z };
        const l = Math.hypot(dir.x, dir.z) || 1;
        e.vel.x += (dir.x / l) * 12 * falloff;
        e.vel.z += (dir.z / l) * 12 * falloff;
        if (!def.flying) e.vel.y += 7 * falloff;
        if (k === 'slam' && this.has(p, 'g_kinetic')) e.vel.y += VARIANTS.kinetic.launch * falloff;
      }
    }
    if (k === 'slam' && hits > 0 && this.has(p, 'g_rebound')) this.healPlayer(p, VARIANTS.rebound.heal, false);
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
    p.hardT = PLAYER.hardDamageDelay * (this.has(p, 'g_ironhide') ? 0.5 : 1);
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
    if (this.phase !== 'over' && this.phase !== 'victory') return;
    if (this.mode === 'run') { this.newRun(); return; }
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
      const cluster = this.has(p, 'm_cluster');
      p.boomTokens = Math.min(cluster ? CLUSTER_TOKENS : BOOM_TOKENS, p.boomTokens + (cluster ? CLUSTER_REFILL : BOOM_REFILL) * dt);
      p.healBudget = Math.min(BLOOD_HEAL_RATE, p.healBudget + BLOOD_HEAL_RATE * dt);
      // co-op revive: a living partner standing on your corpse brings you back early
      if (!p.alive && p.respawnAt > 0 && this.phase !== 'over' && this.phase !== 'victory') {
        let helping = 0;
        for (const o of this.players.values()) {
          if (o !== p && o.alive && o.connected && dist(o.pos, p.deathPos) < REVIVE_RADIUS) helping = Math.max(helping, this.has(o, 'c_rally') ? VARIANTS.rally.speed : 1);
        }
        p.revive = helping ? p.revive + dt * helping : Math.max(0, p.revive - dt * 0.5);
        if (p.revive >= REVIVE_TIME) {
          const by = [...this.players.values()].find((o) => o !== p && o.alive && dist(o.pos, p.deathPos) < REVIVE_RADIUS);
          this.respawn(p, p.deathPos, this.has(by, 'c_rally') ? VARIANTS.rally.hp : 50);
          this.emit({ t: 'revive', pid: p.id, by: by?.id ?? '' });
          continue;
        }
      }
      if (p.hard > 0) {
        p.hardT -= dt;
        if (p.hardT <= 0) p.hard = Math.max(0, p.hard - PLAYER.hardDamageDecay * (this.has(p, 'g_ironhide') ? 2 : 1) * dt);
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
      (x) => [x.id, ENEMY_KINDS.indexOf(x.kind), r2(x.pos.x), r2(x.pos.y), r2(x.pos.z), r2(x.yaw), ENEMY_STATES.indexOf(x.state), Math.ceil(x.hp), x.elite ? ELITE_KINDS.indexOf(x.elite) + 1 : 0] as Snapshot['e'][number],
    );
    const pr = [...this.projectiles.values()].map(
      (x) => [x.id, PROJ_KINDS.indexOf(x.kind), r2(x.pos.x), r2(x.pos.y), r2(x.pos.z), r2(x.vel.x), r2(x.vel.y), r2(x.vel.z), x.kind === 'reflected' ? 1 : 0] as Snapshot['pr'][number],
    );
    const pl = [...this.players.values()].map(
      (p) => [p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.vel.x), r2(p.vel.y), r2(p.vel.z), r2(p.yaw), r2(p.pitch), p.flags, p.weapon, Math.ceil(p.hp), p.alive ? 1 : 0, Math.floor(p.hard), p.connected ? 1 : 0, r2(p.revive / REVIVE_TIME), r2(p.deathPos.x), r2(p.deathPos.y), r2(p.deathPos.z), this.bank(p)] as PlayerSnap,
    );
    const snap: Snapshot = { t: r2(this.time), e, pr, pl, wave: this.wave, phase: this.phase, left: this.waveLeft, timer: r2(this.phaseTimer), pk: this.pickupMask(), mode: this.mode };
    if (this.mode === 'run') {
      const run: RunSnap = { d: this.depth };
      if (this.phase === 'choice') run.g = this.gates;
      if (this.prize) run.prize = this.prize;
      if (this.challenge) run.ch = this.challenge;
      if (this.challenge === 'timetrial' && this.phase === 'combat') run.tl = r2(Math.max(0, this.trialEnd - this.time));
      snap.run = run;
    }
    return snap;
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
    const plan = this.mode === 'run' ? this.plan : null;
    const def: WaveDef = plan ?? WAVES[n - 1];
    this.phase = 'combat';
    this.wave = n;
    const coop = Math.max(1, this.connectedCount());
    this.queue = [];
    for (const g of def.groups) {
      const count = g.kind === 'colossus' || g.kind === 'brute' ? g.count : Math.round(g.count * (1 + 0.5 * (coop - 1)));
      for (let i = 0; i < count; i++) {
        // elite rooms: a share of the light enemies carry an affix
        const el = plan?.elite && !ENEMIES[g.kind].heavy && this.runRand() < RUN.eliteShare ? ELITES[Math.floor(this.runRand() * ELITES.length)] : undefined;
        this.queue.push({ kind: g.kind, at: this.time + g.delay + i * 0.45, where: g.where, el });
      }
    }
    this.queue.sort((a, b) => a.at - b.at);
    this.waveLeft = this.queue.length;
    if (plan) {
      if (this.challenge === 'timetrial') this.trialEnd = this.time + RUN.timeTrial;
      this.emit({
        t: 'room', d: n, layer: RUN.layers[layerOf(n)].name, title: plan.title, boss: plan.boss, elite: plan.elite,
        ch: this.challenge ?? undefined, prize: this.prize ?? undefined,
      });
    } else this.emit({ t: 'wave', n, total: WAVES.length, title: def.title, boss: !!def.boss });
  }

  private updatePhase(dt: number): void {
    if (this.phase === 'choice') this.updateChoice();
    else if (this.phase === 'forge') {
      this.phaseTimer = Math.max(0, this.forgeEnd - this.time);
      if (this.time >= this.forgeEnd) this.closeForge();
    }
    if (this.phase === 'intermission') {
      this.phaseTimer -= dt;
      if (this.phaseTimer <= 0) this.startWave(this.wave);
    } else if (this.phase === 'combat') {
      let alive = 0;
      for (const e of this.enemies.values()) if (e.hp > 0) alive++;
      const cap = this.wave > (this.mode === 'run' ? 8 : 4) ? MAX_ALIVE + 4 : MAX_ALIVE;
      while (this.queue.length && this.queue[0].at <= this.time && alive < cap) {
        const q = this.queue.shift()!;
        this.spawnEnemy(q.kind, q.where, q.el);
        alive++;
      }
      // if the arena is empty, pull the next group forward so pacing never stalls
      if (alive === 0 && this.queue.length) this.queue[0].at = Math.min(this.queue[0].at, this.time + 0.6);
      if (alive === 0 && this.queue.length === 0 && this.mode === 'run') {
        this.emit({ t: 'clear', n: this.wave });
        this.roomCleared();
      } else if (alive === 0 && this.queue.length === 0) {
        this.emit({ t: 'clear', n: this.wave });
        if (this.wave >= WAVES.length) this.finish(true);
        else {
          for (const p of this.players.values()) if (!p.alive) this.respawn(p);
          this.beginIntermission(this.wave + 1, 5);
        }
      }
    }
  }

  // --------------------------------------------------------------------- run

  /** Set up the room at `depth` behind the chosen gate, then count down into it. */
  private beginRoom(depth: number, gate: Gate): void {
    this.depth = depth;
    this.prize = gate.reward;
    this.challenge = gate.challenge ?? null;
    this.gates = [];
    const elite = gate.reward === 'elite';
    this.plan = planRoom(depth, this.runRand, elite, gate.reward === 'challenge' ? 1.15 : 1);
    this.hurtMul = enemyScale(depth).dmg * (this.challenge === 'glass' ? 1.5 : 1);
    this.pickupAt.fill(0);
    this.beginIntermission(depth, depth === 1 ? 2.5 : 3);
  }

  /** Room cleared: pay out the gate's prize, then open a forge or the next gates. */
  private roomCleared(): void {
    for (const p of this.players.values()) if (!p.alive) this.respawn(p);
    const boss = isBossDepth(this.depth);
    if (boss && this.depth >= FINAL_DEPTH) { this.finish(true); return; }
    const prize = this.prize;
    const failed = this.challenge === 'timetrial' && this.time > this.trialEnd;
    this.challenge = null;
    this.hurtMul = enemyScale(this.depth).dmg;
    if (boss) {
      // a layer boss always pays a full repair and a rare forge
      this.repairAll();
      this.emit({ t: 'prize', k: 'repair', ok: true });
      this.openForge(true);
      return;
    }
    if (!prize || failed) {
      if (prize) this.emit({ t: 'prize', k: prize, ok: false });
      this.openChoice();
      return;
    }
    if (prize === 'repair') this.repairAll();
    if (prize === 'cache' || prize === 'challenge') {
      const amt = Math.round((RUN.cacheBase + RUN.cachePerDepth * this.depth) * (prize === 'challenge' ? 0.6 : 1));
      for (const p of this.players.values()) p.bonus += amt;
      this.emit({ t: 'prize', k: prize, ok: true, amt });
    } else this.emit({ t: 'prize', k: prize, ok: true });
    if (prize === 'forge' || prize === 'elite' || prize === 'challenge') this.openForge(prize !== 'forge');
    else this.openChoice();
  }

  private repairAll(): void {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      p.hard = 0;
      const before = p.hp;
      p.hp = PLAYER.maxHealth;
      this.emit({ t: 'heal', pid: p.id, hp: p.hp, amt: r2(p.hp - before), hard: 0 });
    }
  }

  private openChoice(): void {
    this.prize = null;
    this.gates = planGates(this.depth + 1, this.runRand);
    this.phase = 'choice';
    this.phaseTimer = 0;
    this.emit({ t: 'gates', gates: this.gates });
  }

  /** The host walks into a gate to pick it (anyone may if the host is gone). */
  private updateChoice(): void {
    const host = this.players.get(this.hostId);
    const pickers = host && host.connected && host.alive ? [host] : [...this.players.values()].filter((p) => p.connected && p.alive);
    for (const p of pickers) {
      for (let i = 0; i < this.gates.length; i++) {
        const g = GATE_SPOTS[i];
        if (distXZ(p.pos, g) < GATE_RADIUS && p.pos.y < g.y + 3) {
          this.emit({ t: 'gate', i, by: p.id });
          this.beginRoom(this.depth + 1, this.gates[i]);
          return;
        }
      }
    }
  }

  private openForge(rare: boolean): void {
    this.phase = 'forge';
    this.forgeEnd = this.time + RUN.forgeTimeout;
    for (const p of this.players.values()) this.openForgeFor(p, rare);
  }

  private openForgeFor(p: SimPlayer, rare: boolean): void {
    p.forge = { offers: [], free: true, buys: 0, rerolls: 0, done: false, rare };
    p.forge.offers = this.makeOffers(p, rare ? 4 : 3);
    this.emitOffers(p);
  }

  /** Draw distinct upgrades this player can take; weapon variants are favoured early. */
  private makeOffers(p: SimPlayer, n: number): string[] {
    const coop = this.players.size > 1;
    const pool = UPGRADES.filter((u) => eligible(u, p.ups, coop));
    const out: string[] = [];
    while (out.length < n && pool.length) {
      let total = 0;
      const w = pool.map((u) => {
        let x = u.rare ? 0.5 : 1;
        if (u.cat === 'variant') x *= this.depth <= 7 ? 1.6 : 1.1;
        if (u.cat === 'mod') x *= 1.3; // a mod is only here because you own what it improves
        if (u.coop) x *= 1.4;
        total += x;
        return x;
      });
      let r = this.runRand() * total;
      let i = 0;
      for (; i < pool.length - 1; i++) { r -= w[i]; if (r <= 0) break; }
      out.push(pool[i].id);
      pool.splice(i, 1);
    }
    return out;
  }

  private buyCost(p: SimPlayer): number {
    return RUN.forgeBuyBase + RUN.forgeBuyPerDepth * this.depth + RUN.forgeBuyStep * (p.forge?.buys ?? 0);
  }

  private rerollCost(p: SimPlayer): number {
    return (RUN.forgeRerollBase + RUN.forgeRerollPerDepth * this.depth) * (1 + (p.forge?.rerolls ?? 0));
  }

  private emitOffers(p: SimPlayer): void {
    const f = p.forge;
    if (!f) return;
    this.emit({ t: 'offers', pid: p.id, offers: [...f.offers], free: f.free, buy: this.buyCost(p), reroll: this.rerollCost(p), rare: f.rare });
  }

  private grant(p: SimPlayer, id: string): void {
    if (p.ups.includes(id)) return;
    p.ups.push(id);
    this.emit({ t: 'forged', pid: p.id, id });
    this.emit({ t: 'upg', pid: p.id, list: [...p.ups] });
  }

  playerForge(id: string, raw: unknown): void {
    const p = this.players.get(id);
    const m = obj(raw);
    if (!p || !m || this.phase !== 'forge' || !p.forge || p.forge.done) return;
    const f = p.forge;
    const i = Math.floor(num(m.i, -1));
    const offer = i >= 0 && i < f.offers.length ? f.offers[i] : undefined;
    const coop = this.players.size > 1;
    switch (m.a) {
      case 'pick':
        if (!f.free || !offer) return;
        f.free = false;
        this.grant(p, offer);
        f.offers.splice(i, 1);
        break;
      case 'buy': {
        if (f.free || !offer) return;
        const cost = this.buyCost(p);
        if (this.bank(p) < cost) return;
        p.spent += cost;
        f.buys++;
        this.grant(p, offer);
        f.offers.splice(i, 1);
        break;
      }
      case 'reroll': {
        const cost = this.rerollCost(p);
        if (this.bank(p) < cost) return;
        p.spent += cost;
        f.rerolls++;
        f.offers = this.makeOffers(p, f.rare ? 4 : 3);
        break;
      }
      case 'done':
        f.done = true;
        this.emit({ t: 'forgedone', pid: p.id });
        break;
      default:
        return;
    }
    // offers bought out from under an upgrade's requirement (or now ineligible) drop out
    f.offers = f.offers.filter((o) => { const u = UPGRADE_BY_ID.get(o); return !!u && eligible(u, p.ups, coop); });
    this.emitOffers(p);
    if ([...this.players.values()].every((o) => !o.connected || !o.forge || o.forge.done)) this.closeForge();
  }

  private closeForge(): void {
    for (const p of this.players.values()) p.forge = null;
    if (this.phase === 'forge') this.openChoice();
  }

  /** Start over from room 1 with the same players (after a death or a win). */
  private newRun(): void {
    this.enemies.clear();
    this.projectiles.clear();
    this.queue = [];
    let i = 0;
    for (const p of this.players.values()) {
      const sp = PLAYER_SPAWNS[i++ % PLAYER_SPAWNS.length];
      Object.assign(p, {
        pos: { ...sp }, vel: { x: 0, y: 0, z: 0 }, hp: PLAYER.maxHealth, hard: 0, alive: true, respawnAt: 0, revive: 0,
        ups: [], spent: 0, bonus: 0, forge: null,
        stats: { id: p.id, name: p.name, kills: 0, damage: 0, deaths: 0, taken: 0, style: 0, parries: 0 },
      });
      this.emit({ t: 'prespawn', pid: p.id, p: vv(sp) });
      this.emit({ t: 'upg', pid: p.id, list: [] });
    }
    this.pickupAt.fill(0);
    this.runStart = this.time;
    this.emit({ t: 'reset', wave: 1 });
    this.beginRoom(1, { reward: 'forge' });
  }

  private finish(win: boolean): void {
    this.phase = win ? 'victory' : 'over';
    this.projectiles.clear();
    this.emit({
      t: 'over', win, wave: this.wave, time: r2(this.time - this.runStart),
      stats: [...this.players.values()].map((p) => ({ ...p.stats, damage: Math.round(p.stats.damage), taken: Math.round(p.stats.taken) })),
      mode: this.mode,
      ups: this.mode === 'run' ? Object.fromEntries([...this.players.values()].map((p) => [p.id, [...p.ups]])) : undefined,
    });
  }

  private checkDefeat(): void {
    if (this.phase !== 'combat' && this.phase !== 'intermission' && this.phase !== 'choice' && this.phase !== 'forge') return;
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

  private spawnEnemy(kind: EnemyKind, where: 'ground' | 'tower' | 'air', el?: Elite): void {
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
    let runHp = 1;
    if (this.mode === 'run') {
      runHp = enemyScale(this.depth).hp * (el === 'armored' ? 1.8 : 1);
      if (kind === 'colossus') runHp *= RUN.bossHp[layerOf(this.depth)];
    }
    const hp = def.hp * coopHp * runHp;
    const e: SimEnemy = {
      id: this.nextId++, kind, pos, vel: { x: 0, y: 0, z: 0 }, yaw: Math.atan2(pos.x, pos.z),
      elite: el ?? null, spdMul: el === 'swift' ? 1.4 : 1,
      hp, maxHp: hp, state: 'spawn', stateT: kind === 'colossus' ? 2.5 : 0.9,
      target: null, retargetT: 0, cooldown: 1 + this.rand() * 1.5, attack: '', grounded: false,
      burstLeft: 0, strafeDir: this.rand() < 0.5 ? -1 : 1, phase: 1,
      summonT: ENEMY_ATTACKS.colossus.summonEvery, cycle: 0, shots: 0,
      lastStrikeT: -9, lastStrikeAid: 0, lastStrikeDmg: 0, invulnT: 0, blinkCd: 2 + this.rand() * 2,
    };
    this.enemies.set(e.id, e);
    this.emit({ t: 'spawn', id: e.id, k: kind, p: vv(pos), el: el ?? undefined });
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
    const thirst = this.has(p, 'g_bloodthirst');
    const range = PLAYER.bloodHealRange * (thirst ? VARIANTS.bloodthirst.range : 1);
    if (p.alive && this.challenge !== 'bloodless' && dist(p.pos, e.pos) < range + ENEMIES[e.kind].radius) {
      const want = dealt * PLAYER.bloodHealFactor * (ENEMIES[e.kind].heavy ? 0.5 : 1) * (thirst ? VARIANTS.bloodthirst.factor : 1);
      const amt = Math.min(want, p.healBudget);
      p.healBudget -= amt;
      this.healPlayer(p, amt, false);
      if (this.has(p, 'c_tether')) {
        for (const o of this.players.values()) {
          if (o !== p && o.alive && dist(o.pos, p.pos) < VARIANTS.tether.range) this.healPlayer(o, amt * VARIANTS.tether.share, false);
        }
      }
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
      // volatile elites burst when they die: don't finish them off in your own face
      if (e.elite === 'volatile') {
        this.emit({ t: 'boom', p: vv({ x: e.pos.x, y: e.pos.y + 1, z: e.pos.z }), r: 3.4, d: r2(22 * this.hurtMul), hostile: true, aid: this.aid(), k: 'volatile' });
      }
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
    wishX *= e.spdMul;
    wishZ *= e.spdMul;
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
    this.emit({ t: 'melee', id: e.id, aid, p: vv(hit), r, d: r2(d * this.hurtMul) });
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
            this.emit({ t: 'melee', id: e.id, aid: this.aid(), p: vv(e.pos), r: 2.4, d: r2(a.damage * this.hurtMul) });
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
      this.emit({ t: 'melee', id: e.id, aid, p: vv(p), r: 2.6 * sizeMul, d: r2(a.meleeDamage * this.hurtMul) });
      this.emit({ t: 'boom', p: vv({ x: p.x, y: e.pos.y, z: p.z }), r: 2, d: 0, hostile: false, aid: 0, k: 'dust' });
    } else if (attack === 'stomp') {
      this.emit({ t: 'shock', id: e.id, aid: this.aid(), p: vv(e.pos), speed: a.waveSpeed * (sizeMul > 1 ? 1.2 : 1), range: a.waveRange * sizeMul, d: r2(a.stompDamage * this.hurtMul) });
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
            this.emit({ t: 'beam', id: e.id, aid: this.aid(), p: vv(head), yaw0: r2(yawTo - sweep / 2), sweep: r2(sweep), pitch: r2(pitch), dur, dps: r2(c.beamDps * this.hurtMul) });
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
    this.projectiles.set(id, { id, kind, pos: { ...from }, vel, damage: damage * this.hurtMul, born: this.time, owner: String(e.id) });
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
