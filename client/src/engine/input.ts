// Keyboard + mouse state with edge detection, pointer lock, and a programmatic
// override path so the autoplay bot can drive the exact same code paths.

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

export class Input {
  private down = new Set<Action>();
  private pressed = new Set<Action>();
  mouseDX = 0;
  mouseDY = 0;
  locked = false;
  enabled = false;
  /** When set, a bot writes into these instead of the real devices. */
  virtual: { down: Set<Action>; pressed: Set<Action>; dx: number; dy: number } | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      const a = BINDINGS[e.code];
      if (!a) return;
      if (a === 'scores' || (this.locked && (e.code.startsWith('Control') || e.code === 'Space'))) e.preventDefault();
      if (!this.down.has(a)) this.pressed.add(a);
      this.down.add(a);
    });
    window.addEventListener('keyup', (e) => {
      const a = BINDINGS[e.code];
      if (a) this.down.delete(a);
    });
    window.addEventListener('blur', () => this.down.clear());
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      const a: Action | null = e.button === 0 ? 'fire' : e.button === 2 ? 'alt' : e.button === 1 ? 'punch' : e.button === 3 ? 'punch' : null;
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
      if (!this.locked) this.down.clear();
    });
  }

  requestLock(): void {
    if (this.virtual) return;
    const c = this.canvas as HTMLCanvasElement & { requestPointerLock(o?: { unadjustedMovement?: boolean }): Promise<void> | void };
    try {
      const r = c.requestPointerLock({ unadjustedMovement: true });
      if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch(() => c.requestPointerLock());
    } catch {
      c.requestPointerLock();
    }
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

  /** Call once at the end of every frame. */
  endFrame(): void {
    this.pressed.clear();
    if (this.virtual) this.virtual.pressed.clear();
  }

  /** Pause-key check that works even while the pointer is unlocked. */
  pausePressed(): boolean {
    return this.pressed.has('pause');
  }
}
