// "The Crucible" — the co-op arena. The level is a set of axis-aligned boxes so the
// exact same collision and raycast code runs in the browser and on the server.
import type { Vec3 } from './math';

export type Surface = 'floor' | 'metal' | 'stone' | 'grate' | 'crate' | 'wall' | 'pillar' | 'invisible';

export interface Box {
  min: Vec3;
  max: Vec3;
  surface: Surface;
}

export interface JumpPad {
  pos: Vec3; // centre on top surface
  radius: number;
  launch: Vec3;
}

export interface Zone {
  min: Vec3;
  max: Vec3;
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, surface: Surface): Box => ({
  min: { x: Math.min(x0, x1), y: Math.min(y0, y1), z: Math.min(z0, z1) },
  max: { x: Math.max(x0, x1), y: Math.max(y0, y1), z: Math.max(z0, z1) },
  surface,
});

export const ARENA_HALF = 36;
export const WALL_HEIGHT = 18;

function buildBoxes(): Box[] {
  const H = ARENA_HALF;
  const b: Box[] = [];
  // floor slab + outer walls (visible part) + tall invisible caps so nobody escapes
  b.push(box(-H - 4, -2, -H - 4, H + 4, 0, H + 4, 'floor'));
  b.push(box(-H - 2, 0, -H - 2, H + 2, WALL_HEIGHT, -H, 'wall'));
  b.push(box(-H - 2, 0, H, H + 2, WALL_HEIGHT, H + 2, 'wall'));
  b.push(box(-H - 2, 0, -H, -H, WALL_HEIGHT, H, 'wall'));
  b.push(box(H, 0, -H, H + 2, WALL_HEIGHT, H, 'wall'));
  b.push(box(-H - 2, WALL_HEIGHT, -H - 2, H + 2, 60, -H, 'invisible'));
  b.push(box(-H - 2, WALL_HEIGHT, H, H + 2, 60, H + 2, 'invisible'));
  b.push(box(-H - 2, WALL_HEIGHT, -H, -H, 60, H, 'invisible'));
  b.push(box(H, WALL_HEIGHT, -H, H + 2, 60, H, 'invisible'));

  // central dais with steps on every side
  b.push(box(-7, 0, -7, 7, 1.2, 7, 'stone'));
  for (const s of [1, -1]) {
    b.push(box(-3, 0, 7 * s, 3, 0.6, 9 * s, 'stone'));
    b.push(box(7 * s, 0, -3, 9 * s, 0.6, 3, 'stone'));
  }

  // four great pillars
  for (const sx of [1, -1]) for (const sz of [1, -1]) b.push(box(16 * sx - 1.5, 0, 16 * sz - 1.5, 16 * sx + 1.5, 14, 16 * sz + 1.5, 'pillar'));

  // corner towers (reached with jump pads or wall jumps)
  for (const sx of [1, -1]) for (const sz of [1, -1]) b.push(box(25 * sx, 0, 25 * sz, 36 * sx, 5.5, 36 * sz, 'metal'));

  // mid-wall catwalks
  b.push(box(-7, 3, 32, 7, 3.6, 36, 'grate'));
  b.push(box(-7, 3, -36, 7, 3.6, -32, 'grate'));
  b.push(box(32, 3, -7, 36, 3.6, 7, 'grate'));
  b.push(box(-36, 3, -7, -32, 3.6, 7, 'grate'));

  // cover: crates and barriers
  const crates: [number, number, number, number][] = [
    [8, -20, 2, 2], [10, -20, 1.2, 1.2], [-10, 18, 2, 2], [-12.2, 18, 1.4, 1.4], [21, 3, 2, 2],
    [-21, -3, 2, 2], [3, 22, 2, 2], [-3, -22, 2, 2], [26, -12, 1.6, 1.6], [-26, 12, 1.6, 1.6],
  ];
  for (const [x, z, s, h] of crates) b.push(box(x - s / 2, 0, z - s / 2, x + s / 2, h, z + s / 2, 'crate'));
  b.push(box(-14, 0, -4, -13, 1.3, 4, 'metal'));
  b.push(box(13, 0, -4, 14, 1.3, 4, 'metal'));
  b.push(box(-4, 0, 13, 4, 1.3, 14, 'metal'));
  b.push(box(-4, 0, -14, 4, 1.3, -13, 'metal'));
  return b;
}

export const BOXES: Box[] = buildBoxes();

export const JUMP_PADS: JumpPad[] = [
  ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({
    pos: { x: 21.5 * sx, y: 0, z: 21.5 * sz },
    radius: 1.4,
    launch: { x: 6 * sx, y: 21, z: 6 * sz },
  })),
  { pos: { x: 0, y: 1.2, z: 0 }, radius: 1.6, launch: { x: 0, y: 25, z: 0 } },
];

/** Molten slag channels: damage + bounce players standing in them. */
export const LAVA: Zone[] = [
  { min: { x: -31, y: -1, z: -5 }, max: { x: -23, y: 0.2, z: 5 } },
  { min: { x: 23, y: -1, z: -5 }, max: { x: 31, y: 0.2, z: 5 } },
];

/** Health pickup spots (pos = floor under the pickup). Small ones in the open ground ring,
 *  large ones on the four mid-wall catwalks. */
export const HEALTH_PICKUPS: { pos: Vec3; large: boolean }[] = [
  ...[[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([sx, sz]) => ({ pos: { x: 11 * sx, y: 0, z: 11 * sz }, large: false })),
  { pos: { x: 0, y: 3.6, z: 34 }, large: true },
  { pos: { x: 0, y: 3.6, z: -34 }, large: true },
  { pos: { x: 34, y: 3.6, z: 0 }, large: true },
  { pos: { x: -34, y: 3.6, z: 0 }, large: true },
];

export const PLAYER_SPAWNS: Vec3[] = [
  { x: -2.5, y: 1.2, z: 3 },
  { x: 2.5, y: 1.2, z: 3 },
];

/** Enemy spawn points: ground ring, tower tops (good for ranged), air. */
export const GROUND_SPAWNS: Vec3[] = [
  { x: 0, y: 0, z: -30 }, { x: 0, y: 0, z: 30 }, { x: -30, y: 0, z: -14 }, { x: 30, y: 0, z: 14 },
  { x: -30, y: 0, z: 16 }, { x: 30, y: 0, z: -16 }, { x: -16, y: 0, z: -30 }, { x: 16, y: 0, z: 30 },
  { x: 18, y: 0, z: -30 }, { x: -18, y: 0, z: 30 },
];
export const TOWER_SPAWNS: Vec3[] = [
  { x: 30, y: 5.5, z: 30 }, { x: -30, y: 5.5, z: 30 }, { x: 30, y: 5.5, z: -30 }, { x: -30, y: 5.5, z: -30 },
];
export const AIR_SPAWNS: Vec3[] = [
  { x: 0, y: 12, z: -26 }, { x: 0, y: 12, z: 26 }, { x: -26, y: 12, z: 0 }, { x: 26, y: 12, z: 0 },
];

export function inZone(p: Vec3, z: Zone): boolean {
  return p.x > z.min.x && p.x < z.max.x && p.z > z.min.z && p.z < z.max.z && p.y > z.min.y && p.y < z.max.y;
}

// ---------------------------------------------------------------- collision

const EPS = 1e-4;

function overlaps(px: number, py: number, pz: number, hx: number, hy: number, bx: Box): boolean {
  // pos is feet position; hy is full height
  return (
    px + hx > bx.min.x && px - hx < bx.max.x &&
    py + hy > bx.min.y && py < bx.max.y &&
    pz + hx > bx.min.z && pz - hx < bx.max.z
  );
}

export interface MoveResult {
  onGround: boolean;
  hitCeiling: boolean;
  wallNormal: Vec3 | null; // last horizontal wall touched this move
  groundSurface: Surface | null;
}

/**
 * Moves an upright box (half width hx, height hy, feet at pos) by vel*dt against the arena,
 * sliding along surfaces. Mutates pos and vel. stepHeight lets walkers climb small ledges.
 */
export function moveBody(pos: Vec3, vel: Vec3, dt: number, hx: number, hy: number, stepHeight: number, grounded: boolean): MoveResult {
  const res: MoveResult = { onGround: false, hitCeiling: false, wallNormal: null, groundSurface: null };
  const travel = Math.max(Math.abs(vel.x), Math.abs(vel.y), Math.abs(vel.z)) * dt;
  const steps = Math.max(1, Math.ceil(travel / 0.3));
  const h = dt / steps;
  for (let s = 0; s < steps; s++) {
    // vertical
    pos.y += vel.y * h;
    for (const b of BOXES) {
      if (!overlaps(pos.x, pos.y, pos.z, hx, hy, b)) continue;
      if (vel.y > 0) {
        pos.y = b.min.y - hy - EPS;
        vel.y = 0;
        res.hitCeiling = true;
      } else {
        pos.y = b.max.y;
        vel.y = 0;
        res.onGround = true;
        res.groundSurface = b.surface;
      }
    }
    // horizontal axes
    for (const axis of ['x', 'z'] as const) {
      const d = vel[axis] * h;
      if (d === 0) continue;
      pos[axis] += d;
      for (const b of BOXES) {
        if (!overlaps(pos.x, pos.y, pos.z, hx, hy, b)) continue;
        // try stepping up onto low ledges
        const rise = b.max.y - pos.y;
        if ((grounded || res.onGround) && rise > 0 && rise <= stepHeight && !blockedAt(pos.x, b.max.y + EPS, pos.z, hx, hy)) {
          pos.y = b.max.y + EPS;
          res.onGround = true;
          continue;
        }
        if (d > 0) pos[axis] = b.min[axis] - hx - EPS;
        else pos[axis] = b.max[axis] + hx + EPS;
        vel[axis] = 0;
        res.wallNormal = axis === 'x' ? { x: d > 0 ? -1 : 1, y: 0, z: 0 } : { x: 0, y: 0, z: d > 0 ? -1 : 1 };
      }
    }
  }
  if (!res.onGround) {
    // ground probe so standing still still reports grounded
    for (const b of BOXES) {
      if (overlaps(pos.x, pos.y - 0.06, pos.z, hx, hy, b) && pos.y >= b.max.y - 0.07) {
        if (vel.y <= 0.01) {
          res.onGround = true;
          res.groundSurface = b.surface;
          pos.y = b.max.y;
        }
      }
    }
  }
  return res;
}

export function blockedAt(x: number, y: number, z: number, hx: number, hy: number): boolean {
  for (const b of BOXES) if (overlaps(x, y, z, hx, hy, b)) return true;
  return false;
}

/** Finds a wall within reach of the body's sides (for wall jumping). */
export function wallContact(pos: Vec3, hx: number, hy: number, reach: number): Vec3 | null {
  const probes: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of probes) {
    if (blockedAt(pos.x + dx * reach, pos.y + 0.2, pos.z + dz * reach, hx, hy - 0.4)) return { x: -dx, y: 0, z: -dz };
  }
  return null;
}

/** Slab-method ray cast against every arena box. Returns hit distance and normal. */
export function raycastWorld(o: Vec3, d: Vec3, maxDist: number): { dist: number; normal: Vec3; surface: Surface } | null {
  let best = maxDist;
  let bestNormal: Vec3 | null = null;
  let bestSurface: Surface = 'floor';
  for (const b of BOXES) {
    if (b.surface === 'invisible') continue;
    let tmin = 0, tmax = best;
    let nAxis = -1, nSign = 0;
    let ok = true;
    for (let a = 0; a < 3; a++) {
      const k = a === 0 ? 'x' : a === 1 ? 'y' : 'z';
      const oo = o[k], dd = d[k];
      if (Math.abs(dd) < 1e-9) {
        if (oo < b.min[k] || oo > b.max[k]) { ok = false; break; }
        continue;
      }
      let t1 = (b.min[k] - oo) / dd, t2 = (b.max[k] - oo) / dd;
      let sign = -1;
      if (t1 > t2) { const t = t1; t1 = t2; t2 = t; sign = 1; }
      if (t1 > tmin) { tmin = t1; nAxis = a; nSign = sign; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) { ok = false; break; }
    }
    if (!ok || nAxis < 0) continue;
    if (tmin < best) {
      best = tmin;
      bestNormal = { x: nAxis === 0 ? nSign : 0, y: nAxis === 1 ? nSign : 0, z: nAxis === 2 ? nSign : 0 };
      bestSurface = b.surface;
    }
  }
  return bestNormal ? { dist: best, normal: bestNormal, surface: bestSurface } : null;
}

export function lineOfSight(a: Vec3, b: Vec3): boolean {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-3) return true;
  return !raycastWorld(a, { x: dx / l, y: dy / l, z: dz / l }, l - 0.05);
}
