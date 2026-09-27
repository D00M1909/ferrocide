import { Room, type Client } from 'colyseus';
import { MAX_PLAYERS, SERVER_TICK, SNAPSHOT_RATE } from '../shared/constants';
import type { BoomMsg, FxMsg, HitMsg, HurtMsg, ParryMsg, StateMsg, WelcomeMsg } from '../shared/protocol';
import { GameSim } from '../shared/sim';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const usedCodes = new Set<string>();

function makeCode(): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!usedCodes.has(c)) {
      usedCodes.add(c);
      return c;
    }
  }
}

/**
 * One co-op match. The room owns the authoritative GameSim, feeds it player
 * messages, and streams snapshots + batched events back to both clients.
 */
export class ArenaRoom extends Room {
  override maxClients = MAX_PLAYERS;
  private sim = new GameSim();
  private hostId = '';
  private snapAcc = 0;

  override onCreate(): void {
    this.roomId = makeCode();
    this.setPatchRate(null);
    const tick = 1000 / SERVER_TICK;
    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), tick);

    this.onMessage('state', (c: Client, m: StateMsg) => this.sim.playerState(c.sessionId, m));
    this.onMessage('hit', (c: Client, m: HitMsg) => this.sim.playerHit(c.sessionId, m));
    this.onMessage('boom', (c: Client, m: BoomMsg) => this.sim.playerBoom(c.sessionId, m));
    this.onMessage('parry', (c: Client, m: ParryMsg) => this.sim.playerParry(c.sessionId, m));
    this.onMessage('hurt', (c: Client, m: HurtMsg) => this.sim.playerHurt(c.sessionId, m));
    this.onMessage('fx', (c: Client, m: FxMsg) => this.sim.playerFx(c.sessionId, m));
    this.onMessage('start', (c: Client) => {
      if (c.sessionId === this.hostId) this.sim.start();
    });
    this.onMessage('retry', () => this.sim.retry());
    this.onMessage('hello', (c: Client) => this.welcome(c));
    this.onMessage('ping', (c: Client, t: number) => c.send('pong', t));
  }

  override onJoin(client: Client, options: { name?: string } = {}): void {
    const name = String(options.name || 'SLAYER').slice(0, 14).toUpperCase();
    if (!this.hostId) this.hostId = client.sessionId;
    this.sim.addPlayer(client.sessionId, name);
  }

  private welcome(client: Client): void {
    const welcome: WelcomeMsg = {
      id: client.sessionId,
      code: this.roomId,
      host: client.sessionId === this.hostId,
      players: [...this.sim.players.values()].map((p) => ({ id: p.id, name: p.name })),
      phase: this.sim.phase,
    };
    client.send('welcome', welcome);
  }

  override onLeave(client: Client): void {
    this.sim.removePlayer(client.sessionId);
    if (client.sessionId === this.hostId) {
      const next = this.sim.players.keys().next();
      this.hostId = next.done ? '' : next.value;
      if (this.hostId) {
        const c = this.clients.find((x) => x.sessionId === this.hostId);
        c?.send('host', true);
      }
    }
  }

  override onDispose(): void {
    usedCodes.delete(this.roomId);
  }

  private tick(dt: number): void {
    this.sim.step(Math.min(dt, 0.1));
    const events = this.sim.drainEvents();
    if (events.length) this.broadcast('ev', events);
    this.snapAcc += dt;
    if (this.snapAcc >= 1 / SNAPSHOT_RATE) {
      this.snapAcc = 0;
      this.broadcast('snap', this.sim.snapshot());
    }
  }
}
