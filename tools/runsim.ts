// Headless run check: drives the sim through a whole roguelike run (instant kills, free forge
// picks, first gate) and prints each room's makeup, the gates offered and the upgrades taken.
//   npx tsx tools/runsim.ts [seed] [players]
import { GATE_SPOTS } from '../shared/run';
import { GameSim } from '../shared/sim';
import type { GameEvent } from '../shared/protocol';

const seed = Number(process.argv[2] ?? 1234);
const players = Number(process.argv[3] ?? 1);
const sim = new GameSim(seed);
const ids = ['a', 'b'].slice(0, players);
for (const id of ids) sim.addPlayer(id, id.toUpperCase());
sim.hostId = 'a';
sim.start(1, 'run');

// test hooks into the sim's private state
const priv = sim as unknown as { damageEnemy: (...a: unknown[]) => void; players: Map<string, unknown>; enemies: Map<number, { hp: number; kind: string; elite: string | null }> };
const log: string[] = [];
let kinds = new Map<string, number>();
let elites = 0;
let t = 0;
let lastPhase = '';
const ups: Record<string, string[]> = {};
for (let tick = 0; tick < 30 * 60 * 60 && sim.phase !== 'victory' && sim.phase !== 'over'; tick++) {
  sim.step(1 / 30);
  t += 1 / 30;
  for (const e of sim.drainEvents() as GameEvent[]) {
    if (e.t === 'room') { log.push(`\n[${t.toFixed(0)}s] ROOM d${e.d} ${e.layer} "${e.title}"${e.boss ? ' BOSS' : ''}${e.elite ? ' ELITE' : ''}${e.ch ? ' ' + e.ch : ''} prize=${e.prize}`); kinds = new Map(); elites = 0; }
    if (e.t === 'spawn') { kinds.set(e.k, (kinds.get(e.k) ?? 0) + 1); if (e.el) elites++; }
    if (e.t === 'clear') log.push(`   spawned: ${[...kinds].map(([k, n]) => `${k}×${n}`).join(' ')}${elites ? ` (elites ${elites})` : ''}`);
    if (e.t === 'gates') log.push(`   gates: ${e.gates.map((g) => g.reward + (g.challenge ? `/${g.challenge}` : '')).join(', ')}`);
    if (e.t === 'offers' && e.free) log.push(`   offers(${e.pid}): ${e.offers.join(', ')}${e.rare ? ' [rare]' : ''}`);
    if (e.t === 'upg') ups[e.pid] = e.list;
    if (e.t === 'prize') log.push(`   prize: ${e.k} ok=${e.ok}${e.amt ? ` +${e.amt}` : ''}`);
  }
  if (sim.phase !== lastPhase) lastPhase = sim.phase;
  if (sim.phase === 'combat') {
    // let each pulse arrive, then wipe it
    for (const e of [...priv.enemies.values()]) if (Math.random() < 0.02) priv.damageEnemy(e, 1e6, 'a', 'revolver', false, priv.players.get('a'));
  } else if (sim.phase === 'forge') {
    for (const id of ids) { sim.playerForge(id, { a: 'pick', i: 0 }); sim.playerForge(id, { a: 'done' }); }
  } else if (sim.phase === 'choice') {
    const p = priv.players.get('a') as { pos: { x: number; y: number; z: number } };
    const g = GATE_SPOTS[Math.floor(Math.random() * 2)];
    p.pos = { x: g.x, y: 0, z: g.z };
  }
}
console.log(log.join('\n'));
console.log(`\nend phase: ${sim.phase} at depth ${sim.wave} after ${(t / 60).toFixed(1)} sim-minutes`);
for (const [id, list] of Object.entries(ups)) console.log(`upgrades ${id}: ${list.join(', ')}`);
