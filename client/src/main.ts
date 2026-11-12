// Boot, menus, lobby, pause and results screens.
import './style.css';
import { GAME_NAME } from '../../shared/constants';
import type { GameMode, Phase, WelcomeMsg } from '../../shared/protocol';
import { FINAL_DEPTH, RUN, isBossDepth, layerOf, roomOf } from '../../shared/run';
import { UPGRADE_BY_ID, type UpgradeDef } from '../../shared/upgrades';
import { CLASSIC_WAVES } from '../../shared/waves';
import { loadAssets } from './engine/assets';
import { Audio } from './engine/audio';
import { Input } from './engine/input';
import { Game, type ForgeOffers, type GameOverInfo } from './game/Game';
import { finalGrade } from './game/style';
import { ColyseusLink, LocalLink, serverHttp, wakeServer, type NetLink } from './net/link';
import { loadSettings, saveSettings, type Settings } from './settings';
import { isTouch } from './platform';
import { TouchControls } from './game/touch';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;
const params = new URLSearchParams(location.search);
const settings: Settings = loadSettings();
if (params.get('name')) settings.name = params.get('name')!.toUpperCase();
if (params.get('res')) settings.resolution = Number(params.get('res'));
const botMode = params.get('bot') === '1';
/** Run mode is unfinished: only offered on local builds or with ?runs=1, hidden on the public site. */
const runsEnabled = ['localhost', '127.0.0.1'].includes(location.hostname) || params.get('runs') === '1';

const audio = new Audio();
if (params.get('mute') === '1') settings.master = 0;
const input = new Input(canvas);
input.touch = isTouch;
let touchUi: TouchControls | null = null;
if (isTouch) {
  document.body.classList.add('touch');
  // Phones are short in landscape: scale the menus and HUD (designed for ~720px tall) to fit,
  // and size the on-screen buttons from the screen height.
  const fit = () => {
    // the on-screen keyboard shrinks the viewport: don't rescale everything while typing
    if (document.activeElement instanceof HTMLInputElement && document.activeElement.type === 'text') return;
    const w = window.innerWidth, hh = window.innerHeight;
    const st = document.documentElement.style;
    st.setProperty('--ui-scale', String(Math.max(0.6, Math.min(1, hh / 580, w / 1180))));
    st.setProperty('--hud-scale', String(Math.max(0.5, Math.min(1, hh / 640))));
    st.setProperty('--ts', String(Math.max(0.8, Math.min(1.5, hh / 390))));
    // turned upright mid-fight: pause until the phone is back in landscape
    if (hh > w && input.locked) input.exitLock();
  };
  fit();
  window.addEventListener('resize', fit);
  // leaving the tab or locking the phone pauses and silences the game
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (input.locked) input.exitLock();
      void audio.ctx.suspend();
    } else audio.resume();
  });
}

/** Keep the phone's screen awake while a fight is on (it would otherwise dim during a long hold). */
let wakeLock: { release(): Promise<void> } | null = null;
function setAwake(on: boolean): void {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
  if (!isTouch || !wl) return;
  if (on && !wakeLock) void wl.request('screen').then((l) => { wakeLock = l; }).catch(() => undefined);
  else if (!on && wakeLock) { void wakeLock.release().catch(() => undefined); wakeLock = null; }
}
let game: Game;
let screen: HTMLElement | null = null;
let clickGate: HTMLElement | null = null;
let lobbyPlayers: { id: string; name: string }[] = [];

function h(html: string, cls = 'screen dim'): HTMLElement {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  return d;
}

function show(el: HTMLElement | null): void {
  screen?.remove();
  screen = el;
  if (el) ui.appendChild(el);
}

function blip(): void {
  audio.resume();
  audio.synth('tick', 0.35); // a short, quiet click (the old sample was a multi-second drone)
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ------------------------------------------------------------------ boot

async function boot(): Promise<void> {
  const loading = h(`<div class="logo">${GAME_NAME}</div><div class="loading" id="lp">LOADING 0%</div>`);
  show(loading);
  let a = 0, b = 0;
  const upd = () => {
    const el = document.getElementById('lp');
    if (el) el.textContent = `LOADING ${Math.round(((a + b) / 2) * 100)}%`;
  };
  await Promise.all([
    loadAssets((f) => { a = f; upd(); }),
    audio.loadAll((f) => { b = f; upd(); }),
  ]);
  game = new Game(canvas, ui, audio, input, settings);
  game.warmup(); // compile every shader behind the loading screen, not mid-fight
  (window as unknown as { __game: Game }).__game = game;
  game.onGameOver = (info) => showResults(info);
  game.onPause = (p) => (p ? showPause() : hidePause());
  game.onDisconnect = (r) => { game.end(); mainMenu(r); };
  game.onPhase = (p) => onPhase(p);
  game.onForge = (f) => (f ? showForge(f) : closeForge());
  // a retry (from either player) closes everyone's results screen
  game.onReset = () => {
    if (screen?.classList.contains('results-screen')) { show(null); gate(); }
  };
  // the host chose to play on past the boss: the victory screen closes for both players
  game.onEndless = () => {
    if (screen?.classList.contains('results-screen')) { show(null); gate(); }
  };
  let toast: HTMLElement | null = null;
  game.onConnection = (ok) => {
    toast?.remove();
    toast = null;
    if (!ok) {
      toast = h('CONNECTION LOST — RECONNECTING…', 'toast');
      ui.appendChild(toast);
    }
  };
  // (no beforeunload prompt: it fired on every dev hot-reload and refresh. Ctrl+W is
  // instead swallowed by the fullscreen keyboard lock while you're playing.)
  // co-op: tell the server we left on purpose so the partner isn't kept waiting 20 s
  window.addEventListener('pagehide', () => game.link?.leave());
  game.startLoop();
  startPresence();
  if (isTouch) {
    touchUi = new TouchControls(ui, input, () => input.exitLock());
    touchUi.haptics = settings.haptics;
    touchUi.gyroSens = settings.gyroSens;
    setInterval(() => touchUi?.setWeapon(game.weapons.index), 120);
  }
  input.onLockChange = (locked) => {
    touchUi?.setActive(locked && game?.mode === 'play');
    setAwake(locked && game?.mode === 'play');
    if (!game || game.mode !== 'play' || botMode) return;
    if (locked) {
      clickGate?.remove();
      clickGate = null;
      touchUi?.setPreview(false);
      game.held = false;
      game.setPaused(false);
    } else if (!screen && game.phase !== 'over' && game.phase !== 'victory' && !lobbyOpen) {
      game.setPaused(true);
    }
  };
  // safety net: if the game is running but the mouse isn't captured, a click on it recaptures
  canvas.addEventListener('mousedown', () => {
    if (game.mode === 'play' && !botMode && !screen && !pauseEl && !clickGate && !input.locked) input.requestLock();
  });
  const auto = params.get('autostart');
  if (auto === 'solo') startSolo(runsEnabled && params.get('mode') === 'run' ? 'run' : 'classic');
  else if (auto === 'host') void startOnline('host');
  else if (auto === 'join') void startOnline('join', params.get('code') ?? '');
  else mainMenu();
}

/** Heartbeat to the game server's /status page (the only way it sees solo players). */
function startPresence(): void {
  if (location.port === '5173' || botMode) return; // dev: no status page worth feeding
  const id = Math.random().toString(36).slice(2, 12);
  const send = (bye = false) => {
    const body = JSON.stringify({
      id, bye, name: settings.name, wave: game.wave, phase: game.phase,
      mode: game.mode === 'menu' ? 'menu' : game.link?.online ? 'co-op' : 'solo',
    });
    // text/plain keeps it a CORS "simple" request (no preflight) now that the server lives elsewhere
    const url = `${serverHttp()}/presence`;
    if (bye) navigator.sendBeacon?.(url, new Blob([body], { type: 'text/plain' }));
    else void fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true }).catch(() => undefined);
  };
  send();
  setInterval(() => send(), 10_000);
  window.addEventListener('pagehide', () => send(true));
}

// ------------------------------------------------------------------ menus

function mainMenu(error = ''): void {
  void audio.playMusic('menu');
  const el = h(`
    <div class="menu-left">
      <div class="logo">${GAME_NAME}</div>
      <div class="tagline">BLOOD IS <b>FUEL</b> · 2P CO-OP</div>
      <div class="menu">
        <div class="section-label">CALLSIGN</div>
        <input type="text" id="name" maxlength="14" placeholder="SLAYER" value="${esc(settings.name)}" />
        <div class="section-label">DEPLOY</div>
        ${runsEnabled
          ? '<button class="primary" id="run">START A RUN <small>SOLO · ROGUELIKE</small></button><button id="solo">CLASSIC <small>SOLO · 8 WAVES</small></button>'
          : '<button class="primary" id="solo">PLAY SOLO</button>'}
        <button id="host">HOST CO-OP</button>
        <div class="row"><input type="text" id="code" maxlength="4" placeholder="CODE" style="width:118px" /><button id="join" style="flex:1">JOIN CO-OP</button></div>
        <div class="section-label">SYSTEM</div>
        <div class="row"><button id="settings" style="flex:1">SETTINGS</button><button id="controls" style="flex:1">CONTROLS</button></div>
        ${runsEnabled ? bestLine() : ''}${classicBestLine()}
        <div class="err" id="err">${esc(error)}</div>
        ${game?.renderer.softwareRendering ? '<div class="err">HARDWARE ACCELERATION IS OFF: the game will run slowly. Turn on "Use graphics acceleration when available" in your browser settings, then restart the browser.</div>' : ''}
      </div>
    </div>
    <div class="menu-right">
      <h3>FIELD NOTES</h3>
      <p><span class="k">BLOOD IS FUEL.</span> Hurting enemies up close heals you. Part of each hit you take lingers before it can heal.</p>
      <p><span class="k">PARRY <b>YELLOW</b>.</span> Punch ${isTouch ? '' : '(F) '}glowing orbs, bolts and mortars straight back, or punch a husk mid-swing.</p>
      <p><span class="k">STYLE PAYS.</span> Toss a coin, then shoot it. Shoot your own shotgun core. Rotate weapons: repeat kills score less.</p>
      <p><span class="k">RED CRYSTALS</span> restore health, but respawn slowly.</p>
      <p><span class="k">FOR MEOWSHI.</span> He keeps the flame on the dais. Go and say hello.</p>
      ${runsEnabled ? '<p><span class="k">RUNS.</span> Three layers of six rooms and a boss. Pick a gate after every room, forge upgrades that change your guns and movement, spend style on more.</p>' : ''}
    </div>
  `, 'menu-layout');
  show(el);
  const name = el.querySelector<HTMLInputElement>('#name')!;
  name.addEventListener('input', () => { settings.name = name.value.toUpperCase(); saveSettings(settings); });
  el.querySelector('#run')?.addEventListener('click', () => { blip(); startSolo('run'); });
  el.querySelector('#solo')!.addEventListener('click', () => { blip(); startSolo('classic'); });
  el.querySelector('#host')!.addEventListener('click', () => { blip(); void startOnline('host'); });
  const code = el.querySelector<HTMLInputElement>('#code')!;
  const join = () => { blip(); void startOnline('join', code.value); };
  el.querySelector('#join')!.addEventListener('click', join);
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  el.querySelector('#settings')!.addEventListener('click', () => { blip(); settingsScreen(() => mainMenu()); });
  el.querySelector('#controls')!.addEventListener('click', () => { blip(); controlsScreen(() => mainMenu()); });
  el.addEventListener('pointerdown', () => audio.resume(), { once: true });
}

function controlsScreen(back: () => void): void {
  const ALT = isTouch ? 'ALT' : 'RMB';
  const el = h(`
    <div class="panel">
      <h2>CONTROLS</h2>
      <div class="controls">
        ${isTouch ? `
        <div><b>LEFT THUMB</b> move · press anywhere on the left</div><div><b>RIGHT THUMB</b> drag to aim</div>
        <div><b>TAP</b> the right side to punch · parry</div><div><b>DOUBLE-TAP</b> the left side to dash</div>
        <div><b>ANY BUTTON</b> hold it and drag: you keep aiming</div><div><b>I II III</b> weapons</div>
        <div><b>JUMP</b> jump · wall jump ×3</div><div><b>DASH</b> i-frames, 3 charges</div>
        <div><b>SLIDE</b> slide · in air: ground slam</div><div><b>FIRE / ALT</b> hold to shoot by hand</div>
        <div><b>SLAM → JUMP</b> slam bounce (higher from higher)</div><div><b>SLIDE → JUMP</b> keeps momentum</div>
        <div><b>AUTO FIRE</b> shoots while your crosshair is on an enemy</div><div><b>AIM ASSIST · GYRO AIM</b> all in Settings</div>` : `
        <div><b>WASD</b> move</div><div><b>MOUSE</b> aim</div>
        <div><b>SPACE</b> jump · wall jump ×3</div><div><b>SHIFT</b> dash (i-frames, 3 charges)</div>
        <div><b>C / CTRL</b> slide · in air: ground slam</div><div><b>SLAM → JUMP</b> slam bounce (higher from higher)</div>
        <div><b>LMB</b> fire</div><div><b>RMB</b> alt fire</div>
        <div><b>F / MMB</b> punch · parry</div><div><b>1 2 3 / WHEEL / Q</b> weapons</div>
        <div><b>ESC</b> pause</div><div><b>SLIDE → JUMP</b> keeps momentum</div>`}
      </div>
      <h2 style="margin-top:18px">ARSENAL</h2>
      <div class="controls">
        <div><b>PIERCER</b> piercing revolver</div><div>${ALT} tosses a coin — shoot it to ricochet into a head</div>
        <div><b>SCATTERHAMMER</b> shotgun</div><div>${ALT} lobs a core — shoot or punch it to detonate</div>
        <div><b>SLAGTHROWER</b> rockets</div><div>hold ${ALT} to steer rockets to your crosshair · tap to airburst · rocket jump!</div>
        <div><b>PARRY</b> punch yellow orbs/mortars</div><div>press a beat early, it still counts · reflects them, heals ${50} HP</div>
      </div>
      ${runsEnabled ? `<h2 style="margin-top:18px">RUNS</h2>
      <div class="controls">
        <div><b>GATES</b> walk through one after a room</div><div>each shows what clearing the next room pays</div>
        <div><b>FORGE</b> one free pick per visit</div><div>buy more or reroll with style · 1-4 pick · ENTER leaves</div>
        <div><b>VARIANTS</b> new alt-fires for each gun</div><div>press the gun's number again to switch variant</div>
      </div>` : ''}
      <div style="margin-top:18px"><button id="back">BACK</button></div>
    </div>`);
  show(el);
  el.querySelector('#back')!.addEventListener('click', () => { blip(); back(); });
  escBack(el, back);
}

/** Esc on a sub-screen goes back one level (the listener dies with the screen). */
function escBack(el: HTMLElement, back: () => void): void {
  const onKey = (e: KeyboardEvent) => {
    if (!el.isConnected) { window.removeEventListener('keydown', onKey); return; }
    if (e.code === 'Escape') { window.removeEventListener('keydown', onKey); back(); }
  };
  window.addEventListener('keydown', onKey);
}

function settingsScreen(back: () => void): void {
  const s = settings;
  const el = h(`
    <div class="panel">
      <h2>SETTINGS</h2>
      <div class="settings-grid">
      <div class="setting"><span>${isTouch ? 'LOOK SENSITIVITY' : 'MOUSE SENSITIVITY'}</span><input type="range" id="sens" min="0.1" max="4" step="0.05" value="${s.sensitivity}"><span id="sensv"></span></div>
      <div class="setting"><span>FIELD OF VIEW</span><input type="range" id="fov" min="75" max="125" step="1" value="${s.fov}"><span id="fovv"></span></div>
      <div class="setting"><span>MASTER VOLUME</span><input type="range" id="master" min="0" max="1" step="0.05" value="${s.master}"><span id="masterv"></span></div>
      <div class="setting"><span>MUSIC</span><input type="range" id="music" min="0" max="1" step="0.05" value="${s.music}"><span id="musicv"></span></div>
      <div class="setting"><span>EFFECTS</span><input type="range" id="sfx" min="0" max="1" step="0.05" value="${s.sfx}"><span id="sfxv"></span></div>
      <div class="setting"><span>SCREEN SHAKE</span><input type="range" id="shake" min="0" max="1.5" step="0.05" value="${s.shake}"><span id="shakev"></span></div>
      <div class="setting"><span>RENDER RESOLUTION</span><select id="res">
        ${[[240, '240p · CRUNCHY'], [360, '360p · RETRO'], [480, '480p · SHARP'], [720, '720p'], [0, 'NATIVE']].map(([v, l]) => `<option value="${v}" ${s.resolution === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select><span></span></div>
      <div class="setting"><span>FRAME RATE</span><select id="cap">
        ${[[0, 'UNCAPPED'], [60, '60 FPS'], [30, '30 FPS · SAVES BATTERY']].map(([v, l]) => `<option value="${v}" ${s.fpsCap === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select><span></span></div>
      <div class="setting"><span>AUTO RESOLUTION</span><input type="checkbox" id="autores" ${s.autoRes ? 'checked' : ''}><span></span></div>
      <div class="setting"><span>DITHERING</span><input type="checkbox" id="dither" ${s.dither ? 'checked' : ''}><span></span></div>
      <div class="setting"><span>INVERT Y</span><input type="checkbox" id="inv" ${s.invertY ? 'checked' : ''}><span></span></div>
      <div class="setting"><span>SHOW FPS</span><input type="checkbox" id="fpsbox" ${s.showFps ? 'checked' : ''}><span></span></div>
      <div class="setting"><span>HINTS DURING PLAY</span><input type="checkbox" id="tips" ${s.tips ? 'checked' : ''}><span></span></div>
      ${isTouch ? `<div class="setting"><span>AUTO FIRE</span><input type="checkbox" id="autofire" ${s.autoFire ? 'checked' : ''}><span></span></div>
      <div class="setting"><span>AIM ASSIST</span><input type="checkbox" id="assist" ${s.aimAssist ? 'checked' : ''}><span></span></div>
      <div class="setting"><span>GYRO AIM</span><input type="checkbox" id="gyro" ${s.gyro ? 'checked' : ''}><span></span></div>
      <div class="setting"><span>GYRO SENSITIVITY</span><input type="range" id="gsens" min="0.3" max="3" step="0.05" value="${s.gyroSens}"><span id="gsensv"></span></div>
      <div class="setting"><span>VIBRATION</span><input type="checkbox" id="haptics" ${s.haptics ? 'checked' : ''}><span></span></div>` : ''}
      </div>
      <div class="hint" style="margin-top:10px;text-align:left">GPU IN USE: <span style="color:${game?.renderer.softwareRendering ? '#ff6b5b' : '#ccc'}">${esc(game?.renderer.gpuName ?? 'unknown')}</span><br>${isTouch ? 'LOW FPS? AUTO RESOLUTION LOWERS THE PICTURE QUALITY TO KEEP THE GAME SMOOTH.' : 'LOW FPS? TURN ON HARDWARE ACCELERATION IN YOUR BROWSER SETTINGS.'}</div>
      <div style="margin-top:14px"><button id="back">BACK</button></div>
    </div>`);
  show(el);
  const apply = () => {
    saveSettings(settings);
    game.applySettings(settings);
    game.camera.fov = settings.fov;
    game.camera.updateProjectionMatrix();
    if (touchUi) { touchUi.haptics = settings.haptics; touchUi.gyroSens = settings.gyroSens; }
  };
  const map: [string, keyof Settings, (v: number) => string][] = [
    ['sens', 'sensitivity', (v) => v.toFixed(2)], ['fov', 'fov', (v) => `${v}°`], ['master', 'master', (v) => `${Math.round(v * 100)}%`],
    ['music', 'music', (v) => `${Math.round(v * 100)}%`], ['sfx', 'sfx', (v) => `${Math.round(v * 100)}%`], ['shake', 'shake', (v) => `${Math.round(v * 100)}%`],
    ['gsens', 'gyroSens', (v) => v.toFixed(2)],
  ];
  for (const [id, key, fmt] of map) {
    const inp = el.querySelector<HTMLInputElement>(`#${id}`);
    if (!inp) continue;
    const out = el.querySelector<HTMLElement>(`#${id}v`)!;
    out.textContent = fmt(Number(inp.value));
    inp.addEventListener('input', () => {
      (settings as unknown as Record<string, number>)[key] = Number(inp.value);
      out.textContent = fmt(Number(inp.value));
      apply();
    });
  }
  el.querySelector<HTMLSelectElement>('#res')!.addEventListener('change', (e) => { settings.resolution = Number((e.target as HTMLSelectElement).value); apply(); });
  el.querySelector<HTMLInputElement>('#dither')!.addEventListener('change', (e) => { settings.dither = (e.target as HTMLInputElement).checked; apply(); });
  el.querySelector<HTMLInputElement>('#inv')!.addEventListener('change', (e) => { settings.invertY = (e.target as HTMLInputElement).checked; apply(); });
  el.querySelector<HTMLInputElement>('#fpsbox')!.addEventListener('change', (e) => { settings.showFps = (e.target as HTMLInputElement).checked; apply(); });
  el.querySelector<HTMLInputElement>('#autofire')?.addEventListener('change', (e) => { settings.autoFire = (e.target as HTMLInputElement).checked; apply(); });
  el.querySelector<HTMLInputElement>('#assist')?.addEventListener('change', (e) => { settings.aimAssist = (e.target as HTMLInputElement).checked; apply(); });
  el.querySelector<HTMLSelectElement>('#cap')!.addEventListener('change', (e) => { settings.fpsCap = Number((e.target as HTMLSelectElement).value); apply(); });
  el.querySelector<HTMLInputElement>('#autores')!.addEventListener('change', (e) => { settings.autoRes = (e.target as HTMLInputElement).checked; apply(); });
  el.querySelector<HTMLInputElement>('#tips')!.addEventListener('change', (e) => { settings.tips = (e.target as HTMLInputElement).checked; apply(); });
  el.querySelector<HTMLInputElement>('#haptics')?.addEventListener('change', (e) => { settings.haptics = (e.target as HTMLInputElement).checked; apply(); });
  // this tap is the user gesture an iPhone needs before it hands over the motion sensors
  el.querySelector<HTMLInputElement>('#gyro')?.addEventListener('change', (e) => { settings.gyro = (e.target as HTMLInputElement).checked; touchUi?.setGyro(settings.gyro); apply(); });
  el.querySelector('#back')!.addEventListener('click', () => { blip(); back(); });
  escBack(el, back);
}

// ------------------------------------------------------------------ sessions

let lobbyOpen = false;

let lobbyMode: GameMode = runsEnabled ? 'run' : 'classic';

function startSolo(mode: GameMode): void {
  const link = new LocalLink(settings.name || 'SLAYER');
  show(null);
  game.begin(link, [{ id: link.id, name: settings.name || 'SLAYER' }], { bot: botMode });
  link.start(mode);
  gate();
}

async function startOnline(mode: 'host' | 'join', code = ''): Promise<void> {
  if (mode === 'join' && code.trim().length !== 4) { mainMenu('Enter the 4-letter room code your partner sees.'); return; }
  show(h(`<div class="loading">${mode === 'host' ? 'OPENING ROOM' : 'JOINING ' + esc(code.toUpperCase())}…</div>`));
  let res: { link: ColyseusLink; welcome: WelcomeMsg };
  let wake: HTMLElement | null = null;
  let cancelled = false;
  const awake = await wakeServer((s) => {
    if (cancelled) return;
    if (!wake) {
      wake = h(`
        <div class="loading">WAKING THE CO-OP SERVER</div>
        <div class="wake-bar"><i></i></div>
        <div class="wake-time"></div>
        <div class="hint">The free server sleeps when nobody is playing. Waking it usually takes under a minute, sometimes two. Solo is always instant.</div>
        <div class="hint wake-blocked" style="display:none">Taking a while? Ad blockers and browser VPNs often block the co-op server. Allow <b>onrender.com</b> for this site, then try again.</div>
        <div class="row"><button id="wake-cancel">CANCEL</button><button id="wake-solo" class="primary">PLAY SOLO INSTEAD</button></div>`);
      wake.querySelector('#wake-cancel')!.addEventListener('click', () => { blip(); cancelled = true; mainMenu(); });
      wake.querySelector('#wake-solo')!.addEventListener('click', () => { blip(); cancelled = true; startSolo(lobbyMode); });
      show(wake);
    }
    // the bar fills over ~90 s, then crawls, so it never sits "full" while we're still waiting
    const f = s < 90 ? s / 90 : 1 - 0.1 * Math.exp(-(s - 90) / 30);
    (wake.querySelector('.wake-bar i') as HTMLElement).style.width = `${Math.min(99, f * 100)}%`;
    wake.querySelector('.wake-time')!.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (s >= 20) (wake.querySelector('.wake-blocked') as HTMLElement).style.display = '';
  }, 150, () => cancelled);
  if (cancelled) return;
  if (wake) show(h(`<div class="loading">${mode === 'host' ? 'OPENING ROOM' : 'JOINING ' + esc(code.toUpperCase())}…</div>`));
  if (!awake) { mainMenu('Could not reach the co-op server. If you use an ad blocker or a browser VPN, allow onrender.com and try again; otherwise it may still be waking, so try again in a minute. Solo always works.'); return; }
  try {
    void game.warmPartner(); // fetch the partner's model while the room opens
    res = await ColyseusLink.connect(mode, settings.name || 'SLAYER', code);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    mainMenu(mode === 'join' ? `Could not join ${code.toUpperCase()}: ${/not found|locked|full/i.test(msg) ? 'room is full, closed or does not exist.' : msg}` : `Could not reach the co-op server (${msg}). Try again in a moment; solo always works.`);
    return;
  }
  lobbyPlayers = res.welcome.players;
  game.begin(res.link, lobbyPlayers, { bot: botMode });
  if (res.welcome.phase === 'lobby') lobby(res.link);
  else { show(null); gate(); }
}

function lobby(link: NetLink): void {
  lobbyOpen = true;
  const el = h(`
    <div class="panel" style="text-align:center">
      <h2>CO-OP LOBBY</h2>
      <label class="small">ROOM CODE — SHARE WITH YOUR PARTNER</label>
      <div class="code">${esc(link.code)}</div>
      <div class="hint" id="players"></div>
      ${runsEnabled ? `<div class="seg" id="mode">
        <button data-m="run">RUN</button><button data-m="classic">CLASSIC</button>
      </div>
      <div class="hint" id="modehint"></div>` : ''}
      <div style="display:flex;gap:8px;justify-content:center;margin-top:14px">
        <button id="start" class="primary">START</button>
        <button id="leave">LEAVE</button>
      </div>
      <div class="hint" id="wait"></div>
    </div>`);
  show(el);
  const players = el.querySelector<HTMLElement>('#players')!;
  const start = el.querySelector<HTMLButtonElement>('#start')!;
  const wait = el.querySelector<HTMLElement>('#wait')!;
  const modeBtns = [...el.querySelectorAll<HTMLButtonElement>('#mode button')];
  const modeHint = el.querySelector<HTMLElement>('#modehint');
  const paintMode = () => {
    for (const b of modeBtns) {
      b.classList.toggle('on', b.dataset.m === lobbyMode);
      b.disabled = !link.isHost;
    }
    if (modeHint) modeHint.textContent = !link.isHost ? 'The host picks the mode.' : lobbyMode === 'run' ? 'Roguelike: gates, forges, three layers.' : 'The 8-wave arena.';
  };
  for (const b of modeBtns) b.addEventListener('click', () => { blip(); lobbyMode = b.dataset.m === 'classic' ? 'classic' : 'run'; paintMode(); });
  paintMode();
  const refresh = () => {
    const names = [...new Set([...(game as unknown as { names: Map<string, string> }).names.values()])];
    players.innerHTML = `IN ROOM: ${names.map(esc).join(' · ') || '…'}`;
    start.disabled = !link.isHost;
    paintMode();
    wait.textContent = link.isHost ? (names.length < 2 ? 'You can start alone — your partner can drop in any time.' : 'Both slayers ready.') : 'Waiting for the host to start…';
  };
  refresh();
  const timer = setInterval(() => {
    if (!lobbyOpen) { clearInterval(timer); return; }
    refresh();
    if (game.phase !== 'lobby') { lobbyOpen = false; clearInterval(timer); show(null); gate(); }
  }, 250);
  start.addEventListener('click', () => { blip(); link.start(lobbyMode); });
  el.querySelector('#leave')!.addEventListener('click', () => { blip(); lobbyOpen = false; clearInterval(timer); game.end(); mainMenu(); });
  if (botMode && link.isHost && params.get('autostart') === 'host') setTimeout(() => link.start(runsEnabled && params.get('mode') === 'run' ? 'run' : 'classic'), Number(params.get('startDelay') ?? 4000));
}

function onPhase(p: Phase): void {
  if (p !== 'forge') closeForge();
  if (p === 'lobby') return;
  if (lobbyOpen) { lobbyOpen = false; show(null); gate(); }
}

/** Browsers need a click before pointer lock + audio. */
function gate(): void {
  if (botMode) return;
  clickGate?.remove();
  clickGate = h(isTouch
    ? `<div class="click-to-play">TAP TO FIGHT</div>
       <div class="hint">${settings.autoFire ? 'AUTO-FIRE shoots while your crosshair is on an enemy' : 'hold FIRE and drag to aim while shooting'}</div>
       <div class="t-tip t-tip-l"><b>LEFT THUMB</b>MOVE<small>DOUBLE-TAP TO DASH</small></div>
       <div class="t-tip t-tip-r"><b>RIGHT THUMB</b>DRAG TO AIM<small>TAP TO PUNCH · PUNCH <i>YELLOW</i> TO PARRY</small></div>`
    : '<div class="click-to-play">CLICK TO FIGHT</div><div class="hint">WASD · SPACE · SHIFT dash · C slide/slam · F parry · LMB/RMB fire</div>', 'screen');
  clickGate.classList.add('gate');
  clickGate.style.background = 'rgba(0,0,0,0.35)';
  // solo: nothing moves until the player has the controls (co-op can't stop the server's clock)
  game.held = true;
  touchUi?.setPreview(true);
  clickGate.addEventListener('click', () => {
    audio.resume();
    if (settings.gyro) touchUi?.setGyro(true);
    // fullscreen lets the keyboard lock swallow Ctrl+W while sliding
    const root = document.documentElement;
    if (!document.fullscreenElement && root.requestFullscreen) {
      root.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined).finally(() => {
        // phones: hold the screen in landscape while fullscreen (not every browser allows it)
        const o = window.screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        if (isTouch) void o?.lock?.('landscape').catch(() => undefined);
        input.requestLock();
      });
    } else input.requestLock();
  });
  ui.appendChild(clickGate);
}

let pauseEl: HTMLElement | null = null;

function showPause(): void {
  if (pauseEl || screen) return;
  pauseEl = h(`
    <div class="logo" style="font-size:56px">PAUSED</div>
    <div class="menu">
      <button class="primary" id="resume">RESUME</button>
      <button id="settings">SETTINGS</button>
      <button id="controls">CONTROLS</button>
      <button id="quit">QUIT TO MENU</button>
    </div>
    <div class="hint">${game.link?.online ? `CO-OP ROOM <span class="code-inline">${esc(game.link.code)}</span> — the fight goes on while you're paused!` : 'Solo — the world is frozen.'}</div>`);
  ui.appendChild(pauseEl);
  pauseEl.querySelector('#resume')!.addEventListener('click', () => { blip(); input.requestLock(); });
  pauseEl.querySelector('#settings')!.addEventListener('click', () => {
    blip();
    hidePause();
    settingsScreen(() => { show(null); showPause(); });
  });
  pauseEl.querySelector('#controls')!.addEventListener('click', () => {
    blip();
    hidePause();
    controlsScreen(() => { show(null); showPause(); });
  });
  pauseEl.querySelector('#quit')!.addEventListener('click', () => { blip(); hidePause(); game.end(); mainMenu(); });
}

function hidePause(): void {
  pauseEl?.remove();
  pauseEl = null;
  if (screen && game.mode === 'play' && !lobbyOpen) show(null);
}

const CLASSIC_BEST_KEY = 'ferrocide.bestClassic.v1';
/** The furthest Classic has been taken on this device. */
interface ClassicBest { wave: number; win: boolean; time: number; style: number; rank: string }

function loadClassicBest(): ClassicBest | null {
  try { return JSON.parse(localStorage.getItem(CLASSIC_BEST_KEY) ?? 'null') as ClassicBest | null; } catch { return null; }
}

function classicBestText(b: ClassicBest): string {
  const where = b.wave > CLASSIC_WAVES ? `ENDLESS WAVE ${b.wave}` : b.win ? 'CLEARED' : `WAVE ${b.wave}/${CLASSIC_WAVES}`;
  return `${where} · ${fmtTime(b.time)} · ${b.rank}`;
}

function classicBestLine(): string {
  const b = loadClassicBest();
  return b ? `<div class="best">BEST · ${esc(classicBestText(b))}</div>` : '';
}

/** Further is better; at the same point a win beats a loss, then the faster time. */
function betterClassic(a: ClassicBest, b: ClassicBest | null): boolean {
  if (!b) return true;
  if (a.wave !== b.wave) return a.wave > b.wave;
  if (a.win !== b.win) return a.win;
  return a.time < b.time;
}

function showResults(info: GameOverInfo): void {
  hidePause();
  clickGate?.remove();
  touchUi?.setPreview(false);
  closeForge();
  if (info.mode === 'run') { showRunSummary(info); return; }
  const me = info.stats.find((s) => s.id === info.selfId) ?? info.stats[0];
  const grade = finalGrade(me?.style ?? 0, info.time, me?.deaths ?? 0, info.win, info.wave);
  const past = info.wave > CLASSIC_WAVES; // died somewhere in endless
  const mine: ClassicBest = { wave: info.wave, win: info.win || past, time: info.time, style: me?.style ?? 0, rank: grade.name };
  const prev = loadClassicBest();
  const isBest = !botMode && betterClassic(mine, prev);
  if (isBest) { try { localStorage.setItem(CLASSIC_BEST_KEY, JSON.stringify(mine)); } catch { /* storage unavailable */ } }
  const host = game.link?.isHost !== false;
  const solo = !game.link?.online;
  const rows = info.stats.map((s) => `<tr><td>${esc(s.name)}${s.id === info.selfId ? ' (YOU)' : ''}</td><td>${s.kills}</td><td>${s.damage}</td><td>${s.style}</td><td>${s.parries}</td><td>${s.deaths}</td></tr>`).join('');
  const title = info.win ? 'THE FOUNDRY FALLS SILENT' : past ? `SLAIN ON WAVE ${info.wave} · ENDLESS` : `SLAIN ON WAVE ${info.wave}/${CLASSIC_WAVES}`;
  const el = h(`
    <div class="panel results">
      <h2>${title}</h2>
      <div class="hint" style="margin:0 auto">FINAL RANK · ${grade.letter}</div>
      <div class="final-rank" style="color:${grade.color}">${grade.name}</div>
      <div class="hint" style="margin:0 auto">TIME ${fmtTime(info.time)}</div>
      <div class="best" style="text-align:center">${isBest ? 'NEW BEST' : prev ? `BEST · ${esc(classicBestText(prev))}` : ''}</div>
      <table><tr><th>SLAYER</th><th>KILLS</th><th>DAMAGE</th><th>STYLE</th><th>PARRIES</th><th>DEATHS</th></tr>${rows}</table>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        ${info.win
          ? host ? '<button class="primary" id="more">KEEP GOING <small>ENDLESS WAVES</small></button>' : '<div class="hint" style="align-self:center">THE HOST CAN KEEP GOING…</div>'
          : host ? `<button class="primary" id="retry">RETRY WAVE ${info.wave}</button>` : '<div class="hint" style="align-self:center">WAITING FOR THE HOST TO RETRY…</div>'}
        ${solo ? '<button id="again">START OVER</button>' : ''}
        <button id="menu">MAIN MENU</button>
      </div>
    </div>`);
  el.classList.add('results-screen');
  show(el);
  el.querySelector('#retry')?.addEventListener('click', () => {
    blip();
    game.link?.retry();
    show(null);
    void audio.playMusic(info.wave === CLASSIC_WAVES ? 'boss' : info.wave >= 5 ? 'combat2' : 'combat1');
    gate();
  });
  el.querySelector('#more')?.addEventListener('click', () => {
    blip();
    game.link?.continueEndless();
    show(null);
    void audio.playMusic('combat2');
    gate();
  });
  el.querySelector('#again')?.addEventListener('click', () => { blip(); startSolo('classic'); });
  el.querySelector('#menu')!.addEventListener('click', () => { blip(); game.end(); mainMenu(); });
}

// ------------------------------------------------------------------ runs

const BEST_KEY = 'ferrocide.bestRun';
interface BestRun { depth: number; time: number; style: number; win: boolean }

function loadBest(): BestRun | null {
  try { return JSON.parse(localStorage.getItem(BEST_KEY) ?? 'null') as BestRun | null; } catch { return null; }
}

function depthLabel(d: number): string {
  if (d >= FINAL_DEPTH) return 'THE CORE · BOSS';
  return `${RUN.layers[layerOf(d)].name} · ${isBossDepth(d) ? 'BOSS' : `ROOM ${roomOf(d)}/${RUN.roomsPerLayer}`}`;
}

function fmtTime(t: number): string {
  return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
}

function bestLine(): string {
  const b = loadBest();
  if (!b) return '';
  return `<div class="best">BEST RUN · ${b.win ? 'CLEARED' : esc(depthLabel(b.depth))} · ${fmtTime(b.time)}</div>`;
}

const CAT_LABEL: Record<UpgradeDef['cat'], string> = { variant: 'VARIANT', mod: 'MOD', move: 'MOVEMENT', blood: 'BLOOD', coop: 'CO-OP' };
const GUN_LABEL: Record<string, string> = { revolver: 'PIERCER', shotgun: 'SCATTERHAMMER', launcher: 'SLAGTHROWER' };

let forgeEl: HTMLElement | null = null;
let forgeTimer: ReturnType<typeof setInterval> | null = null;
let forgeBotT: ReturnType<typeof setTimeout> | null = null;

function upgradeCard(u: UpgradeDef, i: number, action: string, disabled: boolean): string {
  const tag = `${CAT_LABEL[u.cat]}${u.weapon ? ` · ${GUN_LABEL[u.weapon]}` : ''}${u.rare ? ' · RARE' : ''}`;
  return `<button class="card cat-${u.cat}" data-i="${i}" ${disabled ? 'disabled' : ''}>
    <span class="tag">${i + 1} · ${tag}</span>
    <span class="name">${esc(u.name)}</span>
    <span class="desc">${esc(u.desc)}</span>
    <span class="act">${action}</span>
  </button>`;
}

/** The forge: one free pick, then buy more or reroll with style. */
function showForge(f: ForgeOffers): void {
  if (!game.link) return;
  hidePause();
  clickGate?.remove();
  clickGate = null;
  touchUi?.setPreview(false);
  game.held = false;
  input.exitLock();
  const bank = game.bank;
  const owned = game.ups.map((id) => UPGRADE_BY_ID.get(id)?.name).filter(Boolean).join(' · ') || 'nothing yet';
  const cards = f.offers.map((id, i) => {
    const u = UPGRADE_BY_ID.get(id);
    if (!u) return '';
    return upgradeCard(u, i, f.free ? 'TAKE · FREE' : `BUY · ◆ ${f.buy.toLocaleString('en-US')}`, !f.free && bank < f.buy);
  }).join('');
  const el = h(`
    <div class="panel forge">
      <h2>${f.rare ? 'RARE FORGE' : 'THE FORGE'}</h2>
      <div class="forge-top"><span>${f.free ? 'CHOOSE ONE UPGRADE, FREE' : 'SPEND STYLE FOR MORE'}</span><span class="bank-big">◆ <b id="fbank">${bank.toLocaleString('en-US')}</b></span></div>
      <div class="forge-cards">${cards || '<div class="hint">Nothing left to forge.</div>'}</div>
      <div class="row forge-actions">
        <button id="reroll" ${bank < f.reroll ? 'disabled' : ''}>REROLL · ◆ ${f.reroll.toLocaleString('en-US')}</button>
        <button id="done" class="${f.free ? '' : 'primary'}">${f.free ? 'SKIP THE FREE PICK' : 'CONTINUE ▸'}</button>
      </div>
      <div class="hint" id="ftime"></div>
      <div class="hint owned">OWNED: ${esc(owned)}</div>
    </div>`);
  el.classList.add('forge-screen');
  forgeEl = el;
  show(el);
  const send = (a: 'pick' | 'buy' | 'reroll' | 'done', i?: number) => { blip(); game.link?.forge({ a, i }); };
  el.querySelectorAll<HTMLButtonElement>('.card').forEach((b) => b.addEventListener('click', () => send(f.free ? 'pick' : 'buy', Number(b.dataset.i))));
  el.querySelector('#reroll')!.addEventListener('click', () => send('reroll'));
  el.querySelector('#done')!.addEventListener('click', () => send('done'));
  const onKey = (e: KeyboardEvent) => {
    if (!el.isConnected) { window.removeEventListener('keydown', onKey); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= f.offers.length) {
      const b = el.querySelector<HTMLButtonElement>(`.card[data-i="${n - 1}"]`);
      if (b && !b.disabled) b.click();
    } else if (e.key === 'Enter' && !f.free) send('done');
  };
  window.addEventListener('keydown', onKey);
  if (forgeTimer) clearInterval(forgeTimer);
  forgeTimer = setInterval(() => {
    if (!el.isConnected) { if (forgeTimer) clearInterval(forgeTimer); return; }
    el.querySelector('#fbank')!.textContent = game.bank.toLocaleString('en-US');
    el.querySelector('#ftime')!.textContent = `THE FORGE CLOSES IN ${Math.ceil(game.phaseTimer)}s`;
  }, 200);
  // autoplay: take the first offer, then move on
  if (botMode) {
    if (forgeBotT) clearTimeout(forgeBotT);
    forgeBotT = setTimeout(() => game.link?.forge(f.free && f.offers.length ? { a: 'pick', i: 0 } : { a: 'done' }), 800);
  }
}

let forgeWait: HTMLElement | null = null;

function closeForge(): void {
  if (forgeTimer) clearInterval(forgeTimer);
  const was = forgeEl ?? forgeWait;
  if (!was) return;
  forgeEl = null;
  if (screen !== was) { forgeWait = null; return; }
  // the partner may still be shopping: say so; the forge closes when everyone is done
  if (game.phase === 'forge') {
    forgeWait = h('<div class="loading">WAITING FOR YOUR PARTNER TO FINISH FORGING…</div>');
    show(forgeWait);
    return;
  }
  forgeWait = null;
  show(null);
  if (game.mode === 'play' && game.phase !== 'over' && game.phase !== 'victory') gate();
}

function showRunSummary(info: GameOverInfo): void {
  const me = info.stats.find((s) => s.id === info.selfId) ?? info.stats[0];
  // runs are graded on the same scale: how deep you got stands in for the wave reached
  const grade = finalGrade(me?.style ?? 0, info.time, me?.deaths ?? 0, info.win, Math.max(1, Math.ceil((info.wave / FINAL_DEPTH) * CLASSIC_WAVES)));
  const prev = loadBest();
  const better = !prev || info.win && !prev.win || info.wave > prev.depth || (info.wave === prev.depth && info.time < prev.time);
  if (better) {
    try { localStorage.setItem(BEST_KEY, JSON.stringify({ depth: info.wave, time: info.time, style: me?.style ?? 0, win: info.win })); } catch { /* private mode */ }
  }
  const rows = info.stats.map((s) => `<tr><td>${esc(s.name)}${s.id === info.selfId ? ' (YOU)' : ''}</td><td>${s.kills}</td><td>${s.damage}</td><td>${s.style}</td><td>${s.parries}</td><td>${s.deaths}</td></tr>`).join('');
  const builds = info.stats.map((s) => {
    const names = (info.ups[s.id] ?? []).map((id) => UPGRADE_BY_ID.get(id)?.name).filter(Boolean);
    return `<div class="build"><b>${esc(s.name)}</b> ${names.length ? esc(names.join(' · ')) : '<i>no upgrades</i>'}</div>`;
  }).join('');
  const canRetry = game.link?.isHost !== false;
  const el = h(`
    <div class="panel results">
      <h2>${info.win ? 'THE CORE FALLS SILENT' : `FELL IN THE ${esc(depthLabel(info.wave))}`}</h2>
      <div class="hint" style="margin:0 auto">${better ? 'NEW BEST RUN' : prev ? `BEST · ${prev.win ? 'CLEARED' : esc(depthLabel(prev.depth))} · ${fmtTime(prev.time)}` : ''}</div>
      <div class="final-rank" style="color:${grade.color}">${grade.name}</div>
      <div class="hint" style="margin:0 auto">ROOM ${info.wave}/${FINAL_DEPTH} · TIME ${fmtTime(info.time)}</div>
      <table><tr><th>SLAYER</th><th>KILLS</th><th>DAMAGE</th><th>STYLE</th><th>PARRIES</th><th>DEATHS</th></tr>${rows}</table>
      <div class="builds">${builds}</div>
      <div style="display:flex;gap:8px">
        ${canRetry ? '<button class="primary" id="retry">NEW RUN</button>' : '<div class="hint" style="align-self:center">WAITING FOR THE HOST…</div>'}
        <button id="menu">MAIN MENU</button>
      </div>
    </div>`);
  el.classList.add('results-screen');
  show(el);
  el.querySelector('#retry')?.addEventListener('click', () => {
    blip();
    game.link?.retry();
    show(null);
    gate();
  });
  el.querySelector('#menu')!.addEventListener('click', () => { blip(); game.end(); mainMenu(); });
}

void boot();
