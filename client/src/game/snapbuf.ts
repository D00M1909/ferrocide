// Snapshot buffer with a server-clock estimate so remote entities are rendered
// smoothly a little in the past, interpolating between known states. The
// interpolation delay adapts to measured arrival jitter.
import type { Snapshot } from '../../../shared/protocol';

export class SnapBuffer {
  private snaps: Snapshot[] = [];
  private offset: number | null = null; // localTime - serverTime estimate
  private lastArrival = 0;
  private gapMean = 1 / 30;
  private gapVar = 0;

  push(s: Snapshot, now: number): void {
    const sample = now - s.t;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02; // drift slowly toward typical latency
    if (this.lastArrival > 0) {
      const gap = Math.min(1, now - this.lastArrival);
      const d = gap - this.gapMean;
      this.gapMean += d * 0.05;
      this.gapVar += (d * d - this.gapVar) * 0.05;
    }
    this.lastArrival = now;
    this.snaps.push(s);
    if (this.snaps.length > 60) this.snaps.shift();
  }

  /** Interpolation delay: mean snapshot gap + 2.5σ of jitter, bounded. */
  get delay(): number {
    return Math.max(0.045, Math.min(0.3, this.gapMean + 2.5 * Math.sqrt(this.gapVar) + 0.012));
  }

  /** Typical time between snapshots (for staleness checks). */
  get gap(): number {
    return this.gapMean + 3 * Math.sqrt(this.gapVar);
  }

  get latest(): Snapshot | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }

  clear(): void {
    this.snaps = [];
    this.offset = null;
    this.lastArrival = 0;
  }

  /** Returns the two snapshots around render time and the blend factor. */
  sample(now: number, delay: number): { a: Snapshot; b: Snapshot; t: number } | null {
    if (!this.snaps.length || this.offset === null) return null;
    const rt = now - this.offset - delay;
    const s = this.snaps;
    if (rt <= s[0].t) return { a: s[0], b: s[0], t: 0 };
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].t <= rt) {
        const a = s[i - 1], b = s[i];
        const span = b.t - a.t;
        const t = span > 0 ? Math.min(1.25, (rt - a.t) / span) : 1;
        return { a, b, t };
      }
    }
    const last = s[s.length - 1];
    return { a: last, b: last, t: 0 };
  }

  /** Estimated current server time. */
  serverNow(now: number): number {
    return this.offset === null ? 0 : now - this.offset;
  }
}
