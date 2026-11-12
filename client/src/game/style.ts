// The style meter: variety and aggression fill it, getting hit and repetition
// drain it. Kills with a "fresh" weapon are worth more than spamming one gun.
// The rank also drives music intensity.
import { RANKS } from '../../../shared/constants';

export interface StyleEntry {
  id: number;
  label: string;
  pts: number;
  big: boolean;
  t: number;
}

export class StyleMeter {
  meter = 0; // 0 .. RANKS.length * 100
  total = 0;
  feed: StyleEntry[] = [];
  private lastLabels: string[] = [];
  private freshness = new Map<string, number>(); // weapon -> 0.5..1.5
  private lastWeapon = '';
  onRankChange: ((rank: number, up: boolean) => void) | null = null;
  private lastRank = 0;
  private time = 0;
  private nextId = 1;
  private recent: { t: number; weapon: string; label: string }[] = []; // last few seconds of scoring, for variety

  get rank(): number {
    return Math.min(RANKS.length - 1, Math.floor(this.meter / 100));
  }

  get progress(): number {
    return this.rank === RANKS.length - 1 ? 1 : (this.meter % 100) / 100;
  }

  /**
   * How varied the last ~10 s of play was (0..1): different weapons and different tricks (parries,
   * airborne or slide kills...). The top ranks are capped by it, so spamming one gun at husks stalls.
   */
  get variety(): number {
    const weapons = new Set<string>(), tricks = new Set<string>();
    for (const r of this.recent) {
      if (r.weapon) weapons.add(r.weapon);
      if (r.label !== 'KILL') tricks.add(r.label);
    }
    return Math.min(1, Math.max(0, weapons.size - 1) * 0.3 + Math.min(tricks.size, 5) * 0.12);
  }

  /** Highest meter value the current variety allows: INFERNAL needs some, CATACLYSM more, FERROCIDE a lot. */
  private get ceiling(): number {
    const v = this.variety;
    return v >= 0.95 ? RANKS.length * 100 - 1 : v >= 0.75 ? 699 : v >= 0.4 ? 599 : 499;
  }

  /** @param weapon kills pass the weapon used so switching weapons is rewarded */
  add(label: string, pts: number, big = false, weapon?: string): void {
    let mult = 1;
    if (label !== 'KILL') {
      // repetition penalty for tricks: the same one over and over is worth less
      const repeats = this.lastLabels.filter((l) => l === label).length;
      mult = Math.max(0.35, 1 - repeats * 0.2);
      this.lastLabels.push(label);
      if (this.lastLabels.length > 8) this.lastLabels.shift();
    }
    if (weapon) mult *= this.freshnessOf(weapon);
    const gain = pts * mult;
    this.recent.push({ t: this.time, weapon: weapon ?? '', label });
    this.trimRecent();
    this.meter = Math.min(this.ceiling, this.meter + gain * this.gainFactor());
    this.total += gain;
    this.feed.unshift({ id: this.nextId++, label: weapon && mult > 1.2 ? `${label} · FRESH` : label, pts: Math.round(gain), big, t: this.time });
    if (this.feed.length > 7) this.feed.pop();
    this.checkRank();
  }

  /** Each rank is harder to push into than the last. */
  private gainFactor(): number {
    return 0.55 * 0.82 ** this.rank;
  }

  private trimRecent(): void {
    while (this.recent.length && this.time - this.recent[0].t > 10) this.recent.shift();
  }

  freshnessOf(weapon: string): number {
    return this.freshness.get(weapon) ?? 1.5;
  }

  /** Every point of damage a weapon deals makes it staler; idle weapons freshen back up. */
  noteDamage(weapon: string, dmg: number): void {
    this.freshness.set(weapon, Math.max(0.5, this.freshnessOf(weapon) - dmg * 0.006));
    this.lastWeapon = weapon;
  }

  /** Continuous trickle for damage dealt. */
  trickle(pts: number): void {
    this.meter = Math.min(this.ceiling, this.meter + pts * this.gainFactor() * 0.85);
    this.total += pts * 0.5;
    this.checkRank();
  }

  hurt(dmg: number): void {
    this.meter = Math.max(0, this.meter - dmg * 5);
    this.checkRank();
  }

  update(dt: number, inCombat: boolean): void {
    this.time += dt;
    for (const w of ['revolver', 'shotgun', 'launcher']) {
      if (w !== this.lastWeapon) this.freshness.set(w, Math.min(1.5, this.freshnessOf(w) + dt * 0.1));
    }
    this.trimRecent();
    if (inCombat) this.meter = Math.max(0, this.meter - dt * (5 + this.rank * 4));
    // lost variety drains a rank the play no longer earns
    if (this.meter > this.ceiling) this.meter = Math.max(this.ceiling, this.meter - dt * 30);
    else this.meter = Math.max(0, this.meter - dt * 14);
    this.feed = this.feed.filter((f) => this.time - f.t < 4);
    this.checkRank();
  }

  private checkRank(): void {
    const r = this.rank;
    if (r !== this.lastRank) {
      this.onRankChange?.(r, r > this.lastRank);
      this.lastRank = r;
    }
  }

  reset(): void {
    this.meter = 0;
    this.feed = [];
    this.lastLabels = [];
    this.recent = [];
    this.lastRank = 0;
  }
}

/**
 * Final grade for a run (index into RANKS), mostly about how far you got:
 *   progress  0..6    6 * (waves cleared / 8) ^ 0.7   (a win, or surviving past wave 8 in endless, counts as all 8)
 *   style     0..1.6  style per minute / 2400
 *   deaths    -0.4 each (on a loss the death that ended the run is free)
 * The rank is floor(sum); a loss can never reach the top rank. The last argument is the wave reached (info.wave).
 */
export function finalGrade(stylePts: number, seconds: number, deaths: number, win: boolean, wave = win ? 8 : 4): { letter: string; name: string; color: string } {
  const won = win || wave > 8;
  const cleared = won ? 8 : Math.max(0, Math.min(8, wave - 1));
  const perMin = stylePts / Math.max(1, seconds / 60);
  let score = 6 * (cleared / 8) ** 0.7 + Math.min(1.6, perMin / 2400) - 0.4 * Math.max(0, deaths - (win ? 0 : 1));
  if (!win) score = Math.min(score, 6.99);
  const idx = Math.max(0, Math.min(RANKS.length - 1, Math.floor(score)));
  return { letter: RANKS[idx].letter, name: RANKS[idx].name, color: RANKS[idx].color };
}
