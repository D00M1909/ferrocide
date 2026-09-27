// Player locomotion: Quake-style ground/air acceleration plus the high-speed toolkit
// (dash, slide, slide-jump, ground slam, slam-bounce, wall jumps, jump pads).
import { JUMP_PADS, LAVA, inZone, moveBody, wallContact, type Surface } from './arena';
import { PLAYER } from './constants';
import { clamp, type Vec3 } from './math';

export interface MoveInput {
  forward: number; // -1..1
  strafe: number; // -1..1
  jumpPressed: boolean;
  jumpHeld: boolean;
  dashPressed: boolean;
  slideHeld: boolean;
  slidePressed: boolean;
  yaw: number;
}

export type MoveEvent =
  | { t: 'jump'; kind: 'normal' | 'slide' | 'dash' | 'slam' | 'wall' | 'coyote' }
  | { t: 'land'; speed: number; surface: Surface | null }
  | { t: 'dash' }
  | { t: 'slide' }
  | { t: 'slam' }
  | { t: 'slamland'; fall: number }
  | { t: 'pad' }
  | { t: 'lava' }
  | { t: 'step'; surface: Surface | null };

export class Motor {
  pos: Vec3 = { x: 0, y: 0, z: 0 };
  vel: Vec3 = { x: 0, y: 0, z: 0 };
  grounded = false;
  groundSurface: Surface | null = null;
  stamina: number = PLAYER.staminaMax;
  dashT = 0;
  dashDir: Vec3 = { x: 0, y: 0, z: -1 };
  sliding = false;
  slideDir: Vec3 = { x: 0, y: 0, z: -1 };
  slamming = false;
  slamStartY = 0;
  slamBounceT = 0;
  slamBounce = 0;
  wallJumps = 0;
  coyote = 0;
  jumpBuffer = 0;
  stepDist = 0;
  lavaT = 0;
  airTime = 0;
  events: MoveEvent[] = [];

  get dashing(): boolean {
    return this.dashT > 0;
  }

  get height(): number {
    return this.sliding ? PLAYER.slideHeight : PLAYER.height;
  }

  reset(p: Vec3): void {
    this.pos = { ...p };
    this.vel = { x: 0, y: 0, z: 0 };
    this.dashT = 0;
    this.sliding = false;
    this.slamming = false;
    this.stamina = PLAYER.staminaMax;
    this.wallJumps = 0;
  }

  impulse(v: Vec3): void {
    this.vel.x += v.x;
    this.vel.y += v.y;
    this.vel.z += v.z;
    if (v.y > 2) this.grounded = false;
    this.slamming = false;
  }

  step(inp: MoveInput, dt: number): void {
    const P = PLAYER;
    const fwd = { x: -Math.sin(inp.yaw), z: -Math.cos(inp.yaw) };
    const right = { x: Math.cos(inp.yaw), z: -Math.sin(inp.yaw) };
    let wx = fwd.x * inp.forward + right.x * inp.strafe;
    let wz = fwd.z * inp.forward + right.z * inp.strafe;
    const wl = Math.hypot(wx, wz);
    const hasWish = wl > 0.01;
    if (hasWish) { wx /= wl; wz /= wl; }

    if (inp.jumpPressed) this.jumpBuffer = P.jumpBuffer;
    else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    this.slamBounceT = Math.max(0, this.slamBounceT - dt);
    if (!this.dashing) this.stamina = Math.min(P.staminaMax, this.stamina + P.staminaRegen * dt);

    // ---- dash
    if (inp.dashPressed && this.stamina >= P.dashCost && !this.dashing) {
      this.stamina -= P.dashCost;
      this.dashT = P.dashTime;
      this.dashDir = hasWish ? { x: wx, y: 0, z: wz } : { x: fwd.x, y: 0, z: fwd.z };
      this.sliding = false;
      this.slamming = false;
      this.events.push({ t: 'dash' });
    }

    // ---- slam (slide key pressed in the air)
    if (inp.slidePressed && !this.grounded && !this.slamming && !this.dashing) {
      this.slamming = true;
      this.slamStartY = this.pos.y;
      this.vel.x *= 0.1;
      this.vel.z *= 0.1;
      this.vel.y = -P.slamSpeed;
      this.events.push({ t: 'slam' });
    }

    // ---- slide
    if (inp.slideHeld && this.grounded && !this.sliding && !this.dashing && !this.slamming) {
      this.sliding = true;
      this.slideDir = hasWish ? { x: wx, y: 0, z: wz } : { x: fwd.x, y: 0, z: fwd.z };
      const cur = Math.hypot(this.vel.x, this.vel.z);
      const sp = Math.max(cur, P.slideSpeed) + P.slideBoost * 0.25;
      this.vel.x = this.slideDir.x * sp;
      this.vel.z = this.slideDir.z * sp;
      this.events.push({ t: 'slide' });
    }
    if (this.sliding && (!inp.slideHeld || this.dashing)) this.sliding = false;

    // ---- jumping (ground / coyote / slam-bounce / dash / slide)
    const canGroundJump = this.grounded || this.coyote > 0;
    if (this.jumpBuffer > 0 && canGroundJump && !this.slamming) {
      this.jumpBuffer = 0;
      this.coyote = 0;
      let kind: 'normal' | 'slide' | 'dash' | 'slam' | 'coyote' = this.grounded ? 'normal' : 'coyote';
      if (this.slamBounceT > 0) {
        this.vel.y = this.slamBounce;
        this.slamBounceT = 0;
        kind = 'slam';
      } else if (this.dashing) {
        const sp = P.walkSpeed * 1.4 * P.dashJumpBoost;
        this.vel.x = this.dashDir.x * sp;
        this.vel.z = this.dashDir.z * sp;
        this.vel.y = P.jumpVelocity * 0.8;
        this.dashT = 0;
        kind = 'dash';
      } else if (this.sliding) {
        const sp = Math.max(Math.hypot(this.vel.x, this.vel.z), P.slideSpeed);
        this.vel.x = this.slideDir.x * sp;
        this.vel.z = this.slideDir.z * sp;
        this.vel.y = P.jumpVelocity * P.slideJumpVertical;
        kind = 'slide';
      } else {
        this.vel.y = P.jumpVelocity;
      }
      this.sliding = false;
      this.grounded = false;
      this.events.push({ t: 'jump', kind });
    } else if (this.jumpBuffer > 0 && !this.grounded && !this.slamming && this.wallJumps < P.maxWallJumps) {
      const wall = wallContact(this.pos, P.halfWidth, this.height, 0.35);
      if (wall) {
        this.jumpBuffer = 0;
        this.wallJumps++;
        const push = P.wallJumpPush;
        this.vel.x = wall.x * push + (hasWish ? wx * 5 : 0);
        this.vel.z = wall.z * push + (hasWish ? wz * 5 : 0);
        this.vel.y = P.wallJumpVelocity;
        this.dashT = 0;
        this.events.push({ t: 'jump', kind: 'wall' });
      }
    }

    // ---- horizontal control
    if (this.dashing) {
      this.dashT -= dt;
      this.vel.x = this.dashDir.x * P.dashSpeed;
      this.vel.z = this.dashDir.z * P.dashSpeed;
      this.vel.y = 0;
      if (this.dashT <= 0) {
        this.vel.x = this.dashDir.x * P.walkSpeed * 1.15;
        this.vel.z = this.dashDir.z * P.walkSpeed * 1.15;
      }
    } else if (this.slamming) {
      // committed: no steering during a slam
    } else if (this.sliding) {
      // slides keep their speed; light steering toward the wish direction
      const sp = Math.max(P.slideSpeed, Math.hypot(this.vel.x, this.vel.z) - 4 * dt);
      if (hasWish) {
        const t = Math.min(1, 1.6 * dt);
        this.slideDir.x += (wx - this.slideDir.x) * t;
        this.slideDir.z += (wz - this.slideDir.z) * t;
        const l = Math.hypot(this.slideDir.x, this.slideDir.z) || 1;
        this.slideDir.x /= l;
        this.slideDir.z /= l;
      }
      this.vel.x = this.slideDir.x * sp;
      this.vel.z = this.slideDir.z * sp;
    } else if (this.grounded) {
      const speed = Math.hypot(this.vel.x, this.vel.z);
      if (speed > 0) {
        const drop = speed * P.groundFriction * dt;
        const ns = Math.max(0, speed - drop) / speed;
        this.vel.x *= ns;
        this.vel.z *= ns;
      }
      if (hasWish) this.accelerate(wx, wz, P.walkSpeed, P.groundAccel, dt);
    } else if (hasWish) {
      const before = Math.hypot(this.vel.x, this.vel.z);
      this.accelerate(wx, wz, P.airMaxSpeed, P.airAccel, dt);
      // air strafing can redirect momentum but not farm unlimited speed
      const after = Math.hypot(this.vel.x, this.vel.z);
      const cap = Math.max(before, P.airSpeedCap);
      if (after > cap) { this.vel.x *= cap / after; this.vel.z *= cap / after; }
    }

    // ---- gravity + wall slide
    if (!this.dashing) {
      this.vel.y -= P.gravity * dt;
      if (!this.grounded && !this.slamming && this.vel.y < -P.wallSlideSpeed && hasWish) {
        const wall = wallContact(this.pos, P.halfWidth, this.height, 0.12);
        if (wall && wall.x * wx + wall.z * wz < -0.3) this.vel.y = -P.wallSlideSpeed;
      }
    }

    // ---- integrate
    const wasGrounded = this.grounded;
    const fallSpeed = -this.vel.y;
    const res = moveBody(this.pos, this.vel, dt, P.halfWidth, this.height, P.stepHeight, this.grounded && !this.slamming && this.vel.y <= 0);
    this.grounded = res.onGround && this.vel.y <= 0.01;
    this.groundSurface = res.groundSurface;
    if (this.grounded) {
      this.coyote = P.coyoteTime;
      this.wallJumps = 0;
      if (!wasGrounded) {
        if (this.slamming) {
          const fall = Math.max(0, this.slamStartY - this.pos.y);
          this.slamming = false;
          this.slamBounce = Math.min(P.slamBounceMax, 13 + fall * 1.4);
          this.slamBounceT = 0.22;
          this.events.push({ t: 'slamland', fall });
        } else {
          this.events.push({ t: 'land', speed: fallSpeed, surface: res.groundSurface });
        }
        this.airTime = 0;
      }
      const hs = Math.hypot(this.vel.x, this.vel.z);
      if (!this.sliding && hs > 2) {
        this.stepDist += hs * dt;
        if (this.stepDist > 2.6) {
          this.stepDist = 0;
          this.events.push({ t: 'step', surface: res.groundSurface });
        }
      }
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
      this.airTime += dt;
      if (this.sliding) this.sliding = false;
    }

    // ---- jump pads
    for (const pad of JUMP_PADS) {
      const dx = this.pos.x - pad.pos.x, dz = this.pos.z - pad.pos.z;
      if (dx * dx + dz * dz < pad.radius * pad.radius && Math.abs(this.pos.y - pad.pos.y) < 0.35 && this.vel.y <= 0.5) {
        this.vel.x = this.vel.x * 0.3 + pad.launch.x;
        this.vel.z = this.vel.z * 0.3 + pad.launch.z;
        this.vel.y = pad.launch.y;
        this.grounded = false;
        this.slamming = false;
        this.sliding = false;
        this.coyote = 0;
        this.wallJumps = 0;
        this.events.push({ t: 'pad' });
      }
    }

    // ---- molten slag
    this.lavaT = Math.max(0, this.lavaT - dt);
    if (LAVA.some((z) => inZone(this.pos, z)) && this.pos.y < 0.3) {
      if (this.lavaT <= 0) {
        this.lavaT = 0.25;
        this.events.push({ t: 'lava' });
      }
      if (this.grounded) {
        this.vel.y = P.lavaBounce;
        this.grounded = false;
      }
    }
    this.vel.y = clamp(this.vel.y, -120, 60);
  }

  private accelerate(wx: number, wz: number, maxSpeed: number, accel: number, dt: number): void {
    const cur = this.vel.x * wx + this.vel.z * wz;
    const add = maxSpeed - cur;
    if (add <= 0) return;
    const a = Math.min(add, accel * dt * maxSpeed / 10);
    this.vel.x += wx * a;
    this.vel.z += wz * a;
  }
}
