// Every gameplay number lives here so tuning never means hunting through code.

export const GAME_NAME = 'FERROCIDE';
export const SERVER_TICK = 30; // Hz simulation on the authority
export const SNAPSHOT_RATE = 30; // Hz snapshots to clients (one per sim tick)
export const PLAYER_SEND_RATE = 30; // Hz player state uploads
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
  respawnTime: 10,
  bloodHealRange: 5,
  bloodHealFactor: 0.32,
  hardDamageFraction: 0.4, // share of every hit that can't be healed back right away
  hardDamageDelay: 2.0,
  hardDamageDecay: 12, // hp/s once the delay passes
  airSpeedCap: 38, // strafing can't accelerate you past this
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
    pellets: 12,
    pelletDamage: 11,
    spread: 0.095, // radians
    interval: 0.72,
    closeRange: 6, // point-blank bonus inside this distance
    closeMult: 1.45,
    staggerDamage: 60, // one blast this strong interrupts a light enemy's attack
    range: 60,
    coreCooldown: 2.8,
    coreSpeed: 26,
    coreFuse: 1.4,
    coreRadius: 4.5,
    coreDamage: 60,
    coreShotRadius: 6.5,
    coreShotDamage: 120,
    coreSelfDamage: 8,
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
    // alt fire: hold to steer rockets toward the crosshair, tap to airburst them
    guideTurnRate: 4.2, // rad/s
    guideMaxSpeed: 60,
    guideAccel: 30,
    guideHoldTime: 0.16, // alt held longer than this steers instead of detonating
    airburstRadiusMult: 1.35,
  },
} as const;

/** Health pickups: an option for players who fight at range and can't blood-heal. */
export const HEALTH_PICKUP = {
  radius: 1.4, // horizontal grab distance from the pickup's centre
  // a top-up, not a lifeline: cycling all eight perfectly yields ~4 hp/s (was ~11), so blood
  // healing up close stays the main way to survive
  small: { heal: 20, respawn: 45 },
  // big ones sit on the wall catwalks (reached by wall-jumping) and also burn off hard damage
  large: { heal: 50, respawn: 90 },
};

export const PUNCH = {
  damage: 22,
  interval: 0.36,
  range: 3.2,
  parryRange: 5,
  parryCone: 0.45, // dot threshold
  parryBuffer: 0.14, // a punch stays "live" this long, so a slightly early press still parries
  parryChainCd: 0.1, // a successful parry nearly resets the punch for parry chains
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

export type EnemyKind = 'husk' | 'eye' | 'warden' | 'drone' | 'brute' | 'colossus' | 'stalker';

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
  warden: { name: 'WARDEN', hp: 160, speed: 6, radius: 0.8, height: 2.3, flying: false, headY: 1.9, headR: 0.45, score: 100, heavy: false },
  drone: { name: 'SENTRY DRONE', hp: 65, speed: 9, radius: 0.6, height: 1.1, flying: true, headY: 0.55, headR: 0.4, score: 90, heavy: false },
  brute: { name: 'BRUTE', hp: 900, speed: 5.5, radius: 1.5, height: 4.2, flying: false, headY: 3.5, headR: 0.8, score: 250, heavy: true },
  colossus: { name: 'THE FOUNDRY COLOSSUS', hp: 4500, speed: 4.2, radius: 2.6, height: 7.4, flying: false, headY: 6.2, headR: 1.3, score: 1500, heavy: true },
  stalker: { name: 'STALKER', hp: 90, speed: 14, radius: 0.5, height: 2.1, flying: false, headY: 1.82, headR: 0.3, score: 110, heavy: false },
};

export const ENEMY_ATTACKS = {
  husk: { range: 2.6, windup: 0.42, recover: 0.55, damage: 18, lunge: 14, parryWindow: 0.3 },
  eye: { range: 1.6, damage: 14, diveSpeed: 22, windup: 0.5 },
  warden: { windup: 0.7, cooldown: 2.4, orbSpeed: 17, orbDamage: 22, preferredMin: 13, preferredMax: 26 },
  drone: { windup: 0.55, cooldown: 2.0, burst: 3, burstGap: 0.14, boltSpeed: 46, boltDamage: 9, lead: 0.6 },
  brute: { stompWindup: 0.9, stompDamage: 26, waveSpeed: 17, waveRange: 26, mortarWindup: 0.8, mortarDamage: 30, mortarRadius: 4.5, cooldown: 2.6, meleeRange: 4.2, meleeDamage: 35 },
  stalker: { range: 2.4, windup: 0.32, damage: 16, blinkEvery: 3.4, blinkDist: 3.5 },
  colossus: { beamWindup: 1.3, beamTime: 2.2, beamDps: 70, beamSweep: 1.4, summonEvery: 14, ringOrbs: 14, ringSpeed: 13 },
};

export type ProjectileKind = 'orb' | 'bolt' | 'mortar' | 'reflected';

export const PROJECTILES: Record<ProjectileKind, { radius: number; gravity: number; parryable: boolean; life: number }> = {
  orb: { radius: 0.45, gravity: 0, parryable: true, life: 6 },
  bolt: { radius: 0.25, gravity: 0, parryable: true, life: 3 },
  mortar: { radius: 0.6, gravity: 20, parryable: true, life: 6 },
  reflected: { radius: 0.6, gravity: 0, parryable: false, life: 3 },
};

/** Style ranks — FERROCIDE's own ladder (the HUD shows the word, not a letter). */
export const RANKS = [
  { letter: 'I', name: 'SCRAP', color: '#8a8f99' },
  { letter: 'II', name: 'IRON', color: '#9fb4c8' },
  { letter: 'III', name: 'STEEL', color: '#5fc8ff' },
  { letter: 'IV', name: 'CHROME', color: '#7dffb0' },
  { letter: 'V', name: 'MOLTEN', color: '#ffb03a' },
  { letter: 'VI', name: 'INFERNAL', color: '#ff5a2a' },
  { letter: 'VII', name: 'CATACLYSM', color: '#ff2255' },
  { letter: 'VIII', name: 'FERROCIDE', color: '#ffffff' },
];
