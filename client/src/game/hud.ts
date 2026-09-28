// DOM heads-up display. Everything is created once and mutated per frame;
// list-like widgets (style feed, killfeed) only touch the DOM when entries change.
import { PLAYER, RANKS, WEAPONS, WEAPON_ORDER, type WeaponId } from '../../../shared/constants';
import type { StyleMeter } from './style';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export class HUD {
  readonly root = el('div');
  private hpNum = el('div', 'hp-num');
  private hpFill = el('i', 'hp-fill');
  private hpHard = el('i', 'hp-hard');
  private hpGhost = el('i', 'hp-ghost');
  private hpBar: HTMLElement | null = null;
  private stam: HTMLElement[] = [];
  private weapon = el('div', 'wname');
  private slots: HTMLElement[] = [];
  private fresh: HTMLElement[] = [];
  private altInfo = el('div', 'alt');
  private rank = el('div', 'rank');
  private rankNum = el('div', 'rank-num');
  private styleFill = el('i');
  private feed = el('div', 'style-feed');
  private feedIds = new Map<number, HTMLElement>();
  private waveTitle = el('div');
  private waveLeft = el('div', 'left');
  private boss = el('div', 'boss-bar');
  private bossFill = el('i');
  private banner = el('div', 'banner');
  private bannerMain = el('span');
  private bannerSub = el('small');
  private center = el('div', 'center-msg');
  private hit = el('div');
  private partner = el('div', 'partner');
  private partnerName = el('div');
  private partnerFill = el('i');
  private dmgArcs: HTMLElement[] = [];
  private net = el('div', 'net');
  private fps = el('div', 'fps-counter');
  private killfeed = el('div', 'killfeed');
  private splat = el('div', 'lens-blood');
  private ghostHp = 100;
  private bannerT = 0;
  private hitT = 0;
  private splatT = 0;
  private lastRank = -1;
  private arcIdx = 0;

  constructor(parent: HTMLElement) {
    this.root.id = 'hud';
    parent.appendChild(this.root);
    const cross = el('div');
    cross.id = 'crosshair';
    this.hit.id = 'hitmarker';
    this.root.append(this.splat, cross, this.hit);

    // bottom-left: health, stamina, weapon
    const bl = el('div', 'hud-bl');
    const hpRow = el('div', 'hp-row');
    const hpBar = el('div', 'bar hp');
    this.hpBar = hpBar;
    hpBar.append(this.hpGhost, this.hpFill, this.hpHard);
    hpRow.append(this.hpNum, hpBar);
    const stam = el('div', 'stamina');
    for (let i = 0; i < PLAYER.staminaMax; i++) {
      const d = el('div');
      const f = el('i');
      d.appendChild(f);
      stam.appendChild(d);
      this.stam.push(f);
    }
    const wb = el('div', 'weapon-box');
    const slots = el('div', 'slots');
    WEAPON_ORDER.forEach((w, i) => {
      const s = el('span', '', `${i + 1}`);
      s.title = WEAPONS[w].name;
      const f = el('b', 'fresh');
      s.appendChild(f);
      slots.appendChild(s);
      this.slots.push(s);
      this.fresh.push(f);
    });
    wb.append(slots, this.weapon);
    bl.append(this.altInfo, wb, stam, hpRow);
    this.root.appendChild(bl);

    // right: style
    const sp = el('div', 'style-panel');
    const sb = el('div', 'style-bar');
    sb.appendChild(this.styleFill);
    sp.append(this.rankNum, this.rank, sb, this.feed);
    this.root.appendChild(sp);

    // top: wave
    const wi = el('div', 'wave-info');
    wi.append(this.waveTitle, this.waveLeft);
    this.root.appendChild(wi);
    const bn = el('div', 'name', 'THE FOUNDRY COLOSSUS');
    const bb = el('div', 'bar');
    bb.appendChild(this.bossFill);
    this.boss.append(bn, bb);
    this.banner.append(this.bannerMain, this.bannerSub);
    this.root.append(this.boss, this.banner, this.center);

    const pb = el('div', 'bar');
    pb.appendChild(this.partnerFill);
    this.partner.append(this.partnerName, pb);
    this.partner.style.display = 'none';
    this.root.appendChild(this.partner);

    const dd = el('div', 'dmg-dir');
    for (let i = 0; i < 4; i++) {
      const a = el('i');
      dd.appendChild(a);
      this.dmgArcs.push(a);
    }
    this.root.append(dd, this.net, this.fps, this.killfeed);
  }

  show(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  update(dt: number, s: {
    hp: number; hard: number; stamina: number; weapon: WeaponId; coins: number; coreCd: number; style: StyleMeter;
    wave: number; waves: number; title: string; left: number; phase: string; timer: number;
    boss: { hp: number; max: number } | null; ping: number; online: boolean; fps: number | null;
  }): void {
    // health: bright = current, dark red = hard damage (not healable yet), white = recent loss
    const hp = Math.max(0, s.hp);
    this.hpNum.textContent = String(Math.ceil(hp));
    this.hpNum.classList.toggle('low', hp <= 30);
    this.hpFill.style.transform = `scaleX(${hp / PLAYER.maxHealth})`;
    this.hpHard.style.left = `${(100 - s.hard)}%`;
    this.hpHard.style.width = `${s.hard}%`;
    if (hp > this.ghostHp) this.ghostHp = hp;
    this.ghostHp = Math.max(hp, this.ghostHp - dt * 40);
    this.hpGhost.style.transform = `scaleX(${this.ghostHp / PLAYER.maxHealth})`;
    for (let i = 0; i < this.stam.length; i++) {
      const f = Math.max(0, Math.min(1, s.stamina - i));
      this.stam[i].style.transform = `scaleX(${f})`;
      this.stam[i].classList.toggle('full', f >= 1);
    }
    this.weapon.textContent = WEAPONS[s.weapon].name;
    this.slots.forEach((e, i) => {
      e.classList.toggle('on', WEAPON_ORDER[i] === s.weapon);
      const f = s.style.freshnessOf(WEAPON_ORDER[i]);
      this.fresh[i].style.transform = `scaleX(${(f - 0.5) / 1})`;
      this.fresh[i].classList.toggle('stale', f < 0.9);
    });
    if (s.weapon === 'revolver') this.altInfo.textContent = `COINS ${'●'.repeat(s.coins)}${'○'.repeat(WEAPONS.revolver.coinCharges - s.coins)}`;
    else if (s.weapon === 'shotgun') this.altInfo.textContent = s.coreCd > 0 ? `CORE ${s.coreCd.toFixed(1)}s` : 'CORE READY';
    else this.altInfo.textContent = 'ALT: TAP BURST · HOLD STEER';

    // style
    const r = s.style.rank;
    const rk = RANKS[r];
    const active = s.style.meter > 1;
    this.rank.textContent = active ? rk.name : '';
    this.rank.style.color = rk.color;
    this.rankNum.textContent = active ? rk.letter : '';
    this.rankNum.style.color = rk.color;
    this.styleFill.style.transform = `scaleX(${active ? s.style.progress : 0})`;
    this.styleFill.style.background = rk.color;
    if (r !== this.lastRank) {
      this.rank.classList.remove('pop');
      void this.rank.offsetWidth;
      this.rank.classList.add('pop');
      this.lastRank = r;
    }
    this.syncFeed(s.style);

    // wave
    if (s.phase === 'lobby' || s.wave <= 0) {
      this.waveTitle.textContent = '';
      this.waveLeft.textContent = '';
    } else {
      this.waveTitle.textContent = `WAVE ${s.wave}/${s.waves} — ${s.title}`;
      this.waveLeft.textContent = s.phase === 'combat' ? `${s.left} HOSTILES REMAIN` : s.phase === 'intermission' ? `INCOMING IN ${Math.ceil(s.timer)}` : '';
    }
    this.boss.style.display = s.boss ? 'block' : 'none';
    if (s.boss) this.bossFill.style.transform = `scaleX(${Math.max(0, s.boss.hp / s.boss.max)})`;

    this.bannerT = Math.max(0, this.bannerT - dt);
    this.banner.style.opacity = this.bannerT > 0 ? String(Math.min(1, this.bannerT * 3)) : '0';
    this.hitT = Math.max(0, this.hitT - dt);
    this.hit.style.opacity = this.hitT > 0 ? '1' : '0';
    this.splatT = Math.max(0, this.splatT - dt);
    this.splat.style.opacity = String(Math.min(0.85, this.splatT * 0.7));
    for (const a of this.dmgArcs) a.style.opacity = String(Math.max(0, Number(a.style.opacity || 0) - dt * 1.5));
    this.net.textContent = s.online ? `${Math.round(s.ping)} ms` : '';
    this.fps.style.display = s.fps === null ? 'none' : 'block';
    if (s.fps !== null) this.fps.textContent = `${Math.round(s.fps)} FPS`;
  }

  /** Only add/remove changed rows so the CSS entrance animation plays once per entry. */
  private syncFeed(style: StyleMeter): void {
    const live = new Set(style.feed.map((f) => f.id));
    for (const [id, node] of this.feedIds) {
      if (!live.has(id)) { node.remove(); this.feedIds.delete(id); }
    }
    for (let i = style.feed.length - 1; i >= 0; i--) {
      const f = style.feed[i];
      if (this.feedIds.has(f.id)) continue;
      const d = el('div', f.big ? 'big' : '', `+ ${f.label}`);
      this.feed.prepend(d);
      this.feedIds.set(f.id, d);
    }
  }

  /** Health pickup: a "+N" that floats up off the health number, and the bar glows. */
  healPop(amount: number, big: boolean): void {
    const pop = el('div', big ? 'heal-pop big' : 'heal-pop');
    pop.textContent = `+${Math.round(amount)}`;
    this.hpNum.parentElement?.appendChild(pop);
    setTimeout(() => pop.remove(), 1100);
    for (const e of [this.hpBar, this.hpNum]) {
      if (!e) continue;
      e.classList.remove('healed');
      void e.offsetWidth; // restart the animation
      e.classList.add('healed');
    }
  }

  showBanner(text: string, sub = '', time = 2.2): void {
    this.bannerMain.textContent = text;
    this.bannerSub.textContent = sub;
    this.bannerT = time;
  }

  setCenter(text: string): void {
    this.center.textContent = text;
  }

  hitmarker(kill: boolean): void {
    this.hit.classList.toggle('kill', kill);
    this.hitT = kill ? 0.22 : 0.1;
  }

  bloodSplat(): void {
    this.splat.style.backgroundPosition = `${Math.random() * 100}% ${Math.random() * 100}%`;
    this.splatT = 1.3;
  }

  damageFrom(angle: number): void {
    const a = this.dmgArcs[this.arcIdx++ % this.dmgArcs.length];
    a.style.transform = `rotate(${angle}rad)`;
    a.style.opacity = '1';
  }

  setPartner(name: string | null, hp: number, alive: boolean, connected: boolean): void {
    if (!name) { this.partner.style.display = 'none'; return; }
    this.partner.style.display = '';
    this.partnerName.textContent = !connected ? `${name} — RECONNECTING…` : alive ? name : `${name} — DOWN`;
    this.partnerFill.style.transform = `scaleX(${alive ? Math.max(0, hp) / PLAYER.maxHealth : 0})`;
  }

  kill(text: string): void {
    const d = el('div', '', text);
    this.killfeed.prepend(d);
    while (this.killfeed.childElementCount > 4) this.killfeed.lastElementChild?.remove();
    setTimeout(() => d.remove(), 3500);
  }
}
