// Visual effects: GPU point-sprite particle systems, blood decals, tracers,
// physics gibs, pooled flash lights, camera shake and hitstop.
import * as THREE from 'three';
import { raycastWorld } from '../../../shared/arena';
import type { Vec3 } from '../../../shared/math';
import { sprite, type SpriteName } from '../engine/assets';

const tmpV = new THREE.Vector3();

class ParticleSystem {
  readonly points: THREE.Points;
  private n = 0;
  private pos: Float32Array;
  private col: Float32Array;
  private size: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private s0: Float32Array;
  private s1: Float32Array;
  private a0: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private geo: THREE.BufferGeometry;
  static scale = { value: 400 };

  constructor(tex: THREE.Texture, private cap: number, additive: boolean) {
    this.pos = new Float32Array(cap * 3);
    this.col = new Float32Array(cap * 4);
    this.size = new Float32Array(cap);
    this.vel = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.s0 = new Float32Array(cap);
    this.s1 = new Float32Array(cap);
    this.a0 = new Float32Array(cap);
    this.grav = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { tMap: { value: tex }, uScale: ParticleSystem.scale },
      vertexShader: `
        attribute vec4 aColor; attribute float aSize; uniform float uScale; varying vec4 vColor;
        void main(){
          vColor = aColor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(0.1, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform sampler2D tMap; varying vec4 vColor;
        void main(){
          vec4 t = texture2D(tMap, gl_PointCoord);
          float a = (t.a < 0.99 ? t.a : max(max(t.r, t.g), t.b)) * vColor.a;
          if (a < 0.03) discard;
          gl_FragColor = vec4(vColor.rgb * mix(1.0, max(max(t.r,t.g),t.b), 0.35), a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  emit(p: Vec3, v: Vec3, life: number, s0: number, s1: number, color: THREE.Color, alpha = 1, gravity = 0, drag = 0): void {
    let i = this.n;
    if (i >= this.cap) {
      // overwrite the oldest-looking slot (lowest remaining life)
      i = 0;
      let lo = Infinity;
      for (let k = 0; k < this.cap; k += 7) if (this.life[k] < lo) { lo = this.life[k]; i = k; }
    } else this.n++;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.life[i] = life; this.maxLife[i] = life;
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha;
    this.col[i * 4] = color.r; this.col[i * 4 + 1] = color.g; this.col[i * 4 + 2] = color.b; this.col[i * 4 + 3] = alpha;
    this.grav[i] = gravity; this.drag[i] = drag;
    this.size[i] = s0;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        const last = --this.n;
        if (i !== last) this.move(last, i);
        continue;
      }
      const t = 1 - this.life[i] / this.maxLife[i];
      const d = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= d; this.vel[i * 3 + 2] *= d;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * d - this.grav[i] * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      if (this.pos[i * 3 + 1] < 0.02 && this.grav[i] > 0) { this.pos[i * 3 + 1] = 0.02; this.vel[i * 3 + 1] *= -0.2; }
      this.size[i] = this.s0[i] + (this.s1[i] - this.s0[i]) * t;
      this.col[i * 4 + 3] = this.a0[i] * (1 - t * t);
      i++;
    }
    this.geo.setDrawRange(0, this.n);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
  }

  private move(from: number, to: number): void {
    for (let k = 0; k < 3; k++) {
      this.pos[to * 3 + k] = this.pos[from * 3 + k];
      this.vel[to * 3 + k] = this.vel[from * 3 + k];
    }
    for (let k = 0; k < 4; k++) this.col[to * 4 + k] = this.col[from * 4 + k];
    this.size[to] = this.size[from]; this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.s0[to] = this.s0[from]; this.s1[to] = this.s1[from]; this.a0[to] = this.a0[from];
    this.grav[to] = this.grav[from]; this.drag[to] = this.drag[from];
  }

  clear(): void {
    this.n = 0;
  }
}

interface Gib {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  life: number;
  scale: number;
  floor: number;
  trail: number;
}

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
  max: number;
}

const C = (hex: number) => new THREE.Color(hex);
export const COLORS = {
  blood: C(0x8a0010),
  bloodBright: C(0xd0001a),
  spark: C(0xffc860),
  fire: C(0xff7a20),
  smoke: C(0x201814),
  smokeLight: C(0x5a4a40),
  gold: C(0xffd040),
  white: C(0xffffff),
  red: C(0xff2020),
  parry: C(0xfff4b0),
  blue: C(0x60c0ff),
  purple: C(0xc040ff),
  hostile: C(0xff3010),
};

export class FX {
  readonly group = new THREE.Group();
  private sys: Record<'spark' | 'fire' | 'smoke' | 'blood' | 'glow' | 'magic' | 'dust', ParticleSystem>;
  private decals: THREE.Mesh[] = [];
  private decalIdx = 0;
  private decalMats: THREE.MeshBasicMaterial[];
  private scorchMat: THREE.MeshBasicMaterial;
  private tracers: Tracer[] = [];
  private gibs: Gib[] = [];
  private gibMesh: THREE.InstancedMesh;
  private lights: { l: THREE.PointLight; life: number; max: number; i0: number }[] = [];
  trauma = 0;
  hitstop = 0;
  shakeScale = 1;
  private dummy = new THREE.Object3D();

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
    const mk = (s: SpriteName, cap: number, add: boolean) => {
      const ps = new ParticleSystem(sprite(s), cap, add);
      this.group.add(ps.points);
      return ps;
    };
    this.sys = {
      spark: mk('spark_04', 900, true),
      fire: mk('fire_01', 500, true),
      smoke: mk('smoke_04', 400, false),
      blood: mk('circle_05', 1200, false),
      glow: mk('light_01', 200, true),
      magic: mk('magic_01', 300, true),
      dust: mk('dirt_02', 300, false),
    };
    // decals
    const decalGeo = new THREE.PlaneGeometry(1, 1);
    const mkDecalMat = (s: SpriteName, color: number, opacity = 0.9) =>
      new THREE.MeshBasicMaterial({ map: sprite(s), color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.decalMats = [mkDecalMat('dirt_02', 0x6a0010), mkDecalMat('dirt_03', 0x5a000c), mkDecalMat('circle_05', 0x70000e, 0.8)];
    this.scorchMat = mkDecalMat('scorch_01', 0x000000, 0.85);
    for (let i = 0; i < 160; i++) {
      const m = new THREE.Mesh(decalGeo, this.decalMats[0]);
      m.visible = false;
      m.renderOrder = 1;
      this.decals.push(m);
      this.group.add(m);
    }
    // tracers
    const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 4, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5);
    for (let i = 0; i < 48; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xfff0a0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const m = new THREE.Mesh(tracerGeo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.tracers.push({ mesh: m, life: 0, max: 1 });
    }
    // gibs
    this.gibMesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0x7a0a0a, emissive: 0x200000 }),
      220,
    );
    this.gibMesh.count = 0;
    this.gibMesh.frustumCulled = false;
    this.group.add(this.gibMesh);
    // flash lights
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffaa55, 0, 14, 1.6);
      this.group.add(l);
      this.lights.push({ l, life: 0, max: 1, i0: 0 });
    }
  }

  setParticleScale(renderHeight: number, fovDeg: number): void {
    ParticleSystem.scale.value = (renderHeight * 0.5) / Math.tan((fovDeg * Math.PI) / 360);
  }

  // ------------------------------------------------------------------ emitters

  sparks(p: Vec3, n: number, speed = 8, color = COLORS.spark, size = 0.12): void {
    for (let i = 0; i < n; i++) {
      const v = randDir(speed * (0.4 + Math.random() * 0.8));
      this.sys.spark.emit(p, v, 0.2 + Math.random() * 0.35, size, size * 0.3, color, 1, 14, 1.5);
    }
  }

  blood(p: Vec3, n: number, dir: Vec3 | null = null, force = 7): void {
    for (let i = 0; i < n; i++) {
      const v = randDir(force * (0.3 + Math.random()));
      if (dir) { v.x += dir.x * force; v.y += dir.y * force + 2; v.z += dir.z * force; }
      const c = Math.random() < 0.5 ? COLORS.blood : COLORS.bloodBright;
      this.sys.blood.emit(p, v, 0.5 + Math.random() * 0.6, 0.12 + Math.random() * 0.18, 0.05, c, 1, 22, 0.5);
    }
  }

  bloodMist(p: Vec3, n: number, size = 0.9): void {
    for (let i = 0; i < n; i++) {
      this.sys.smoke.emit(p, randDir(2), 0.5 + Math.random() * 0.4, size * 0.5, size * 1.6, COLORS.blood, 0.55, -0.5, 2);
    }
  }

  explosion(p: Vec3, r: number, color = COLORS.fire): void {
    const n = Math.floor(10 + r * 6);
    for (let i = 0; i < n; i++) {
      const v = randDir(r * (1.4 + Math.random() * 2));
      this.sys.fire.emit(p, v, 0.35 + Math.random() * 0.35, r * 0.45, r * 0.9, color, 1, -2, 4);
    }
    for (let i = 0; i < n * 0.6; i++) {
      const v = randDir(r * 0.9);
      v.y += 2;
      this.sys.smoke.emit(p, v, 1.1 + Math.random() * 0.8, r * 0.4, r * 1.3, COLORS.smoke, 0.75, -1.5, 2.5);
    }
    this.sparks(p, Math.floor(r * 6), r * 4);
    this.sys.glow.emit(p, { x: 0, y: 0, z: 0 }, 0.18, r * 2.2, r * 3.2, color, 1);
    this.flashLight(p, color.getHex(), 5 + r, r * 4.5, 0.25);
  }

  muzzle(p: Vec3, color = COLORS.spark, size = 0.6): void {
    this.sys.glow.emit(p, { x: 0, y: 0, z: 0 }, 0.06, size, size * 1.4, color, 1);
    this.flashLight(p, color.getHex(), 3, 9, 0.07);
  }

  glow(p: Vec3, size: number, color: THREE.Color, life = 0.15, alpha = 1): void {
    this.sys.glow.emit(p, { x: 0, y: 0, z: 0 }, life, size, size * 1.3, color, alpha);
  }

  magic(p: Vec3, n: number, color: THREE.Color, speed = 3, size = 0.4): void {
    for (let i = 0; i < n; i++) this.sys.magic.emit(p, randDir(speed), 0.4 + Math.random() * 0.5, size, 0, color, 1, -2, 1);
  }

  smoke(p: Vec3, n: number, size = 0.6, color = COLORS.smokeLight, alpha = 0.5): void {
    for (let i = 0; i < n; i++) {
      const v = randDir(1);
      v.y = Math.abs(v.y) + 0.8;
      this.sys.smoke.emit(p, v, 0.8 + Math.random() * 0.6, size, size * 2.2, color, alpha, -0.8, 1);
    }
  }

  dust(p: Vec3, n: number, spread = 3): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = { x: Math.cos(a) * spread * (0.5 + Math.random()), y: 0.5 + Math.random(), z: Math.sin(a) * spread * (0.5 + Math.random()) };
      this.sys.dust.emit(p, v, 0.6 + Math.random() * 0.4, 0.5, 1.4, COLORS.smokeLight, 0.6, 0, 2.5);
    }
  }

  fireTrail(p: Vec3, color = COLORS.fire, size = 0.35): void {
    this.sys.fire.emit(p, randDir(0.6), 0.18, size, size * 0.3, color, 0.9);
    if (Math.random() < 0.5) this.sys.smoke.emit(p, randDir(0.3), 0.6, size * 0.6, size * 2, COLORS.smoke, 0.35, -0.5, 1);
  }

  tracer(a: Vec3, b: Vec3, color = 0xfff0a0, width = 0.035, life = 0.09): void {
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0];
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    t.mesh.position.set(a.x, a.y, a.z);
    t.mesh.lookAt(b.x, b.y, b.z);
    t.mesh.scale.set(width, width, len);
    (t.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    (t.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    t.mesh.visible = true;
    t.life = t.max = life;
  }

  decal(p: Vec3, n: Vec3, size: number, kind: 'blood' | 'scorch' = 'blood'): void {
    const m = this.decals[this.decalIdx];
    this.decalIdx = (this.decalIdx + 1) % this.decals.length;
    m.material = kind === 'scorch' ? this.scorchMat : this.decalMats[Math.floor(Math.random() * this.decalMats.length)];
    m.position.set(p.x + n.x * 0.02, p.y + n.y * 0.02, p.z + n.z * 0.02);
    m.lookAt(p.x + n.x, p.y + n.y, p.z + n.z);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(size);
    m.visible = true;
  }

  /** Splatter blood decals around a point by raycasting in random directions. */
  splatter(p: Vec3, n: number, reach = 3, size = 1.2): void {
    for (let i = 0; i < n; i++) {
      const d = randDir(1);
      if (i === 0) { d.x = 0; d.y = -1; d.z = 0; }
      const l = Math.hypot(d.x, d.y, d.z) || 1;
      const dir = { x: d.x / l, y: d.y / l - (i === 0 ? 0 : 0.5), z: d.z / l };
      const dl = Math.hypot(dir.x, dir.y, dir.z);
      dir.x /= dl; dir.y /= dl; dir.z /= dl;
      const hit = raycastWorld(p, dir, reach);
      if (hit) this.decal({ x: p.x + dir.x * hit.dist, y: p.y + dir.y * hit.dist, z: p.z + dir.z * hit.dist }, hit.normal, size * (0.6 + Math.random() * 0.8));
    }
  }

  gibBurst(p: Vec3, n: number, force = 9, scale = 0.22): void {
    const floorHit = raycastWorld(p, { x: 0, y: -1, z: 0 }, 30);
    const floor = floorHit ? p.y - floorHit.dist : 0;
    for (let i = 0; i < n; i++) {
      if (this.gibs.length >= 220) this.gibs.shift();
      const v = randDir(force * (0.4 + Math.random()));
      v.y = Math.abs(v.y) * 0.9 + 3;
      this.gibs.push({
        pos: new THREE.Vector3(p.x + (Math.random() - 0.5) * 0.5, p.y + (Math.random() - 0.5) * 0.5, p.z + (Math.random() - 0.5) * 0.5),
        vel: new THREE.Vector3(v.x, v.y, v.z),
        rot: new THREE.Euler(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        spin: new THREE.Vector3((Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20),
        life: 5 + Math.random() * 3,
        scale: scale * (0.5 + Math.random()),
        floor,
        trail: 0,
      });
    }
  }

  flashLight(p: Vec3, color: number, intensity: number, dist: number, life: number): void {
    const slot = this.lights.reduce((a, b) => (a.life < b.life ? a : b));
    slot.l.position.set(p.x, p.y, p.z);
    slot.l.color.setHex(color);
    slot.l.distance = dist;
    slot.i0 = intensity * 6;
    slot.l.intensity = slot.i0;
    slot.life = slot.max = life;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount * this.shakeScale);
  }

  freeze(t: number): void {
    this.hitstop = Math.max(this.hitstop, t);
  }

  shakeOffset(time: number): THREE.Vector3 {
    const s = this.trauma * this.trauma;
    return tmpV.set(
      (Math.sin(time * 71.3) + Math.sin(time * 37.1)) * 0.5 * s * 0.25,
      (Math.sin(time * 63.7) + Math.sin(time * 29.9)) * 0.5 * s * 0.25,
      (Math.sin(time * 53.3) + Math.sin(time * 41.7)) * 0.5 * s * 0.06,
    );
  }

  update(dt: number): void {
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
    for (const s of Object.values(this.sys)) s.update(dt);
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const m = t.mesh.material as THREE.MeshBasicMaterial;
      m.opacity = Math.max(0, t.life / t.max);
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const l of this.lights) {
      if (l.life <= 0) { l.l.intensity = 0; continue; }
      l.life -= dt;
      l.l.intensity = Math.max(0, l.i0 * (l.life / l.max));
    }
    // gibs
    let n = 0;
    for (let i = this.gibs.length - 1; i >= 0; i--) {
      const g = this.gibs[i];
      g.life -= dt;
      if (g.life <= 0) { this.gibs.splice(i, 1); continue; }
      g.vel.y -= 26 * dt;
      g.pos.addScaledVector(g.vel, dt);
      if (g.pos.y < g.floor + g.scale * 0.5) {
        g.pos.y = g.floor + g.scale * 0.5;
        if (g.vel.y < -4) {
          this.sys.blood.emit(g.pos, { x: 0, y: 1.5, z: 0 }, 0.3, 0.12, 0.02, COLORS.blood, 1, 10);
          if (Math.random() < 0.3) this.decal({ x: g.pos.x, y: g.floor, z: g.pos.z }, { x: 0, y: 1, z: 0 }, 0.5 + Math.random() * 0.5);
        }
        g.vel.y *= -0.3;
        g.vel.x *= 0.6;
        g.vel.z *= 0.6;
        g.spin.multiplyScalar(0.6);
      }
      g.trail -= dt;
      if (g.trail <= 0 && g.vel.lengthSq() > 16) {
        g.trail = 0.04;
        this.sys.blood.emit(g.pos, { x: 0, y: 0, z: 0 }, 0.4, 0.1, 0.02, COLORS.blood, 0.9, 12);
      }
      g.rot.x += g.spin.x * dt; g.rot.y += g.spin.y * dt; g.rot.z += g.spin.z * dt;
      this.dummy.position.copy(g.pos);
      this.dummy.rotation.copy(g.rot);
      this.dummy.scale.setScalar(g.scale * Math.min(1, g.life));
      this.dummy.updateMatrix();
      this.gibMesh.setMatrixAt(n++, this.dummy.matrix);
    }
    this.gibMesh.count = n;
    this.gibMesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (const s of Object.values(this.sys)) s.clear();
    this.gibs = [];
    for (const d of this.decals) d.visible = false;
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
  }
}

function randDir(speed: number): Vec3 {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return { x: r * Math.cos(a) * speed, y: u * speed, z: r * Math.sin(a) * speed };
}
