// First-time hints during play. Each one is tied to the moment it matters (a yellow shot on its
// way, health running low) and is shown in the first two sessions it comes up, then never again.

const KEY = 'ferrocide.tips.v1';
/** Sessions in which a hint is shown before it is considered learned. */
const TIMES = 2;
/** Seconds between hints, so they never stack up mid-fight. */
const GAP = 10;

export class Tips {
  enabled = true;
  private seen: Record<string, number> = {};
  private session = new Set<string>();
  private cool = 3;

  constructor(private show: (text: string) => void) {
    try {
      this.seen = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, number>;
    } catch {
      /* storage unavailable: hints simply show again next time */
    }
  }

  update(dt: number): void {
    this.cool = Math.max(0, this.cool - dt);
  }

  /** Show a hint if it is still new to this player and nothing else was said just now. */
  offer(id: string, text: string): void {
    if (!this.enabled || this.cool > 0 || this.session.has(id) || (this.seen[id] ?? 0) >= TIMES) return;
    this.session.add(id);
    this.seen[id] = (this.seen[id] ?? 0) + 1;
    this.cool = GAP;
    this.show(text);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.seen));
    } catch {
      /* storage unavailable */
    }
  }
}
