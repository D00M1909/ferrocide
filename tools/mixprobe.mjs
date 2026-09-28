// Meters the FINAL audio output (everything reaching the speakers) for music alone and
// for typical gameplay sounds at given slider settings (dev aid). Needs `npm run dev`.
//   node tools/mixprobe.mjs [master] [music] [sfx]
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const [master, music, sfx] = process.argv.slice(2).map(Number);
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((b) => fs.existsSync(b));
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = (await browser.pages())[0];
page.on('pageerror', (e) => console.log('pageerror', e.message));
// tap every connection into the destination so the probe hears exactly what the player hears
await page.evaluateOnNewDocument(() => {
  const orig = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) {
      const ctx = this.context;
      if (!ctx.__tap) { ctx.__tap = ctx.createAnalyser(); ctx.__tap.fftSize = 2048; }
      orig.call(this, ctx.__tap);
    }
    return orig.call(this, dest, ...rest);
  };
});
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async (vols) => {
  const g = window.__game;
  const a = g.audio;
  a.resume();
  const s = g.settings ?? { master: 0.8, music: 0.5, sfx: 0.9 };
  a.setVolumes(vols[0] ?? s.master, vols[1] ?? s.music, vols[2] ?? s.sfx);
  const an = a.ctx.__tap;
  const buf = new Float32Array(an.fftSize);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const measure = async (secs) => {
    let peak = 0, sum = 0, n = 0, maxWin = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      an.getFloatTimeDomainData(buf);
      let w = 0;
      for (const v of buf) { peak = Math.max(peak, Math.abs(v)); sum += v * v; w += v * v; n++; }
      maxWin = Math.max(maxWin, w / buf.length);
      await sleep(20);
    }
    const db = (x) => +(10 * Math.log10(x || 1e-12)).toFixed(1);
    return { peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(1), loudestDb: db(maxWin), avgDb: db(sum / n) };
  };
  const out = {};
  a.setIntensity(0.6);
  await a.playMusic('combat1', 0.2);
  await sleep(2500);
  out['music combat1'] = await measure(4);
  await a.playMusic(null, 0.2);
  await sleep(3000);
  const at = { x: 0, y: 0, z: 0 };
  a.setListener({ x: 0, y: 0, z: 8 }, 0);
  const shots = {
    revolver: () => { a.play('revolver', { volume: 0.85, variance: 0, reverb: 0.3 }); a.synth('thump', 0.55); },
    shotgun: () => { a.play('shotgun', { volume: 1, variance: 0, reverb: 0.4 }); a.synth('thump', 1); },
    rocket: () => { a.play('rocket', { volume: 0.9, reverb: 0.3 }); a.synth('thump', 0.7); },
    explosion: () => { a.play('explosion', { at, volume: 1, reverb: 0.5 }); a.synth('boom', 0.7); },
    'enemy death': () => { a.play('gore', { at, volume: 0.9 }); a.play('edeath', { at, volume: 0.6, dur: 0.7 }); },
    'enemy spawn': () => { a.play('spawn', { at, volume: 0.7 }); a.play('growl', { at, volume: 0.55, dur: 0.8, reverb: 0.4 }); },
    pump: () => a.play('pump', { volume: 0.55 }),
    coin: () => a.play('coin', { volume: 0.7 }),
    step: () => a.play('step', { volume: 0.25 }),
  };
  for (const [k, f] of Object.entries(shots)) {
    f();
    out[k] = await measure(1.5);
    await sleep(2500);
  }
  // a busy moment: 6 revolver shots, 2 explosions, 3 deaths inside ~1 s
  const busy = measure(2.5);
  for (let i = 0; i < 6; i++) { shots.revolver(); if (i % 2 === 0) shots['enemy death'](); if (i === 2 || i === 5) shots.explosion(); await sleep(170); }
  out['busy fight'] = await busy;
  return out;
}, [master, music, sfx].map((v) => (Number.isFinite(v) ? v : undefined)));
console.table(result);
await browser.close();
