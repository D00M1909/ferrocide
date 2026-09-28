// Who's playing right now: browsers send a small heartbeat every few seconds (solo games
// never touch the game server otherwise), and co-op rooms register themselves. /status
// renders both, but only for requests made on this machine (anything arriving through a
// Cloudflare tunnel carries cf-* headers) or carrying ?key=STATUS_KEY when hosted, so
// visitors can't read room codes or callsigns.
import express, { type Application, type Request } from 'express';

interface Visitor { name: string; mode: string; wave: number; phase: string; first: number; last: number }
export interface RoomInfo { code: string; players: { name: string; connected: boolean; alive: boolean }[]; wave: number; phase: string; created: number }

const visitors = new Map<string, Visitor>();
export const rooms = new Map<string, () => RoomInfo>();
const STALE_MS = 75_000; // background tabs throttle timers to ~1/min

const clean = (v: unknown, max: number) => String(v ?? '').replace(/[^A-Za-z0-9 _-]/g, '').slice(0, max);

const STATUS_KEY = process.env.STATUS_KEY ?? '';

function allowed(req: Request): boolean {
  if (STATUS_KEY && req.query.key === STATUS_KEY) return true;
  if (req.headers['cf-connecting-ip'] || req.headers['cf-ray'] || req.headers['x-forwarded-for']) return false;
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

const ago = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function mountStatus(app: Application): void {
  // text/plain JSON: a CORS "simple" request, so the hosted client can post it cross-origin
  app.post('/presence', express.text({ type: '*/*', limit: '1kb' }), (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    let b: Record<string, unknown> = {};
    try { b = JSON.parse(String(req.body || '{}')) as Record<string, unknown>; } catch { /* ignore junk */ }
    const id = clean(b.id, 24);
    if (!id) { res.sendStatus(400); return; }
    const now = Date.now();
    const prev = visitors.get(id);
    if (!prev && visitors.size >= 500) { res.sendStatus(429); return; } // flood guard
    if (b.bye) visitors.delete(id);
    else visitors.set(id, {
      name: clean(b.name, 14).toUpperCase() || '—', mode: clean(b.mode, 8), wave: Math.max(0, Math.min(99, Number(b.wave) | 0)),
      phase: clean(b.phase, 12), first: prev?.first ?? now, last: now,
    });
    res.sendStatus(204);
  });

  app.get('/status', (req, res) => {
    if (!allowed(req)) { res.sendStatus(404); return; }
    const now = Date.now();
    for (const [id, v] of visitors) if (now - v.last > STALE_MS) visitors.delete(id);
    const vis = [...visitors.values()].sort((a, b) => a.first - b.first);
    const rs = [...rooms.values()].map((f) => f());
    const playing = vis.filter((v) => v.mode !== 'menu').length;
    const row = (v: Visitor) => `<tr><td>${esc(v.name)}</td><td>${v.mode === 'menu' ? 'main menu' : esc(v.mode)}</td><td>${v.mode === 'menu' ? '' : `wave ${v.wave} · ${esc(v.phase)}`}</td><td>${ago(now - v.first)}</td></tr>`;
    const room = (r: RoomInfo) => `<tr><td><b>${esc(r.code)}</b></td><td>${r.players.map((p) => `${esc(p.name)}${p.connected ? '' : ' (reconnecting)'}${p.alive ? '' : ' ☠'}`).join(', ') || '—'}</td><td>wave ${r.wave} · ${esc(r.phase)}</td><td>${ago(now - r.created)}</td></tr>`;
    res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="5"><title>FERROCIDE status</title>
<style>body{background:#0e0b0c;color:#ddd;font:15px system-ui;margin:32px}h1{color:#ff5a2a;margin:0 0 4px}h2{margin:28px 0 8px;color:#aaa;font-size:14px;letter-spacing:.1em}
table{border-collapse:collapse;min-width:520px}td,th{padding:6px 14px 6px 0;text-align:left;border-bottom:1px solid #2a2224}th{color:#888;font-weight:500}.big{font-size:40px;font-weight:700}.dim{color:#777}</style></head><body>
<h1>FERROCIDE · live</h1><div class="dim">refreshes every 5 s · private (this PC, or ?key=)</div>
<p><span class="big">${vis.length}</span> on the site · <b>${playing}</b> in a game · <b>${rs.length}</b> co-op room${rs.length === 1 ? '' : 's'}</p>
<h2>VISITORS</h2>${vis.length ? `<table><tr><th>CALLSIGN</th><th>DOING</th><th></th><th>ONLINE FOR</th></tr>${vis.map(row).join('')}</table>` : '<div class="dim">nobody right now</div>'}
<h2>CO-OP ROOMS</h2>${rs.length ? `<table><tr><th>CODE</th><th>PLAYERS</th><th></th><th>OPEN FOR</th></tr>${rs.map(room).join('')}</table>` : '<div class="dim">none</div>'}
</body></html>`);
  });
}

/** One line per join/leave in the server console too. */
export function logLine(msg: string): void {
  console.log(`${new Date().toLocaleTimeString()}  ${msg}`);
}
