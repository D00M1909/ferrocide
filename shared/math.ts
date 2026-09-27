// Tiny allocation-light vector helpers shared by client and server.
// Plain objects keep the simulation free of any Three.js dependency.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const copy = (o: Vec3, a: Vec3): Vec3 => ((o.x = a.x), (o.y = a.y), (o.z = a.z), o);
export const clone = (a: Vec3): Vec3 => ({ x: a.x, y: a.y, z: a.z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const addScaled = (o: Vec3, a: Vec3, s: number): Vec3 => ((o.x += a.x * s), (o.y += a.y * s), (o.z += a.z * s), o);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const lenXZ = (a: Vec3): number => Math.hypot(a.x, a.z);
export const dist = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const distXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);
export const normalize = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const damp = (a: number, b: number, lambda: number, dt: number): number => lerp(a, b, 1 - Math.exp(-lambda * dt));

/** Forward direction from yaw (radians, 0 = -Z) and pitch. */
export function dirFromAngles(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Shortest signed angle difference b - a in radians. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Ray vs sphere; returns distance along the ray or -1. */
export function raySphere(o: Vec3, d: Vec3, c: Vec3, r: number): number {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const t0 = -b - s;
  if (t0 >= 0) return t0;
  const t1 = -b + s;
  return t1 >= 0 ? 0 : -1;
}

/** Closest distance between a point and a segment. */
export function pointSegmentDist(p: Vec3, a: Vec3, b: Vec3): number {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const l2 = abx * abx + aby * aby + abz * abz || 1e-9;
  const t = clamp(((p.x - a.x) * abx + (p.y - a.y) * aby + (p.z - a.z) * abz) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t), p.z - (a.z + abz * t));
}

/** Small deterministic PRNG (mulberry32) so waves are reproducible. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
