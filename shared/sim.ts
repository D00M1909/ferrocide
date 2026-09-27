// Authoritative world simulation: enemies, AI, projectiles, waves, player health.
// Runs inside the Colyseus room for co-op and inside the browser for solo play.
// Player movement is client-authoritative (instant, lag-free); everything that
// both players must agree on (enemies, damage, waves) is decided here.
import {
  AIR_SPAWNS, GROUND_SPAWNS, LAVA, PLAYER_SPAWNS, TOWER_SPAWNS, inZone, lineOfSight, moveBody, raycastWorld,
} from './arena';
import {
  ENEMIES, ENEMY_ATTACKS, PLAYER, PROJECTILES, PUNCH, type EnemyKind, type ProjectileKind,
} from './constants';
import { angleDiff, clamp, dist, distXZ, rng, type Vec3 } from './math';
import {
  ENEMY_KINDS, ENEMY_STATES, PROJ_KINDS, r2,
  type BoomMsg, type EnemyState, type FxMsg, type GameEvent, type HitMsg, type HurtMsg, type ParryMsg, type Phase,
  type PlayerSnap, type PlayerStats, type Snapshot, type StateMsg, type V,
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
  alive: boolean;
  respawnAt: number;
  stats: PlayerStats;
  hurtIds: Set<number>;
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
  aid: number;
  grounded: boolean;
  burstLeft: number;
  strafeDir: number;
  aim: Vec3;
  enraged: boolean;
  summonT: number;
  cycle: number;
  lastHitBy: string;
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
  private rand: () => number;
  private runStart = 0;
  private waveLeft = 0;

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
      hp: PLAYER.maxHealth, alive: true, respawnAt: 0,
      stats: { id, name, kills: 0, damage: 0, deaths: 0, taken: 0, style: 0, parries: 0 },
      hurtIds: new Set(),
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

  start(wave = 1): void {
    if (this.phase !== 'lobby') return;
    this.runStart = this.time;
    this.beginIntermission(clamp(Math.floor(wave), 1, WAVES.length), 2.5);
  }

  playerState(id: string, m: StateMsg): void {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    p.pos.x = clamp(m.p[0], -40, 40);
    p.pos.y = clamp(m.p[1], -2, 60);
    p.pos.z = clamp(m.p[2], -40, 40);
    p.vel.x = m.v[0]; p.vel.y = m.v[1]; p.vel.z = m.v[2];
    p.yaw = m.yaw; p.pitch = m.pitch; p.flags = m.f; p.weapon = m.w;
    p.stats.style = Math.max(p.stats.style, Math.floor(m.s) || 0);
  }

  playerHit(id: string, m: HitMsg): void {
    const p = this.players.get(id);
    const e = this.enemies.get(m.e);
    if (!p || !p.alive || !e || e.hp <= 0) return;
    const dmg = clamp(Number(m.d) || 0, 0, 2000);
    // interrupting a telegraphed ranged attack with a precise shot staggers it
    if ((m.k === 'revolver' || m.k === 'ricoshot') && e.state === 'windup' && (e.kind === 'warden' || e.kind === 'drone')) {
      e.state = 'stun';
      e.stateT = 1.1;
      this.emit({ t: 'stun', id: e.id, by: id });
      this.damageEnemy(e, dmg * 1.5, id, m.k, !!m.hs, p);
      return;
    }
    this.damageEnemy(e, dmg, id, m.k, !!m.hs, p);
  }

  playerBoom(id: string, m: BoomMsg, localFx = true): void {
    const p = this.players.get(id);
    if (!p || !p.alive) return;
    const r = clamp(m.r, 0, 10);
    const base = clamp(m.d, 0, 300);
    const c = { x: m.p[0], y: m.p[1], z: m.p[2] };
    for (const e of this.enemies.values()) {
      if (e.hp <= 0) continue;
      const def = ENEMIES[e.kind];
      const centre = { x: e.pos.x, y: e.pos.y + def.height * 0.5, z: e.pos.z };
      const d = Math.max(0, dist(c, centre) - def.radius);
      if (d > r) continue;
      const falloff = 1 - (d / r) * 0.6;
      this.damageEnemy(e, base * falloff, id, m.k, false, p);
      if (!def.heavy) {
        const dir = { x: centre.x - c.x, y: 0, z: centre.z - c.z };
        const l = Math.hypot(dir.x, dir.z) || 1;
        e.vel.x += (dir.x / l) * 12 * falloff;
        e.vel.z += (dir.z / l) * 12 * falloff;
        if (!def.flying) e.vel.y += 7 * falloff;
      }
    }
    this.emit({ t: 'boom', p: m.p, r, d: 0, hostile: false, aid: 0, k: m.k, by: localFx ? id : undefined });
  }

  playerParry(id: string, m: ParryMsg): void {
    const p = this.players.get(id);
    const pr = this.projectiles.get(m.id);
    if (!p || !p.alive || !pr || pr.kind === 'reflected' || !PROJECTILES[pr.kind].parryable) return;
    if (dist(p.pos, pr.pos) > PUNCH.parryRange + 3) return;
    const l = Math.hypot(m.dir[0], m.dir[1], m.dir[2]) || 1;
    pr.kind = 'reflected';
    pr.vel = { x: (m.dir[0] / l) * PUNCH.parrySpeed, y: (m.dir[1] / l) * PUNCH.parrySpeed, z: (m.dir[2] / l) * PUNCH.parrySpeed };
    pr.damage = pr.damage * PUNCH.parryDamageMult + 40;
    pr.owner = id;
    pr.born = this.time;
    p.stats.parries++;
    this.healPlayer(p, PUNCH.parryHeal);
    this.emit({ t: 'parried', id: pr.id, by: id });
  }

  playerHurt(id: string, m: HurtMsg): void {
    const p = this.players.get(id);
    if (!p || !p.alive || this.phase === 'over' || this.phase === 'victory') return;
    let dmg = clamp(Number(m.d) || 0, 0, 100);
    if (m.src === 'proj' && m.id !== undefined) {
      const pr = this.projectiles.get(m.id);
      if (!pr || pr.kind === 'reflected') return;
      dmg = pr.damage;
      this.projectiles.delete(pr.id);
      if (pr.kind === 'mortar') this.emit({ t: 'boom', p: vv(pr.pos), r: 2.5, d: 0, hostile: false, aid: 0, k: 'mortar' });
    } else if (m.id !== undefined && m.src !== 'beam' && m.src !== 'lava' && m.src !== 'self') {
      if (p.hurtIds.has(m.id)) return; // each attack instance hurts once
      p.hurtIds.add(m.id);
      if (p.hurtIds.size > 64) p.hurtIds.delete(p.hurtIds.values().next().value!);
    }
    p.hp -= dmg;
    p.stats.taken += dmg;
    this.emit({ t: 'phurt', pid: id, d: r2(dmg), hp: r2(Math.max(0, p.hp)), src: m.src });
    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      p.stats.deaths++;
      p.respawnAt = this.time + PLAYER.respawnTime;
      this.emit({ t: 'pdie', pid: id });
      this.checkDefeat();
    }
  }

  playerFx(id: string, fx: FxMsg): void {
    if (this.players.has(id)) this.emit({ t: 'fx', from: id, fx });
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
      p.alive = true;
      this.emit({ t: 'prespawn', pid: p.id, p: vv(sp) });
    }
    this.emit({ t: 'reset', wave: this.wave });
    this.beginIntermission(this.wave, 3);
  }

  // ----------------------------------------------------------------- stepping

  step(dt: number): void {
    this.time += dt;
    this.updatePhase(dt);
    for (const p of this.players.values()) {
      if (!p.alive && this.phase !== 'over' && this.phase !== 'victory' && this.time >= p.respawnAt && p.respawnAt > 0) this.respawn(p);
    }
    for (const e of this.enemies.values()) this.updateEnemy(e, dt);
    for (const pr of this.projectiles.values()) this.updateProjectile(pr, dt);
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
      (p) => [p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.vel.x), r2(p.vel.y), r2(p.vel.z), r2(p.yaw), r2(p.pitch), p.flags, p.weapon, Math.ceil(p.hp), p.alive ? 1 : 0] as PlayerSnap,
    );
    return { t: r2(this.time), e, pr, pl, wave: this.wave, phase: this.phase, left: this.waveLeft, timer: r2(this.phaseTimer) };
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
    const coop = Math.max(1, this.players.size);
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
      while (this.queue.length && this.queue[0].at <= this.time && alive < MAX_ALIVE) {
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
    for (const p of this.players.values()) if (p.alive) return;
    this.finish(false);
  }

  private respawn(p: SimPlayer): void {
    const sp = PLAYER_SPAWNS[Math.floor(this.rand() * PLAYER_SPAWNS.length)];
    p.pos = { ...sp };
    p.vel = { x: 0, y: 0, z: 0 };
    p.hp = PLAYER.maxHealth;
    p.alive = true;
    p.respawnAt = 0;
    this.emit({ t: 'prespawn', pid: p.id, p: vv(sp) });
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
    const coopHp = kind === 'colossus' && this.players.size > 1 ? 1.5 : 1;
    const e: SimEnemy = {
      id: this.nextId++, kind, pos, vel: { x: 0, y: 0, z: 0 }, yaw: Math.atan2(pos.x, pos.z),
      hp: def.hp * coopHp, maxHp: def.hp * coopHp, state: 'spawn', stateT: kind === 'colossus' ? 2.5 : 0.9,
      target: null, retargetT: 0, cooldown: 1 + this.rand() * 1.5, attack: '', aid: 0, grounded: false,
      burstLeft: 0, strafeDir: this.rand() < 0.5 ? -1 : 1, aim: { x: 0, y: 0, z: 0 }, enraged: false,
      summonT: ENEMY_ATTACKS.colossus.summonEvery, cycle: 0, lastHitBy: '',
    };
    this.enemies.set(e.id, e);
    this.emit({ t: 'spawn', id: e.id, k: kind, p: vv(pos) });
  }

  // ------------------------------------------------------------------ damage

  private damageEnemy(e: SimEnemy, dmg: number, by: string, how: string, hs: boolean, p: SimPlayer): void {
    if (e.hp <= 0 || dmg <= 0) return;
    const dealt = Math.min(dmg, e.hp);
    e.hp -= dmg;
    e.lastHitBy = by;
    p.stats.damage += dealt;
    // blood heals the aggressive: damage dealt up close restores health
    if (p.alive && dist(p.pos, e.pos) < PLAYER.bloodHealRange + ENEMIES[e.kind].radius) {
      this.healPlayer(p, dealt * PLAYER.bloodHealFactor);
    }
    this.emit({ t: 'dmg', id: e.id, d: r2(dealt), by, hs, k: how, p: vv(e.pos) });
    if (e.kind === 'colossus' && !e.enraged && e.hp < e.maxHp * 0.5) {
      e.enraged = true;
      this.emit({ t: 'enrage', id: e.id });
    }
    if (e.hp <= 0) {
      p.stats.kills++;
      this.enemies.delete(e.id);
      this.waveLeft = Math.max(0, this.waveLeft - 1);
      this.emit({ t: 'kill', id: e.id, k: e.kind, by, how, p: vv(e.pos), hs });
    }
  }

  private healPlayer(p: SimPlayer, amt: number): void {
    if (!p.alive || amt <= 0 || p.hp >= PLAYER.maxHealth) return;
    const before = p.hp;
    p.hp = Math.min(PLAYER.maxHealth, p.hp + amt);
    this.emit({ t: 'heal', pid: p.id, hp: r2(p.hp), amt: r2(p.hp - before) });
  }

  private emit(e: GameEvent): void {
    this.events.push(e);
  }

  // ---------------------------------------------------------------------- AI

  private pickTarget(e: SimEnemy): SimPlayer | null {
    let cur = e.target ? this.players.get(e.target) : undefined;
    if (cur && !cur.alive) cur = undefined;
    if (!cur || this.time > e.retargetT) {
      let best: SimPlayer | null = null, bd = 1e9;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
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
    if (e.state === 'spawn') {
      if (e.stateT <= 0) this.setState(e, 'move', 0);
      if (!def.flying) this.physics(e, dt, 0, 0);
      return;
    }
    const tgt = this.phase === 'combat' || this.phase === 'intermission' ? this.pickTarget(e) : null;
    switch (e.kind) {
      case 'husk': this.aiHusk(e, tgt, dt); break;
      case 'eye': this.aiEye(e, tgt, dt); break;
      case 'warden': this.aiWarden(e, tgt, dt); break;
      case 'drone': this.aiDrone(e, tgt, dt); break;
      case 'brute': this.aiBrute(e, tgt, dt); break;
      case 'colossus': this.aiColossus(e, tgt, dt); break;
    }
    // fell out somehow: put it back on the floor
    if (e.pos.y < -5) { e.pos.y = 1; e.vel.y = 0; }
  }

  /** Ground locomotion with separation + wall sliding. wishX/wishZ is desired velocity. */
  private physics(e: SimEnemy, dt: number, wishX: number, wishZ: number, accel = 30): void {
    const def = ENEMIES[e.kind];
    // separation from other enemies
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
    const k = Math.min(1, accel * dt / 10);
    e.vel.x += (wishX - e.vel.x) * k;
    e.vel.z += (wishZ - e.vel.z) * k;
    if (def.flying) {
      e.pos.x += e.vel.x * dt;
      e.pos.y += e.vel.y * dt;
      e.pos.z += e.vel.z * dt;
      e.pos.x = clamp(e.pos.x, -34, 34);
      e.pos.z = clamp(e.pos.z, -34, 34);
      e.pos.y = clamp(e.pos.y, 1.5, 16);
      return;
    }
    e.vel.y -= PLAYER.gravity * dt;
    const res = moveBody(e.pos, e.vel, dt, def.radius * 0.7, def.height * 0.9, 0.7, e.grounded);
    e.grounded = res.onGround;
    if (res.wallNormal && (wishX || wishZ)) {
      // slide around obstacles: steer along the wall tangent
      const tx = -res.wallNormal.z * e.strafeDir, tz = res.wallNormal.x * e.strafeDir;
      e.vel.x += tx * 6;
      e.vel.z += tz * 6;
    }
  }

  private aiHusk(e: SimEnemy, t: SimPlayer | null, dt: number): void {
    const a = ENEMY_ATTACKS.husk;
    const def = ENEMIES.husk;
    if (!t) { this.physics(e, dt, 0, 0); return; }
    const d = distXZ(e.pos, t.pos);
    const dy = t.pos.y - e.pos.y;
    switch (e.state) {
      case 'move': {
        this.face(e, t.pos, dt, 10);
        const dx = t.pos.x - e.pos.x, dz = t.pos.z - e.pos.z;
        const l = Math.hypot(dx, dz) || 1;
        const sp = def.speed;
        this.physics(e, dt, (dx / l) * sp, (dz / l) * sp);
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
        this.face(e, t.pos, dt, 6);
        this.physics(e, dt, 0, 0);
        if (e.stateT <= 0) {
          const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
          e.vel.x = fx * a.lunge;
          e.vel.z = fz * a.lunge;
          const hit = { x: e.pos.x + fx * 1.3, y: e.pos.y + 1, z: e.pos.z + fz * 1.3 };
          this.emit({ t: 'melee', id: e.id, aid: ++e.aid * 1000 + e.id, p: vv(hit), r: 1.7, d: a.damage });
          this.setState(e, 'recover', a.recover);
        }
        break;
      }
      case 'stun':
      case 'recover':
        this.physics(e, dt, 0, 0);
        if (e.stateT <= 0) this.setState(e, 'move', 0);
        break;
      default:
        this.setState(e, 'move', 0);
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
          e.aim = { ...eyeTarget };
          this.emit({ t: 'atk', id: e.id, a: 'dive', dur: a.windup });
        }
        break;
      }
      case 'windup':
        e.vel.x *= 0.85; e.vel.y *= 0.85; e.vel.z *= 0.85;
        this.physics(e, dt, e.vel.x, e.vel.z);
        if (e.stateT <= 0) {
          const dx = eyeTarget.x - e.pos.x, dy = eyeTarget.y - 0.4 - e.pos.y, dz = eyeTarget.z - e.pos.z;
          const l = Math.hypot(dx, dy, dz) || 1;
          e.vel = { x: (dx / l) * a.diveSpeed, y: (dy / l) * a.diveSpeed, z: (dz / l) * a.diveSpeed };
          this.setState(e, 'dive', 0.75);
        }
        break;
      case 'dive': {
        e.pos.x += e.vel.x * dt; e.pos.y += e.vel.y * dt; e.pos.z += e.vel.z * dt;
        // kamikaze: burst when close to any player
        for (const p of this.players.values()) {
          if (!p.alive) continue;
          if (dist({ x: p.pos.x, y: p.pos.y + 1, z: p.pos.z }, e.pos) < a.range + 0.6) {
            this.emit({ t: 'melee', id: e.id, aid: ++e.aid * 1000 + e.id, p: vv(e.pos), r: 2.4, d: a.damage });
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
          // lead the target a little so strafing in a straight line is punished
          const flight = dist(head, tp) / a.orbSpeed;
          const aimP = { x: tp.x + t.vel.x * flight * 0.5, y: tp.y, z: tp.z + t.vel.z * flight * 0.5 };
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
    // orbit the target at a comfortable radius and altitude
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
            const spread = { x: tp.x + (this.rand() - 0.5) * 1.2, y: tp.y + (this.rand() - 0.5) * 0.8, z: tp.z + (this.rand() - 0.5) * 1.2 };
            this.fireProjectile('bolt', muzzle, spread, a.boltSpeed, a.boltDamage, e);
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
          this.bruteStrike(e, t, e.attack, 1);
          e.cooldown = a.cooldown * (0.8 + this.rand() * 0.5);
          this.setState(e, 'recover', 0.8);
        }
        break;
      default:
        this.physics(e, dt, 0, 0, 12);
        if (e.stateT <= 0) this.setState(e, 'move', 0);
    }
  }

  private bruteStrike(e: SimEnemy, t: SimPlayer, attack: string, sizeMul: number): void {
    const a = ENEMY_ATTACKS.brute;
    const def = ENEMIES[e.kind];
    if (attack === 'smash') {
      const fx = -Math.sin(e.yaw), fz = -Math.cos(e.yaw);
      const p = { x: e.pos.x + fx * 2.4 * sizeMul, y: e.pos.y + 1, z: e.pos.z + fz * 2.4 * sizeMul };
      this.emit({ t: 'melee', id: e.id, aid: ++e.aid * 1000 + e.id, p: vv(p), r: 2.6 * sizeMul, d: a.meleeDamage });
      this.emit({ t: 'boom', p: vv({ x: p.x, y: e.pos.y, z: p.z }), r: 2, d: 0, hostile: false, aid: 0, k: 'dust' });
    } else if (attack === 'stomp') {
      this.emit({ t: 'shock', id: e.id, aid: ++e.aid * 1000 + e.id, p: vv(e.pos), speed: a.waveSpeed * (sizeMul > 1 ? 1.2 : 1), range: a.waveRange * sizeMul, d: a.stompDamage });
    } else if (attack === 'mortar') {
      const shots = sizeMul > 1 ? 3 : 1;
      for (let i = 0; i < shots; i++) {
        const spread = i === 0 ? 0 : 5;
        const land = { x: t.pos.x + t.vel.x * 0.6 + (this.rand() - 0.5) * spread * 2, y: t.pos.y, z: t.pos.z + t.vel.z * 0.6 + (this.rand() - 0.5) * spread * 2 };
        const from = { x: e.pos.x, y: e.pos.y + def.height * 0.85, z: e.pos.z };
        const T = 1.25 + i * 0.15;
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
    const rage = e.enraged ? 1.45 : 1;
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
          const moves = d < 7 ? ['smash', 'stomp'] : ['stomp', 'mortar', 'beam', 'mortar', 'beam'];
          const next = moves[e.cycle++ % moves.length];
          const dur = next === 'beam' ? c.beamWindup : next === 'smash' ? 0.8 : 1.0 / rage + 0.2;
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
            for (let i = 0; i < 3; i++) this.spawnEnemy('eye', 'air');
            this.spawnEnemy('husk', 'ground');
            this.waveLeft += 4;
            e.cooldown = 1.5;
            this.setState(e, 'recover', 0.6);
          } else if (e.attack === 'beam') {
            const head = { x: e.pos.x, y: e.pos.y + ENEMIES.colossus.headY, z: e.pos.z };
            const toT = { x: t.pos.x - head.x, y: t.pos.y + 1 - head.y, z: t.pos.z - head.z };
            const yawTo = Math.atan2(-toT.x, -toT.z);
            const pitch = Math.atan2(toT.y, Math.hypot(toT.x, toT.z));
            const dir = this.rand() < 0.5 ? 1 : -1;
            const sweep = c.beamSweep * dir;
            this.emit({ t: 'beam', id: e.id, aid: ++e.aid * 1000 + e.id, p: vv(head), yaw0: r2(yawTo - sweep / 2), sweep: r2(sweep), pitch: r2(pitch), dur: c.beamTime, dps: c.beamDps });
            this.setState(e, 'beam', c.beamTime);
          } else {
            this.bruteStrike(e, t, e.attack, 1.8);
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
    const dir = { x: pr.vel.x * dt / (step || 1), y: pr.vel.y * dt / (step || 1), z: pr.vel.z * dt / (step || 1) };
    const wall = raycastWorld(pr.pos, dir, step + def.radius * 0.5);
    if (pr.kind === 'reflected') {
      // player-owned: slam into enemies
      const owner = this.players.get(pr.owner);
      for (const e of this.enemies.values()) {
        const ed = ENEMIES[e.kind];
        const c = { x: e.pos.x, y: e.pos.y + ed.height * 0.55, z: e.pos.z };
        if (dist(c, pr.pos) < ed.radius + ed.height * 0.3 + def.radius + step * 0.5) {
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
      this.emit({ t: 'boom', p: vv(pr.pos), r: hostile ? ENEMY_ATTACKS.brute.mortarRadius : 1, d: hostile ? pr.damage : 0, hostile, aid: hostile ? pr.id + 500000 : 0, k: pr.kind });
      return;
    }
    pr.pos.x += pr.vel.x * dt; pr.pos.y += pr.vel.y * dt; pr.pos.z += pr.vel.z * dt;
    // enemy projectiles that stray far outside are culled
    if (Math.abs(pr.pos.x) > 45 || Math.abs(pr.pos.z) > 45 || pr.pos.y > 70) this.projectiles.delete(pr.id);
  }

  private explodeReflected(pr: SimProjectile, owner: SimPlayer | undefined): void {
    this.projectiles.delete(pr.id);
    if (owner) this.playerBoom(owner.id, { p: vv(pr.pos), r: 4, d: 45, k: 'parry' }, false);
    else this.emit({ t: 'boom', p: vv(pr.pos), r: 4, d: 0, hostile: false, aid: 0, k: 'parry' });
  }

  /** Solo/debug helper: lava damage is applied from client reports; used for bots. */
  inLava(p: Vec3): boolean {
    return LAVA.some((z) => inZone(p, z));
  }
}
