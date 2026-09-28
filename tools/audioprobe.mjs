// Meters the live music bus in a headless browser (dev aid): peak/RMS per piece and
// intensity, plus a coarse spectrum, so the mix can be sanity-checked without ears.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((b) => fs.existsSync(b));
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=d3d11'] });
const page = (await browser.pages())[0];
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(m.type(), m.text()); });
await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 5000));

const result = await page.evaluate(async () => {
  const a = window.__game.audio;
  a.resume();
  const an = a.ctx.createAnalyser();
  an.fftSize = 4096;
  a.musicBus.connect(an);
  const buf = new Float32Array(an.fftSize);
  const spec = new Float32Array(an.frequencyBinCount);
  const measure = async (secs) => {
    let peak = 0, sum = 0, n = 0;
    const bands = [0, 0, 0, 0]; // <150, 150-1k, 1k-5k, >5k
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      an.getFloatTimeDomainData(buf);
      for (const v of buf) { peak = Math.max(peak, Math.abs(v)); sum += v * v; n++; }
      an.getFloatFrequencyData(spec);
      const hz = a.ctx.sampleRate / an.fftSize;
      for (let i = 1; i < spec.length; i++) {
        const f = i * hz, p = Math.pow(10, spec[i] / 10);
        bands[f < 150 ? 0 : f < 1000 ? 1 : f < 5000 ? 2 : 3] += p;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    const tot = bands.reduce((x, y) => x + y, 0) || 1;
    return { peakDb: +(20 * Math.log10(peak || 1e-9)).toFixed(1), rmsDb: +(10 * Math.log10(sum / n || 1e-12)).toFixed(1), bands: bands.map((b) => Math.round((b / tot) * 100) + '%').join(' ') };
  };
  const out = {};
  for (const [id, intens] of [['menu', 0.2], ['combat1', 0.2], ['combat1', 0.55], ['combat1', 0.9], ['combat2', 0.6], ['boss', 0.8]]) {
    a.setIntensity(intens);
    await a.playMusic(id, 0.3);
    await new Promise((r) => setTimeout(r, 1800));
    out[`${id}@${intens}`] = await measure(5);
  }
  return out;
});
console.table(result);
await browser.close();
