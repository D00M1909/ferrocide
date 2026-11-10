// On-screen controls for phones and tablets. A floating stick under the left thumb moves,
// dragging anywhere on the right looks, and the buttons feed the same Input actions the
// keyboard does. Every right-hand button also looks while held, so you can fire and turn
// (or steer rockets) with one thumb.
import type { Action, Input } from '../engine/input';

const STICK_R = 54; // px of travel for full speed
const DEADZONE = 0.14;
/** Mouse counts per CSS pixel of drag, on a ~900px-wide screen. */
const LOOK_SCALE = 2.7;

interface Track {
  kind: 'stick' | 'look' | 'hold';
  x: number;
  y: number;
  el?: HTMLElement;
  action?: Action;
}

const BUTTONS: { a: Action; cls: string; label: string }[] = [
  { a: 'fire', cls: 't-fire', label: 'FIRE' },
  { a: 'alt', cls: 't-alt', label: 'ALT' },
  { a: 'jump', cls: 't-jump', label: 'JUMP' },
  { a: 'dash', cls: 't-dash', label: 'DASH' },
  { a: 'slide', cls: 't-slide', label: 'SLIDE' },
  { a: 'punch', cls: 't-punch', label: 'PUNCH' },
];

export class TouchControls {
  readonly root = document.createElement('div');
  private stick = document.createElement('div');
  private knob = document.createElement('i');
  private tracks = new Map<number, Track>();
  private slots: HTMLElement[] = [];
  private base = { x: 0, y: 0 };

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
      e.textContent = String(i + 1);
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
      if (tap) { input.tap(tap.dataset.tap as Action); return; }
      try { r.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      const btn = t.closest<HTMLElement>('[data-a]');
      if (btn) {
        const action = btn.dataset.a as Action;
        input.setDown(action, true);
        btn.classList.add('on');
        this.tracks.set(e.pointerId, { kind: 'hold', x: e.clientX, y: e.clientY, el: btn, action });
        return;
      }
      const hasStick = [...this.tracks.values()].some((k) => k.kind === 'stick');
      if (e.clientX < window.innerWidth * 0.42 && !hasStick) {
        this.base = { x: e.clientX, y: e.clientY };
        this.tracks.set(e.pointerId, { kind: 'stick', x: e.clientX, y: e.clientY });
        this.drawStick(0, 0, true);
        return;
      }
      this.tracks.set(e.pointerId, { kind: 'look', x: e.clientX, y: e.clientY });
    });
    r.addEventListener('pointermove', (e) => {
      const k = this.tracks.get(e.pointerId);
      if (!k) return;
      e.preventDefault();
      if (k.kind === 'stick') {
        let dx = e.clientX - this.base.x, dy = e.clientY - this.base.y;
        const len = Math.hypot(dx, dy);
        if (len > STICK_R) {
          // the base follows a thumb that overshoots, so reversing direction is instant
          this.base.x += (dx / len) * (len - STICK_R);
          this.base.y += (dy / len) * (len - STICK_R);
          dx = (dx / len) * STICK_R;
          dy = (dy / len) * STICK_R;
        }
        const nx = dx / STICK_R, ny = dy / STICK_R;
        const m = Math.hypot(nx, ny);
        // past the dead zone, rescale so speed ramps from zero and tops out before the rim
        const g = m < DEADZONE ? 0 : Math.min(1, (m - DEADZONE) / (0.85 - DEADZONE)) / m;
        input.stickX = nx * g;
        input.stickY = -ny * g;
        this.drawStick(dx, dy, true);
        return;
      }
      const s = (LOOK_SCALE * 900) / Math.max(600, window.innerWidth);
      input.addLook((e.clientX - k.x) * s, (e.clientY - k.y) * s * 0.75);
      k.x = e.clientX;
      k.y = e.clientY;
    });
    const end = (e: PointerEvent) => {
      const k = this.tracks.get(e.pointerId);
      if (!k) return;
      this.tracks.delete(e.pointerId);
      this.release(k);
    };
    r.addEventListener('pointerup', end);
    r.addEventListener('pointercancel', end);
    r.addEventListener('contextmenu', (e) => e.preventDefault());
    // iOS: stop double-tap zoom, text selection and the magnifier loupe
    r.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
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
  }

  /** Highlight the weapon in hand. */
  setWeapon(index: number): void {
    this.slots.forEach((s, i) => s.classList.toggle('cur', i === index));
  }
}
