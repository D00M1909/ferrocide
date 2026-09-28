// Meters every SFX sample (dev aid): peak, loudest 50 ms RMS window and duration, so
// sample levels can be balanced against each other without ears. Needs `npm run dev`.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((b) => fs.existsSync(b));
const files = fs.readdirSync('client/public/assets/sfx');
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new' });
const page = (await browser.pages())[0];
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
const result = await page.evaluate(async (files) => {
  const ctx = new OfflineAudioContext(2, 48000, 48000);
  const out = {};
  for (const f of files) {
    const buf = await ctx.decodeAudioData(await (await fetch(`/assets/sfx/${f}`)).arrayBuffer());
    const win = Math.floor(buf.sampleRate * 0.05);
    let peak = 0, maxRms = 0;
    const chans = [...Array(buf.numberOfChannels)].map((_, c) => buf.getChannelData(c));
    for (let s = 0; s + win <= buf.length; s += win >> 1) {
      let sum = 0;
      for (const d of chans) for (let i = s; i < s + win; i++) { sum += d[i] * d[i]; peak = Math.max(peak, Math.abs(d[i])); }
      maxRms = Math.max(maxRms, sum / (win * chans.length));
    }
    out[f] = { peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(1), rmsDb: +(10 * Math.log10(maxRms || 1e-12)).toFixed(1), secs: +buf.duration.toFixed(2) };
  }
  return out;
}, files);
console.table(result);
await browser.close();
