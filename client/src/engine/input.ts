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
  /** Touch devices have no pointer lock: "locked" simply means the on-screen controls are live. */
  touch = false;
  /** Fired whenever capture starts or ends (pointer lock on desktop, the touch equivalent on phones). */
  onLockChange: ((locked: boolean) => void) | null = null;
  /** Analog movement from the touch stick, each -1..1. Added to the keys. */
  stickX = 0;
  stickY = 0;
  /** Touch auto-fire: the game holds the trigger while the crosshair is on a target. */
  autoFire = false;
  /** When set, a bot writes into these instead of the real devices. */
  virtual: { down: Set<Action>; pressed: Set<Action>; dx: number; dy: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      const a = BINDINGS[e.code];
      // while playing, swallow browser shortcuts on game keys (Ctrl+W/S/D, Space scroll, Tab focus...)
      if (this.locked && (a || e.ctrlKey || e.metaKey)) e.preventDefault();
      if (!a) return;
      if (a === 'scores') e.preventDefault();
      this.setDown(a, true);
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
      if (this.touch) return;
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.down.clear(); this.latched.clear(); }
      this.onLockChange?.(this.locked);
    });
  }

  /** Hold or release an action, exactly as a key would (used by the on-screen buttons). */
  setDown(a: Action, on: boolean): void {
    if (!on) { this.down.delete(a); return; }
    if (!this.down.has(a)) {
      this.pressed.add(a);
      if (LATCHED.includes(a)) this.latched.set(a, performance.now());
    }
    this.down.add(a);
  }

  /** A one-off press with nothing held (weapon slots, pause). */
  tap(a: Action): void {
    this.pressed.add(a);
  }

  /** Look input in mouse counts from a touch drag. */
  addLook(dx: number, dy: number): void {
    if (!this.locked) return;
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  /** Movement axes: keys plus the touch stick, each clamped to -1..1. */
  moveAxes(): { forward: number; strafe: number } {
    const key = (a: Action, b: Action) => (this.isDown(a) ? 1 : 0) - (this.isDown(b) ? 1 : 0);
    const stick = !this.virtual && this.enabled;
    return {
      forward: Math.max(-1, Math.min(1, key('forward', 'back') + (stick ? this.stickY : 0))),
      strafe: Math.max(-1, Math.min(1, key('right', 'left') + (stick ? this.stickX : 0))),
    };
  }

  private setTouchLock(on: boolean): void {
    if (this.locked === on) return;
    this.locked = on;
    if (!on) { this.down.clear(); this.latched.clear(); this.stickX = this.stickY = 0; this.autoFire = false; }
    // like the real pointerlockchange event, tell listeners after the current call unwinds
    queueMicrotask(() => this.onLockChange?.(this.locked));
  }

  /** Pointer lock + (best effort) fullscreen keyboard lock so Ctrl+W can't close the tab mid-slide. */
  requestLock(): void {
    if (this.virtual) return;
    if (this.touch) { this.setTouchLock(true); return; }
    // plain lock: raw 'unadjustedMovement' input could come back silent after fullscreen changes
    const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    r?.catch?.(() => undefined);
    const nav = navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void> } };
    if (document.fullscreenElement && nav.keyboard) void nav.keyboard.lock(['KeyW', 'KeyS', 'KeyD', 'ControlLeft']).catch(() => undefined);
  }

  exitLock(): void {
    if (this.touch) { this.setTouchLock(false); return; }
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(a: Action): boolean {
    if (this.virtual) return this.virtual.down.has(a);
    return this.enabled && (this.down.has(a) || (a === 'fire' && this.autoFire));
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
