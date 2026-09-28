// Builds the visible arena from the shared collision boxes, plus lighting,
// molten slag, jump pads, sky, and set dressing (chains, braziers, pipes).
import * as THREE from 'three';
import { ARENA_HALF, BOXES, HEALTH_PICKUPS, JUMP_PADS, LAVA, WALL_HEIGHT, type Box, type Surface } from '../../../shared/arena';
import { psxUniforms, psxify, Textures } from '../engine/psx';
import { sprite } from '../engine/assets';

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
  private pickups: { core: THREE.Object3D; light: THREE.PointLight; glow: THREE.Sprite; baseY: number; on: boolean; pop: number }[] = [];
  private embers: THREE.Points;
  private emberVel: Float32Array;
  private flames: THREE.Sprite[] = [];
  private lavaLights: THREE.PointLight[] = [];
  private sky: THREE.Mesh;

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
    for (const b of BOXES) {
      if (b.surface === 'invisible') continue;
      const mesh = new THREE.Mesh(boxGeometry(b, scaleFor[b.surface]), mat(b.surface));
      s.add(mesh);
    }

    // glowing trim along the top of the outer walls
    const trimMat = new THREE.MeshBasicMaterial({ color: 0xff4a10 });
    for (const [x, z, w, d] of [[0, -ARENA_HALF + 0.05, ARENA_HALF * 2, 0.2], [0, ARENA_HALF - 0.05, ARENA_HALF * 2, 0.2], [-ARENA_HALF + 0.05, 0, 0.2, ARENA_HALF * 2], [ARENA_HALF - 0.05, 0, 0.2, ARENA_HALF * 2]]) {
      for (const y of [2.2, 9.5]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, d), trimMat);
        m.position.set(x, y, z);
        s.add(m);
      }
    }

    // ------------------------------------------------------------ molten slag
    this.lavaMat = new THREE.MeshBasicMaterial({ map: Textures.lava(), color: 0xffffff, fog: false });
    this.lavaMat.map!.repeat.set(2, 2);
    for (const z of LAVA) {
      const w = z.max.x - z.min.x, d = z.max.z - z.min.z;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2), this.lavaMat);
      m.position.set((z.min.x + z.max.x) / 2, 0.03, (z.min.z + z.max.z) / 2);
      s.add(m);
      // dark rim
      const rimMat = new THREE.MeshLambertMaterial({ color: 0x140606 });
      for (const [rx, rz, rw, rd] of [[m.position.x, z.min.z - 0.25, w + 1, 0.5], [m.position.x, z.max.z + 0.25, w + 1, 0.5], [z.min.x - 0.25, m.position.z, 0.5, d], [z.max.x + 0.25, m.position.z, 0.5, d]]) {
        const r = new THREE.Mesh(new THREE.BoxGeometry(rw, 0.12, rd), rimMat);
        r.position.set(rx, 0.06, rz);
        s.add(r);
      }
      const l = new THREE.PointLight(0xff5a10, 30, 22, 1.4);
      l.position.set(m.position.x, 1.5, m.position.z);
      s.add(l);
      this.lavaLights.push(l);
    }

    // ------------------------------------------------------------ jump pads
    const padTex = Textures.pad();
    for (const p of JUMP_PADS) {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius + 0.2, 0.12, 12), psxify(new THREE.MeshLambertMaterial({ color: 0x202428, emissive: 0x002a38 })));
      base.position.set(p.pos.x, p.pos.y + 0.06, p.pos.z);
      s.add(base);
      const ring = new THREE.Mesh(
        new THREE.PlaneGeometry(p.radius * 2, p.radius * 2).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: padTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xffffff }),
      );
      const pl = new THREE.PointLight(0x30d8ff, 6, 6, 1.5);
      pl.position.set(p.pos.x, p.pos.y + 0.8, p.pos.z);
      s.add(pl);
      ring.position.set(p.pos.x, p.pos.y + 0.14, p.pos.z);
      s.add(ring);
      this.padRings.push(ring);
    }

    // ------------------------------------------------------------ health pickups
    // a floating blood crystal over a dark plate; the plate stays when the crystal is taken
    // so players learn where they respawn
    const glowTex = sprite('light_01');
    for (const h of HEALTH_PICKUPS) {
      const size = h.large ? 0.5 : 0.36;
      const plate = new THREE.Mesh(new THREE.CylinderGeometry(size * 2.2, size * 2.5, 0.1, 8), psxify(new THREE.MeshLambertMaterial({ color: 0x241c1c, emissive: 0x2a0406 })));
      plate.position.set(h.pos.x, h.pos.y + 0.05, h.pos.z);
      s.add(plate);
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
      const light = new THREE.PointLight(0xff2a2a, h.large ? 8 : 5, 6, 1.5);
      light.position.copy(core.position);
      s.add(light);
      this.pickups.push({ core, light, glow, baseY, on: true, pop: 0 });
    }

    // ------------------------------------------------------------ sky dome
    const skyTex = Textures.sky();
    skyTex.wrapT = THREE.ClampToEdgeWrapping;
    skyTex.repeat.set(3, 1);
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }),
    );
    s.add(this.sky);

    // distant foundry silhouettes beyond the walls
    const silMat = new THREE.MeshBasicMaterial({ color: 0x0c0304, fog: false });
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xff5010, fog: false });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.1;
      const r = 90 + Math.random() * 60;
      const h = 30 + Math.random() * 60;
      const w = 4 + Math.random() * 10;
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, w), silMat);
      m.position.set(Math.cos(a) * r, h / 2 - 5, Math.sin(a) * r);
      s.add(m);
      const g = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.6, w * 0.9), glowMat);
      g.position.set(m.position.x, h - 5, m.position.z);
      s.add(g);
    }

    // ------------------------------------------------------------ set dressing
    this.addChains();
    this.addBraziers();
    this.addPipes();

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

  private addChains(): void {
    const linkGeo = new THREE.TorusGeometry(0.12, 0.035, 4, 6);
    const mat = psxify(new THREE.MeshLambertMaterial({ color: 0x3a3230 }));
    const spots = [[-10, -10], [10, 10], [-10, 10], [10, -10], [0, -18], [0, 18], [-24, 0], [24, 0]];
    for (const [x, z] of spots) {
      const len = 5 + Math.random() * 6;
      const n = Math.floor(len / 0.2);
      const chain = new THREE.InstancedMesh(linkGeo, mat, n);
      const d = new THREE.Object3D();
      for (let i = 0; i < n; i++) {
        d.position.set(x, WALL_HEIGHT + 6 - i * 0.2, z);
        d.rotation.set(0, i % 2 ? Math.PI / 2 : 0, 0);
        d.updateMatrix();
        chain.setMatrixAt(i, d.matrix);
      }
      this.scene.add(chain);
      // hook / cage at the end
      const cage = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0), psxify(new THREE.MeshLambertMaterial({ color: 0x241c1a, emissive: 0x1a0400 })));
      cage.position.set(x, WALL_HEIGHT + 6 - n * 0.2 - 0.4, z);
      this.scene.add(cage);
    }
  }

  private addBraziers(): void {
    const bowlMat = psxify(new THREE.MeshLambertMaterial({ color: 0x2c2422, emissive: 0x200600 }));
    const spots: [number, number, number][] = [[-7, 1.2, -7], [7, 1.2, -7], [-7, 1.2, 7], [7, 1.2, 7], [30.5, 5.5, 30.5], [-30.5, 5.5, 30.5], [30.5, 5.5, -30.5], [-30.5, 5.5, -30.5]];
    const flameMat = new THREE.SpriteMaterial({ map: sprite('flame_01'), color: 0xffa040, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    for (const [x, y, z] of spots) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 1.1, 6), bowlMat);
      post.position.set(x, y + 0.55, z);
      const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.25, 0.4, 6), bowlMat);
      bowl.position.set(x, y + 1.25, z);
      this.scene.add(post, bowl);
      const f = new THREE.Sprite(flameMat);
      f.position.set(x, y + 1.9, z);
      f.scale.set(1.2, 1.6, 1);
      this.scene.add(f);
      this.flames.push(f);
      const l = new THREE.PointLight(0xff7a30, 14, 12, 1.5);
      l.position.set(x, y + 2, z);
      this.scene.add(l);
    }
  }

  private addPipes(): void {
    const mat = psxify(new THREE.MeshLambertMaterial({ color: 0x3a302c, emissive: 0x0a0200 }));
    const H = ARENA_HALF - 0.4;
    for (const y of [6, 12.5]) {
      for (const side of [0, 1, 2, 3]) {
        const g = new THREE.CylinderGeometry(0.35, 0.35, H * 2, 6).rotateZ(Math.PI / 2);
        const m = new THREE.Mesh(g, mat);
        if (side < 2) m.position.set(0, y, side === 0 ? -H : H);
        else { m.rotation.y = Math.PI / 2; m.position.set(side === 2 ? -H : H, y, 0); }
        this.scene.add(m);
      }
    }
    // vertical ribs on the walls
    const ribMat = psxify(new THREE.MeshLambertMaterial({ color: 0x2a2220 }));
    for (let i = -32; i <= 32; i += 8) {
      for (const [x, z, rx, rz] of [[i, -ARENA_HALF + 0.3, 0.8, 0.6], [i, ARENA_HALF - 0.3, 0.8, 0.6], [-ARENA_HALF + 0.3, i, 0.6, 0.8], [ARENA_HALF - 0.3, i, 0.6, 0.8]]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(rx, WALL_HEIGHT, rz), ribMat);
        m.position.set(x, WALL_HEIGHT / 2, z);
        this.scene.add(m);
      }
    }
  }

  /** Show/hide pickups from the server's availability bitmask. */
  setPickups(mask: number): void {
    this.pickups.forEach((p, i) => {
      const on = (mask & (1 << i)) !== 0;
      if (on && !p.on) p.pop = 1; // respawned: grow back in
      p.on = on;
      p.core.visible = p.glow.visible = on;
      p.light.visible = on;
    });
  }

  update(dt: number, time: number): void {
    psxUniforms.uTime.value = time;
    for (let i = 0; i < this.pickups.length; i++) {
      const p = this.pickups[i];
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
    for (let i = 0; i < this.lavaLights.length; i++) this.lavaLights[i].intensity = 26 + Math.sin(time * 3 + i * 2) * 6;
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
