// Transport abstraction: the game talks to a NetLink whether it's playing solo
// (GameSim runs in-browser) or co-op (GameSim runs in a Colyseus room).
import { Client, type Room } from '@colyseus/sdk';
import { SERVER_TICK, SNAPSHOT_RATE } from '../../../shared/constants';
import type { BoomMsg, FxMsg, GameEvent, HitMsg, HurtMsg, ParryMsg, Snapshot, StateMsg, WelcomeMsg } from '../../../shared/protocol';
import { GameSim } from '../../../shared/sim';

export interface NetHandlers {
  snap: (s: Snapshot) => void;
  events: (e: GameEvent[]) => void;
  host: (isHost: boolean) => void;
  disconnect: (reason: string) => void;
  drop: () => void; // connection lost, SDK is trying to reconnect
  reconnect: () => void;
}

export interface NetLink {
  readonly id: string;
  readonly code: string;
  readonly online: boolean;
  isHost: boolean;
  interpDelay: number;
  ping: number;
  handlers: Partial<NetHandlers>;
  state(m: StateMsg): void;
  hit(m: HitMsg): void;
  boom(m: BoomMsg): void;
  parry(m: ParryMsg): void;
  hurt(m: HurtMsg): void;
  fx(m: FxMsg): void;
  start(): void;
  retry(): void;
  update(dt: number): void;
  leave(): void;
}

/** Solo play: the authoritative simulation runs right here at a fixed tick. */
export class LocalLink implements NetLink {
  readonly id = 'local';
  readonly code = 'SOLO';
  readonly online = false;
  isHost = true;
  interpDelay = 1 / SERVER_TICK + 0.01;
  ping = 0;
  handlers: Partial<NetHandlers> = {};
  private sim = new GameSim();
  private acc = 0;
  /** Dev/test flags: ?wave=N starts at a later wave, ?god=1 ignores damage. */
  private startWave = Number(new URLSearchParams(location.search).get('wave') || 1);
  private god = new URLSearchParams(location.search).get('god') === '1';

  constructor(name: string) {
    this.sim.addPlayer(this.id, name);
  }

  state(m: StateMsg): void { this.sim.playerState(this.id, m); }
  hit(m: HitMsg): void { this.sim.playerHit(this.id, m); this.flush(); }
  boom(m: BoomMsg): void { this.sim.playerBoom(this.id, m); this.flush(); }
  parry(m: ParryMsg): void { this.sim.playerParry(this.id, m); this.flush(); }
  hurt(m: HurtMsg): void { if (!this.god) this.sim.playerHurt(this.id, m); this.flush(); }
  fx(_m: FxMsg): void { /* nobody else to tell */ }
  start(): void { this.sim.start(this.startWave); }
  retry(): void { this.sim.retry(); }

  update(dt: number): void {
    const step = 1 / SERVER_TICK;
    this.acc += Math.min(dt, 0.25);
    while (this.acc >= step) {
      this.acc -= step;
      this.sim.step(step);
      this.flush();
      this.handlers.snap?.(this.sim.snapshot());
    }
  }

  private flush(): void {
    const ev = this.sim.drainEvents();
    if (ev.length) this.handlers.events?.(ev);
  }

  leave(): void { /* nothing to tear down */ }
}

export function serverUrl(): string {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  // hosted: the static client (Cloudflare Pages) talks to a separate game server set at build time
  const built = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (built) return built.replace(/\/$/, '');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // dev: vite on 5173, game server on 2567. self-hosted build: same origin.
  if (location.port === '5173') return `${proto}://${location.hostname}:2567`;
  return `${proto}://${location.host}`;
}

/** The game server's HTTP base (health checks, presence). */
export function serverHttp(): string {
  return serverUrl().replace(/^ws/, 'http');
}

/**
 * Free hosting puts an idle game server to sleep; waking it takes up to a minute. Pings /health
 * until it answers, reporting progress so the menu can say what's happening instead of failing.
 */
export async function wakeServer(onWaiting: (seconds: number) => void, timeout = 150, cancelled: () => boolean = () => false): Promise<boolean> {
  const t0 = performance.now();
  for (;;) {
    if (cancelled()) return false;
    const ctl = new AbortController();
    const abort = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(`${serverHttp()}/health`, { signal: ctl.signal, cache: 'no-store' });
      if (r.ok) return true;
    } catch {
      /* asleep or unreachable: keep knocking */
    } finally {
      clearTimeout(abort);
    }
    const waited = (performance.now() - t0) / 1000;
    if (waited > timeout) return false;
    onWaiting(Math.round(waited));
    await new Promise((r) => setTimeout(r, 2000));
  }
}

/** Co-op over Colyseus. */
export class ColyseusLink implements NetLink {
  readonly online = true;
  isHost = false;
  interpDelay = 1 / SNAPSHOT_RATE * 2 + 0.02;
  ping = 0;
  handlers: Partial<NetHandlers> = {};
  id = '';
  code = '';
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  private constructor(private room: Room) {}

  static async connect(mode: 'host' | 'join', name: string, code = ''): Promise<{ link: ColyseusLink; welcome: WelcomeMsg }> {
    const client = new Client(serverUrl());
    const room = mode === 'host'
      ? await client.create('arena', { name })
      : await client.joinById(code.trim().toUpperCase(), { name });
    const link = new ColyseusLink(room);
    const welcome = await new Promise<WelcomeMsg>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Server did not respond')), 8000);
      room.onMessage('welcome', (w: WelcomeMsg) => {
        clearTimeout(t);
        resolve(w);
      });
      room.send('hello', 1);
    });
    link.id = welcome.id;
    link.code = welcome.code;
    link.isHost = welcome.host;
    room.onMessage('snap', (s: Snapshot) => link.handlers.snap?.(s));
    room.onMessage('ev', (e: GameEvent[]) => link.handlers.events?.(e));
    room.onMessage('host', () => {
      link.isHost = true;
      link.handlers.host?.(true);
    });
    room.onMessage('pong', (t: number) => {
      const rtt = performance.now() - t;
      link.ping = link.ping ? link.ping * 0.8 + rtt * 0.2 : rtt;
      link.interpDelay = Math.min(0.25, 2 / SNAPSHOT_RATE + 0.02);
    });
    room.onDrop(() => link.handlers.drop?.());
    room.onReconnect(() => link.handlers.reconnect?.());
    room.onLeave((code) => {
      if (code !== 1000 && code !== 4000) link.handlers.disconnect?.('Connection to the server was lost.');
    });
    link.pingTimer = setInterval(() => room.send('ping', performance.now()), 1000);
    return { link, welcome };
  }

  state(m: StateMsg): void { this.room.send('state', m); }
  hit(m: HitMsg): void { this.room.send('hit', m); }
  boom(m: BoomMsg): void { this.room.send('boom', m); }
  parry(m: ParryMsg): void { this.room.send('parry', m); }
  hurt(m: HurtMsg): void { this.room.send('hurt', m); }
  fx(m: FxMsg): void { this.room.send('fx', m); }
  start(): void { this.room.send('start', 1); }
  retry(): void { this.room.send('retry', 1); }
  update(): void { /* network pushes to us */ }

  leave(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.handlers = {};
    void this.room.leave(true).catch(() => undefined);
  }
}
