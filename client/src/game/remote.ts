// The other player: the Quaternius hazmat character, tinted per player,
// interpolated from snapshots, animated from its movement flags, with a nameplate.
import * as THREE from 'three';
import { angleDiff } from '../../../shared/math';
import { PF, type PlayerSnap } from '../../../shared/protocol';
import { ensurePartnerModel, hasModel, instance, playClip, type ModelInstance } from '../engine/assets';

function nameplate(text: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 48;
  const ctx = c.getContext('2d')!;
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 6, 256, 36);
  ctx.fillStyle = '#ffc03a';
  ctx.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true, fog: false }));
  s.scale.set(1.6, 0.3, 1);
  s.renderOrder = 20;
  return s;
}

export class RemotePlayer {
  inst: ModelInstance;
  pos = new THREE.Vector3();
  yaw = 0;
  flags = 0;
  hp = 100;
  alive = true;
  connected = true;
  revive = 0;
  deathPos = new THREE.Vector3();
  private reviveRing: THREE.Mesh;
  private reviveFill: THREE.Mesh;
  private anim: THREE.AnimationAction | null = null;
  private mode = '';
  private tag: THREE.Sprite;
  private marker: THREE.Sprite;
  private disposed = false;

  private buildModel(): ModelInstance {
    return instance('character_hazmat', { height: 1.8, hue: 0, sat: 1.1, bright: 1.05, emissive: new THREE.Color(0x1a1000), rim: new THREE.Color(0xffc040) });
  }

  constructor(public id: string, public name: string, private scene: THREE.Scene, glow: THREE.Texture) {
    this.inst = this.buildModel();
    scene.add(this.inst.root);
    // the partner model is fetched on demand: until it arrives a stand-in box is shown, then swapped
    if (!hasModel('character_hazmat')) void ensurePartnerModel().then(() => this.upgradeModel());
    this.tag = nameplate(name);
    this.tag.position.y = 2.25;
    this.inst.root.add(this.tag);
    // through-wall marker so partners can always find each other
    this.marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffc03a, depthTest: false, transparent: true, blending: THREE.AdditiveBlending, fog: false }));
    this.marker.scale.setScalar(0.5);
    this.marker.position.y = 2.55;
    this.marker.renderOrder = 20;
    this.inst.root.add(this.marker);
    // downed partner: a cyan revive circle on the corpse that fills while you stand in it
    this.reviveRing = new THREE.Mesh(
      new THREE.RingGeometry(2.7, 3, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x40e0ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.reviveFill = new THREE.Mesh(
      new THREE.CircleGeometry(2.7, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0x40e0ff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.reviveRing.visible = this.reviveFill.visible = false;
    scene.add(this.reviveRing, this.reviveFill);
  }

  /** Swaps the stand-in for the real character once its file has arrived. */
  private upgradeModel(): void {
    if (this.disposed || !hasModel('character_hazmat')) return;
    const old = this.inst;
    const fresh = this.buildModel();
    fresh.root.position.copy(old.root.position);
    fresh.root.rotation.copy(old.root.rotation);
    fresh.root.visible = old.root.visible;
    fresh.root.add(this.tag, this.marker);
    this.scene.remove(old.root);
    this.scene.add(fresh.root);
    this.inst = fresh;
    this.anim = null;
    this.mode = '';
  }

  apply(a: PlayerSnap | undefined, b: PlayerSnap, t: number): void {
    const p = a ?? b;
    this.pos.set(p[1] + (b[1] - p[1]) * t, p[2] + (b[2] - p[2]) * t, p[3] + (b[3] - p[3]) * t);
    this.yaw = p[7] + angleDiff(p[7], b[7]) * t;
    this.flags = b[9];
    this.hp = b[11];
    this.alive = b[12] === 1;
    this.connected = b[14] !== 0;
    this.revive = b[15] ?? 0;
    this.deathPos.set(b[16] ?? 0, b[17] ?? 0, b[18] ?? 0);
  }

  update(dt: number, speed: number): void {
    const r = this.inst.root;
    r.visible = this.alive && this.connected;
    const down = !this.alive && this.connected;
    this.reviveRing.visible = this.reviveFill.visible = down;
    if (down) {
      this.reviveRing.position.set(this.deathPos.x, this.deathPos.y + 0.08, this.deathPos.z);
      this.reviveFill.position.copy(this.reviveRing.position);
      this.reviveFill.scale.setScalar(Math.max(0.02, this.revive));
      this.reviveRing.rotation.y += dt * 1.5;
    }
    r.position.copy(this.pos);
    r.rotation.y = this.yaw + Math.PI;
    this.inst.mixer?.update(dt);
    let mode = 'Idle';
    if (!(this.flags & PF.grounded)) mode = 'Jump_Idle';
    else if (this.flags & PF.sliding) mode = 'Duck';
    else if (speed > 1.5) mode = this.flags & PF.firing ? 'Run_Shoot' : 'Run_Gun';
    else if (this.flags & PF.firing) mode = 'Idle_Shoot';
    if (mode !== this.mode) {
      this.mode = mode;
      this.anim = playClip(this.inst, [mode, 'Run', 'Idle'], { current: this.anim, fade: 0.12, speed: mode.startsWith('Run') ? Math.min(2, 0.6 + speed / 14) : 1 });
    }
    r.rotation.z = this.flags & PF.dashing ? 0.25 : 0;
  }

  dispose(): void {
    this.disposed = true;
    this.scene.remove(this.inst.root, this.reviveRing, this.reviveFill);
  }
}

/**
 * Loads the partner model if needed and compiles its shaders now (in the world scene, without drawing),
 * so the partner's first appearance doesn't stall the frame. Call it when a co-op session starts.
 */
export async function warmPartner(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
  await ensurePartnerModel();
  if (!hasModel('character_hazmat')) return;
  const warm = new RemotePlayer('warm', 'WARM', scene, new THREE.Texture());
  try {
    await gl.compileAsync(scene, camera);
  } finally {
    warm.dispose();
  }
}
