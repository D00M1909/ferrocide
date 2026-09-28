// PS1-style look: vertex snapping, nearest-filtered low-res textures, per-material
// hue shifting (used to re-skin the stock Quaternius models), and hit flashes.
import * as THREE from 'three';

/** Shared uniform: snapping grid resolution, updated when the render size changes. */
export const psxUniforms = {
  uSnap: { value: new THREE.Vector2(320, 180) },
  uTime: { value: 0 },
};

export interface PsxOptions {
  hue?: number; // radians of hue rotation
  sat?: number; // saturation multiplier
  bright?: number;
  flash?: { value: number }; // hit flash uniform (0..1)
  flashColor?: THREE.Color;
  snap?: boolean;
  rim?: THREE.Color; // fresnel rim light so enemies pop out of the murk
  rimPow?: number; // fresnel exponent: higher = thinner edge-only rim (default 2.2)
}

/** Patches any built-in material with PSX vertex snapping plus optional colour grading. */
export function psxify<T extends THREE.Material>(mat: T, opts: PsxOptions = {}): T {
  const snap = opts.snap !== false;
  const flash = opts.flash ?? { value: 0 };
  const flashColor = { value: opts.flashColor ?? new THREE.Color(1, 1, 1) };
  const grade = opts.hue !== undefined || opts.sat !== undefined || opts.bright !== undefined;
  const hue = { value: opts.hue ?? 0 };
  const sat = { value: opts.sat ?? 1 };
  const bright = { value: opts.bright ?? 1 };
  const rim = { value: opts.rim ?? new THREE.Color(0, 0, 0) };
  const hasRim = !!opts.rim;
  const rimPow = { value: opts.rimPow ?? 2.2 };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSnap = psxUniforms.uSnap;
    shader.uniforms.uFlash = flash;
    shader.uniforms.uFlashColor = flashColor;
    shader.uniforms.uHue = hue;
    shader.uniforms.uSat = sat;
    shader.uniforms.uBright = bright;
    shader.uniforms.uRim = rim;
    shader.uniforms.uRimPow = rimPow;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 uSnap;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        ${snap ? 'vec4 sp = gl_Position; sp.xyz /= sp.w; sp.xy = floor(sp.xy * uSnap + 0.5) / uSnap; gl_Position = vec4(sp.xyz * sp.w, sp.w);' : ''}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uFlash; uniform vec3 uFlashColor; uniform float uHue; uniform float uSat; uniform float uBright; uniform vec3 uRim; uniform float uRimPow;
        vec3 hueRotate(vec3 c, float a) {
          const vec3 k = vec3(0.57735);
          float ca = cos(a);
          return c * ca + cross(k, c) * sin(a) + k * dot(k, c) * (1.0 - ca);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        ${grade ? `diffuseColor.rgb = hueRotate(diffuseColor.rgb, uHue);
        float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = max(mix(vec3(lum), diffuseColor.rgb, uSat) * uBright, 0.0);` : ''}`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        ${hasRim ? 'float fres = pow(1.0 - clamp(dot(normalize(normal), normalize(vViewPosition)), 0.0, 1.0), uRimPow); gl_FragColor.rgb += uRim * fres;' : ''}
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uFlashColor, clamp(uFlash, 0.0, 1.0));`,
      );
  };
  mat.customProgramCacheKey = () => `psx-${snap}-${grade}-${hasRim}`;
  return mat;
}

// ---------------------------------------------------------------- textures

type Painter = (ctx: CanvasRenderingContext2D, s: number, rnd: () => number) => void;

function makeTex(size: number, paint: Painter, seed = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  paint(ctx, size, rnd);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapNearestFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 1;
  return t;
}

function noise(ctx: CanvasRenderingContext2D, s: number, rnd: () => number, amount: number, dark = true): void {
  const img = ctx.getImageData(0, 0, s, s);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (rnd() - 0.5) * amount;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n * (dark ? 0.8 : 1)));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n * (dark ? 0.7 : 1)));
  }
  ctx.putImageData(img, 0, 0);
}

function grime(ctx: CanvasRenderingContext2D, s: number, rnd: () => number, n: number, color: string): void {
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.08 + rnd() * 0.18;
    const r = 1 + rnd() * s * 0.12;
    ctx.beginPath();
    ctx.arc(rnd() * s, rnd() * s, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

export const Textures = {
  floor: () =>
    makeTex(64, (ctx, s, rnd) => {
      ctx.fillStyle = '#36383c';
      ctx.fillRect(0, 0, s, s);
      // plates
      ctx.strokeStyle = '#18191c';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, s / 2 - 1, s / 2 - 1);
      ctx.strokeRect(s / 2 + 1, 1, s / 2 - 2, s / 2 - 1);
      ctx.strokeRect(1, s / 2 + 1, s - 2, s / 2 - 2);
      ctx.fillStyle = '#4c4f55';
      ctx.fillRect(3, 3, s / 2 - 5, 2);
      ctx.fillRect(s / 2 + 3, 3, s / 2 - 6, 2);
      // diamond tread
      ctx.fillStyle = '#2a2c30';
      for (let y = s / 2 + 6; y < s - 4; y += 6) for (let x = 5 + ((y / 6) % 2) * 3; x < s - 4; x += 6) ctx.fillRect(x, y, 2, 1);
      // rivets
      ctx.fillStyle = '#767a82';
      for (const [x, y] of [[4, 4], [s / 2 - 5, 4], [s / 2 + 4, 4], [s - 6, 4], [4, s / 2 + 4], [s - 6, s / 2 + 4], [4, s - 6], [s - 6, s - 6]]) ctx.fillRect(x, y, 2, 2);
      grime(ctx, s, rnd, 26, '#0e0e10');
      grime(ctx, s, rnd, 5, '#3e2616');
      noise(ctx, s, rnd, 24, false);
    }, 3),
  wall: () =>
    makeTex(64, (ctx, s, rnd) => {
      ctx.fillStyle = '#18171a';
      ctx.fillRect(0, 0, s, s);
      const bh = 8;
      for (let row = 0; row < s / bh; row++) {
        const off = (row % 2) * 8;
        for (let x = -off; x < s; x += 16) {
          const shade = 58 + rnd() * 30;
          ctx.fillStyle = `rgb(${shade * 0.8},${shade * 0.76},${shade * 0.78})`;
          ctx.fillRect(x + 1, row * bh + 1, 14, bh - 2);
          ctx.fillStyle = 'rgba(220,225,240,0.07)';
          ctx.fillRect(x + 1, row * bh + 1, 14, 1);
        }
      }
      grime(ctx, s, rnd, 30, '#060607');
      grime(ctx, s, rnd, 4, '#3a1a10');
      noise(ctx, s, rnd, 20, false);
    }, 7),
  pillar: () =>
    makeTex(64, (ctx, s, rnd) => {
      ctx.fillStyle = '#2d2b2e';
      ctx.fillRect(0, 0, s, s);
      for (let x = 0; x < s; x += 8) {
        ctx.fillStyle = '#3d3a3e';
        ctx.fillRect(x + 1, 0, 4, s);
        ctx.fillStyle = '#18161a';
        ctx.fillRect(x + 6, 0, 1, s);
      }
      ctx.fillStyle = '#5a2a10';
      ctx.fillRect(0, 28, s, 8);
      ctx.fillStyle = '#ff7a1a';
      for (let x = 0; x < s; x += 8) ctx.fillRect(x + 2, 30, 3, 4);
      grime(ctx, s, rnd, 20, '#0c0808');
      noise(ctx, s, rnd, 20);
    }, 11),
  metal: () =>
    makeTex(64, (ctx, s, rnd) => {
      ctx.fillStyle = '#4a4240';
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = '#2a2322';
      ctx.fillRect(0, 0, s, 3);
      ctx.fillRect(0, 0, 3, s);
      // hazard trim
      for (let x = -s; x < s * 2; x += 12) {
        ctx.fillStyle = '#c28a12';
        ctx.beginPath();
        ctx.moveTo(x, s - 10);
        ctx.lineTo(x + 6, s - 10);
        ctx.lineTo(x + 12, s);
        ctx.lineTo(x + 6, s);
        ctx.fill();
      }
      ctx.fillStyle = '#1a1414';
      ctx.fillRect(0, s - 11, s, 1);
      grime(ctx, s, rnd, 24, '#120807');
      grime(ctx, s, rnd, 10, '#6b2a0a');
      noise(ctx, s, rnd, 24);
    }, 5),
  grate: () =>
    makeTex(32, (ctx, s, rnd) => {
      ctx.fillStyle = '#15100f';
      ctx.fillRect(0, 0, s, s);
      ctx.fillStyle = '#5b514c';
      for (let i = 0; i < s; i += 4) {
        ctx.fillRect(i, 0, 1, s);
        ctx.fillRect(0, i, s, 1);
      }
      noise(ctx, s, rnd, 30);
    }, 9),
  crate: () =>
    makeTex(32, (ctx, s, rnd) => {
      ctx.fillStyle = '#5c2e14';
      ctx.fillRect(0, 0, s, s);
      ctx.strokeStyle = '#2a1206';
      ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, s - 3, s - 3);
      ctx.beginPath();
      ctx.moveTo(2, 2);
      ctx.lineTo(s - 2, s - 2);
      ctx.stroke();
      ctx.fillStyle = '#9a5a20';
      ctx.fillRect(3, 3, s - 6, 1);
      noise(ctx, s, rnd, 40);
    }, 13),
  stone: () =>
    makeTex(64, (ctx, s, rnd) => {
      ctx.fillStyle = '#242226';
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 9; i++) {
        const x = (i % 3) * 21 + rnd() * 3, y = Math.floor(i / 3) * 21 + rnd() * 3;
        const sh = 52 + rnd() * 25;
        ctx.fillStyle = `rgb(${sh * 0.86},${sh * 0.8},${sh * 0.78})`;
        ctx.fillRect(x + 1, y + 1, 19, 19);
      }
      // glowing runes carved into the dais
      ctx.fillStyle = '#ff3a0a';
      ctx.globalAlpha = 0.55;
      ctx.fillRect(30, 8, 2, 12);
      ctx.fillRect(26, 12, 10, 2);
      ctx.globalAlpha = 1;
      grime(ctx, s, rnd, 16, '#140807');
      noise(ctx, s, rnd, 24);
    }, 17),
  lava: () =>
    makeTex(64, (ctx, s, rnd) => {
      const g = ctx.createLinearGradient(0, 0, s, s);
      g.addColorStop(0, '#ff5a00');
      g.addColorStop(0.5, '#ffb000');
      g.addColorStop(1, '#ff3000');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = rnd() < 0.5 ? '#7a1000' : '#3a0500';
        ctx.globalAlpha = 0.5 + rnd() * 0.5;
        ctx.beginPath();
        ctx.ellipse(rnd() * s, rnd() * s, 2 + rnd() * 7, 1 + rnd() * 4, rnd() * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      noise(ctx, s, rnd, 30, false);
    }, 19),
  sky: () =>
    makeTex(128, (ctx, s, rnd) => {
      // a clean smoke-choked gradient: near-black zenith, ember glow on the horizon
      const g = ctx.createLinearGradient(0, 0, 0, s);
      g.addColorStop(0, '#040305');
      g.addColorStop(0.4, '#0d090b');
      g.addColorStop(0.6, '#2a0e08');
      g.addColorStop(0.67, '#4a1a0a');
      g.addColorStop(0.72, '#120806');
      g.addColorStop(1, '#040303');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, s, s);
      // soft smoke bands
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = `rgba(20,16,18,${0.25 + rnd() * 0.25})`;
        ctx.fillRect(0, s * (0.25 + rnd() * 0.35), s, 2 + rnd() * 4);
      }
      // distant smokestack silhouettes on the horizon band
      for (let i = 0; i < 16; i++) {
        const x = rnd() * s, w = 2 + rnd() * 5, h = 8 + rnd() * 22;
        ctx.fillStyle = '#060304';
        ctx.fillRect(x, s * 0.7 - h, w, h);
        ctx.fillStyle = '#b8400c';
        ctx.fillRect(x, s * 0.7 - h, w, 1);
      }
    }, 23),
  /** Worn gun steel: neutral so the model's own material colour tints it. */
  gunmetal: () =>
    makeTex(64, (ctx, s, rnd) => {
      ctx.fillStyle = '#c8c8c8';
      ctx.fillRect(0, 0, s, s);
      // brushed streaks
      for (let i = 0; i < 70; i++) {
        ctx.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '40,40,40'},${0.05 + rnd() * 0.12})`;
        ctx.fillRect(0, rnd() * s, s, 1);
      }
      // panel seams + rivets
      ctx.fillStyle = 'rgba(20,20,20,0.55)';
      ctx.fillRect(0, s / 2, s, 1);
      ctx.fillRect(s / 3, 0, 1, s);
      for (let i = 0; i < 6; i++) ctx.fillRect(4 + i * 10, s / 2 + 3, 2, 2);
      // edge wear and scratches
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      for (let i = 0; i < 12; i++) {
        ctx.beginPath();
        const x = rnd() * s, y = rnd() * s;
        ctx.moveTo(x, y);
        ctx.lineTo(x + (rnd() - 0.5) * 14, y + (rnd() - 0.5) * 6);
        ctx.stroke();
      }
      grime(ctx, s, rnd, 18, '#1a1414');
      grime(ctx, s, rnd, 4, '#5a2a10');
      noise(ctx, s, rnd, 26, false);
    }, 31),
  pad: () =>
    makeTex(32, (ctx, s) => {
      ctx.clearRect(0, 0, s, s);
      ctx.strokeStyle = '#48e8ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(s / 2, s / 2, s / 2 - 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#48e8ff';
      ctx.beginPath();
      ctx.moveTo(s / 2, 6);
      ctx.lineTo(s / 2 + 8, 16);
      ctx.lineTo(s / 2 - 8, 16);
      ctx.fill();
      ctx.fillRect(s / 2 - 3, 16, 6, 9);
    }, 29),
};
