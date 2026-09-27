// The orchestrator: owns the render loop, the local player, and routes network
// snapshots/events to the enemy, hazard, weapon, FX, HUD and audio systems.
import * as THREE from 'three';
import { ENEMIES, PLAYER, SLAM, WEAPON_ORDER, PLAYER_SEND_RATE } from '../../../shared/constants';
import { Motor, type MoveInput } from '../../../shared/movement';
import { PF, type GameEvent, type HitKind, type Phase, type PlayerStats, type Snapshot, type V } from '../../../shared/protocol';
import { WAVES } from '../../../shared/waves';
import { sprite } from '../engine/assets';
import type { Audio } from '../engine/audio';
import type { Input } from '../engine/input';
import { RetroRenderer } from '../engine/renderer';
import type { NetLink } from '../net/link';
import type { Settings } from '../settings';
import { Bot } from './bot';
import { Enemies, type EnemyView } from './enemies';
import { COLORS, FX } from './fx';
import { Hazards, type PlayerProbe } from './hazards';
import { HUD } from './hud';
import { RemotePlayer } from './remote';
import { SnapBuffer } from './snapbuf';
import { StyleMeter } from './style';
import { Weapons, type WeaponCtx } from './weapons';
import { World } from './world';

export interface GameOverInfo {
  win: boolean;
  wave: number;
  time: number;
  stats: PlayerStats[];
  selfId: string;
}

export class Game {
  readonly renderer: RetroRenderer;
  readonly world = new World();
  readonly camera: THREE.PerspectiveCamera;
  readonly fx: FX;
  readonly enemies: Enemies;
  readonly hazards: Hazards;
  readonly weapons: Weapons;
  readonly style = new StyleMeter();
  readonly hud: HUD;
  private motor = new Motor();
  private snaps = new SnapBuffer();
  private remotes = new Map<string, RemotePlayer>();
  private names = new Map<string, string>();
  link: NetLink | null = null;
  private bot: Bot | null = null;

  mode: 'menu' | 'play' = 'menu';
  paused = false;
  yaw = 0;
  pitch = 0;
  hp = PLAYER.maxHealth;
  alive = true;
  phase: Phase = 'lobby';
  wave = 0;
  waveLeft = 0;
  phaseTimer = 0;
  private waveTitle = '';
  private time = 0;
  private acc = 0;
  private sendAcc = 0;
  private eyeH: number = PLAYER.eyeHeight;
  private landDip = 0;
  private roll = 0;
  private fovKick = 0;
  private lastKillT = -1;
  private multi = 0;
  private deadT = 0;
  private hurtFlash = 0;
  private flashAmt = 0;
  private flashColor = new THREE.Color();
  private lastRaf = 0;
  private running = false;
  private tmpEye = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private up = new THREE.Vector3();
  private musicTrack = 0;
  onGameOver: ((info: GameOverInfo) => void) | null = null;
  onPause: ((paused: boolean) => void) | null = null;
  onDisconnect: ((reason: string) => void) | null = null;
  onPhase: ((phase: Phase) => void) | null = null;
  fps = 0;

  constructor(canvas: HTMLCanvasElement, ui: HTMLElement, readonly audio: Audio, readonly input: Input, public settings: Settings) {
    this.renderer = new RetroRenderer(canvas);
    this.camera = new THREE.PerspectiveCamera(settings.fov, 1, 0.05, 600);
    this.camera.rotation.order = 'YXZ';
    this.fx = new FX(this.world.scene);
    this.enemies = new Enemies(this.world.scene, this.fx, audio, () => this.selfId, sprite('light_01'));
    this.hazards = new Hazards(this.world.scene, this.fx, audio, () => this.selfId);
    this.weapons = new Weapons(this.world.scene, () => this.selfId);
    this.hud = new HUD(ui);
    this.hud.show(false);
    this.enemies.onLocalKill = (v, how) => this.onLocalKill(v, how);
    this.hazards.onHurt = (m, from) => {
      if (!this.link || !this.alive) return;
      this.link.hurt(m);
      if (from) this.showDamageDir(from);
    };
    this.style.onRankChange = (r, up) => {
      if (up && r >= 2) audio.synth('rankup', 0.6);
    };
    this.applySettings(settings);
    window.addEventListener('resize', () => this.resize());
    this.resize();
  }

  get selfId(): string {
    return this.link?.id ?? '';
  }

  applySettings(s: Settings): void {
    this.settings = s;
    this.renderer.internalHeight = s.resolution;
    this.renderer.post.dither = s.dither;
    this.fx.shakeScale = s.shake;
    this.audio.setVolumes(s.master, s.music, s.sfx);
    this.resize();
  }

  resize(): void {
    this.renderer.resize();
    this.camera.aspect = this.renderer.aspect;
    this.camera.updateProjectionMatrix();
    this.weapons.resize(this.renderer.aspect);
    const h = this.settings.resolution > 0 ? Math.min(this.settings.resolution, window.innerHeight) : window.innerHeight;
    this.fx.setParticleScale(h, this.camera.fov);
  }

  startLoop(): void {
    if (this.running) return;
    this.running = true;
    this.lastRaf = performance.now();
    const frame = (t: number) => {
      if (!this.running) return;
      const dt = Math.min(0.05, (t - this.lastRaf) / 1000);
      this.lastRaf = t;
      this.fps = this.fps * 0.95 + (dt > 0 ? 1 / dt : 60) * 0.05;
      this.frame(dt);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ sessions

  begin(link: NetLink, players: { id: string; name: string }[], opts: { bot?: boolean } = {}): void {
    this.end();
    this.link = link;
    this.mode = 'play';
    this.paused = false;
    for (const p of players) this.names.set(p.id, p.name);
    link.handlers.snap = (s) => this.onSnap(s);
    link.handlers.events = (e) => this.onEvents(e);
    link.handlers.disconnect = (r) => this.onDisconnect?.(r);
    this.motor.reset({ x: players.findIndex((p) => p.id === link.id) === 1 ? 2.5 : -2.5, y: 1.2, z: 3 });
    this.yaw = 0;
    this.pitch = 0;
    this.hp = PLAYER.maxHealth;
    this.alive = true;
    this.style.reset();
    this.style.total = 0;
    this.hud.show(true);
    this.bot = opts.bot ? new Bot(this.input) : null;
    this.input.enabled = true;
    this.musicTrack = 0;
    void this.audio.playMusic('combat1');
    this.audio.setIntensity(0.1);
  }

  end(): void {
    if (this.link) this.link.leave();
    this.link = null;
    this.mode = 'menu';
    this.snaps.clear();
    this.enemies.clear();
    this.hazards.clear();
    this.weapons.clear();
    this.fx.clear();
    for (const r of this.remotes.values()) r.dispose();
    this.remotes.clear();
    this.names.clear();
    this.hud.show(false);
    this.phase = 'lobby';
    this.wave = 0;
    this.input.virtual = null;
    this.bot = null;
  }

  setPaused(p: boolean): void {
    if (this.paused === p) return;
    this.paused = p;
    this.onPause?.(p);
  }

  // ------------------------------------------------------------------ network

  private onSnap(s: Snapshot): void {
    const now = performance.now() / 1000;
    this.snaps.push(s, now);
    this.hazards.applySnapshot(s, now);
    if (s.phase !== this.phase) {
      this.phase = s.phase;
      this.onPhase?.(s.phase);
    }
    this.wave = s.wave;
    this.waveLeft = s.left;
    this.phaseTimer = s.timer;
    if (!this.waveTitle && s.wave > 0) this.waveTitle = WAVES[s.wave - 1]?.title ?? '';
    // remote players present/absent
    const seen = new Set<string>();
    for (const p of s.pl) {
      if (p[0] === this.selfId) {
        this.hp = p[11];
        continue;
      }
      seen.add(p[0]);
      if (!this.remotes.has(p[0])) this.remotes.set(p[0], new RemotePlayer(p[0], this.names.get(p[0]) ?? 'PARTNER', this.world.scene, sprite('light_01')));
    }
    for (const [id, r] of this.remotes) if (!seen.has(id)) { r.dispose(); this.remotes.delete(id); }
  }

  private onEvents(list: GameEvent[]): void {
    const now = performance.now() / 1000;
    const me = this.selfId;
    for (const e of list) {
      switch (e.t) {
        case 'spawn': case 'dmg': case 'atk': case 'stun': case 'enrage':
          this.enemies.onEvent(e, now);
          break;
        case 'kill':
          this.enemies.onEvent(e, now);
          if (e.by && e.by !== me) this.hud.kill(`${this.names.get(e.by) ?? 'PARTNER'} ✦ ${ENEMIES[e.k].name}`);
          break;
        case 'melee': case 'shock': case 'beam': case 'boom':
          this.hazards.onEvent(e, this.probe());
          break;
        case 'phurt':
          if (e.pid === me) this.onHurt(e.d, e.hp);
          break;
        case 'heal':
          if (e.pid === me) {
            this.hp = e.hp;
            if (e.amt >= 8) this.audio.synth('heal', 0.5);
          }
          break;
        case 'pdie':
          if (e.pid === me) this.onDeath();
          else this.hud.showBanner('PARTNER DOWN', `${this.names.get(e.pid) ?? ''} respawns in ${PLAYER.respawnTime}s`, 2);
          break;
        case 'prespawn':
          if (e.pid === me) this.onRespawn({ x: e.p[0], y: e.p[1], z: e.p[2] });
          break;
        case 'wave': {
          this.waveTitle = e.title;
          this.hud.showBanner(e.boss ? 'WARNING' : `WAVE ${e.n}`, e.title, 2.6);
          this.audio.play('door', { volume: 0.8, pitch: 0.6 });
          this.audio.synth('charge', 0.6);
          if (e.boss) void this.audio.playMusic('boss');
          else if (e.n === 4 || e.n === 1) { this.musicTrack = e.n === 4 ? 1 : 0; void this.audio.playMusic(this.musicTrack ? 'combat2' : 'combat1'); }
          break;
        }
        case 'clear':
          this.hud.showBanner('WAVE CLEARED', e.n < WAVES.length ? 'BREATHE' : '', 2.2);
          this.style.total += 150;
          this.audio.synth('rankup', 0.8);
          break;
        case 'parried':
          if (e.by !== me) this.audio.play('parry', { volume: 0.7 });
          break;
        case 'fx':
          if (e.from !== me) this.weapons.remoteFx(e.from, e.fx, this.fx, this.audio);
          break;
        case 'over':
          this.input.exitLock();
          this.onGameOver?.({ win: e.win, wave: e.wave, time: e.time, stats: e.stats, selfId: me });
          void this.audio.playMusic('menu');
          break;
        case 'reset':
          this.enemies.clear();
          this.hazards.clear();
          this.weapons.clear();
          this.style.reset();
          this.hud.showBanner('RETRY', `WAVE ${e.wave}`, 2);
          break;
        case 'join':
          this.names.set(e.pid, e.name);
          if (e.pid !== me) this.hud.showBanner(`${e.name} JOINED`, 'CO-OP ACTIVE', 2);
          break;
        case 'leave':
          if (e.pid !== me) this.hud.showBanner(`${this.names.get(e.pid) ?? 'PARTNER'} LEFT`, '', 2);
          break;
      }
    }
  }

  private probe(): PlayerProbe {
    return {
      centre: { x: this.motor.pos.x, y: this.motor.pos.y + this.motor.height * 0.55, z: this.motor.pos.z },
      feetY: this.motor.pos.y,
      grounded: this.motor.grounded,
      invulnerable: this.motor.dashing,
      alive: this.alive && this.mode === 'play',
    };
  }

  // ------------------------------------------------------------------ player feedback

  private onHurt(d: number, hp: number): void {
    this.hp = hp;
    this.hurtFlash = Math.min(1, this.hurtFlash + 0.35 + d / 60);
    this.fx.shake(Math.min(0.6, 0.2 + d / 60));
    this.style.hurt(d);
    this.audio.play('flesh', { volume: 0.8, pitch: 0.8 });
    this.audio.play('armor', { volume: 0.5, pitch: 0.6 });
  }

  private onDeath(): void {
    this.alive = false;
    this.deadT = 0;
    this.hp = 0;
    this.fx.blood(this.tmpEye.set(this.motor.pos.x, this.motor.pos.y + 1, this.motor.pos.z), 40, null, 8);
    this.audio.play('gore', { volume: 1 });
    this.audio.duck(0.3, 1);
    this.style.reset();
  }

  private onRespawn(p: { x: number; y: number; z: number }): void {
    this.motor.reset(p);
    this.alive = true;
    this.hp = PLAYER.maxHealth;
    this.hud.setCenter('');
    this.fx.magic({ x: p.x, y: p.y + 1, z: p.z }, 20, COLORS.gold, 3);
  }

  private showDamageDir(from: { x: number; y: number; z: number }): void {
    const dx = from.x - this.motor.pos.x, dz = from.z - this.motor.pos.z;
    const ang = Math.atan2(-dx, -dz); // world yaw toward the source
    this.hud.damageFrom(-(ang - this.yaw));
  }

  private onLocalKill(v: EnemyView, how: string): void {
    const now = this.time;
    const s = this.style;
    const head = (v as EnemyView & { lastHead?: boolean }).lastHead;
    s.add(v.def.heavy ? `${v.def.name} SLAIN` : 'KILL', v.def.score, v.def.heavy);
    if (head) s.add('HEADSHOT', 35);
    if (!this.motor.grounded) s.add('AIRBORNE', 40);
    if (Math.hypot(this.motor.vel.x, this.motor.vel.z) > 23) s.add('SPEEDKILL', 30);
    if (how === 'explosion' || how === 'rocket' || how === 'core') s.add('FRIED', 30);
    if (how === 'slam') s.add('GROUND POUND', 60);
    if (how === 'punch') s.add('DISRESPECT', 70);
    if (how === 'parry') s.add('RETURN TO SENDER', 90, true);
    if (how === 'ricoshot') s.add('COINSLINGER', 30);
    if (now - this.lastKillT < 0.45) {
      this.multi++;
      s.add(this.multi === 1 ? 'DOUBLE KILL' : this.multi === 2 ? 'TRIPLE KILL' : 'MULTIKILL', 50 * (this.multi + 1), true);
    } else this.multi = 0;
    this.lastKillT = now;
    this.weapons.noteKill();
    if (this.weapons.arsenal()) s.add('ARSENAL', 120, true);
    this.fx.freeze(v.def.heavy ? 0.14 : 0.035);
    this.audio.synth('kill', 0.5);
    this.hud.hitmarker(true);
    if (v.def.heavy) this.fx.shake(0.7);
  }

  private weaponCtx(): WeaponCtx {
    const link = this.link!;
    return {
      now: this.time,
      eye: this.tmpEye,
      fwd: this.fwd,
      right: this.right,
      up: this.up,
      motor: this.motor,
      alive: this.alive,
      enemies: this.enemies,
      hazards: this.hazards,
      fx: this.fx,
      audio: this.audio,
      damage: (v, dmg, kind, head, point, dir, extra) => {
        if (v.dead) return;
        (v as EnemyView & { lastHead?: boolean }).lastHead = head;
        this.fx.blood(point, Math.min(24, 4 + dmg / 4), dir, 6);
        if (dmg >= 25) this.fx.splatter(point, 1, 4, 0.9);
        this.audio.play(v.kind === 'drone' || v.kind === 'warden' || v.kind === 'colossus' ? 'metal_light' : 'flesh', { at: point, volume: Math.min(1, 0.4 + dmg / 60) });
        if (head) this.audio.synth('tick', 0.8);
        this.hud.hitmarker(false);
        this.style.trickle(dmg * 0.12);
        link.hit({ e: v.id, d: Math.round(dmg * 10) / 10, k: kind, hs: head || undefined, rc: extra?.rc });
        if (this.enemies.predictDamage(v, dmg, performance.now() / 1000)) this.enemies.kill(v, kind, true);
      },
      explode: (p, r, dmg, kind, force, selfDmg) => this.explode(p, r, dmg, kind, force, selfDmg),
      parry: (id, dir) => link.parry({ id, dir: [dir.x, dir.y, dir.z] }),
      sendFx: (m) => link.fx(m),
      style: (label, pts, big) => this.style.add(label, pts, big),
    };
  }

  private explode(p: { x: number; y: number; z: number }, r: number, dmg: number, kind: HitKind, force: number, selfDmg: number): void {
    if (!this.link) return;
    const pv: V = [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100];
    this.link.boom({ p: pv, r, d: dmg, k: kind });
    this.audio.play(r > 4.5 ? 'explosion' : 'explosion_small', { at: p, volume: 1 });
    this.fx.decal(p, { x: 0, y: 1, z: 0 }, r * 0.8, 'scorch');
    const c = { x: this.motor.pos.x, y: this.motor.pos.y + 0.9, z: this.motor.pos.z };
    const d = Math.hypot(c.x - p.x, c.y - p.y, c.z - p.z);
    this.fx.shake(Math.max(0.15, 0.6 * (1 - d / 25)));
    if (force > 0 && d < r + 0.6 && this.alive) {
      const k = 1 - (d / (r + 0.6)) * 0.5;
      const dir = new THREE.Vector3(c.x - p.x, c.y - p.y + 0.6, c.z - p.z).normalize();
      this.motor.impulse({ x: dir.x * force * k, y: Math.max(dir.y, 0.4) * force * k * 1.1, z: dir.z * force * k });
      if (selfDmg > 0) this.link.hurt({ src: 'self', d: selfDmg * k });
      if (!this.motor.grounded || dir.y > 0.5) this.style.add(kind === 'core' ? 'CORE JUMP' : 'ROCKET JUMP', 25);
    }
  }

  // ------------------------------------------------------------------ frame

  private frame(dt: number): void {
    const now = performance.now() / 1000;
    this.time += dt;
    if (this.mode === 'menu') {
      this.menuFrame(dt);
      return;
    }
    const link = this.link!;
    if (this.input.pausePressed() && !this.bot) this.setPaused(!this.paused);
    const soloPaused = this.paused && !link.online;
    // hitstop slows the world, not the network
    let worldDt = dt;
    if (this.fx.hitstop > 0) {
      this.fx.hitstop -= dt;
      worldDt = dt * 0.06;
    }
    if (soloPaused) worldDt = 0;
    if (!soloPaused) link.update(dt);

    // look
    const mouse = this.input.consumeMouse();
    const sens = 0.0022 * this.settings.sensitivity;
    if (this.bot) {
      const aim = this.bot.update(dt, {
        pos: this.motor.pos, eye: this.eyePos(), yaw: this.yaw, pitch: this.pitch, grounded: this.motor.grounded,
        alive: this.alive, enemies: this.enemies, hazards: this.hazards, weapons: this.weapons,
      });
      this.yaw = aim.yaw;
      this.pitch = aim.pitch;
    } else if (!this.paused) {
      this.yaw -= mouse[0] * sens;
      this.pitch -= mouse[1] * sens * (this.settings.invertY ? -1 : 1);
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    }

    // move (fixed 120 Hz substeps for consistent physics)
    const canMove = this.alive && !this.paused && this.phase !== 'over' && this.phase !== 'victory';
    const inp: MoveInput = {
      forward: canMove ? (this.input.isDown('forward') ? 1 : 0) - (this.input.isDown('back') ? 1 : 0) : 0,
      strafe: canMove ? (this.input.isDown('right') ? 1 : 0) - (this.input.isDown('left') ? 1 : 0) : 0,
      jumpPressed: canMove && this.input.wasPressed('jump'),
      jumpHeld: canMove && this.input.isDown('jump'),
      dashPressed: canMove && this.input.wasPressed('dash'),
      slideHeld: canMove && this.input.isDown('slide'),
      slidePressed: canMove && this.input.wasPressed('slide'),
      yaw: this.yaw,
    };
    if (this.alive && worldDt > 0) {
      const step = 1 / 120;
      this.acc += worldDt;
      let first = true;
      while (this.acc >= step) {
        this.acc -= step;
        this.motor.step(first ? inp : { ...inp, jumpPressed: false, dashPressed: false, slidePressed: false }, step);
        first = false;
      }
      this.handleMotorEvents();
    }

    // camera basis for weapons
    const eye = this.eyePos();
    this.camera.position.copy(eye);
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.updateMatrixWorld();
    this.fwd.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.right.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    this.tmpEye.copy(eye);

    if (!this.paused || link.online) this.weapons.update(worldDt, this.input, this.weaponCtx(), mouse);

    // remote entities
    const smp = this.snaps.sample(now, link.interpDelay);
    if (smp) {
      this.enemies.applySnapshot(smp.a, smp.b, smp.t, now);
      const prevPl = new Map(smp.a.pl.map((p) => [p[0], p]));
      for (const p of smp.b.pl) {
        const r = this.remotes.get(p[0]);
        if (r) r.apply(prevPl.get(p[0]), p, smp.t);
      }
    }
    const serverNow = this.snaps.serverNow(now);
    this.hazards.update(worldDt, serverNow, this.probe(), now);
    this.enemies.update(worldDt, now);
    for (const r of this.remotes.values()) {
      const snap = this.snaps.latest?.pl.find((p) => p[0] === r.id);
      r.update(worldDt, snap ? Math.hypot(snap[4], snap[6]) : 0);
    }
    this.fx.update(worldDt);
    this.world.update(worldDt, this.time);
    this.style.update(worldDt, this.phase === 'combat');

    // music intensity follows the fight and the style rank
    const combat = this.phase === 'combat' && this.enemies.views.size > 0;
    this.audio.setIntensity(combat ? 0.55 + this.style.rank * 0.07 : 0.12);

    // upload our state
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / PLAYER_SEND_RATE) {
      this.sendAcc = 0;
      const m = this.motor;
      let f = 0;
      if (m.grounded) f |= PF.grounded;
      if (m.sliding) f |= PF.sliding;
      if (m.dashing) f |= PF.dashing;
      if (m.slamming) f |= PF.slamming;
      if (this.input.isDown('fire')) f |= PF.firing;
      link.state({
        p: [r2(m.pos.x), r2(m.pos.y), r2(m.pos.z)], v: [r2(m.vel.x), r2(m.vel.y), r2(m.vel.z)],
        yaw: r2(this.yaw), pitch: r2(this.pitch), f, w: WEAPON_ORDER.indexOf(this.weapons.current), s: Math.floor(this.style.total),
      });
    }

    // death camera
    if (!this.alive) {
      this.deadT += dt;
      const left = Math.max(0, PLAYER.respawnTime - this.deadT);
      this.hud.setCenter(link.online && this.phase !== 'over' ? `YOU DIED — RESPAWN IN ${Math.ceil(left)}` : 'YOU DIED');
    }

    this.updateCamera(dt);
    this.updatePost(dt);
    this.hud.update(dt, {
      hp: this.hp, stamina: this.motor.stamina, weapon: this.weapons.current, coins: this.weapons.coins, coreCd: this.weapons.coreCd,
      style: this.style, wave: this.wave, waves: WAVES.length, title: this.waveTitle, left: this.waveLeft, phase: this.phase,
      timer: this.phaseTimer, boss: this.bossInfo(), ping: link.ping, online: link.online,
    });
    const partner = [...this.remotes.values()][0];
    this.hud.setPartner(partner ? partner.name : null, partner?.hp ?? 0, partner?.alive ?? false);
    this.audio.setListener(eye, this.yaw);
    this.renderer.render(this.world.scene, this.camera, this.alive ? this.weapons.vmScene : null, this.weapons.vmCam);
    this.input.endFrame();
  }

  private bossInfo(): { hp: number; max: number } | null {
    const b = this.enemies.boss;
    if (!b) return null;
    const coop = this.remotes.size > 0 ? 1.5 : 1;
    return { hp: b.effectiveHp, max: ENEMIES.colossus.hp * coop };
  }

  private eyePos(): THREE.Vector3 {
    const m = this.motor;
    return new THREE.Vector3(m.pos.x, m.pos.y + this.eyeH - this.landDip, m.pos.z);
  }

  private handleMotorEvents(): void {
    const m = this.motor;
    for (const e of m.events) {
      switch (e.t) {
        case 'jump':
          this.audio.synth('jump', 0.7);
          if (e.kind === 'wall') { this.audio.play('step', { volume: 0.6, pitch: 1.2 }); this.style.add('WALLJUMP', 8); }
          if (e.kind === 'slam') { this.audio.play('whoosh', { volume: 0.6, pitch: 0.8 }); this.style.add('SLAMJUMP', 15); }
          if (e.kind === 'dash') this.style.add('DASHJUMP', 10);
          break;
        case 'land':
          if (e.speed > 8) {
            this.landDip = Math.min(0.35, e.speed * 0.012);
            this.audio.synth('land', Math.min(1, e.speed / 30));
            if (e.speed > 20) this.fx.dust(m.pos, 8, 2);
          }
          break;
        case 'dash':
          this.audio.play('whoosh', { volume: 0.8 });
          this.audio.synth('dash', 0.4);
          this.fovKick = 1;
          break;
        case 'slide':
          this.audio.play('step', { volume: 0.7, pitch: 0.6 });
          break;
        case 'slam':
          this.audio.play('whoosh', { volume: 0.7, pitch: 0.6 });
          break;
        case 'slamland': {
          const r = SLAM.radius, dmg = SLAM.baseDamage + e.fall * SLAM.damagePerMeter;
          this.link?.boom({ p: [r2(m.pos.x), r2(m.pos.y + 0.5), r2(m.pos.z)], r, d: dmg, k: 'slam' });
          this.fx.dust(m.pos, 26, 6);
          this.fx.shake(Math.min(0.8, 0.3 + e.fall * 0.03));
          this.landDip = 0.45;
          this.audio.play('metal_heavy', { volume: 1, pitch: 0.7 });
          this.audio.play('explosion_low', { volume: 0.6 });
          break;
        }
        case 'pad':
          this.audio.play('thruster', { volume: 0.8 });
          this.fx.sparks({ x: m.pos.x, y: m.pos.y + 0.2, z: m.pos.z }, 16, 6, COLORS.gold);
          break;
        case 'lava':
          this.link?.hurt({ src: 'lava', d: PLAYER.lavaDps * 0.25 });
          this.fx.fireTrail({ x: m.pos.x, y: m.pos.y + 0.2, z: m.pos.z }, COLORS.fire, 0.8);
          this.audio.play('explosion_small', { volume: 0.3, pitch: 1.8 });
          break;
        case 'step':
          this.audio.play('step', { volume: 0.25 });
          break;
      }
    }
    m.events.length = 0;
  }

  private updateCamera(dt: number): void {
    const m = this.motor;
    const wantEye = !this.alive ? 0.3 : m.sliding ? PLAYER.slideEyeHeight : PLAYER.eyeHeight;
    this.eyeH += (wantEye - this.eyeH) * Math.min(1, dt * (this.alive ? 14 : 3));
    this.landDip = Math.max(0, this.landDip - dt * 1.6);
    const strafe = (this.input.isDown('right') ? 1 : 0) - (this.input.isDown('left') ? 1 : 0);
    const wantRoll = !this.alive ? 0.5 : (-strafe * 0.018) + (m.sliding ? 0.05 : 0);
    this.roll += (wantRoll - this.roll) * Math.min(1, dt * 8);
    this.fovKick = Math.max(0, this.fovKick - dt * 4);
    const speed = Math.hypot(m.vel.x, m.vel.z);
    const fov = this.settings.fov + this.fovKick * 8 + Math.max(0, speed - 16) * 0.35;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 10);
      this.camera.updateProjectionMatrix();
    }
    const eye = this.eyePos();
    const shake = this.fx.shakeOffset(this.time);
    this.camera.position.set(eye.x + shake.x, eye.y + shake.y, eye.z);
    this.camera.rotation.set(this.pitch + shake.y * 0.5, this.yaw + shake.x * 0.5, this.roll + shake.z * 2);
    this.weapons.vmCam.rotation.z = shake.z;
  }

  private updatePost(dt: number): void {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 1.8);
    this.flashAmt = Math.max(0, this.flashAmt - dt * 4);
    const p = this.renderer.post;
    p.hurt = this.hurtFlash;
    p.lowHp = this.alive && this.hp <= 30 ? 1 - this.hp / 30 : 0;
    if (this.fx.hitstop > 0.08) { this.flashAmt = 0.35; this.flashColor.set(0xfff4d0); }
    p.flash.copy(this.flashColor);
    p.flashAmount = this.flashAmt;
    p.saturation = this.alive ? 1.0 : 0.2;
  }

  // ------------------------------------------------------------------ attract mode

  private menuFrame(dt: number): void {
    const t = this.time * 0.05;
    this.camera.position.set(Math.sin(t) * 26, 9 + Math.sin(t * 2) * 2, Math.cos(t) * 26);
    this.camera.lookAt(0, 3, 0);
    if (Math.abs(this.camera.fov - 80) > 0.1) { this.camera.fov = 80; this.camera.updateProjectionMatrix(); }
    this.fx.update(dt);
    this.world.update(dt, this.time);
    this.renderer.post.hurt = 0;
    this.renderer.post.lowHp = 0;
    this.renderer.post.flashAmount = 0;
    this.renderer.post.saturation = 1;
    this.renderer.render(this.world.scene, this.camera, null, null);
    this.input.endFrame();
  }

  /** Debug/test hook exposed on window for automated captures. */
  debugState(): Record<string, unknown> {
    return {
      mode: this.mode, phase: this.phase, wave: this.wave, left: this.waveLeft, hp: this.hp, alive: this.alive,
      pos: { ...this.motor.pos }, enemies: this.enemies.views.size, projectiles: this.hazards.projectiles.size,
      style: Math.round(this.style.total), rank: this.style.rank, weapon: this.weapons.current, fps: Math.round(this.fps),
      remotes: this.remotes.size, shots: this.weapons.shotsFired,
    };
  }
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
