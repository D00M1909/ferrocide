// Roguelike run: 3 layers of 6 rooms plus a boss. Rooms are waves built from a threat budget
// that grows with depth; between rooms the players walk through one of 2-3 gates, each
// showing what clearing the next room pays out.
import type { EnemyKind } from './constants';
import type { Vec3 } from './math';
import type { SpawnGroup } from './waves';

export const RUN = {
  layers: [
    { name: 'FOUNDRY', boss: 'THE FOUNDRY COLOSSUS' },
    { name: 'SMELTER', boss: 'THE SMELTER COLOSSUS' },
    { name: 'CORE', boss: 'THE CORE COLOSSUS' },
  ],
  roomsPerLayer: 6, // then the boss
  budgetBase: 12,
  budgetPerDepth: 3,
  // past this depth enemies get tougher and hit harder every room
  scaleFrom: 8,
  hpPerDepth: 0.04,
  dmgPerDepth: 0.02,
  bossHp: [1, 1.35, 1.7],
  eliteShare: 0.35, // share of non-heavy enemies that get an affix in an elite room
  cacheBase: 300,
  cachePerDepth: 40,
  // the free pick is free; extra purchases and rerolls cost style, more the deeper you are
  forgeBuyBase: 1500,
  forgeBuyPerDepth: 150,
  forgeBuyStep: 1000, // each further purchase at the same forge
  forgeRerollBase: 400,
  forgeRerollPerDepth: 40,
  forgeTimeout: 75, // seconds before a forge closes on its own (co-op: nobody waits forever)
  timeTrial: 70, // seconds to clear a TIME TRIAL room
};

/** Threat cost per enemy (budget spent per spawn). */
export const COST: Partial<Record<EnemyKind, number>> = { husk: 1, eye: 1, drone: 2, warden: 3, stalker: 3, brute: 8 };

export type Reward = 'forge' | 'repair' | 'cache' | 'elite' | 'challenge';
export type Challenge = 'bloodless' | 'glass' | 'timetrial';
export type Elite = 'armored' | 'swift' | 'volatile';
export const ELITES: Elite[] = ['armored', 'swift', 'volatile'];

export const REWARD_INFO: Record<Reward, { name: string; sub: string; color: number }> = {
  forge: { name: 'FORGE', sub: 'CHOOSE AN UPGRADE', color: 0xff8a2a },
  repair: { name: 'REPAIR', sub: 'FULL HEAL', color: 0x40e070 },
  cache: { name: 'STYLE CACHE', sub: '+STYLE TO SPEND', color: 0x60c8ff },
  elite: { name: 'ELITE', sub: 'TOUGHER ROOM · RARE FORGE', color: 0xff3050 },
  challenge: { name: 'CHALLENGE', sub: 'FORGE + CACHE', color: 0xffe040 },
};

export const CHALLENGE_INFO: Record<Challenge, { name: string; sub: string }> = {
  bloodless: { name: 'BLOODLESS', sub: 'NO BLOOD HEALING' },
  glass: { name: 'GLASS', sub: 'DEAL +50% · TAKE +50%' },
  timetrial: { name: 'TIME TRIAL', sub: `CLEAR IN ${RUN.timeTrial}s OR FORFEIT THE PRIZE` },
};

/** Where the gates stand (feet), facing the arena centre. */
export const GATE_SPOTS: Vec3[] = [
  { x: -10.5, y: 0, z: 0 },
  { x: 10.5, y: 0, z: 0 },
  { x: 0, y: 0, z: -11 },
];
export const GATE_RADIUS = 1.5;

export interface Gate { reward: Reward; challenge?: Challenge }

export interface RoomPlan {
  title: string;
  groups: SpawnGroup[];
  boss: boolean;
  elite: boolean;
}

export const layerOf = (depth: number): number => Math.min(RUN.layers.length - 1, Math.floor((depth - 1) / (RUN.roomsPerLayer + 1)));
export const roomOf = (depth: number): number => ((depth - 1) % (RUN.roomsPerLayer + 1)) + 1; // 7 = boss
export const isBossDepth = (depth: number): boolean => roomOf(depth) === RUN.roomsPerLayer + 1;
export const FINAL_DEPTH = RUN.layers.length * (RUN.roomsPerLayer + 1);

export function roomBudget(depth: number): number {
  return RUN.budgetBase + RUN.budgetPerDepth * depth;
}

export function enemyScale(depth: number): { hp: number; dmg: number } {
  const over = Math.max(0, depth - RUN.scaleFrom);
  return { hp: 1 + over * RUN.hpPerDepth, dmg: 1 + over * RUN.dmgPerDepth };
}

const TITLES = [
  'SLAG AND BONE', 'THE MELT', 'IRON RAIN', 'CRUCIBLE', 'HOT METAL', 'FURNACE LUNG', 'RIVET STORM', 'PIG IRON',
  'THE QUENCH', 'CINDER CHOIR', 'BLAST FURNACE', 'RED SHIFT', 'THE POUR', 'ASH SERMON', 'BELLOWS', 'TEMPERING',
];

/** Build a room's spawn plan from the threat budget. Deterministic for a given rand. */
export function planRoom(depth: number, rand: () => number, elite: boolean, budgetMul = 1): RoomPlan {
  const layer = layerOf(depth);
  if (isBossDepth(depth)) {
    const groups: SpawnGroup[] = [{ kind: 'colossus', count: 1, delay: 1.5, where: 'ground' }, { kind: 'husk', count: 3 + layer * 2, delay: 12, where: 'ground' }];
    if (layer >= 1) groups.push({ kind: 'eye', count: 3 + layer, delay: 20, where: 'air' });
    if (layer >= 2) groups.push({ kind: 'stalker', count: 2, delay: 28, where: 'ground' });
    return { title: RUN.layers[layer].boss, groups, boss: true, elite: false };
  }
  // what can appear this deep
  const unlocked: EnemyKind[] = ['husk', 'eye'];
  if (depth >= 2) unlocked.push('drone');
  if (depth >= 3) unlocked.push('warden');
  if (depth >= 5) unlocked.push('stalker');
  if (depth >= 6 || (elite && depth >= 4)) unlocked.push('brute');
  // dangerous kinds are capped so a room's random theme can't stack them early
  const cap: Partial<Record<EnemyKind, number>> = {
    brute: layer === 0 ? 1 : layer === 1 ? 2 : 3,
    stalker: Math.floor(depth / 2.5),
    warden: 1 + Math.floor(depth / 3),
    drone: 1 + Math.floor(depth / 2.5),
    husk: 8 + depth,
    eye: 5 + depth,
  };
  // each room leans on a random pair of kinds so rooms feel different
  const weight: Partial<Record<EnemyKind, number>> = {};
  for (const k of unlocked) weight[k] = k === 'husk' ? 3 : k === 'brute' ? 0.5 : 1.5;
  for (let i = 0; i < 2; i++) {
    const k = unlocked[Math.floor(rand() * unlocked.length)];
    weight[k] = (weight[k] ?? 1) * 2.2;
  }
  let budget = Math.round(roomBudget(depth) * budgetMul);
  const picks: EnemyKind[] = [];
  const count = new Map<EnemyKind, number>();
  let guard = 0;
  while (budget > 0 && guard++ < 200) {
    const afford = unlocked.filter((k) => (COST[k] ?? 1) <= budget && (count.get(k) ?? 0) < (cap[k] ?? Infinity));
    if (!afford.length) break;
    let total = 0;
    for (const k of afford) total += weight[k] ?? 1;
    let r = rand() * total;
    let pick = afford[0];
    for (const k of afford) { r -= weight[k] ?? 1; if (r <= 0) { pick = k; break; } }
    count.set(pick, (count.get(pick) ?? 0) + 1);
    picks.push(pick);
    budget -= COST[pick] ?? 1;
  }
  // three or four pulses: fodder first, heavies arrive in the middle, the rest trickle in
  const pulses = picks.length > 18 ? 4 : 3;
  const heavy = picks.filter((k) => k === 'brute');
  const rest = picks.filter((k) => k !== 'brute').sort(() => rand() - 0.5);
  const buckets: EnemyKind[][] = Array.from({ length: pulses }, () => []);
  rest.forEach((k, i) => buckets[Math.min(pulses - 1, Math.floor((i / rest.length) * pulses))].push(k));
  heavy.forEach((k, i) => buckets[Math.min(pulses - 1, 1 + (i % (pulses - 1)))].push(k));
  const groups: SpawnGroup[] = [];
  buckets.forEach((b, pi) => {
    const counts = new Map<EnemyKind, number>();
    for (const k of b) counts.set(k, (counts.get(k) ?? 0) + 1);
    let off = 0;
    for (const [kind, count] of counts) {
      const where = kind === 'eye' || kind === 'drone' ? 'air' : kind === 'warden' && rand() < 0.5 ? 'tower' : 'ground';
      groups.push({ kind, count, delay: 0.5 + pi * 5.5 + off, where });
      off += 1.2;
    }
  });
  return { title: TITLES[Math.floor(rand() * TITLES.length)], groups, boss: false, elite };
}

/** The gates offered after a room. `next` is the depth the gates lead to. */
export function planGates(next: number, rand: () => number): Gate[] {
  const room = roomOf(next);
  if (isBossDepth(next)) {
    // the boss door: always a choice between patching up and one more upgrade
    return [{ reward: 'repair' }, { reward: 'forge' }];
  }
  const pool: Reward[] = ['forge', 'forge', 'repair', 'cache', 'cache'];
  if (next >= 3) pool.push('elite', 'challenge');
  if (next >= 9) pool.push('elite');
  const n = rand() < 0.4 || room === 1 ? 3 : 2;
  const out: Gate[] = [];
  // a forge is always on offer every other room so builds keep growing
  if (room % 2 === 1) out.push({ reward: 'forge' });
  while (out.length < n) {
    const r = pool[Math.floor(rand() * pool.length)];
    if (out.some((g) => g.reward === r)) continue;
    const g: Gate = { reward: r };
    if (r === 'challenge') g.challenge = (['bloodless', 'glass', 'timetrial'] as Challenge[])[Math.floor(rand() * 3)];
    out.push(g);
  }
  return out.sort(() => rand() - 0.5);
}
