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
}

const DEFAULTS: Settings = {
  name: '',
  sensitivity: 1,
  fov: 100,
  master: 0.8,
  music: 0.6,
  sfx: 0.9,
  resolution: 360,
  dither: true,
  shake: 1,
  invertY: false,
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
