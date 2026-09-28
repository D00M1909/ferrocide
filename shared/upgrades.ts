// Run upgrades: weapon variants (new alt-fires), frames, variant mods, and general
// movement/blood/co-op upgrades. Shared so the sim can validate forge picks and scale its
// anti-cheat caps, and the client can apply the effects.
import type { WeaponId } from './constants';

export type UpgradeCat = 'variant' | 'mod' | 'move' | 'blood' | 'coop';

export interface UpgradeDef {
  id: string;
  name: string;
  desc: string;
  cat: UpgradeCat;
  weapon?: WeaponId;
  /** Variant/frame this mod needs (any of them). */
  needs?: string[];
  /** Can't be offered alongside this upgrade. */
  excl?: string;
  coop?: boolean;
  rare?: boolean;
}

/** Alt-fire variants every run starts with (one per gun). */
export const DEFAULT_VARIANTS: Record<WeaponId, string> = { revolver: 'v_coin', shotgun: 'v_core', launcher: 'v_guide' };
/** A gun holds at most this many variants (its default included); press its number again to cycle. */
export const MAX_VARIANTS = 3;

export const UPGRADES: UpgradeDef[] = [
  // ---- default variants (never offered, listed for names)
  { id: 'v_coin', name: 'COIN TOSS', desc: 'Toss a coin, shoot it to ricochet into a head.', cat: 'variant', weapon: 'revolver' },
  { id: 'v_core', name: 'CORE EJECT', desc: 'Lob a core; shoot or punch it to detonate.', cat: 'variant', weapon: 'shotgun' },
  { id: 'v_guide', name: 'GUIDANCE', desc: 'Hold to steer rockets, tap to airburst them.', cat: 'variant', weapon: 'launcher' },

  // ---- new variants: they add a second alt-fire to the gun
  { id: 'v_beam', name: 'CHARGE BEAM', desc: 'PIERCER alt: hold, then release a beam that pierces every enemy in its path.', cat: 'variant', weapon: 'revolver' },
  { id: 'v_ricochet', name: 'SPINSHOT', desc: 'PIERCER alt: hold to spin up, release a shot that bounces off walls up to 3 times, harder each bounce.', cat: 'variant', weapon: 'revolver' },
  { id: 'v_pump', name: 'PUMP CHARGE', desc: 'SCATTERHAMMER alt: pump up to 3 times. More pellets per pump; the third pump blasts point-blank and launches you.', cat: 'variant', weapon: 'shotgun' },
  { id: 'v_freeze', name: 'FREEZEFRAME', desc: 'SLAGTHROWER alt: freeze your rockets mid-air. Fire more, then release them all at once.', cat: 'variant', weapon: 'launcher' },
  // a frame replaces the primary fire and works with any variant
  { id: 'f_hammer', name: 'JACKHAMMER', desc: 'SCATTERHAMMER primary becomes a hammer swing. The faster you move, the harder it hits.', cat: 'variant', weapon: 'shotgun', rare: true },

  // ---- variant mods
  { id: 'm_split', name: 'SPLIT COINS', desc: 'Coin ricochets strike two targets.', cat: 'mod', weapon: 'revolver', needs: ['v_coin'] },
  { id: 'm_overcharge', name: 'OVERCHARGE', desc: 'Keep holding the Charge Beam past full: double damage and it hurls enemies back.', cat: 'mod', weapon: 'revolver', needs: ['v_beam'] },
  { id: 'm_headhunter', name: 'HEADHUNTER', desc: 'Every Spinshot bounce curves toward the nearest head.', cat: 'mod', weapon: 'revolver', needs: ['v_ricochet'] },
  { id: 'm_pierce', name: 'PIERCING BUCKSHOT', desc: 'Shotgun pellets pass through the first enemy they hit.', cat: 'mod', weapon: 'shotgun', excl: 'f_hammer' },
  { id: 'm_hotcore', name: 'OVERCHARGED CORE', desc: 'A punched core detonates with a far bigger blast.', cat: 'mod', weapon: 'shotgun', needs: ['v_core'] },
  { id: 'm_valve', name: 'PRESSURE VALVE', desc: 'The overpump blast no longer hurts you and throws you much further.', cat: 'mod', weapon: 'shotgun', needs: ['v_pump'] },
  { id: 'm_momentum', name: 'MOMENTUM', desc: 'Jackhammer kills refund a dash.', cat: 'mod', weapon: 'shotgun', needs: ['f_hammer'] },
  { id: 'm_cluster', name: 'CLUSTER ROCKETS', desc: 'Rockets burst into three bomblets when they explode.', cat: 'mod', weapon: 'launcher' },
  { id: 'm_cold', name: 'COLD STORAGE', desc: 'Rockets held frozen for half a second hit 50% harder and wider.', cat: 'mod', weapon: 'launcher', needs: ['v_freeze'] },

  // ---- movement
  { id: 'g_wallrunner', name: 'WALL RUNNER', desc: '+2 wall jumps, and every wall jump refills half a dash.', cat: 'move' },
  { id: 'g_kinetic', name: 'KINETIC SLAM', desc: 'Ground slams hit twice as hard per metre fallen and launch enemies skyward.', cat: 'move' },
  { id: 'g_slideblade', name: 'SLIDE BLADE', desc: 'Sliding through enemies cuts them.', cat: 'move' },
  { id: 'g_afterburner', name: 'AFTERBURNER', desc: 'Dashing leaves a trail of burning slag.', cat: 'move' },
  { id: 'g_airkill', name: 'AIR KILL', desc: 'Kills while airborne refund a dash.', cat: 'move' },

  // ---- blood and defence
  { id: 'g_bloodthirst', name: 'BLOODTHIRST', desc: 'Blood heals from 50% further away, and 25% more.', cat: 'blood' },
  { id: 'g_parryrush', name: 'PARRY RUSH', desc: 'A parry refills your dashes and gives you a burst of speed.', cat: 'blood' },
  { id: 'g_rebound', name: 'REBOUND', desc: 'Ground slams that hit an enemy heal you 8.', cat: 'blood' },
  { id: 'g_ironhide', name: 'IRON HIDE', desc: 'Hard damage starts fading sooner and fades twice as fast.', cat: 'blood' },
  { id: 'g_styleengine', name: 'STYLE ENGINE', desc: '+15% damage while your style rank is MOLTEN or higher.', cat: 'blood', rare: true },

  // ---- co-op only
  { id: 'c_tether', name: 'BLOOD TETHER', desc: 'Your partner gets half of your blood heals while within 15 m.', cat: 'coop', coop: true },
  { id: 'c_rally', name: 'RALLY', desc: 'You revive your partner twice as fast, and they come back with 75 HP.', cat: 'coop', coop: true },
];

export const UPGRADE_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

/** Can this player be offered this upgrade? */
export function eligible(u: UpgradeDef, owned: readonly string[], coop: boolean): boolean {
  if (owned.includes(u.id)) return false;
  if (Object.values(DEFAULT_VARIANTS).includes(u.id)) return false;
  if (u.coop && !coop) return false;
  if (u.excl && owned.includes(u.excl)) return false;
  if (u.needs && !u.needs.some((n) => owned.includes(n))) return false;
  if (u.cat === 'variant' && u.weapon && u.id.startsWith('v_')) {
    const held = 1 + owned.filter((o) => o.startsWith('v_') && UPGRADE_BY_ID.get(o)?.weapon === u.weapon).length;
    if (held >= MAX_VARIANTS) return false;
  }
  // a mod that blocks an upgrade you own also stays out (piercing buckshot vs the hammer)
  if (u.id === 'f_hammer' && owned.includes('m_pierce')) return false;
  return true;
}

/** The variants a player holds for a gun: the default first, then new ones in the order gained. */
export function variantsOf(owned: readonly string[], w: WeaponId): string[] {
  return [DEFAULT_VARIANTS[w], ...owned.filter((o) => o.startsWith('v_') && o !== DEFAULT_VARIANTS[w] && UPGRADE_BY_ID.get(o)?.weapon === w)];
}
