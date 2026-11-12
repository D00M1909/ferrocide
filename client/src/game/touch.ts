// On-screen controls for phones and tablets. A floating stick under the left thumb moves,
// dragging anywhere on the right looks, and the buttons feed the same Input actions the
// keyboard does. Every right-hand button also looks while held, so you can jump, dash or fire
// and keep turning with the same thumb. A quick tap on open screen punches (and parries), and
// a double tap on the stick side dashes, so the two things you need in a hurry need no aiming.
import type { Action, Input } from '../engine/input';

const STICK_R = 54; // px of travel for full speed, times the control scale
const DEADZONE = 0.14;
/** Mouse counts per CSS pixel of drag, on a ~900px-wide screen. */
const LOOK_SCALE = 2.7;
/** A press on a button only starts turning the camera after the thumb has moved this far. */
const HOLD_SLOP = 9;
/** A touch on open screen shorter and stiller than this is a punch. */
const TAP_MS = 190;
const TAP_PX = 11;
/** Two stick touches this close together dash. */
const DOUBLE_TAP_MS = 280;
/** Keep the stick's base off the screen edge, where phones start their own swipe gestures. */
const EDGE = 34;

interface Track {
  kind: 'stick' | 'look' | 'hold';
  x: number;
  y: number;
  /** Where and when the touch began. */
  x0: number;
  y0: number;
  t0: number;
  /** Timestamp of the last move, for the look speed curve. */
  t: number;
  /** Furthest the touch has strayed from where it began. */
  far: number;
  /** A held button that has moved past the slop is now also turning the camera. */
  looking: boolean;
  el?: HTMLElement;
  action?: Action;
}

const BUTTONS: { a: Action; cls: string; label: string }[] = [
  { a: 'fire', cls: 't-fire', label: 'FIRE' },
  { a: 'alt', cls: 't-alt', label: 'ALT' },
  { a: 'jump', cls: 't-jump', label: 'JUMP' },
  { a: 'dash', cls: 't-dash', label: 'DASH' },
  { a: 'slide', cls: 't-slide', label: 'SLIDE' },
];

const WEAPON_LABELS = ['I', 'II', 'III'];

export class TouchControls {
  readonly root = document.createElement('div');
  private stick = document.createElement('div');
  private knob = document.createElement('i');
  private tracks = new Map<number, Track>();
  private slots: HTMLElement[] = [];
  private base = { x: 0, y: 0 };
  /** The one touch that turns the camera: the newest finger wins, so two never add up. */
  private lookId = -1;
  private lastStickDown = -1e9;
  private dashTimer = 0;
  private gyroOn = false;
  private gyroT = 0;
  /** Radians of turn per radian the phone turns. */
  gyroSens = 1;
  /** Buzz on dash and punch (Android; iPhones have no vibration API). */
  haptics = true;

  constructor(parent: HTMLElement, private input: Input, onPause: () => void) {
    const r = this.root;
    r.id = 'touch';
    this.stick.className = 't-stick';
    this.stick.appendChild(this.knob);
    r.appendChild(this.stick);
    for (const b of BUTTONS) {
      const e = document.createElement('div');
      e.className = `t-btn ${b.cls}`;
      e.dataset.a = b.a;
      e.textContent = b.label;
      r.appendChild(e);
    }
    const weapons = document.createElement('div');
    weapons.className = 't-weapons';
    (['w1', 'w2', 'w3'] as Action[]).forEach((a, i) => {
      const e = document.createElement('div');
      e.className = 't-slot';
      e.dataset.tap = a;
      e.textContent = WEAPON_LABELS[i];
      weapons.appendChild(e);
      this.slots.push(e);
    });
    r.appendChild(weapons);
    const pause = document.createElement('div');
    pause.className = 't-pause';
    pause.textContent = 'II';
    r.appendChild(pause);
    parent.appendChild(r);

    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const t = e.target as HTMLElement;
      if (t === pause) { onPause(); return; }
      const tap = t.closest<HTMLElement>('[data-tap]');
      if (tap) { input.tap(tap.dataset.tap as Action); this.buzz(8); return; }
      try { r.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      const now = performance.now();
      const k: Track = { kind: 'look', x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: now, t: now, far: 0, looking: true };
      const btn = t.closest<HTMLElement>('[data-a]');
      if (btn) {
        const action = btn.dataset.a as Action;
        input.setDown(action, true);
        btn.classList.add('on');
        if (action === 'dash') this.buzz(12);
        k.kind = 'hold';
        k.el = btn;
        k.action = action;
        k.looking = false;
        this.tracks.set(e.pointerId, k);
        return;
      }
      const hasStick = [...this.tracks.values()].some((o) => o.kind === 'stick');
      if (e.clientX < window.innerWidth * 0.42 && !hasStick) {
        const m = EDGE * this.scale();
        this.base = {
          x: Math.max(m, e.clientX),
          y: Math.min(window.innerHeight - m, Math.max(m, e.clientY)),
        };
        k.kind = 'stick';
        this.tracks.set(e.pointerId, k);
        this.moveStick(e.clientX, e.clientY);
        // a second touch right after the first is a dash: wait a moment for the thumb to pick a
        // direction, so the dash goes where the stick is pushed rather than straight ahead
        if (now - this.lastStickDown < DOUBLE_TAP_MS) {
          this.lastStickDown = -1e9;
          this.dashTimer = window.setTimeout(() => this.fireDash(), 70);
        } else this.lastStickDown = now;
        return;
      }
      this.tracks.set(e.pointerId, k);
      this.lookId = e.pointerId;
    });
    r.addEventListener('pointermove', (e) => {
      const k = this.tracks.get(e.pointerId);
      if (!k) return;
      e.preventDefault();
      k.far = Math.max(k.far, Math.hypot(e.clientX - k.x0, e.clientY - k.y0));
      if (k.kind === 'stick') {
        this.moveStick(e.clientX, e.clientY);
        if (this.dashTimer && (input.stickX !== 0 || input.stickY !== 0)) this.fireDash();
        return;
      }
      const now = performance.now();
      if (!k.looking) {
        // a thumb rolling on a button must not twitch the camera
        if (k.far < HOLD_SLOP * this.scale()) return;
        k.looking = true;
        k.x = e.clientX;
        k.y = e.clientY;
        k.t = now;
        this.lookId = e.pointerId;
        return;
      }
      const dx = e.clientX - k.x, dy = e.clientY - k.y;
      const dt = Math.max(1, now - k.t);
      k.x = e.clientX;
      k.y = e.clientY;
      k.t = now;
      if (e.pointerId !== this.lookId) return;
      // slow drags are fine aim, fast flicks turn you around: speed in px/ms picks the gain
      const v = Math.hypot(dx, dy) / dt;
      const u = Math.max(0, Math.min(1, (v - 0.12) / 1.1));
      const gain = 0.72 + 0.88 * u * u * (3 - 2 * u);
      const s = ((LOOK_SCALE * 900) / Math.max(600, window.innerWidth)) * gain;
      input.addLook(dx * s, dy * s * 0.75);
    });
    const end = (e: PointerEvent) => {
      const k = this.tracks.get(e.pointerId);
      if (!k) return;
      this.tracks.delete(e.pointerId);
      if (k.kind === 'look' && e.type === 'pointerup' && performance.now() - k.t0 < TAP_MS && k.far < TAP_PX * this.scale()) {
        input.tap('punch');
        this.buzz(10);
      }
      this.release(k);
      if (e.pointerId === this.lookId) {
        // hand the camera to another finger that is still down and already turning
        this.lookId = -1;
        for (const [id, o] of this.tracks) if (o.kind !== 'stick' && o.looking) this.lookId = id;
      }
    };
    r.addEventListener('pointerup', end);
    r.addEventListener('pointercancel', end);
    r.addEventListener('lostpointercapture', end);
    r.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS: stop double-tap zoom, text selection and the magnifier loupe
    r.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  }

  /** The control scale set from the screen height (see --ts in main.ts). */
  private scale(): number {
    return Number(getComputedStyle(document.documentElement).getPropertyValue('--ts')) || 1;
  }

  private moveStick(x: number, y: number): void {
    const R = STICK_R * this.scale();
    let dx = x - this.base.x, dy = y - this.base.y;
    const len = Math.hypot(dx, dy);
    if (len > R) {
      // the base follows a thumb that overshoots, so reversing direction is instant
      this.base.x += (dx / len) * (len - R);
      this.base.y += (dy / len) * (len - R);
      dx = (dx / len) * R;
      dy = (dy / len) * R;
    }
    const nx = dx / R, ny = dy / R;
    const m = Math.hypot(nx, ny);
    // past the dead zone, rescale so speed ramps from zero and tops out before the rim
    const g = m < DEADZONE ? 0 : Math.min(1, (m - DEADZONE) / (0.85 - DEADZONE)) / m;
    this.input.stickX = nx * g;
    this.input.stickY = -ny * g;
    this.drawStick(dx, dy, true);
  }

  private fireDash(): void {
    clearTimeout(this.dashTimer);
    this.dashTimer = 0;
    this.input.tap('dash');
    this.buzz(12);
  }

  private buzz(ms: number): void {
    if (this.haptics) navigator.vibrate?.(ms);
  }

  private release(k: Track): void {
    if (k.kind === 'stick') {
      this.input.stickX = this.input.stickY = 0;
      this.drawStick(0, 0, false);
    } else if (k.kind === 'hold' && k.action) {
      this.input.setDown(k.action, false);
      k.el?.classList.remove('on');
    }
  }

  private drawStick(dx: number, dy: number, on: boolean): void {
    this.stick.classList.toggle('on', on);
    // at rest the stick goes back to its hint position (set in CSS)
    this.stick.style.left = on ? `${this.base.x}px` : '';
    this.stick.style.top = on ? `${this.base.y}px` : '';
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
  }

  /** Show the controls while playing; letting go of everything when they hide. */
  setActive(on: boolean): void {
    this.root.classList.toggle('on', on);
    if (on) return;
    for (const k of this.tracks.values()) this.release(k);
    this.tracks.clear();
    this.lookId = -1;
    clearTimeout(this.dashTimer);
    this.dashTimer = 0;
  }

  /** Draw the controls without making them live, behind the tap-to-play screen. */
  setPreview(on: boolean): void {
    this.root.classList.toggle('preview', on);
  }

  /** Highlight the weapon in hand. */
  setWeapon(index: number): void {
    this.slots.forEach((s, i) => s.classList.toggle('cur', i === index));
  }

  /**
   * Gyro aim: turning the phone turns the view, on top of the thumb. Must be called from a tap
   * the first time, because iPhones only grant motion access from a user gesture.
   */
  setGyro(on: boolean): void {
    if (on === this.gyroOn) return;
    this.gyroOn = on;
    if (!on) { window.removeEventListener('devicemotion', this.onMotion); return; }
    const DM = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
    if (!DM) { this.gyroOn = false; return; }
    const listen = () => { if (this.gyroOn) window.addEventListener('devicemotion', this.onMotion); };
    if (DM.requestPermission) DM.requestPermission().then((p) => { if (p === 'granted') listen(); else this.gyroOn = false; }).catch(() => { this.gyroOn = false; });
    else listen();
  }

  private onMotion = (e: DeviceMotionEvent): void => {
    const rr = e.rotationRate;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.gyroT) / 1000);
    this.gyroT = now;
    if (!rr || dt <= 0 || !this.root.classList.contains('on')) return;
    // Rates are in the phone's own frame (x across the short side, y up the long side). Held in
    // landscape, turning left/right is rotation about x and tipping up/down is rotation about y;
    // which way is positive depends on which side the top of the phone points.
    const flip = (window.screen.orientation?.angle ?? 90) === 270 ? -1 : 1;
    const D = Math.PI / 180;
    const yaw = (rr.beta ?? 0) * D * dt * flip;
    const pitch = -(rr.gamma ?? 0) * D * dt * flip;
    // ignore the tremor of a hand that is just holding the phone
    if (Math.abs(yaw) + Math.abs(pitch) < 0.0004) return;
    this.input.addAngles(yaw * this.gyroSens, pitch * this.gyroSens);
  };
}
