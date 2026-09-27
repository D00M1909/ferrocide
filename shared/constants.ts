// Every gameplay number lives here so tuning never means hunting through code.

export const GAME_NAME = 'FERROCIDE';
export const SERVER_TICK = 30; // Hz simulation on the authority
export const SNAPSHOT_RATE = 20; // Hz snapshots to clients
export const PLAYER_SEND_RATE = 30; // Hz player state uploads
export const INTERP_DELAY = 0.1; // s of buffered interpolation for remote entities
export const MAX_PLAYERS = 2;

export const PLAYER = {
  maxHealth: 100,
  halfWidth: 0.4,
  height: 1.8,
  slideHeight: 0.9,
  eyeHeight: 1.62,
  slideEyeHeight: 0.75,
  stepHeight: 0.65,
  walkSpeed: 15,
  groundAccel: 110,
  groundFriction: 12,
  airAccel: 34,
  airMaxSpeed: 15,
  gravity: 34,
  jumpVelocity: 11.5,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  dashSpeed: 44,
  dashTime: 0.17,
  dashCost: 1,
  staminaMax: 3,
  staminaRegen: 0.85, // bars per second
  dashJumpBoost: 1.35, // horizontal multiplier when jumping out of a dash
  slideSpeed: 22,
  slideBoost: 4,
  slideJumpVertical: 0.85,
  slamSpeed: 70,
  slamBounceMax: 26,
  wallJumpVelocity: 12,
  wallJumpPush: 11,
  maxWallJumps: 3,
  wallSlideSpeed: 3.5,
  lavaDps: 32,
  lavaBounce: 14,
  respawnTime: 6,
  bloodHealRange: 6.5,
  bloodHealFactor: 0.4,
  hardDamageDelay: 1.2,
};

export type WeaponId = 'revolver' | 'shotgun' | 'launcher';
export const WEAPON_ORDER: WeaponId[] = ['revolver', 'shotgun', 'launcher'];

export const WEAPONS = {
  revolver: {
    name: 'PIERCER',
    damage: 32,
    headshotMult: 1.75,
    interval: 0.34,
    pierce: 3,
    coinCharges: 4,
    coinRegen: 1.6, // s per coin
    coinThrowSpeed: 11,
    coinUpSpeed: 9,
    coinLife: 2.4,
    ricochetMult: 1.5,
    coinHitRadius: 0.55,
  },
  shotgun: {
    name: 'SCATTERHAMMER',
    pellets: 11,
    pelletDamage: 9,
    spread: 0.11, // radians
    interval: 0.82,
    range: 60,
    coreCooldown: 2.8,
    coreSpeed: 26,
    coreFuse: 1.4,
    coreRadius: 5,
    coreDamage: 70,
    coreShotRadius: 8.5,
    coreShotDamage: 160,
  },
  launcher: {
    name: 'SLAGTHROWER',
    interval: 0.9,
    rocketSpeed: 42,
    directDamage: 70,
    splashDamage: 70,
    splashRadius: 5,
    selfKnockback: 17,
    selfDamage: 12,
    rocketLife: 4,
  },
} as const;

export const PUNCH = {
  damage: 22,
  interval: 0.42,
  range: 3.2,
  parryRange: 4.2,
  parryCone: 0.55, // dot threshold
  parrySpeed: 70,
  parryDamageMult: 4,
  parryHeal: 50,
  knockback: 14,
};

export const SLAM = {
  baseDamage: 30,
  damagePerMeter: 4,
  radius: 5.5,
};

export type EnemyKind = 'husk' | 'eye' | 'warden' | 'drone' | 'brute' | 'colossus';

export interface EnemyDef {
  name: string;
  hp: number;
  speed: number;
  radius: number;
  height: number;
  flying: boolean;
  headY: number; // head sphere centre height (relative to feet)
  headR: number;
  score: number; // style points on kill
  heavy: boolean;
}

export const ENEMIES: Record<EnemyKind, EnemyDef> = {
  husk: { name: 'HUSK', hp: 55, speed: 10.5, radius: 0.5, height: 1.9, flying: false, headY: 1.62, headR: 0.3, score: 60, heavy: false },
  eye: { name: 'GAZER', hp: 22, speed: 13, radius: 0.45, height: 0.9, flying: true, headY: 0.45, headR: 0.45, score: 40, heavy: false },
  warden: { name: 'WARDEN', hp: 120, speed: 6, radius: 0.8, height: 2.3, flying: false, headY: 1.9, headR: 0.45, score: 100, heavy: false },
  drone: { name: 'SENTRY DRONE', hp: 65, speed: 9, radius: 0.6, height: 1.1, flying: true, headY: 0.55, headR: 0.4, score: 90, heavy: false },
  brute: { name: 'BRUTE', hp: 520, speed: 5.5, radius: 1.5, height: 4.2, flying: false, headY: 3.5, headR: 0.8, score: 250, heavy: true },
  colossus: { name: 'THE FOUNDRY COLOSSUS', hp: 3200, speed: 4.2, radius: 2.6, height: 7.4, flying: false, headY: 6.2, headR: 1.3, score: 1500, heavy: true },
};

export const ENEMY_ATTACKS = {
  husk: { range: 2.4, windup: 0.38, recover: 0.55, damage: 18, lunge: 9 },
  eye: { range: 1.6, damage: 14, diveSpeed: 22, windup: 0.5 },
  warden: { windup: 0.7, cooldown: 2.4, orbSpeed: 17, orbDamage: 22, preferredMin: 13, preferredMax: 26 },
  drone: { windup: 0.55, cooldown: 2.6, burst: 3, burstGap: 0.14, boltSpeed: 38, boltDamage: 9 },
  brute: { stompWindup: 0.9, stompDamage: 26, waveSpeed: 17, waveRange: 26, mortarWindup: 0.8, mortarDamage: 30, mortarRadius: 4.5, cooldown: 2.6, meleeRange: 4.2, meleeDamage: 35 },
  colossus: { beamWindup: 1.3, beamTime: 2.2, beamDps: 70, beamSweep: 1.4, summonEvery: 14 },
};

export type ProjectileKind = 'orb' | 'bolt' | 'mortar' | 'reflected';

export const PROJECTILES: Record<ProjectileKind, { radius: number; gravity: number; parryable: boolean; life: number }> = {
  orb: { radius: 0.45, gravity: 0, parryable: true, life: 6 },
  bolt: { radius: 0.2, gravity: 0, parryable: false, life: 3 },
  mortar: { radius: 0.6, gravity: 20, parryable: true, life: 6 },
  reflected: { radius: 0.6, gravity: 0, parryable: false, life: 3 },
};

/** Style ranks — our own names, bottom to top. */
export const RANKS = [
  { letter: 'D', name: 'DENTED', color: '#8a8f99' },
  { letter: 'C', name: 'CRUDE', color: '#4fb3ff' },
  { letter: 'B', name: 'BUTCHER', color: '#48e07a' },
  { letter: 'A', name: 'ATROCITY', color: '#ffd23f' },
  { letter: 'S', name: 'SAVAGE', color: '#ff8a2a' },
  { letter: 'SS', name: 'SLAUGHTER', color: '#ff4a2a' },
  { letter: 'SSS', name: 'SCRAPSTORM', color: '#ff2255' },
  { letter: 'F', name: 'FERROCIDE', color: '#ffffff' },
];
