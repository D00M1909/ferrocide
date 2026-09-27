// Snapshot buffer with a server-clock estimate so remote entities are rendered
// smoothly a fixed delay in the past, interpolating between known states.
import type { Snapshot } from '../../../shared/protocol';

export class SnapBuffer {
  private snaps: Snapshot[] = [];
  private offset: number | null = null; // localTime - serverTime estimate

  push(s: Snapshot, now: number): void {
    const sample = now - s.t;
    if (this.offset === null || sample < this.offset) this.offset = sample;
    else this.offset += (sample - this.offset) * 0.02; // drift slowly toward typical latency
    this.snaps.push(s);
    if (this.snaps.length > 40) this.snaps.shift();
  }

  get latest(): Snapshot | null {
    return this.snaps.length ? this.snaps[this.snaps.length - 1] : null;
  }

  clear(): void {
    this.snaps = [];
    this.offset = null;
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
