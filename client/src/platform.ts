// What kind of device are we on? Decided once at boot.
const q = new URLSearchParams(location.search);

/**
 * Touch-first devices (phones, tablets) get on-screen controls and a tap-to-play flow instead of
 * pointer lock. Laptops with a touchscreen keep mouse and keyboard: their primary pointer is fine.
 * Force either way with ?touch=1 / ?touch=0.
 */
/**
 * Phones and tablets get a lighter render setup: fewer live lights, smaller particle bursts,
 * a 60 fps cap. Decided once at boot (the light count is baked into every shader, so it can't
 * change mid-session). Force either way with ?low=1 / ?low=0.
 */
export const lowSpec: boolean =
  q.get('low') === '1' ||
  (q.get('low') !== '0' &&
    (q.get('touch') === '1' || (navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches)));

export const isTouch: boolean =
  q.get('touch') === '1' ||
  (q.get('touch') !== '0' && navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches);
