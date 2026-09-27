// Autoplay: drives the real input path (?bot=1) so the game can be exercised
// headlessly for screenshots, soak tests and co-op smoke tests.
import * as THREE from 'three';
import { LAVA } from '../../../shared/arena';
import { angleDiff, type Vec3 } from '../../../shared/math';
import type { Action, Input } from '../engine/input';
import type { Enemies, EnemyView } from './enemies';
import type { Hazards } from './hazards';
import type { Weapons } from './weapons';

export interface BotView {
  pos: Vec3;
  eye: THREE.Vector3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  alive: boolean;
  enemies: Enemies;
  hazards: Hazards;
  weapons: Weapons;
}

export class Bot {
  private strafe = 1;
  private strafeT = 0;
  private coinT = 3;
  private coinPhase = 0;
  private weaponT = 0;
  private jumpT = 1;
  private target: EnemyView | null = null;
  private wanderT = 0;
  private wander = new THREE.Vector3();

  constructor(private input: Input) {
    input.virtual = { down: new Set(), pressed: new Set(), dx: 0, dy: 0 };
  }

  private press(a: Action): void {
    this.input.virtual!.pressed.add(a);
  }

  private hold(a: Action, on: boolean): void {
    const d = this.input.virtual!.down;
    if (on) d.add(a);
    else d.delete(a);
  }

  /** Returns the yaw/pitch the bot wants this frame. */
  update(dt: number, v: BotView): { yaw: number; pitch: number } {
    for (const a of ['forward', 'back', 'left', 'right', 'fire', 'slide', 'jump'] as Action[]) this.hold(a, false);
    if (!v.alive) return { yaw: v.yaw, pitch: v.pitch };

    // target selection (sticky)
    if (!this.target || this.target.dead || Math.random() < dt * 0.3) this.target = v.enemies.nearest(v.eye, 90);
    const t = this.target;
    let yaw = v.yaw, pitch = v.pitch;
    let aimErr = 1;
    let dist = 30;

    // coin trick: throw, wait, shoot the coin
    this.coinT -= dt;
    const coinAim = v.weapons.coinAimPoint();
    if (v.weapons.current === 'revolver' && this.coinT <= 0 && t) {
      if (this.coinPhase === 0 && v.weapons.coins > 0) { this.press('alt'); this.coinPhase = 1; }
      else if (this.coinPhase === 1 && coinAim) this.coinPhase = 2;
      if (this.coinPhase === 2 && !coinAim) { this.coinPhase = 0; this.coinT = 4 + Math.random() * 4; }
    }

    const aimAt = this.coinPhase === 2 && coinAim ? coinAim : t ? t.headPos().add(t.vel.clone().multiplyScalar(0.08)) : null;
    if (aimAt) {
      const d = aimAt.clone().sub(v.eye);
      dist = d.length();
      const wantYaw = Math.atan2(-d.x, -d.z);
      const wantPitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      const k = Math.min(1, dt * (this.coinPhase === 2 ? 22 : 9));
      yaw = v.yaw + angleDiff(v.yaw, wantYaw) * k;
      pitch = v.pitch + (wantPitch - v.pitch) * k;
      aimErr = Math.abs(angleDiff(yaw, wantYaw)) + Math.abs(wantPitch - pitch);
    } else {
      yaw = v.yaw + dt * 0.4;
      pitch *= 0.95;
    }

    // weapon choice
    this.weaponT -= dt;
    if (t && this.weaponT <= 0 && this.coinPhase === 0) {
      this.weaponT = 2 + Math.random() * 2;
      const want = t.def.heavy && dist > 9 ? 'launcher' : dist < 9 ? 'shotgun' : Math.random() < 0.25 ? 'launcher' : 'revolver';
      this.press(want === 'revolver' ? 'w1' : want === 'shotgun' ? 'w2' : 'w3');
    }
    const safeRocket = v.weapons.current !== 'launcher' || dist > 7;
    if (aimErr < (this.coinPhase === 2 ? 0.04 : 0.08) && safeRocket && (t || this.coinPhase === 2)) {
      this.hold('fire', true);
      if (this.coinPhase === 2) { this.coinPhase = 0; this.coinT = 4 + Math.random() * 4; }
    }
    if (v.weapons.current === 'shotgun' && t && dist > 12 && Math.random() < dt * 0.4) this.press('alt');

    // movement: circle-strafe at a comfortable range, avoid slag
    this.strafeT -= dt;
    if (this.strafeT <= 0) { this.strafe *= -1; this.strafeT = 1.2 + Math.random() * 2; }
    if (t) {
      const range = v.weapons.current === 'shotgun' ? 5 : 14;
      if (dist > range + 4) this.hold('forward', true);
      else if (dist < range - 3) this.hold('back', true);
      this.hold(this.strafe > 0 ? 'right' : 'left', true);
    } else {
      this.wanderT -= dt;
      if (this.wanderT <= 0) { this.wanderT = 3; this.wander.set((Math.random() - 0.5) * 30, 0, (Math.random() - 0.5) * 30); }
      this.hold('forward', true);
    }
    for (const z of LAVA) {
      const cx = (z.min.x + z.max.x) / 2, cz = (z.min.z + z.max.z) / 2;
      if (Math.hypot(v.pos.x - cx, v.pos.z - cz) < 8) {
        // steer away from the slag: face centre-ish by backing off
        this.hold('back', false);
        this.hold('forward', true);
        yaw = v.yaw + angleDiff(v.yaw, Math.atan2(v.pos.x, v.pos.z)) * Math.min(1, dt * 6);
      }
    }
    // dodge incoming fire, parry what we can
    const threat = v.hazards.nearestThreat(v.eye);
    if (threat < 6 && Math.random() < 0.5) this.press('dash');
    if (v.hazards.parryCandidates(v.eye, new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)), 3.5, 0.3).length) this.press('punch');
    if (t && dist < 3) this.press('punch');
    this.jumpT -= dt;
    if (this.jumpT <= 0) {
      this.jumpT = 0.8 + Math.random() * 2.5;
      this.press('jump');
      if (Math.random() < 0.3) this.hold('slide', true);
    }
    if (Math.random() < dt * 0.25 && v.grounded) this.hold('slide', true);
    return { yaw, pitch: Math.max(-1.4, Math.min(1.4, pitch)) };
  }
}
