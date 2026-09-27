// Screenshots each weapon viewmodel (dev aid): node tools/vmshot.mjs [outDir]
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const out = path.resolve(process.argv[2] || 'captures/vm');
fs.mkdirSync(out, { recursive: true });
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((b) => fs.existsSync(b));
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--use-angle=d3d11', '--ignore-gpu-blocklist'], defaultViewport: { width: 1280, height: 720 } });
const page = (await browser.pages())[0];
page.on('pageerror', (e) => console.log('pageerror', e.message));
await page.goto('http://localhost:5173/?autostart=solo&mute=1&name=VM', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 6000));
for (const w of ['revolver', 'shotgun', 'launcher']) {
  await page.evaluate((w) => { const g = window.__game; g.weapons.select(w, true); g.pitch = -0.15; }, w);
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(out, `${w}.png`) });
}
await browser.close();
console.log('saved', out);
