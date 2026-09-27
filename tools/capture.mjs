// Headless play-test harness. Launches Edge/Chrome, lets the autoplay bot fight,
// saves screenshots + a JSON report (state samples, console errors, fps).
//
//   node tools/capture.mjs solo  [--seconds 40] [--shots 6] [--wave 1] [--god] [--out captures/solo]
//   node tools/capture.mjs coop  [--seconds 40] [--shots 4] [--out captures/coop]
//   node tools/capture.mjs menu  [--out captures/menu]
//
// Requires the dev servers running (npm run dev) or pass --url http://host:port.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const mode = args[0] && !args[0].startsWith('--') ? args[0] : 'solo';
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : d;
};
const base = opt('url', 'http://localhost:5173');
const seconds = Number(opt('seconds', 40));
const shots = Number(opt('shots', 6));
const out = path.resolve(opt('out', `captures/${mode}`));
const wave = Number(opt('wave', 1));
const god = !!opt('god', false);
const width = Number(opt('width', 1280)), height = Number(opt('height', 720));
fs.mkdirSync(out, { recursive: true });

const browsers = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const executablePath = process.env.BROWSER || browsers.find((b) => fs.existsSync(b));
if (!executablePath) throw new Error('No Chrome/Edge found; set BROWSER=path');

const launch = () => puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--enable-webgl', '--use-angle=d3d11', `--window-size=${width},${height}`],
  defaultViewport: { width, height },
});
// one browser per player: headless Chrome only animates the focused tab
const browsers2 = [];

const report = { mode, url: base, started: new Date().toISOString(), pages: {} };

async function open(name, query) {
  const browser = await launch();
  browsers2.push(browser);
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  const log = { errors: [], warnings: [], samples: [] };
  report.pages[name] = log;
  page.on('console', (m) => {
    if (m.type() === 'error') log.errors.push(m.text());
    else if (m.type() === 'warning' && log.warnings.length < 30) log.warnings.push(m.text());
  });
  page.on('pageerror', (e) => log.errors.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/?${query}`, { waitUntil: 'domcontentloaded' });
  return { page, log };
}

async function state(page) {
  return page.evaluate(() => (window.__game ? window.__game.debugState() : null)).catch(() => null);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (mode === 'menu') {
  const { page } = await open('menu', 'mute=1');
  await sleep(6000);
  await page.screenshot({ path: path.join(out, 'menu.png') });
} else if (mode === 'solo') {
  const q = `autostart=solo&bot=1&mute=1&name=CAPTURE${wave > 1 ? `&wave=${wave}` : ''}${god ? '&god=1' : ''}`;
  const { page, log } = await open('solo', q);
  await sleep(5000);
  const interval = (seconds * 1000) / shots;
  for (let i = 0; i < shots; i++) {
    await sleep(interval);
    const s = await state(page);
    log.samples.push({ t: (i + 1) * interval / 1000, ...s });
    await page.screenshot({ path: path.join(out, `solo_${String(i + 1).padStart(2, '0')}.png`) });
  }
} else if (mode === 'coop') {
  const A = await open('host', 'autostart=host&bot=1&mute=1&name=ALPHA&startDelay=6000');
  let code = null;
  for (let i = 0; i < 40 && !code; i++) {
    await sleep(500);
    code = await A.page.evaluate(() => window.__game?.link?.code || null).catch(() => null);
  }
  if (!code) throw new Error('host never got a room code (is the game server running?)');
  report.code = code;
  const B = await open('guest', `autostart=join&code=${code}&bot=1&mute=1&name=BRAVO`);
  await sleep(9000);
  const interval = (seconds * 1000) / shots;
  for (let i = 0; i < shots; i++) {
    await sleep(interval);
    for (const [name, p] of [['host', A], ['guest', B]]) {
      const s = await state(p.page);
      p.log.samples.push({ t: (i + 1) * interval / 1000, ...s });
      await p.page.screenshot({ path: path.join(out, `${name}_${String(i + 1).padStart(2, '0')}.png`) });
    }
  }
}

report.finished = new Date().toISOString();
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
await Promise.all(browsers2.map((b) => b.close()));
for (const [name, p] of Object.entries(report.pages)) {
  const last = p.samples[p.samples.length - 1];
  console.log(`[${name}] errors=${p.errors.length} samples=${p.samples.length} last=${JSON.stringify(last ?? {})}`);
  for (const e of p.errors.slice(0, 8)) console.log('   !', e.slice(0, 300));
}
console.log('saved to', out);
