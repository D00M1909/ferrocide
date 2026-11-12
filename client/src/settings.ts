import { isTouch, lowSpec } from './platform';

export interface Settings {
  name: string;
  sensitivity: number; // multiplier
  fov: number;
  master: number;
  music: number;
  sfx: number;
  resolution: number; // internal render height, 0 = native
  dither: boolean;
  shake: number;
  invertY: boolean;
  showFps: boolean;
  autoFire: boolean; // touch only: shoot while the crosshair is on an enemy
  aimAssist: boolean; // touch only: ease the crosshair toward nearby enemies
  gyro: boolean; // touch only: turning the phone turns the view
  gyroSens: number;
  haptics: boolean; // touch only: short buzzes on dash, punch and damage
  fpsCap: number; // frames per second, 0 = as fast as the screen goes
  autoRes: boolean; // drop the render resolution when the frame rate can't hold
  tips: boolean; // first-time hints during play
}

const DEFAULTS: Settings = {
  name: '',
  sensitivity: 1,
  fov: 100,
  master: 0.8,
  music: 0.5,
  sfx: 0.9,
  resolution: 480,
  dither: true,
  shake: 1,
  invertY: false,
  showFps: false,
  autoFire: true,
  aimAssist: true,
  gyro: false,
  gyroSens: 1,
  haptics: true,
  // phones: a narrower view keeps distant enemies big enough to see, and 60 fps keeps them cool
  ...(isTouch ? { fov: 90 } : {}),
  fpsCap: lowSpec ? 60 : 0,
  autoRes: lowSpec,
  tips: true,
};

const KEY = 'ferrocide.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}
