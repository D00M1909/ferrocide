// The style meter: variety and aggression fill it, getting hit and repetition
// drain it. The rank also drives music intensity.
import { RANKS } from '../../../shared/constants';

export interface StyleEntry {
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
  onRankChange: ((rank: number, up: boolean) => void) | null = null;
  private lastRank = 0;
  private time = 0;

  get rank(): number {
    return Math.min(RANKS.length - 1, Math.floor(this.meter / 100));
  }

  get progress(): number {
    return this.rank === RANKS.length - 1 ? 1 : (this.meter % 100) / 100;
  }

  add(label: string, pts: number, big = false): void {
    // repetition penalty: the same trick over and over is worth less
    const repeats = this.lastLabels.filter((l) => l === label).length;
    const mult = Math.max(0.35, 1 - repeats * 0.2);
    const gain = pts * mult;
    this.lastLabels.push(label);
    if (this.lastLabels.length > 8) this.lastLabels.shift();
    // higher ranks are harder to climb
    this.meter = Math.min(RANKS.length * 100 - 1, this.meter + gain * Math.max(0.18, 0.62 - this.rank * 0.06));
    this.total += gain;
    this.feed.unshift({ label, pts: Math.round(gain), big, t: this.time });
    if (this.feed.length > 7) this.feed.pop();
    this.checkRank();
  }

  /** Continuous trickle for damage dealt. */
  trickle(pts: number): void {
    this.meter = Math.min(RANKS.length * 100 - 1, this.meter + pts * Math.max(0.2, 0.6 - this.rank * 0.06));
    this.total += pts * 0.5;
    this.checkRank();
  }

  hurt(dmg: number): void {
    this.meter = Math.max(0, this.meter - dmg * 3.2);
    this.checkRank();
  }

  update(dt: number, inCombat: boolean): void {
    this.time += dt;
    if (inCombat) this.meter = Math.max(0, this.meter - dt * (5 + this.rank * 3.2));
    else this.meter = Math.max(0, this.meter - dt * 20);
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

/** Final letter grade for a run. */
export function finalGrade(stylePts: number, seconds: number, deaths: number, win: boolean): { letter: string; color: string } {
  const perMin = stylePts / Math.max(1, seconds / 60);
  let score = perMin / 300 - deaths * 0.8 + (win ? 1 : 0);
  score = Math.max(0, score);
  const idx = Math.min(RANKS.length - 1, Math.floor(score));
  return { letter: RANKS[idx].letter, color: RANKS[idx].color };
}
