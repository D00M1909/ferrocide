import { Server } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArenaRoom } from './ArenaRoom';

const port = Number(process.env.PORT || 2567);
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', 'dist');

const server = new Server({
  transport: new WebSocketTransport(),
  greet: false,
  express: (app) => {
    // production: serve the built client from the same origin as the game server
    if (fs.existsSync(dist)) app.use(express.static(dist));
    app.get('/health', (_req, res) => {
      res.json({ ok: true });
    });
  },
});

server.define('arena', ArenaRoom);
await server.listen(port);
console.log(`[ferrocide] game server on :${port}${fs.existsSync(dist) ? ' (serving dist/)' : ''}`);
