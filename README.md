# FERROCIDE

A fast, retro PS1-style arena shooter for the browser, inspired by ULTRAKILL, with **2-player online co-op**.
Blood is fuel: you heal by hurting things up close. Prefer range? Red health crystals are scattered around the arena (small ones on the ground, big ones on the wall catwalks), but they respawn slowly.

## Run it

```bash
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` starts both the Vite client (5173) and the Colyseus game server (2567).

**Production:** `npm run build` then `npm start` — the game server also serves `dist/`, so one process on one port (`PORT`, default 2567) hosts everything. Deploy that process to any Node host with WebSocket support (Fly.io, Railway, Render).

## Play co-op
1. Player 1: **HOST CO-OP** → share the 4-letter room code.
2. Player 2: type the code → **JOIN CO-OP**. You can also join a game already in progress.
3. The host presses **START**.

## Controls
| | |
|---|---|
| WASD / mouse | move / aim |
| Space | jump (3 wall jumps in the air) |
| Shift | dash (3 stamina charges, invulnerable while dashing) |
| C / Ctrl | slide on the ground · **ground slam** in the air · jump right after a slam lands to slam-bounce |
| LMB / RMB | fire / alt-fire |
| F / middle mouse | punch · **parry** yellow projectiles (reflects them, heals 50) |
| 1 2 3 · wheel · Q | weapons · last weapon |
| Esc | pause |

## The arsenal
- **PIERCER** (revolver) — piercing hitscan. RMB throws a coin: shoot it mid-air to ricochet into the nearest head for bonus damage. Chain several coins.
- **SCATTERHAMMER** (shotgun) — brutal up close. RMB lobs a core: shoot it (or punch it) to detonate a huge blast.
- **SLAGTHROWER** (rocket launcher) — RMB remote-detonates rockets in flight. Rocket jump for height.

## Architecture
```
shared/   arena collision, movement physics, the authoritative GameSim (enemies, AI, waves), protocol
server/   Colyseus room wrapping GameSim for co-op (room codes, 30 Hz sim, 20 Hz snapshots)
client/   Three.js renderer (low-res + dither post), weapons, FX, HUD, audio, snapshot interpolation
tools/    asset preparation + headless play-test harness (capture.mjs)
```
- Solo runs the **same GameSim in the browser** (no server needed).
- Co-op: movement is client-authoritative (zero input lag); enemies, damage, waves and health are server-authoritative. Hit claims come from the client that saw the hit; "I got hit" is checked against the victim's exact local position, so dodges are always judged on what the player saw.

## Testing
```bash
node tools/capture.mjs solo --seconds 40 --shots 6          # autoplay bot, screenshots + report
node tools/capture.mjs solo --wave 8 --god --seconds 30      # jump to the boss
node tools/capture.mjs coop --seconds 40                     # two real clients over the network
```
Dev URL flags: `?autostart=solo&bot=1&mute=1&wave=N&god=1`.

See [CREDITS.md](CREDITS.md) for asset licences.
