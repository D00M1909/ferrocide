import { ENEMIES, type EnemyKind } from './constants';

export interface SpawnGroup {
  kind: EnemyKind;
  count: number;
  delay: number; // seconds after wave start
  where: 'ground' | 'tower' | 'air';
}

export interface WaveDef {
  title: string;
  groups: SpawnGroup[];
  boss?: boolean;
}

// Each wave teaches or combines one thing: husks, then drone bolts (parry them), gazers, wardens,
// the first brute, a mixed air/ground swarm with stalkers, two brutes staggered apart, and a
// climax that layers everything. Heavies always arrive well apart so they are fought one at a time.
export const WAVES: WaveDef[] = [
  {
    title: 'FIRST BLOOD',
    groups: [
      { kind: 'husk', count: 4, delay: 0.5, where: 'ground' },
      { kind: 'husk', count: 4, delay: 6, where: 'ground' },
      { kind: 'drone', count: 1, delay: 11, where: 'air' },
      { kind: 'husk', count: 3, delay: 14, where: 'ground' },
    ],
  },
  {
    title: 'EYES IN THE SMOKE',
    groups: [
      { kind: 'husk', count: 5, delay: 0.5, where: 'ground' },
      { kind: 'eye', count: 4, delay: 3, where: 'air' },
      { kind: 'husk', count: 5, delay: 9, where: 'ground' },
      { kind: 'drone', count: 2, delay: 12, where: 'air' },
      { kind: 'eye', count: 3, delay: 15, where: 'air' },
    ],
  },
  {
    title: 'CROSSFIRE',
    groups: [
      { kind: 'husk', count: 5, delay: 0.5, where: 'ground' },
      { kind: 'warden', count: 2, delay: 4, where: 'ground' },
      { kind: 'drone', count: 2, delay: 8, where: 'air' },
      { kind: 'husk', count: 4, delay: 12, where: 'ground' },
      { kind: 'warden', count: 1, delay: 15, where: 'tower' },
    ],
  },
  {
    title: 'THE HEAVY',
    groups: [
      { kind: 'brute', count: 1, delay: 0.5, where: 'ground' },
      { kind: 'husk', count: 6, delay: 4, where: 'ground' },
      { kind: 'eye', count: 6, delay: 10, where: 'air' },
      { kind: 'warden', count: 2, delay: 15, where: 'tower' },
      { kind: 'husk', count: 4, delay: 19, where: 'ground' },
    ],
  },
  {
    title: 'SWARM PROTOCOL',
    groups: [
      { kind: 'eye', count: 8, delay: 0.5, where: 'air' },
      { kind: 'husk', count: 6, delay: 4, where: 'ground' },
      { kind: 'drone', count: 3, delay: 8, where: 'air' },
      { kind: 'stalker', count: 2, delay: 12, where: 'ground' },
      { kind: 'warden', count: 3, delay: 15, where: 'tower' },
      { kind: 'husk', count: 5, delay: 19, where: 'ground' },
    ],
  },
  {
    title: 'TWIN HAMMERS',
    groups: [
      { kind: 'brute', count: 1, delay: 0.5, where: 'ground' },
      { kind: 'husk', count: 6, delay: 4, where: 'ground' },
      { kind: 'warden', count: 2, delay: 8, where: 'tower' },
      { kind: 'stalker', count: 3, delay: 13, where: 'ground' },
      { kind: 'drone', count: 2, delay: 17, where: 'air' },
      { kind: 'brute', count: 1, delay: 26, where: 'ground' },
      { kind: 'husk', count: 4, delay: 30, where: 'ground' },
    ],
  },
  {
    title: 'MELTDOWN',
    groups: [
      { kind: 'husk', count: 8, delay: 0.5, where: 'ground' },
      { kind: 'drone', count: 3, delay: 4, where: 'air' },
      { kind: 'brute', count: 1, delay: 9, where: 'ground' },
      { kind: 'eye', count: 8, delay: 14, where: 'air' },
      { kind: 'warden', count: 3, delay: 18, where: 'tower' },
      { kind: 'stalker', count: 3, delay: 22, where: 'ground' },
      { kind: 'brute', count: 1, delay: 32, where: 'ground' },
      { kind: 'husk', count: 6, delay: 36, where: 'ground' },
      { kind: 'drone', count: 2, delay: 40, where: 'air' },
    ],
  },
  {
    title: 'THE FOUNDRY COLOSSUS',
    boss: true,
    groups: [
      { kind: 'colossus', count: 1, delay: 1.5, where: 'ground' },
      { kind: 'husk', count: 4, delay: 12, where: 'ground' },
    ],
  },
];

/** The scripted campaign; beating the last wave is a win, and an endless mode can carry on from there. */
export const CLASSIC_WAVES = WAVES.length;

/** Simultaneous enemies allowed on the field; the rest wait in the spawn queue. */
export const MAX_ALIVE = 16;
const MAX_ALIVE_LATE = 20; // later waves
// two players face x1.5 enemies, so the field holds more of them at once
const MAX_ALIVE_COOP = 22;
const MAX_ALIVE_COOP_LATE = 24;

export function aliveCap(late: boolean, players: number): number {
  if (players > 1) return late ? MAX_ALIVE_COOP_LATE : MAX_ALIVE_COOP;
  return late ? MAX_ALIVE_LATE : MAX_ALIVE;
}

/** How dangerous one enemy is to fight, relative to its health (ranged and fast ones punish more). */
export const THREAT_WEIGHT: Record<EnemyKind, number> = {
  husk: 1, eye: 1.5, drone: 1.6, warden: 1.5, stalker: 2, brute: 0.7, colossus: 0.5,
};

/** Wave difficulty in comparable units: sum of enemy HP x danger weight, per 100. */
export function waveThreat(def: WaveDef): number {
  let t = 0;
  for (const g of def.groups) t += g.count * ENEMIES[g.kind].hp * THREAT_WEIGHT[g.kind];
  return Math.round(t / 10) / 10;
}
