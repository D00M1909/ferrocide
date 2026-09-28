import { Room, type Client } from 'colyseus';
import { MAX_PLAYERS, SERVER_TICK } from '../shared/constants';
import type { WelcomeMsg } from '../shared/protocol';
import { GameSim } from '../shared/sim';
import { logLine, rooms } from './status';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const usedCodes = new Set<string>();
const RECONNECT_SECONDS = 20;

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
 * messages, and streams a snapshot + batched events back every simulation tick.
 * Rooms are private: the only way in is the 4-letter code.
 */
export class ArenaRoom extends Room {
  override maxClients = MAX_PLAYERS;
  override maxMessagesPerSecond = 150;
  private sim = new GameSim();
  private hostId = '';
  private created = Date.now();

  override onCreate(): void {
    this.roomId = makeCode();
    void this.setPrivate(true);
    // fixed 30 Hz authority; state patches are unused (we stream our own snapshots)
    this.setFixedTimestep((ctx) => this.tick(ctx.dt), SERVER_TICK);
    this.patchRate = null;

    // every handler goes through the sim's own validation; bad payloads are ignored
    this.onMessage('state', (c: Client, m: unknown) => this.sim.playerState(c.sessionId, m));
    this.onMessage('hit', (c: Client, m: unknown) => this.sim.playerHit(c.sessionId, m));
    this.onMessage('boom', (c: Client, m: unknown) => this.sim.playerBoom(c.sessionId, m));
    this.onMessage('parry', (c: Client, m: unknown) => this.sim.playerParry(c.sessionId, m));
    this.onMessage('hurt', (c: Client, m: unknown) => this.sim.playerHurt(c.sessionId, m));
    this.onMessage('fx', (c: Client, m: unknown) => this.sim.playerFx(c.sessionId, m));
    this.onMessage('start', (c: Client, m: unknown) => {
      if (c.sessionId !== this.hostId) return;
      const mode = m && typeof m === 'object' ? (m as { mode?: unknown }).mode : undefined;
      this.sim.start(1, mode === 'run' ? 'run' : 'classic');
    });
    this.onMessage('forge', (c: Client, m: unknown) => this.sim.playerForge(c.sessionId, m));
    this.onMessage('retry', (c: Client) => {
      if (c.sessionId === this.hostId) this.sim.retry();
    });
    this.onMessage('hello', (c: Client) => this.welcome(c));
    this.onMessage('ping', (c: Client, t: unknown) => c.send('pong', Number(t) || 0));
    rooms.set(this.roomId, () => ({
      code: this.roomId, wave: this.sim.wave, phase: this.sim.phase, created: this.created,
      players: [...this.sim.players.values()].map((p) => ({ name: p.name, connected: p.connected, alive: p.alive })),
    }));
    logLine(`room ${this.roomId} opened`);
  }

  override onUncaughtException(error: unknown, method: string): void {
    // never let one bad packet take the whole match down
    console.error(`[room ${this.roomId}] ${method} threw:`, error);
  }

  override onJoin(client: Client, options: { name?: unknown } = {}): void {
    const name = String(options?.name || 'SLAYER').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 14).toUpperCase() || 'SLAYER';
    if (!this.hostId) this.hostId = client.sessionId;
    this.sim.hostId = this.hostId;
    this.sim.addPlayer(client.sessionId, name);
    logLine(`${name} joined room ${this.roomId} (${this.clients.length}/${MAX_PLAYERS})`);
  }

  override onDrop(client: Client): void {
    this.sim.setConnected(client.sessionId, false);
    this.allowReconnection(client, RECONNECT_SECONDS);
  }

  override onReconnect(client: Client): void {
    this.sim.setConnected(client.sessionId, true);
    this.welcome(client);
  }

  override onLeave(client: Client): void {
    logLine(`${this.sim.players.get(client.sessionId)?.name ?? 'player'} left room ${this.roomId}`);
    this.sim.removePlayer(client.sessionId);
    if (client.sessionId === this.hostId) {
      const next = this.sim.players.keys().next();
      this.hostId = next.done ? '' : next.value;
      this.sim.hostId = this.hostId;
      if (this.hostId) this.clients.find((x) => x.sessionId === this.hostId)?.send('host', true);
    }
  }

  override onDispose(): void {
    usedCodes.delete(this.roomId);
    rooms.delete(this.roomId);
    logLine(`room ${this.roomId} closed`);
  }

  private welcome(client: Client): void {
    const welcome: WelcomeMsg = {
      id: client.sessionId,
      code: this.roomId,
      host: client.sessionId === this.hostId,
      players: [...this.sim.players.values()].map((p) => ({ id: p.id, name: p.name })),
      phase: this.sim.phase,
      mode: this.sim.mode,
    };
    client.send('welcome', welcome);
    this.sim.resync();
  }

  private tick(dt: number): void {
    this.sim.step(dt);
    const events = this.sim.drainEvents();
    if (events.length) this.broadcast('ev', events);
    this.broadcast('snap', this.sim.snapshot());
  }
}
