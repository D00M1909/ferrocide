// Keyboard + mouse state with edge detection, pointer lock, and a programmatic
// override path so the autoplay bot can drive the exact same code paths.
// Presses are latched until the game consumes them, so a tap is never lost
// between physics steps or during hitstop.

export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'dash' | 'slide' | 'fire' | 'alt' | 'punch'
  | 'w1' | 'w2' | 'w3' | 'next' | 'prev' | 'last' | 'pause' | 'scores';

const BINDINGS: Record<string, Action> = {
  KeyW: 'forward', ArrowUp: 'forward',
  KeyS: 'back', ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'dash', ShiftRight: 'dash',
  KeyC: 'slide', ControlLeft: 'slide',
  KeyF: 'punch', KeyV: 'punch',
  Digit1: 'w1', Digit2: 'w2', Digit3: 'w3',
  KeyQ: 'last',
  Escape: 'pause',
  Tab: 'scores',
};

/** Movement actions whose presses are latched until a physics step uses them. */
export const LATCHED: Action[] = ['jump', 'dash', 'slide'];

export class Input {
  private down = new Set<Action>();
  private pressed = new Set<Action>();
  private latched = new Map<Action, number>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;
  enabled = false;
  /** When set, a bot writes into these instead of the real devices. */
  virtual: { down: Set<Action>; pressed: Set<Action>; dx: number; dy: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      const a = BINDINGS[e.code];
      // while playing, swallow browser shortcuts on game keys (Ctrl+W/S/D, Space scroll, Tab focus...)
      if (this.locked && (a || e.ctrlKey || e.metaKey)) e.preventDefault();
      if (!a) return;
      if (a === 'scores') e.preventDefault();
      if (!this.down.has(a)) {
        this.pressed.add(a);
        if (LATCHED.includes(a)) this.latched.set(a, performance.now());
      }
      this.down.add(a);
    });
    window.addEventListener('keyup', (e) => {
      const a = BINDINGS[e.code];
      if (a) this.down.delete(a);
    });
    window.addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      const a: Action | null = e.button === 0 ? 'fire' : e.button === 2 ? 'alt' : e.button === 1 || e.button === 3 ? 'punch' : null;
      if (!a) return;
      if (!this.down.has(a)) this.pressed.add(a);
      this.down.add(a);
    });
    window.addEventListener('mouseup', (e) => {
      const a: Action | null = e.button === 0 ? 'fire' : e.button === 2 ? 'alt' : e.button === 1 || e.button === 3 ? 'punch' : null;
      if (a) this.down.delete(a);
    });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      this.pressed.add(e.deltaY > 0 ? 'next' : 'prev');
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.down.clear(); this.latched.clear(); }
    });
  }

  /** Pointer lock + (best effort) fullscreen keyboard lock so Ctrl+W can't close the tab mid-slide. */
  requestLock(): void {
    if (this.virtual) return;
    const c = this.canvas as HTMLCanvasElement & { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void };
    try {
      const r = c.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => c.requestPointerLock());
    } catch {
      c.requestPointerLock();
    }
    const nav = navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void> } };
    if (document.fullscreenElement && nav.keyboard) void nav.keyboard.lock(['KeyW', 'KeyS', 'KeyD', 'ControlLeft']).catch(() => undefined);
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(a: Action): boolean {
    if (this.virtual) return this.virtual.down.has(a);
    return this.enabled && this.down.has(a);
  }

  wasPressed(a: Action): boolean {
    if (this.virtual) return this.virtual.pressed.has(a);
    return this.enabled && this.pressed.has(a);
  }

  /** Returns and clears a latched movement press (jump/dash/slide). */
  consume(a: Action): boolean {
    if (this.virtual) {
      const had = this.virtual.pressed.has(a);
      this.virtual.pressed.delete(a);
      return had;
    }
    const t = this.latched.get(a);
    this.latched.delete(a);
    // a press stays valid for 200 ms: long enough to bridge frames/hitstop, short enough not to feel sticky
    return this.enabled && t !== undefined && performance.now() - t < 200;
  }

  consumeMouse(): [number, number] {
    if (this.virtual) {
      const r: [number, number] = [this.virtual.dx, this.virtual.dy];
      this.virtual.dx = this.virtual.dy = 0;
      return r;
    }
    const r: [number, number] = this.enabled ? [this.mouseDX, this.mouseDY] : [0, 0];
    this.mouseDX = this.mouseDY = 0;
    return r;
  }

  /** Call once at the end of every frame. Latched movement presses survive. */
  endFrame(): void {
    this.pressed.clear();
    if (this.virtual) this.virtual.pressed.clear();
  }

  pausePressed(): boolean {
    return this.pressed.has('pause');
  }
}
