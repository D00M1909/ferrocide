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
  onRankChange: ((rank: number, up: boolean) => void) | null = null;
  private lastRank = 0;
  private time = 0;
  private nextId = 1;

  get rank(): number {
    return Math.min(RANKS.length - 1, Math.floor(this.meter / 100));
  }

  get progress(): number {
    return this.rank === RANKS.length - 1 ? 1 : (this.meter % 100) / 100;
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
    if (weapon) {
      const f = this.freshness.get(weapon) ?? 1.5;
      mult *= f;
      // the weapon you just used goes stale, the others recover
      for (const [w, v] of this.freshness) this.freshness.set(w, Math.min(1.5, v + 0.25));
      this.freshness.set(weapon, Math.max(0.5, f - 0.35));
    }
    const gain = pts * mult;
    this.meter = Math.min(RANKS.length * 100 - 1, this.meter + gain * Math.max(0.25, 0.7 - this.rank * 0.06));
    this.total += gain;
    this.feed.unshift({ id: this.nextId++, label: weapon && mult > 1.2 ? `${label} · FRESH` : label, pts: Math.round(gain), big, t: this.time });
    if (this.feed.length > 7) this.feed.pop();
    this.checkRank();
  }

  freshnessOf(weapon: string): number {
    return this.freshness.get(weapon) ?? 1.5;
  }

  /** Continuous trickle for damage dealt. */
  trickle(pts: number): void {
    this.meter = Math.min(RANKS.length * 100 - 1, this.meter + pts * Math.max(0.25, 0.65 - this.rank * 0.06));
    this.total += pts * 0.5;
    this.checkRank();
  }

  hurt(dmg: number): void {
    this.meter = Math.max(0, this.meter - dmg * 3.2);
    this.checkRank();
  }

  update(dt: number, inCombat: boolean): void {
    this.time += dt;
    if (inCombat) this.meter = Math.max(0, this.meter - dt * (4 + this.rank * 2.2));
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
    this.lastRank = 0;
  }
}

/** Final grade for a run (index into RANKS). */
export function finalGrade(stylePts: number, seconds: number, deaths: number, win: boolean): { letter: string; name: string; color: string } {
  const perMin = stylePts / Math.max(1, seconds / 60);
  let score = perMin / 300 - deaths * 0.8 + (win ? 1 : 0);
  score = Math.max(0, score);
  const idx = Math.min(RANKS.length - 1, Math.floor(score));
  return { letter: RANKS[idx].letter, name: RANKS[idx].name, color: RANKS[idx].color };
}
