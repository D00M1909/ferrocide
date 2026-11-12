// Builds the visible arena from the shared collision boxes, plus lighting,
// molten slag, jump pads, sky, and set dressing (chains, braziers, pipes).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ARENA_HALF, BOXES, HEALTH_PICKUPS, JUMP_PADS, LAVA, WALL_HEIGHT, type Box, type Surface } from '../../../shared/arena';
import { psxUniforms, psxify, Textures } from '../engine/psx';
import { sprite } from '../engine/assets';
import { lowSpec } from '../platform';
import { Meowshi } from './meowshi';

/** Phones: the world scene gets this many point lights in total, however many sources exist. */
const POOL_SIZE = 5;
/** Seconds for a pooled light to fade out (then in) when it moves to another source. */
const POOL_FADE = 0.1;

/** A static light source. On desktop it owns a real PointLight; on phones it competes for a pooled one. */
interface LightSrc {
  x: number; y: number; z: number;
  color: number; dist: number; decay: number;
  cur: number; // intensity right now (pulse, availability), applied only while a pool light holds it
  light: THREE.PointLight | null;
  score: number; top: boolean; held: boolean;
}

interface PoolSlot { l: THREE.PointLight; src: LightSrc | null; next: LightSrc | null; fade: number }

const place = new THREE.Object3D();
/** Bake a position (and optional yaw) into a geometry so it can be merged with others. */
function at<G extends THREE.BufferGeometry>(g: G, x: number, y: number, z: number, yaw = 0): G {
  place.position.set(x, y, z);
  place.rotation.set(0, yaw, 0);
  place.updateMatrix();
  g.applyMatrix4(place.matrix);
  return g;
}

/** Merge never-moving geometry that shares a material into a single draw call. */
function addMerged(scene: THREE.Scene, geos: THREE.BufferGeometry[], material: THREE.Material): THREE.Mesh | null {
  if (!geos.length) return null;
  const merged = mergeGeometries(geos, false);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  const mesh = new THREE.Mesh(merged, material);
  scene.add(mesh);
  return mesh;
}

/** Box geometry whose UVs are in world units so textures tile consistently. */
function boxGeometry(b: Box, texScale: number): THREE.BufferGeometry {
  const sx = b.max.x - b.min.x, sy = b.max.y - b.min.y, sz = b.max.z - b.min.z;
  const g = new THREE.BoxGeometry(sx, sy, sz);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nrm = g.attributes.normal as THREE.BufferAttribute;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  const cx = (b.min.x + b.max.x) / 2, cy = (b.min.y + b.max.y) / 2, cz = (b.min.z + b.max.z) / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx, y = pos.getY(i) + cy, z = pos.getZ(i) + cz;
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i));
    let u: number, v: number;
    if (ny > 0.5) { u = x; v = z; } else if (nx > 0.5) { u = z; v = y; } else { u = x; v = y; }
    uv.setXY(i, u / texScale, v / texScale);
  }
  g.translate(cx, cy, cz);
  return g;
}

export class World {
  readonly scene = new THREE.Scene();
  private lavaMat: THREE.MeshBasicMaterial;
  private padRings: THREE.Mesh[] = [];
  private pickups: { core: THREE.Object3D; src: LightSrc; lightI: number; glow: THREE.Sprite; ring: THREE.Mesh; ringT: number; baseY: number; on: boolean; pop: number }[] = [];
  private embers: THREE.Points;
  private emberVel: Float32Array;
  private flames: THREE.Sprite[] = [];
  private lavaSrc: LightSrc[] = [];
  private sky: THREE.Mesh;
  private sources: LightSrc[] = [];
  private pool: PoolSlot[] = [];
  private poolFree: LightSrc[] = [];
  private focus = new THREE.Vector3(0, 2, 0);
  private camPos = new THREE.Vector3(0, 2, 0);
  /** Meowshi, keeper of the flame. Updated by the game, which knows where the camera is. */
  readonly meowshi: Meowshi;

  constructor() {
    const s = this.scene;
    s.fog = new THREE.Fog(0x0f0b0c, 30, 120);
    s.background = new THREE.Color(0x060405);

    // ------------------------------------------------------------ lighting
    // cold ambient from the smoke-choked sky, hot key light from the furnaces
    s.add(new THREE.HemisphereLight(0xaab4c8, 0x161214, 1.05));
    // neutral-cool key light; warmth comes only from the slag, braziers and trim
    const sun = new THREE.DirectionalLight(0xdce2f0, 1.05);
    sun.position.set(-30, 60, 20);
    s.add(sun);
    const fill = new THREE.DirectionalLight(0x5a70c0, 0.45);
    fill.position.set(40, 20, -30);
    s.add(fill);

    // ------------------------------------------------------------ geometry
    const tex: Record<string, THREE.Texture> = {
      floor: Textures.floor(), wall: Textures.wall(), pillar: Textures.pillar(), metal: Textures.metal(),
      grate: Textures.grate(), crate: Textures.crate(), stone: Textures.stone(),
    };
    const scaleFor: Record<Surface, number> = { floor: 4, wall: 4, pillar: 3, metal: 3, grate: 1.5, crate: 2, stone: 3, invisible: 1 };
    const mats = new Map<Surface, THREE.Material>();
    const mat = (surf: Surface) => {
      let m = mats.get(surf);
      if (!m) {
        const t = tex[surf] ?? tex.floor;
        m = psxify(new THREE.MeshLambertMaterial({ map: t, emissive: surf === 'pillar' || surf === 'stone' ? 0x220500 : 0x000000 }));
        mats.set(surf, m);
      }
      return m;
    };
    // Everything below that never moves is merged: one draw call per material, not per box.
    const bySurface = new Map<Surface, THREE.BufferGeometry[]>();
    for (const b of BOXES) {
      if (b.surface === 'invisible') continue;
      const list = bySurface.get(b.surface) ?? [];
      list.push(boxGeometry(b, scaleFor[b.surface]));
      bySurface.set(b.surface, list);
    }
    for (const [surf, geos] of bySurface) addMerged(s, geos, mat(surf));

    // glowing trim along the top of the outer walls
    const trimMat = new THREE.MeshBasicMaterial({ color: 0xff4a10 });
    const trimGeos: THREE.BufferGeometry[] = [];
    for (const [x, z, w, d] of [[0, -ARENA_HALF + 0.05, ARENA_HALF * 2, 0.2], [0, ARENA_HALF - 0.05, ARENA_HALF * 2, 0.2], [-ARENA_HALF + 0.05, 0, 0.2, ARENA_HALF * 2], [ARENA_HALF - 0.05, 0, 0.2, ARENA_HALF * 2]]) {
      for (const y of [2.2, 9.5]) trimGeos.push(at(new THREE.BoxGeometry(w, 0.18, d), x, y, z));
    }
    addMerged(s, trimGeos, trimMat);

    // ------------------------------------------------------------ molten slag
    // The floor slab under the slag is a few huge vertex-snapped triangles whose depth wobbles as
    // the camera moves; a depth bias keeps it from flickering through as dark patches.
    this.lavaMat = new THREE.MeshBasicMaterial({ map: Textures.lava(), color: 0xffffff, fog: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 });
    this.lavaMat.map!.repeat.set(2, 2);
    const lavaGeos: THREE.BufferGeometry[] = [];
    const rimGeos: THREE.BufferGeometry[] = [];
    const rimMat = new THREE.MeshLambertMaterial({ color: 0x140606 });
    for (const z of LAVA) {
      const w = z.max.x - z.min.x, d = z.max.z - z.min.z;
      const cx = (z.min.x + z.max.x) / 2, cz = (z.min.z + z.max.z) / 2;
      lavaGeos.push(at(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), cx, 0.06, cz));
      // dark rim
      for (const [rx, rz, rw, rd] of [[cx, z.min.z - 0.25, w + 1, 0.5], [cx, z.max.z + 0.25, w + 1, 0.5], [z.min.x - 0.25, cz, 0.5, d], [z.max.x + 0.25, cz, 0.5, d]]) {
        rimGeos.push(at(new THREE.BoxGeometry(rw, 0.12, rd), rx, 0.06, rz));
      }
      this.lavaSrc.push(this.addSource(0xff5a10, cx, 1.5, cz, 30, 22, 1.4));
    }
    addMerged(s, lavaGeos, this.lavaMat);
    addMerged(s, rimGeos, rimMat);

    // ------------------------------------------------------------ jump pads
    const padTex = Textures.pad();
    const padBaseGeos: THREE.BufferGeometry[] = [];
    for (const p of JUMP_PADS) {
      padBaseGeos.push(at(new THREE.CylinderGeometry(p.radius, p.radius + 0.2, 0.12, 12), p.pos.x, p.pos.y + 0.06, p.pos.z));
      const ring = new THREE.Mesh(
        new THREE.PlaneGeometry(p.radius * 2, p.radius * 2).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: padTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffffff }),
      );
      this.addSource(0x30d8ff, p.pos.x, p.pos.y + 0.8, p.pos.z, 6, 6, 1.5);
      ring.position.set(p.pos.x, p.pos.y + 0.14, p.pos.z);
      s.add(ring);
      this.padRings.push(ring);
    }
    addMerged(s, padBaseGeos, psxify(new THREE.MeshLambertMaterial({ color: 0x202428, emissive: 0x002a38 })));

    // ------------------------------------------------------------ health pickups
    // a floating blood crystal over a dark plate; the plate stays when the crystal is taken
    // so players learn where they respawn
    const glowTex = sprite('light_01');
    const plateGeos: THREE.BufferGeometry[] = [];
    for (const h of HEALTH_PICKUPS) {
      const size = h.large ? 0.5 : 0.36;
      plateGeos.push(at(new THREE.CylinderGeometry(size * 2.2, size * 2.5, 0.1, 8), h.pos.x, h.pos.y + 0.05, h.pos.z));
      const core = new THREE.Group();
      const crystal = new THREE.Mesh(
        new THREE.OctahedronGeometry(size).scale(1, 1.5, 1),
        psxify(new THREE.MeshLambertMaterial({ color: 0xff2020, emissive: 0xb00010 })),
      );
      core.add(crystal);
      if (h.large) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(size * 1.7, 0.035, 4, 12), new THREE.MeshBasicMaterial({ color: 0xffd0c0 }));
        ring.rotation.x = Math.PI / 2;
        core.add(ring);
      }
      const baseY = h.pos.y + 1.0;
      core.position.set(h.pos.x, baseY, h.pos.z);
      s.add(core);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff3030, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.scale.setScalar(size * 6);
      glow.position.copy(core.position);
      s.add(glow);
      const lightI = h.large ? 8 : 5;
      const src = this.addSource(0xff2a2a, core.position.x, core.position.y, core.position.z, lightI, 6, 1.5);
      // pickup shockwave: hidden at rest (it is drawn at opacity 0 otherwise); the hazard shockwave
      // uses the same material variant, so its shader is already compiled by the loading screen
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.85, 1, 24).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: 0xff3030, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      );
      ring.position.set(h.pos.x, h.pos.y + 0.12, h.pos.z);
      ring.scale.setScalar(0.01);
      ring.visible = false;
      s.add(ring);
      this.pickups.push({ core, src, lightI, glow, ring, ringT: 0, baseY, on: true, pop: 0 });
    }
    addMerged(s, plateGeos, psxify(new THREE.MeshLambertMaterial({ color: 0x241c1c, emissive: 0x2a0406 })));

    // ------------------------------------------------------------ sky dome
    const skyTex = Textures.sky();
    skyTex.wrapT = THREE.ClampToEdgeWrapping;
    skyTex.repeat.set(3, 1);
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    // the sky is drawn every frame from inside the world scene, so it tells us where the camera is
    // (used to pick which static lights get a pooled light on phones)
    this.sky.onBeforeRender = (_r, _s, camera) => { this.camPos.setFromMatrixPosition(camera.matrixWorld); };
    s.add(this.sky);

    // distant foundry silhouettes beyond the walls
    const silMat = new THREE.MeshBasicMaterial({ color: 0x0c0304, fog: false });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xff5010, fog: false });
    const silGeos: THREE.BufferGeometry[] = [];
    const silGlowGeos: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.1;
      const r = 90 + Math.random() * 60;
      const h = 30 + Math.random() * 60;
      const w = 4 + Math.random() * 10;
      const px = Math.cos(a) * r, pz = Math.sin(a) * r;
      silGeos.push(at(new THREE.BoxGeometry(w, h, w), px, h / 2 - 5, pz));
      silGlowGeos.push(at(new THREE.BoxGeometry(w * 0.9, 0.6, w * 0.9), px, h - 5, pz));
    }
    addMerged(s, silGeos, silMat);
    addMerged(s, silGlowGeos, glowMat);

    // ------------------------------------------------------------ set dressing
    this.addChains();
    this.addBraziers();
    this.addPipes();
    this.meowshi = new Meowshi(s);

    // phones: a fixed set of pooled lights stands in for every static source (never added or removed
    // later, so the shader light count stays put)
    if (lowSpec) {
      for (let i = 0; i < POOL_SIZE; i++) {
        const l = new THREE.PointLight(0xffffff, 0, 10, 1.5);
        s.add(l);
        this.pool.push({ l, src: null, next: null, fade: 0 });
      }
    }

    // floating embers
    const N = 260;
    const pos = new Float32Array(N * 3);
    this.emberVel = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * ARENA_HALF * 2;
      pos[i * 3 + 1] = Math.random() * WALL_HEIGHT;
      pos[i * 3 + 2] = (Math.random() - 0.5) * ARENA_HALF * 2;
      this.emberVel[i] = 0.5 + Math.random() * 1.5;
    }
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.embers = new THREE.Points(eg, new THREE.PointsMaterial({ color: 0xff7020, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    s.add(this.embers);
  }

  /** Register a static light source. Desktop gives it its own light; phones pool them (see updatePool). */
  private addSource(color: number, x: number, y: number, z: number, intensity: number, dist: number, decay: number): LightSrc {
    let light: THREE.PointLight | null = null;
    if (!lowSpec) {
      light = new THREE.PointLight(color, intensity, dist, decay);
      light.position.set(x, y, z);
      this.scene.add(light);
    }
    const src: LightSrc = { x, y, z, color, dist, decay, cur: intensity, light, score: 0, top: false, held: false };
    this.sources.push(src);
    return src;
  }

  private setSourceIntensity(src: LightSrc, i: number): void {
    src.cur = i;
    if (src.light) src.light.intensity = i;
  }

  private addChains(): void {
    const linkGeo = new THREE.TorusGeometry(0.12, 0.035, 4, 6);
    const mat = psxify(new THREE.MeshLambertMaterial({ color: 0x3a3230 }));
    const spots = [[-10, -10], [10, 10], [-10, 10], [10, -10], [0, -18], [0, 18], [-24, 0], [24, 0]];
    const lens = spots.map(() => Math.floor((5 + Math.random() * 6) / 0.2));
    // every link of every chain in one instanced mesh
    const chains = new THREE.InstancedMesh(linkGeo, mat, lens.reduce((a, b) => a + b, 0));
    const d = new THREE.Object3D();
    const cageGeos: THREE.BufferGeometry[] = [];
    let k = 0;
    spots.forEach(([x, z], c) => {
      const n = lens[c];
      for (let i = 0; i < n; i++) {
        d.position.set(x, WALL_HEIGHT + 6 - i * 0.2, z);
        d.rotation.set(0, i % 2 ? Math.PI / 2 : 0, 0);
        d.updateMatrix();
        chains.setMatrixAt(k++, d.matrix);
      }
      // hook / cage at the end
      cageGeos.push(at(new THREE.OctahedronGeometry(0.5, 0), x, WALL_HEIGHT + 6 - n * 0.2 - 0.4, z));
    });
    chains.frustumCulled = false;
    this.scene.add(chains);
    addMerged(this.scene, cageGeos, psxify(new THREE.MeshLambertMaterial({ color: 0x241c1a, emissive: 0x1a0400 })));
  }

  private addBraziers(): void {
    const bowlMat = psxify(new THREE.MeshLambertMaterial({ color: 0x2c2422, emissive: 0x200600 }));
    const spots: [number, number, number][] = [[-7, 1.2, -7], [7, 1.2, -7], [-7, 1.2, 7], [7, 1.2, 7], [30.5, 5.5, 30.5], [-30.5, 5.5, 30.5], [30.5, 5.5, -30.5], [-30.5, 5.5, -30.5]];
    const flameMat = new THREE.SpriteMaterial({ map: sprite('flame_01'), color: 0xffa040, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    const bodyGeos: THREE.BufferGeometry[] = [];
    for (const [x, y, z] of spots) {
      bodyGeos.push(at(new THREE.CylinderGeometry(0.12, 0.2, 1.1, 6), x, y + 0.55, z));
      bodyGeos.push(at(new THREE.CylinderGeometry(0.55, 0.25, 0.4, 6), x, y + 1.25, z));
      const f = new THREE.Sprite(flameMat);
      f.position.set(x, y + 1.9, z);
      f.scale.set(1.2, 1.6, 1);
      this.scene.add(f);
      this.flames.push(f);
      this.addSource(0xff7a30, x, y + 2, z, 14, 12, 1.5);
    }
    addMerged(this.scene, bodyGeos, bowlMat);
  }

  private addPipes(): void {
    const mat = psxify(new THREE.MeshLambertMaterial({ color: 0x3a302c, emissive: 0x0a0200 }));
    const H = ARENA_HALF - 0.4;
    const pipeGeos: THREE.BufferGeometry[] = [];
    for (const y of [6, 12.5]) {
      for (const side of [0, 1, 2, 3]) {
        const g = new THREE.CylinderGeometry(0.35, 0.35, H * 2, 6).rotateZ(Math.PI / 2);
        if (side < 2) pipeGeos.push(at(g, 0, y, side === 0 ? -H : H));
        else pipeGeos.push(at(g, side === 2 ? -H : H, y, 0, Math.PI / 2));
      }
    }
    addMerged(this.scene, pipeGeos, mat);
    // vertical ribs on the walls
    const ribMat = psxify(new THREE.MeshLambertMaterial({ color: 0x2a2220 }));
    const ribGeos: THREE.BufferGeometry[] = [];
    for (let i = -32; i <= 32; i += 8) {
      for (const [x, z, rx, rz] of [[i, -ARENA_HALF + 0.3, 0.8, 0.6], [i, ARENA_HALF - 0.3, 0.8, 0.6], [-ARENA_HALF + 0.3, i, 0.6, 0.8], [ARENA_HALF - 0.3, i, 0.6, 0.8]]) {
        ribGeos.push(at(new THREE.BoxGeometry(rx, WALL_HEIGHT, rz), x, WALL_HEIGHT / 2, z));
      }
    }
    addMerged(this.scene, ribGeos, ribMat);
  }

  /**
   * Phones: hand the pooled lights to the static sources that light the area around the camera
   * most. A light that changes source fades out, jumps, then fades in so nothing pops.
   */
  private updatePool(dt: number): void {
    const f = this.focus;
    const src = this.sources;
    for (const s of src) {
      const dx = s.x - f.x, dy = s.y - f.y, dz = s.z - f.z;
      const k = 1 - Math.sqrt(dx * dx + dy * dy + dz * dz) / s.dist;
      // influence falls off with the same cutoff the light itself uses; held lights get a head start
      s.score = k > 0 ? s.cur * k * k * (s.held ? 1.3 : 1) : 0;
      s.top = false;
    }
    src.sort((a, b) => b.score - a.score);
    const free = this.poolFree;
    free.length = 0;
    for (let i = 0; i < POOL_SIZE && i < src.length; i++) {
      if (src[i].score <= 0) break;
      src[i].top = true;
      if (!src[i].held) free.push(src[i]);
    }
    const step = dt / POOL_FADE;
    for (const slot of this.pool) {
      if (slot.src && !slot.src.top) {
        // its source is no longer among the best: fade out, then take over a free one
        if (!slot.next) { slot.next = free.pop() ?? null; if (slot.next) slot.next.held = true; }
        slot.fade -= step;
        if (slot.fade <= 0) {
          slot.fade = 0;
          slot.src.held = false;
          slot.src = null;
        }
      } else if (slot.src) {
        if (slot.next) { slot.next.held = false; slot.next = null; }
        slot.fade = Math.min(1, slot.fade + step);
      }
      if (!slot.src) {
        const next = slot.next ?? free.pop() ?? null;
        slot.next = null;
        if (next) {
          next.held = true;
          slot.src = next;
          slot.fade = 0;
          slot.l.position.set(next.x, next.y, next.z);
          slot.l.color.setHex(next.color);
          slot.l.distance = next.dist;
          slot.l.decay = next.decay;
        }
      }
      slot.l.intensity = slot.src ? slot.src.cur * slot.fade : 0;
    }
  }

  /** Show/hide pickups from the server's availability bitmask. */
  setPickups(mask: number): void {
    this.pickups.forEach((p, i) => {
      const on = (mask & (1 << i)) !== 0;
      if (on && !p.on) p.pop = 1; // respawned: grow back in
      p.on = on;
      p.core.visible = p.glow.visible = on;
      // never toggle a light's visibility: changing the active light count recompiles every
      // shader in the scene (a visible freeze). Dim it instead.
      this.setSourceIntensity(p.src, on ? p.lightI : 0);
    });
  }

  /** A pickup was taken: a red shockwave rolls out across the floor from it. */
  pickupBurst(i: number): void {
    const p = this.pickups[i];
    if (p) { p.ringT = 0.55; p.ring.visible = true; }
  }

  /** `focus` is where the player is; omitted, the camera position seen by the last render is used. */
  update(dt: number, time: number, focus?: THREE.Vector3): void {
    psxUniforms.uTime.value = time;
    for (let i = 0; i < this.pickups.length; i++) {
      const p = this.pickups[i];
      if (p.ringT > 0) {
        p.ringT = Math.max(0, p.ringT - dt);
        const k = 1 - p.ringT / 0.55; // 0 -> 1
        p.ring.scale.setScalar(0.3 + k * 4.2);
        (p.ring.material as THREE.MeshBasicMaterial).opacity = (1 - k) * 0.9;
        p.ring.visible = p.ringT > 0;
      }
      if (!p.on) continue;
      p.pop = Math.max(0, p.pop - dt * 3);
      p.core.rotation.y = time * 1.8 + i;
      p.core.position.y = p.baseY + Math.sin(time * 2.2 + i) * 0.12;
      p.core.scale.setScalar(1 - p.pop);
      p.glow.position.y = p.core.position.y;
      (p.glow.material as THREE.SpriteMaterial).opacity = 0.55 + Math.sin(time * 4 + i) * 0.2;
    }
    if (this.lavaMat.map) {
      this.lavaMat.map.offset.x = time * 0.03;
      this.lavaMat.map.offset.y = Math.sin(time * 0.4) * 0.05;
    }
    const pulse = 0.7 + Math.sin(time * 5) * 0.3;
    for (const r of this.padRings) {
      (r.material as THREE.MeshBasicMaterial).opacity = pulse;
      r.rotation.y += dt * 1.5;
    }
    for (let i = 0; i < this.flames.length; i++) {
      const f = this.flames[i];
      const k = 1 + Math.sin(time * 13 + i * 3) * 0.12 + Math.sin(time * 7.3 + i) * 0.08;
      f.scale.set(1.2 * k, 1.6 * k, 1);
    }
    for (let i = 0; i < this.lavaSrc.length; i++) this.setSourceIntensity(this.lavaSrc[i], 26 + Math.sin(time * 3 + i * 2) * 6);
    if (lowSpec) {
      this.focus.copy(focus ?? this.camPos);
      this.updatePool(dt);
    }
    const pos = this.embers.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      let y = pos.getY(i) + this.emberVel[i] * dt;
      if (y > WALL_HEIGHT + 4) y = 0;
      pos.setY(i, y);
      pos.setX(i, pos.getX(i) + Math.sin(time + i) * dt * 0.3);
    }
    pos.needsUpdate = true;
    this.sky.rotation.y = time * 0.004;
  }
}
