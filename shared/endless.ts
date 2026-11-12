// Endless mode: waves past the scripted campaign are generated from the wave number alone, so
// the browser and the server (and a retry) always produce the same wave. Budgets and enemy
// scaling reuse the roguelike room machinery in run.ts.
import { rng } from './math';
import { RUN, enemyScale, isBossDepth, planRoom } from './run';
import { CLASSIC_WAVES, waveThreat, type SpawnGroup, type WaveDef } from './waves';

export const ENDLESS_BOSS_EVERY = 8;

const ADJ = ['MOLTEN', 'HOLLOW', 'RUSTED', 'SCORCHED', 'BROKEN', 'CRIMSON', 'SILENT', 'BURNING', 'FORGOTTEN', 'RELENTLESS', 'IRON', 'ASHEN'];
const NOUN = ['CRUCIBLE', 'FURNACE', 'CHOIR', 'ANVIL', 'TIDE', 'ENGINE', 'HARVEST', 'VIGIL', 'STORM', 'RECKONING', 'SMELTER', 'PYRE'];

export const isEndlessBoss = (wave: number): boolean => wave > CLASSIC_WAVES && wave % ENDLESS_BOSS_EVERY === 0;

/** Enemy health and damage multipliers for a generated wave (the roguelike's per-depth curve). */
export const endlessScale = (wave: number): { hp: number; dmg: number } => enemyScale(wave);

/** Extra health on the Colossus of wave 16, 24, ...: starts at the last campaign boss's ceiling. */
export const endlessBossMul = (wave: number): number => RUN.bossHp[RUN.bossHp.length - 1] + 0.5 * (Math.floor(wave / ENDLESS_BOSS_EVERY) - 2);

export function endlessTitle(wave: number): string {
  const r = rng(wave * 7919 + 13);
  return `${ADJ[Math.floor(r() * ADJ.length)]} ${NOUN[Math.floor(r() * NOUN.length)]}`;
}

/**
 * The wave for number `wave` (> CLASSIC_WAVES). The budget starts above the campaign's last
 * regular wave and grows every wave; heavies are spread out so they never arrive together.
 */
export function generateWave(wave: number): WaveDef {
  const k = wave - CLASSIC_WAVES; // 1 = first endless wave
  if (isEndlessBoss(wave)) {
    const tier = Math.floor(wave / ENDLESS_BOSS_EVERY);
    const groups: SpawnGroup[] = [
      { kind: 'colossus', count: 1, delay: 1.5, where: 'ground' },
      { kind: 'husk', count: 6 + tier, delay: 12, where: 'ground' },
      { kind: 'eye', count: 4 + tier, delay: 20, where: 'air' },
      { kind: 'stalker', count: 2 + Math.floor(tier / 2), delay: 28, where: 'ground' },
    ];
    return { title: `${endlessTitle(wave)} · COLOSSUS`, groups, boss: true };
  }
  // depth 22 plans a ~78 budget (above the campaign's wave 7); every wave adds about 6
  let depth = 22 + 2 * (k - 1);
  if (isBossDepth(depth)) depth++; // planRoom would build a roguelike boss room
  // random picks vary a lot in danger, so draw a few plans and keep the one closest to the wave's target threat
  const target = 46 + 3.5 * k;
  let plan = planRoom(depth, rng(wave * 104729 + 7), false);
  for (let salt = 1; salt < 12; salt++) {
    const alt = planRoom(depth, rng(wave * 104729 + 7 + salt * 977), false);
    if (Math.abs(waveThreat(alt) - target) < Math.abs(waveThreat(plan) - target)) plan = alt;
  }
  // spread any heavies apart: one brute per group, 11 s between them
  const groups: SpawnGroup[] = [];
  let brutes = 0;
  for (const g of plan.groups) {
    if (g.kind !== 'brute') { groups.push(g); continue; }
    for (let i = 0; i < g.count; i++) groups.push({ ...g, count: 1, delay: g.delay + 11 * brutes++ });
  }
  groups.sort((a, b) => a.delay - b.delay);
  return { title: endlessTitle(wave), groups };
}
