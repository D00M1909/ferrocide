// DOM heads-up display. Everything is created once and mutated per frame.
import { PLAYER, RANKS, WEAPONS, WEAPON_ORDER, type WeaponId } from '../../../shared/constants';
import type { StyleMeter } from './style';

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export class HUD {
  readonly root = el('div');
  private hpNum = el('div', 'hp-num');
  private hpFill = el('i', 'hp-fill');
  private hpGhost = el('i', 'hp-ghost');
  private stam: HTMLElement[] = [];
  private weapon = el('div');
  private slots: HTMLElement[] = [];
  private altInfo = el('div', 'alt');
  private rank = el('div', 'rank');
  private rankName = el('div', 'rank-name');
  private styleFill = el('i');
  private feed = el('div', 'style-feed');
  private waveTitle = el('div');
  private waveLeft = el('div', 'left');
  private boss = el('div', 'boss-bar');
  private bossFill = el('i');
  private banner = el('div', 'banner');
  private center = el('div', 'center-msg');
  private hit = el('div');
  private partner = el('div', 'partner');
  private partnerName = el('div');
  private partnerFill = el('i');
  private dmgArcs: HTMLElement[] = [];
  private net = el('div', 'net');
  private killfeed = el('div', 'killfeed');
  private ghostHp = 100;
  private bannerT = 0;
  private hitT = 0;
  private lastRank = -1;
  private arcIdx = 0;

  constructor(parent: HTMLElement) {
    this.root.id = 'hud';
    parent.appendChild(this.root);
    const cross = el('div');
    cross.id = 'crosshair';
    this.hit.id = 'hitmarker';
    this.root.append(cross, this.hit);

    // bottom-left: health, stamina, weapon
    const bl = el('div', 'hud-bl');
    const hpRow = el('div', 'hp-row');
    const hpBar = el('div', 'bar');
    hpBar.append(this.hpGhost, this.hpFill);
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
      slots.appendChild(s);
      this.slots.push(s);
    });
    wb.append(slots, this.weapon);
    bl.append(this.altInfo, wb, stam, hpRow);
    this.root.appendChild(bl);

    // right: style
    const sp = el('div', 'style-panel');
    const sb = el('div', 'style-bar');
    sb.appendChild(this.styleFill);
    sp.append(this.rank, this.rankName, sb, this.feed);
    this.root.appendChild(sp);

    // top: wave
    const wi = el('div', 'wave-info');
    wi.append(this.waveTitle, this.waveLeft);
    this.root.appendChild(wi);
    const bn = el('div', 'name', 'THE FOUNDRY COLOSSUS');
    const bb = el('div', 'bar');
    bb.appendChild(this.bossFill);
    this.boss.append(bn, bb);
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
    this.root.append(dd, this.net, this.killfeed);
  }

  show(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  setHealth(hp: number): void {
    const f = Math.max(0, hp) / PLAYER.maxHealth;
    this.hpNum.textContent = String(Math.max(0, Math.ceil(hp)));
    this.hpNum.classList.toggle('low', hp <= 30);
    this.hpFill.style.transform = `scaleX(${f})`;
    if (hp > this.ghostHp) this.ghostHp = hp;
  }

  update(dt: number, s: {
    hp: number; stamina: number; weapon: WeaponId; coins: number; coreCd: number; style: StyleMeter;
    wave: number; waves: number; title: string; left: number; phase: string; timer: number;
    boss: { hp: number; max: number } | null; ping: number; online: boolean;
  }): void {
    this.setHealth(s.hp);
    this.ghostHp = Math.max(s.hp, this.ghostHp - dt * 40);
    this.hpGhost.style.transform = `scaleX(${Math.max(0, this.ghostHp) / PLAYER.maxHealth})`;
    for (let i = 0; i < this.stam.length; i++) this.stam[i].style.transform = `scaleX(${Math.max(0, Math.min(1, s.stamina - i))})`;
    this.weapon.textContent = WEAPONS[s.weapon].name;
    this.slots.forEach((el2, i) => el2.classList.toggle('on', WEAPON_ORDER[i] === s.weapon));
    if (s.weapon === 'revolver') this.altInfo.textContent = `COINS ${'●'.repeat(s.coins)}${'○'.repeat(WEAPONS.revolver.coinCharges - s.coins)}`;
    else if (s.weapon === 'shotgun') this.altInfo.textContent = s.coreCd > 0 ? `CORE ${s.coreCd.toFixed(1)}s` : 'CORE READY';
    else this.altInfo.textContent = 'ALT: DETONATE';

    // style
    const r = s.style.rank;
    const rk = RANKS[r];
    const active = s.style.meter > 1;
    this.rank.textContent = active ? rk.letter : '';
    this.rank.style.color = rk.color;
    this.rankName.textContent = active ? rk.name : '';
    this.rankName.style.color = rk.color;
    this.styleFill.style.transform = `scaleX(${active ? s.style.progress : 0})`;
    this.styleFill.style.background = rk.color;
    if (r !== this.lastRank) {
      this.rank.style.transform = 'scale(1.35)';
      setTimeout(() => (this.rank.style.transform = ''), 90);
      this.lastRank = r;
    }
    this.feed.innerHTML = s.style.feed.map((f) => `<div class="${f.big ? 'big' : ''}">+ ${f.label}</div>`).join('');

    // wave
    if (s.phase === 'lobby') {
      this.waveTitle.textContent = '';
      this.waveLeft.textContent = '';
    } else {
      this.waveTitle.textContent = `WAVE ${s.wave}/${s.waves} — ${s.title}`;
      this.waveLeft.textContent = s.phase === 'combat' ? `${s.left} HOSTILES REMAIN` : s.phase === 'intermission' ? `NEXT WAVE IN ${Math.ceil(s.timer)}` : '';
    }
    this.boss.style.display = s.boss ? 'block' : 'none';
    if (s.boss) this.bossFill.style.transform = `scaleX(${Math.max(0, s.boss.hp / s.boss.max)})`;

    this.bannerT = Math.max(0, this.bannerT - dt);
    this.banner.style.opacity = this.bannerT > 0 ? String(Math.min(1, this.bannerT * 3)) : '0';
    this.hitT = Math.max(0, this.hitT - dt);
    this.hit.style.opacity = this.hitT > 0 ? '1' : '0';
    for (const a of this.dmgArcs) a.style.opacity = String(Math.max(0, Number(a.style.opacity || 0) - dt * 1.5));
    this.net.textContent = s.online ? `${Math.round(s.ping)} ms` : '';
  }

  showBanner(text: string, sub = '', time = 2.2): void {
    this.banner.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    this.bannerT = time;
  }

  setCenter(text: string): void {
    this.center.textContent = text;
  }

  hitmarker(kill: boolean): void {
    this.hit.classList.toggle('kill', kill);
    this.hitT = kill ? 0.22 : 0.1;
  }

  damageFrom(angle: number): void {
    const a = this.dmgArcs[this.arcIdx++ % this.dmgArcs.length];
    a.style.transform = `rotate(${angle}rad)`;
    a.style.opacity = '1';
  }

  setPartner(name: string | null, hp: number, alive: boolean): void {
    if (!name) { this.partner.style.display = 'none'; return; }
    this.partner.style.display = '';
    this.partnerName.textContent = alive ? name : `${name} — DOWN`;
    this.partnerFill.style.transform = `scaleX(${alive ? Math.max(0, hp) / PLAYER.maxHealth : 0})`;
  }

  kill(text: string): void {
    const d = document.createElement('div');
    d.textContent = text;
    this.killfeed.prepend(d);
    while (this.killfeed.childElementCount > 4) this.killfeed.lastElementChild?.remove();
    setTimeout(() => d.remove(), 3500);
  }
}
