// Wire format shared by the Colyseus room and the in-browser local server.
import type { EnemyKind, ProjectileKind } from './constants';
import type { Challenge, Elite, Gate, Reward } from './run';

export type V = [number, number, number];

// ------------------------------------------------------------ client -> server

export interface StateMsg {
  p: V; // feet position
  v: V; // velocity
  yaw: number;
  pitch: number;
  f: number; // PlayerFlags bitmask
  w: number; // weapon index
  s: number; // style points total (for results)
}

export const PF = {
  grounded: 1,
  sliding: 2,
  dashing: 4,
  slamming: 8,
  firing: 16,
} as const;

export type HitKind =
  | 'revolver' | 'ricoshot' | 'shotgun' | 'punch' | 'parry' | 'explosion' | 'slam' | 'rocket' | 'core'
  | 'beam' | 'spin' | 'hammer' | 'pump' | 'slide' | 'burn';

export type GameMode = 'classic' | 'run';

export interface StartMsg {
  mode: GameMode;
}

/** Forge actions: take the free pick, buy another offer, reroll the offers, or leave. */
export interface ForgeMsg {
  a: 'pick' | 'buy' | 'reroll' | 'done';
  i?: number; // offer index
}

export interface HitMsg {
  e: number; // enemy id
  d: number; // damage
  k: HitKind;
  hs?: boolean; // headshot
  rc?: number; // ricochet count
}

export interface BoomMsg {
  p: V;
  r: number;
  d: number;
  k: HitKind;
}

export interface ParryMsg {
  id: number;
  dir: V;
  at?: V; // what the parrying player was aiming at (server aims from the projectile's own position)
}

export type HurtSource = 'proj' | 'melee' | 'shock' | 'beam' | 'boom' | 'lava' | 'self';

export interface HurtMsg {
  src: HurtSource;
  id?: number; // projectile id / attack id
  d: number;
}

/** Cosmetic events relayed to other players (tracers, coins, rockets...). */
export type FxMsg =
  | { t: 'shot'; w: 'revolver' | 'shotgun' | 'beam'; from: V; to: V[] }
  | { t: 'coin'; p: V; v: V; id: number }
  | { t: 'coinhit'; id: number }
  | { t: 'rocket'; id: number; p: V; v: V }
  | { t: 'rocketdie'; id: number }
  | { t: 'core'; id: number; p: V; v: V }
  | { t: 'coredie'; id: number }
  | { t: 'punch' }
  | { t: 'ricochet'; pts: V[] };

// ------------------------------------------------------------ server -> client

/** [id, kind index, x, y, z, yaw, state index, hp, elite index + 1 (0 = none)] */
export type EnemySnap = [number, number, number, number, number, number, number, number, number?];
/** [id, kind index, x, y, z, vx, vy, vz, reflected?1:0] */
export type ProjSnap = [number, number, number, number, number, number, number, number, number];
/** [id, x, y, z, vx, vy, vz, yaw, pitch, flags, weapon, hp, alive, hardDamage, connected, revive 0..1, deathX, deathY, deathZ, style to spend] */
export type PlayerSnap = [string, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number?];

/** Run state riding on every snapshot (absent in classic). */
export interface RunSnap {
  d: number; // depth (1-based room number across the run)
  g?: Gate[]; // gates on offer (choice phase)
  prize?: Reward; // what clearing the current room pays
  ch?: Challenge; // current room's challenge
  tl?: number; // time trial: seconds left
}

export interface Snapshot {
  t: number;
  e: EnemySnap[];
  pr: ProjSnap[];
  pl: PlayerSnap[];
  wave: number;
  phase: Phase;
  left: number; // enemies remaining in wave
  timer: number; // phase timer (intermission countdown)
  pk: number; // bitmask of health pickups currently available (index into HEALTH_PICKUPS)
  mode?: GameMode;
  run?: RunSnap;
}

export type Phase = 'lobby' | 'intermission' | 'combat' | 'choice' | 'forge' | 'over' | 'victory';

export const ENEMY_KINDS: EnemyKind[] = ['husk', 'eye', 'warden', 'drone', 'brute', 'colossus', 'stalker'];
export const PROJ_KINDS: ProjectileKind[] = ['orb', 'bolt', 'mortar', 'reflected'];
export const ELITE_KINDS: Elite[] = ['armored', 'swift', 'volatile'];
export const ENEMY_STATES = ['spawn', 'move', 'windup', 'attack', 'recover', 'stun', 'dive', 'beam'] as const;
export type EnemyState = (typeof ENEMY_STATES)[number];

export interface PlayerStats {
  id: string;
  name: string;
  kills: number;
  damage: number;
  deaths: number;
  taken: number;
  style: number;
  parries: number;
}

export type GameEvent =
  | { t: 'spawn'; id: number; k: EnemyKind; p: V; el?: Elite }
  | { t: 'dmg'; id: number; d: number; by: string; hs: boolean; k: string; p: V }
  | { t: 'kill'; id: number; k: EnemyKind; by: string; how: string; p: V; hs: boolean }
  | { t: 'phurt'; pid: string; d: number; hp: number; hard: number; src: HurtSource }
  | { t: 'heal'; pid: string; hp: number; amt: number; hard: number }
  | { t: 'pickup'; i: number; pid: string }
  | { t: 'pdie'; pid: string }
  | { t: 'prespawn'; pid: string; p: V }
  | { t: 'wave'; n: number; total: number; title: string; boss: boolean }
  | { t: 'clear'; n: number }
  | { t: 'atk'; id: number; a: string; dur: number; target?: V }
  | { t: 'melee'; id: number; aid: number; p: V; r: number; d: number }
  | { t: 'shock'; id: number; aid: number; p: V; speed: number; range: number; d: number }
  | { t: 'beam'; id: number; aid: number; p: V; yaw0: number; sweep: number; pitch: number; dur: number; dps: number }
  | { t: 'boom'; p: V; r: number; d: number; hostile: boolean; aid: number; k: string; by?: string }
  | { t: 'parried'; id: number; by: string }
  | { t: 'stun'; id: number; by: string }
  | { t: 'mparry'; id: number; by: string } // punched an enemy mid-swing
  | { t: 'revive'; pid: string; by: string }
  | { t: 'enrage'; id: number }
  | { t: 'fx'; from: string; fx: FxMsg }
  | { t: 'over'; win: boolean; wave: number; time: number; stats: PlayerStats[]; mode?: GameMode; ups?: Record<string, string[]> }
  | { t: 'gates'; gates: Gate[] }
  | { t: 'gate'; i: number; by: string }
  | { t: 'room'; d: number; layer: string; title: string; boss: boolean; elite: boolean; ch?: Challenge; prize?: Reward }
  | { t: 'prize'; k: Reward; ok: boolean; amt?: number }
  | { t: 'offers'; pid: string; offers: string[]; free: boolean; buy: number; reroll: number; rare: boolean }
  | { t: 'upg'; pid: string; list: string[] }
  | { t: 'forged'; pid: string; id: string }
  | { t: 'forgedone'; pid: string }
  | { t: 'reset'; wave: number }
  | { t: 'join'; pid: string; name: string }
  | { t: 'leave'; pid: string };

export interface WelcomeMsg {
  id: string;
  code: string;
  host: boolean;
  players: { id: string; name: string }[];
  phase: Phase;
  mode?: GameMode;
}

export const r2 = (n: number): number => Math.round(n * 100) / 100;
