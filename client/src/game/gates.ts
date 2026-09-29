// Run gates: portal frames that stand around the dais between rooms. Each shows the prize for
// clearing the room behind it. The host walks through one to choose. The meshes live in the
// scene the whole time (parked under the floor when unused) so their shaders compile at load.
import * as THREE from 'three';
import { CHALLENGE_INFO, GATE_SPOTS, REWARD_INFO, type Gate } from '../../../shared/run';
import { sprite } from '../engine/assets';
import { psxify, Textures } from '../engine/psx';

const PARK_Y = -60;

interface GateView {
  root: THREE.Group;
  field: THREE.Mesh;
  fieldMat: THREE.MeshBasicMaterial;
  glow: THREE.Sprite;
  label: THREE.Sprite;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  active: boolean;
  fade: number; // 1 = fully shown
  chosen: number; // >0 while the picked gate flares
}

export class Gates {
  private views: GateView[] = [];
  private time = 0;

  constructor(scene: THREE.Scene) {
    const metal = psxify(new THREE.MeshLambertMaterial({ map: Textures.metal(), color: 0x9a8a84 }));
    const trim = new THREE.MeshBasicMaterial({ color: 0xff5a1a });
    for (const spot of GATE_SPOTS) {
      const root = new THREE.Group();
      const postGeo = new THREE.BoxGeometry(0.4, 4.4, 0.5);
      for (const s of [-1, 1]) {
        const post = new THREE.Mesh(postGeo, metal);
        post.position.set(s * 1.55, 2.2, 0);
        root.add(post);
        const strip = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.6, 0.52), trim);
        strip.position.set(s * 1.33, 2.2, 0);
        root.add(strip);
      }
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.45, 0.55), metal);
      lintel.position.y = 4.4;
      root.add(lintel);
      const fieldMat = new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
      const field = new THREE.Mesh(new THREE.PlaneGeometry(2.7, 4.0), fieldMat);
      field.position.y = 2.1;
      root.add(field);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: sprite('light_01'), color: 0xff8a2a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.6, fog: false }));
      glow.scale.set(6, 6, 1);
      glow.position.y = 2.2;
      root.add(glow);
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 200;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
      label.scale.set(6.4, 2.5, 1);
      label.position.y = 6.3;
      label.renderOrder = 5;
      root.add(label);
      // face the centre of the arena
      root.position.set(spot.x, PARK_Y, spot.z);
      root.rotation.y = Math.atan2(-spot.x, -spot.z);
      scene.add(root);
      this.views.push({ root, field, fieldMat, glow, label, canvas, tex, active: false, fade: 0, chosen: 0 });
    }
  }

  /** Show the gates on offer (empty list hides them). */
  set(gates: Gate[] | undefined): void {
    const list = gates ?? [];
    this.views.forEach((v, i) => {
      const g = list[i];
      if (!g) { v.active = false; return; }
      if (!v.active) v.fade = 0;
      v.active = true;
      v.chosen = 0;
      const info = REWARD_INFO[g.reward];
      v.fieldMat.color.setHex(info.color);
      (v.glow.material as THREE.SpriteMaterial).color.setHex(info.color);
      this.drawLabel(v, g);
    });
  }

  /** The host picked gate i: it flares, the rest fold away. */
  choose(i: number): void {
    this.views.forEach((v, k) => {
      if (k === i) v.chosen = 0.8;
      else v.active = false;
    });
  }

  /** Loading-screen warm-up: stand the gates up for one frame so their shaders compile. */
  warm(on: boolean): void {
    for (const v of this.views) v.root.position.y = on ? 0 : PARK_Y;
  }

  get anyActive(): boolean {
    return this.views.some((v) => v.active);
  }

  private drawLabel(v: GateView, g: Gate): void {
    const c = v.canvas.getContext('2d')!;
    const info = REWARD_INFO[g.reward];
    c.clearRect(0, 0, v.canvas.width, v.canvas.height);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const hex = `#${info.color.toString(16).padStart(6, '0')}`;
    c.fillStyle = 'rgba(8,6,7,0.72)';
    c.fillRect(16, 10, 480, g.challenge ? 180 : 130);
    c.fillStyle = hex;
    c.fillRect(16, 10, 480, 5);
    c.font = '46px Future, sans-serif';
    c.fillStyle = hex;
    c.fillText(info.name, 256, 52);
    c.font = '22px Future, sans-serif';
    c.fillStyle = '#e8e2dc';
    c.fillText(info.sub, 256, 100);
    if (g.challenge) {
      const ch = CHALLENGE_INFO[g.challenge];
      c.font = '26px Future, sans-serif';
      c.fillStyle = '#ffe040';
      c.fillText(ch.name, 256, 140);
      c.font = '18px Future, sans-serif';
      c.fillStyle = '#d8d0c8';
      c.fillText(ch.sub, 256, 170);
    }
    v.tex.needsUpdate = true;
  }

  update(dt: number): void {
    this.time += dt;
    for (const v of this.views) {
      if (v.chosen > 0) {
        v.chosen -= dt;
        const k = Math.max(0, v.chosen / 0.8);
        v.fieldMat.opacity = 0.4 + (1 - k) * 0.6;
        v.root.scale.set(1 + (1 - k) * 0.15, 1 + (1 - k) * 0.15, 1);
        if (v.chosen <= 0) v.active = false;
      }
      v.fade = Math.max(0, Math.min(1, v.fade + (v.active ? dt * 2.5 : -dt * 4)));
      const shown = v.fade > 0.001 || v.chosen > 0;
      // rise out of the floor, sink back when done
      v.root.position.y = shown ? -4.6 * (1 - easeOut(v.fade)) : PARK_Y;
      if (v.chosen <= 0) {
        v.fieldMat.opacity = (0.32 + Math.sin(this.time * 3) * 0.08) * v.fade;
        v.root.scale.set(1, 1, 1);
      }
      (v.glow.material as THREE.SpriteMaterial).opacity = 0.5 * v.fade;
      (v.label.material as THREE.SpriteMaterial).opacity = v.fade;
    }
  }
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;
