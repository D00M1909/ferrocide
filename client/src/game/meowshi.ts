// In memory of Meowshi: an orange tabby with a green collar and a gold bell.
// He sits by the fire on the dais where every run begins and watches over whoever is fighting.
// He is scenery only: nothing can hurt him, and he never gets in the way.
import * as THREE from 'three';
import { psxify } from '../engine/psx';
import type { Audio } from '../engine/audio';

/** Where he sits: beside the north-west brazier, in view from the spawn point. */
export const MEOWSHI_POS = { x: -5.3, y: 1.2, z: -5.5 };
const SCALE = 1.5; // a little larger than life so he reads at PS1 resolution
const GREET_RANGE = 4.2;
const NAME_RANGE = 9;

function canvasTex(w: number, h: number, paint: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  paint(cv.getContext('2d')!);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  return t;
}

/** Orange tabby coat: warm ginger with darker bands that wrap around the body. */
function furTexture(): THREE.CanvasTexture {
  const t = canvasTex(32, 32, (c) => {
    c.fillStyle = '#e8892e';
    c.fillRect(0, 0, 32, 32);
    c.fillStyle = '#c4621a';
    for (let y = 2; y < 32; y += 6) {
      for (let x = 0; x < 32; x += 2) c.fillRect(x, y + Math.round(Math.sin(x * 0.9 + y) * 1.2), 2, 2);
    }
    c.fillStyle = '#f2a54c';
    for (let i = 0; i < 40; i++) c.fillRect((i * 13) % 32, (i * 7) % 32, 1, 1);
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function heartTexture(): THREE.CanvasTexture {
  const rows = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
  return canvasTex(7, 6, (c) => {
    rows.forEach((r, y) => [...r].forEach((ch, x) => {
      if (ch !== 'X') return;
      c.fillStyle = y === 1 && x === 1 ? '#ffd0d8' : '#ff4a6a';
      c.fillRect(x, y, 1, 1);
    }));
  });
}

function nameTexture(): THREE.CanvasTexture {
  const t = canvasTex(256, 64, (c) => {
    c.textAlign = 'center';
    c.font = '34px Future, monospace';
    c.lineWidth = 6;
    c.strokeStyle = '#1a0a04';
    c.strokeText('MEOWSHI', 128, 34);
    c.fillStyle = '#ffc878';
    c.fillText('MEOWSHI', 128, 34);
    c.font = '15px Future, monospace';
    c.lineWidth = 4;
    c.strokeText('KEEPER OF THE FLAME', 128, 56);
    c.fillStyle = '#e8e0d8';
    c.fillText('KEEPER OF THE FLAME', 128, 56);
  });
  t.magFilter = THREE.LinearFilter;
  return t;
}

export class Meowshi {
  readonly root = new THREE.Group();
  private head = new THREE.Group();
  private eyes: THREE.Mesh[] = [];
  private ears: THREE.Mesh[] = [];
  private tail: THREE.Group[] = [];
  private torso: THREE.Mesh;
  private bell: THREE.Mesh;
  private hearts: { s: THREE.Sprite; t: number; x: number }[] = [];
  private label: THREE.Sprite;
  private blinkIn = 2.5;
  private blink = 0; // seconds of blink left
  private blinkLen = 0.14;
  private earIn = 4;
  private ear = 0;
  private greetCd = 0;
  private wasNear = false;
  private headYaw = 0;
  private headPitch = 0;
  private local = new THREE.Vector3();

  constructor(scene: THREE.Scene) {
    const fur = psxify(new THREE.MeshLambertMaterial({ map: furTexture(), emissive: 0x3a1804 }));
    const white = psxify(new THREE.MeshLambertMaterial({ color: 0xf4ece0, emissive: 0x2a2622 }));
    const pink = psxify(new THREE.MeshLambertMaterial({ color: 0xe88a8a, emissive: 0x30100e }));
    const dark = new THREE.MeshBasicMaterial({ color: 0x0c0806 });
    const glint = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const collarMat = psxify(new THREE.MeshLambertMaterial({ color: 0x4f8a6a, emissive: 0x0c2418 }));
    const gold = psxify(new THREE.MeshLambertMaterial({ color: 0xf0c040, emissive: 0x6a4a08 }));

    const cat = new THREE.Group();
    cat.scale.setScalar(SCALE);
    this.root.add(cat);
    const add = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    // seated body: a pear-shaped torso leaning slightly forward over the front paws
    this.torso = add(cat, new THREE.SphereGeometry(0.13, 7, 6).scale(1, 1.45, 1.05), fur, 0, 0.19, -0.02);
    this.torso.rotation.x = 0.16;
    for (const sx of [-1, 1]) {
      add(cat, new THREE.SphereGeometry(0.085, 6, 5).scale(0.9, 1, 1.25), fur, 0.1 * sx, 0.08, -0.03); // haunches
      add(cat, new THREE.CylinderGeometry(0.028, 0.03, 0.2, 5), fur, 0.05 * sx, 0.1, 0.1); // front legs
      add(cat, new THREE.SphereGeometry(0.036, 5, 4).scale(1, 0.6, 1.3), white, 0.05 * sx, 0.018, 0.115); // white mittens
      add(cat, new THREE.SphereGeometry(0.034, 5, 4).scale(1, 0.6, 1.4), white, 0.115 * sx, 0.018, 0.06); // back toes
    }
    add(cat, new THREE.SphereGeometry(0.075, 6, 5).scale(1, 1.5, 0.5), white, 0, 0.22, 0.095); // white bib

    // collar and bell
    const collar = add(cat, new THREE.TorusGeometry(0.082, 0.02, 4, 8), collarMat, 0, 0.365, 0.02);
    collar.rotation.x = Math.PI / 2 - 0.25;
    this.bell = add(cat, new THREE.SphereGeometry(0.03, 6, 4), gold, 0, 0.335, 0.105);

    // head
    this.head.position.set(0, 0.46, 0.035);
    this.head.rotation.order = 'YXZ';
    cat.add(this.head);
    add(this.head, new THREE.SphereGeometry(0.115, 8, 6).scale(1.08, 0.9, 0.95), fur, 0, 0, 0);
    add(this.head, new THREE.SphereGeometry(0.058, 6, 5).scale(1.25, 0.8, 0.8), white, 0, -0.04, 0.083); // muzzle
    add(this.head, new THREE.SphereGeometry(0.02, 5, 4).scale(1, 0.9, 0.6), white, 0, -0.005, 0.105); // blaze up the nose
    add(this.head, new THREE.ConeGeometry(0.017, 0.022, 3).rotateX(Math.PI), pink, 0, -0.018, 0.133); // nose
    for (const sx of [-1, 1]) {
      // the big dark eyes from his photo
      const eye = add(this.head, new THREE.SphereGeometry(0.031, 6, 5).scale(1, 1.1, 0.5), dark, 0.05 * sx, 0.018, 0.092);
      add(eye, new THREE.BoxGeometry(0.009, 0.009, 0.004), glint, -0.008, 0.012, 0.015);
      this.eyes.push(eye);
      const earG = new THREE.ConeGeometry(0.045, 0.085, 4);
      const ear = add(this.head, earG, fur, 0.07 * sx, 0.115, -0.005);
      ear.rotation.set(-0.1, 0, -0.32 * sx);
      add(ear, new THREE.ConeGeometry(0.026, 0.055, 3), pink, 0, -0.008, 0.016);
      this.ears.push(ear);
    }

    // tail: a chain of segments curled round his side, the tip swaying
    let parent: THREE.Object3D = cat;
    for (let i = 0; i < 6; i++) {
      const seg = new THREE.Group();
      if (i === 0) { seg.position.set(0.02, 0.035, -0.14); seg.rotation.y = 2.2; }
      else seg.position.set(0, 0, 0.075);
      add(seg, new THREE.CylinderGeometry(0.022 - i * 0.0015, 0.024 - i * 0.0015, 0.085, 5).rotateX(Math.PI / 2), i === 5 ? white : fur, 0, 0, 0.04);
      parent.add(seg);
      parent = seg;
      this.tail.push(seg);
    }

    // hearts (pooled, always in the scene so their shader compiles behind the loading screen)
    const heartTex = heartTexture();
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: heartTex, transparent: true, opacity: 0, depthWrite: false, fog: false }));
      s.scale.set(0.3, 0.26, 1);
      s.position.set(0, 1, 0);
      this.root.add(s);
      this.hearts.push({ s, t: 0, x: 0 });
    }
    this.label = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTexture(), transparent: true, opacity: 0, depthWrite: false, fog: false }));
    this.label.scale.set(2.2, 0.55, 1);
    this.label.position.set(0, 1.45, 0);
    this.root.add(this.label);

    // a small bronze plate at his feet
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.03, 0.2), psxify(new THREE.MeshLambertMaterial({ color: 0x8a6a30, emissive: 0x2a1c06 })));
    plate.position.set(0, 0.015, 0.42);
    this.root.add(plate);

    this.root.position.set(MEOWSHI_POS.x, MEOWSHI_POS.y, MEOWSHI_POS.z);
    this.root.rotation.y = 0.6; // facing the middle of the dais, where the fight starts
    scene.add(this.root);
  }

  /**
   * @param viewer camera position (he follows it with his head)
   * @param audio pass null to keep him quiet (menus, pause)
   */
  update(dt: number, time: number, viewer: THREE.Vector3, audio: Audio | null): void {
    dt = Math.max(0, Math.min(0.1, dt));
    // look at whoever is watching
    this.local.copy(viewer);
    this.root.worldToLocal(this.local);
    const headY = this.head.position.y * SCALE;
    const flat = Math.hypot(this.local.x, this.local.z);
    const dist = Math.hypot(flat, this.local.y - headY);
    const wantYaw = Math.max(-1.35, Math.min(1.35, Math.atan2(this.local.x, this.local.z)));
    const wantPitch = Math.max(-0.75, Math.min(0.3, -Math.atan2(this.local.y - headY, Math.max(0.3, flat))));
    const k = 1 - Math.exp(-dt * 5);
    this.headYaw += (wantYaw - this.headYaw) * k;
    this.headPitch += (wantPitch - this.headPitch) * k;
    this.head.rotation.set(this.headPitch, this.headYaw, Math.sin(time * 0.7) * 0.04);

    // breathing, tail, ears
    this.torso.scale.set(1 + Math.sin(time * 2.1) * 0.02, 1, 1 + Math.sin(time * 2.1) * 0.03);
    for (let i = 1; i < this.tail.length; i++) {
      this.tail[i].rotation.y = 0.62 + Math.sin(time * 1.7 - i * 0.6) * 0.05 * i;
      this.tail[i].rotation.x = i > 3 ? -0.12 - Math.max(0, Math.sin(time * 1.7 - i * 0.6)) * 0.22 : 0;
    }
    this.earIn -= dt;
    if (this.earIn <= 0) { this.earIn = 2.5 + Math.random() * 5; this.ear = 0.22; }
    this.ear = Math.max(0, this.ear - dt);
    const flick = Math.sin((this.ear / 0.22) * Math.PI) * 0.35;
    this.ears[0].rotation.x = -0.1 - flick;
    this.ears[1].rotation.x = -0.1 - flick * 0.4;

    // blinking; a long slow blink when a friend is close
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) { this.blinkIn = 2.2 + Math.random() * 4; this.blinkLen = 0.14; this.blink = this.blinkLen; }
    this.blink = Math.max(0, this.blink - dt);
    const lid = this.blink > 0 ? 1 - Math.sin((1 - this.blink / this.blinkLen) * Math.PI) * 0.92 : 1;
    for (const e of this.eyes) e.scale.y = lid;

    // greeting: a meow, a jingle and a heart when you come and sit with him
    this.greetCd = Math.max(0, this.greetCd - dt);
    const near = dist < GREET_RANGE;
    if (near && audio && this.greetCd <= 0 && (!this.wasNear || this.greetCd === 0)) {
      this.greetCd = 9;
      this.blinkLen = 0.9;
      this.blink = this.blinkLen;
      this.blinkIn = 3;
      audio.meow(this.root.position);
      this.popHeart();
    }
    this.wasNear = near;
    this.bell.rotation.z = Math.sin(time * 9) * Math.min(1, Math.max(0, this.greetCd - 8)) * 0.6;

    for (const h of this.hearts) {
      const m = h.s.material as THREE.SpriteMaterial;
      if (h.t <= 0) { m.opacity = 0; continue; }
      h.t = Math.max(0, h.t - dt);
      const p = 1 - h.t / 1.6;
      h.s.position.set(h.x + Math.sin(p * 6) * 0.06, 0.95 + p * 0.9, 0);
      m.opacity = p < 0.15 ? p / 0.15 : Math.min(1, (1 - p) * 2.2);
      const s = 0.22 + Math.min(1, p * 5) * 0.1;
      h.s.scale.set(s, s * 0.86, 1);
    }

    const lm = this.label.material as THREE.SpriteMaterial;
    const want = dist < NAME_RANGE ? Math.min(1, (NAME_RANGE - dist) / 2.5) : 0;
    lm.opacity += (want - lm.opacity) * (1 - Math.exp(-dt * 6));
  }

  private popHeart(): void {
    const h = this.hearts.find((x) => x.t <= 0) ?? this.hearts[0];
    h.t = 1.6;
    h.x = (Math.random() - 0.5) * 0.3;
  }
}
