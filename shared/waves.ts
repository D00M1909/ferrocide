import type { EnemyKind } from './constants';

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

export const WAVES: WaveDef[] = [
  {
    title: 'FIRST BLOOD',
    groups: [
      { kind: 'husk', count: 4, delay: 0.5, where: 'ground' },
      { kind: 'eye', count: 3, delay: 4, where: 'air' },
      { kind: 'husk', count: 4, delay: 7, where: 'ground' },
    ],
  },
  {
    title: 'EYES IN THE SMOKE',
    groups: [
      { kind: 'husk', count: 5, delay: 0.5, where: 'ground' },
      { kind: 'eye', count: 4, delay: 3, where: 'air' },
      { kind: 'warden', count: 2, delay: 7, where: 'tower' },
    ],
  },
  {
    title: 'CROSSFIRE',
    groups: [
      { kind: 'warden', count: 3, delay: 0.5, where: 'ground' },
      { kind: 'drone', count: 2, delay: 2, where: 'air' },
      { kind: 'husk', count: 6, delay: 5, where: 'ground' },
    ],
  },
  {
    title: 'THE HEAVY',
    groups: [
      { kind: 'brute', count: 1, delay: 0.5, where: 'ground' },
      { kind: 'husk', count: 5, delay: 2, where: 'ground' },
      { kind: 'eye', count: 5, delay: 8, where: 'air' },
    ],
  },
  {
    title: 'SWARM PROTOCOL',
    groups: [
      { kind: 'eye', count: 8, delay: 0.5, where: 'air' },
      { kind: 'drone', count: 3, delay: 3, where: 'air' },
      { kind: 'warden', count: 3, delay: 6, where: 'tower' },
      { kind: 'husk', count: 6, delay: 9, where: 'ground' },
    ],
  },
  {
    title: 'TWIN HAMMERS',
    groups: [
      { kind: 'brute', count: 2, delay: 0.5, where: 'ground' },
      { kind: 'warden', count: 4, delay: 4, where: 'tower' },
      { kind: 'husk', count: 6, delay: 8, where: 'ground' },
    ],
  },
  {
    title: 'MELTDOWN',
    groups: [
      { kind: 'husk', count: 8, delay: 0.5, where: 'ground' },
      { kind: 'drone', count: 4, delay: 3, where: 'air' },
      { kind: 'brute', count: 2, delay: 7, where: 'ground' },
      { kind: 'eye', count: 8, delay: 10, where: 'air' },
      { kind: 'warden', count: 4, delay: 12, where: 'tower' },
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

export const MAX_ALIVE = 16;
