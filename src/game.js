import { MW, MH, O, OBJ, WEAPONS, ITEMS, AGENTS, ENEMIES, DIFFICULTY } from './defs.js';
import { generateMap } from './mapgen.js';
import { dist, cheb, angleDiff, clamp, lerp, lin, rgb, scale3 } from './util.js';
import { FX } from './fx.js';
import { SceneBuilder, lightMatrix, CH, CHX, CHZ, NCH } from './scene.js';
import { Camera, FlatList } from './renderer.js';
import { DIR4 } from './map.js';
import { EnemyAI } from './ai.js';

const AGENT_HALF = 1.05, PERIPH = 2.5;
const MOON_DIR = (() => { const v = [-0.55, 1.0, -0.35]; const l = Math.hypot(...v); return v.map((c) => c / l); })();
const ri = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

export class Game {
  constructor({ audio, ui, seed, difficulty }) {
    this.audio = audio; this.ui = ui;
    this.seed = seed; this.diffKey = difficulty; this.diff = DIFFICULTY[difficulty];
    const gen = generateMap(seed, difficulty);
    this.map = gen.map; this.lz = gen.lz;
    const n = MW * MH;
    this.occ = new Array(n).fill(null);
    this.visible = new Uint8Array(n);
    this.explored = new Uint8Array(n);
    this.fogCur = new Float32Array(n);
    this.fogData = new Uint8Array(n * 4);
    this.units = []; this.nextId = 1;
    this.fx = new FX();
    this.scene = new SceneBuilder();
    this.camera = new Camera();
    this.lightVP = lightMatrix(MOON_DIR);
    this.anims = [];
    this.time = 0;
    this.turn = 1; this.phase = 'intro';
    this.alarm = false; this.reinforceIn = 3;
    this.drones = [];
    this.stats = { kills: 0, extracted: 0, lost: 0, shots: 0, hits: 0, destroyed: 0 };
    this.mode = 'move'; this.selected = null; this.preview = null; this.action = null; this.target = null; this.aoe = null;
    this.busy = false;
    this.rv = 0;
    this.lines = { halfway: false, lzNear: false, sniper: false };
    this.decals = new FlatList(16, 8192);
    this.partsA = new FlatList(12, 4096); this.partsD = new FlatList(12, 4096); this.beams = new FlatList(12, 1024);
    this.coneCache = new Map();
    this.heli = { x: this.lz.cx + 0.6, z: this.lz.cy, y: 4.2, rot: 0, leaving: 0 };

    for (let k = 0; k < AGENTS.length; k++) this.addAgent(AGENTS[k], ...gen.start[k]);
    for (const e of gen.enemies) this.addEnemy(e);
    for (const i of this.map.lzTiles) this.explored[i] = 1;
    this.ai = new EnemyAI(this);
    this.updateVision();
    this.fogCur.set(this.visible);
    this.camera.tx = this.lz.cx - 6; this.camera.tz = this.lz.cy; this.camera.dist = 34;
  }

  // ---------- units ----------
  get agents() { return this.units.filter((u) => u.side === 'agent'); }
  get enemies() { return this.units.filter((u) => u.side === 'enemy'); }
  alive(u) { return u && !u.dead && !u.extracted; }
  idx(x, y) { return y * MW + x; }

  addAgent(def, x, y) {
    const u = {
      id: this.nextId++, side: 'agent', key: def.key, def, name: def.name, role: def.role, color: def.color,
      x, y, rx: x + 0.5, rz: y + 0.5, ry: 0, facing: 0, rfacing: 0, walk: 0,
      hp: def.hp, maxHp: def.hp, aim: def.aim, mob: def.mob, vision: def.vision,
      weapons: def.weapons.map((k) => ({ key: k, ammo: WEAPONS[k].ammo, max: WEAPONS[k].ammo })),
      items: { ...def.items }, abilities: def.abilities, ap: 2, moved: false,
      overwatch: false, hunker: false, shadow: 0, cooldown: {}, downed: false, bleed: 0, dead: false, extracted: false,
    };
    this.units.push(u); this.occ[this.idx(x, y)] = u;
    return u;
  }

  addEnemy(s) {
    const d = ENEMIES[s.type];
    const u = {
      id: this.nextId++, side: 'enemy', type: s.type, def: d, name: d.name, color: d.color,
      x: s.x, y: s.y, rx: s.x + 0.5, rz: s.y + 0.5, ry: this.map.standH(this.idx(s.x, s.y)), facing: s.facing, rfacing: s.facing, walk: 0,
      hp: d.hp, maxHp: d.hp, aim: d.aim + this.diff.aim, mob: d.mob, vision: d.vision,
      weapon: d.weapon, grenades: d.grenades || 0, officer: !!d.officer,
      state: s.alerted ? 'alerted' : 'unaware', pod: s.pod ?? this.nextId * 7, patrol: s.patrol || null, patrolIdx: 1, follower: !!s.follower,
      guard: !!s.guard, baseFacing: s.facing, investigate: null, susTurns: 0, lastKnown: s.lastKnown || null,
      overwatch: false, hunker: false, suppressedBy: null, panic: false, mark: null, dead: false, seen: false, discovered: false,
    };
    this.units.push(u); this.occ[this.idx(s.x, s.y)] = u;
    return u;
  }

  setPos(u, x, y) {
    const i0 = this.idx(u.x, u.y);
    if (this.occ[i0] === u) this.occ[i0] = null;
    u.x = x; u.y = y;
    const i = this.idx(x, y);
    if (!this.occ[i]) this.occ[i] = u;
  }

  isVisible(u) { return u.side === 'agent' ? !u.extracted : !u.dead ? this.visible[this.idx(u.x, u.y)] === 1 : this.explored[this.idx(u.x, u.y)] === 1; }

  // ---------- animation helpers ----------
  tween(dur, fn) {
    if (dur <= 0) { fn(1); return Promise.resolve(); }
    return new Promise((res) => this.anims.push({ t: 0, dur, fn, res }));
  }
  sleep(ms) { return this.tween(ms / 1000, () => {}); }
  focus(x, z, force = false) {
    const c = this.camera;
    const halfW = Math.tan(c.fov / 2) * c.dist * c.aspect * 0.55, halfH = Math.tan(c.fov / 2) * c.dist * 0.5;
    if (force || Math.abs(x - c.tx) > halfW || Math.abs(z - c.tz) > halfH) c.goal = [x, z];
  }

  update(dt) {
    this.time += dt;
    for (let k = this.anims.length - 1; k >= 0; k--) {
      const a = this.anims[k];
      a.t += dt;
      const p = Math.min(1, a.t / a.dur);
      a.fn(p);
      if (p >= 1) { this.anims.splice(k, 1); a.res(); }
    }
    const c = this.camera;
    if (c.goal) {
      const k = 1 - Math.exp(-dt * 5);
      c.tx += (c.goal[0] - c.tx) * k; c.tz += (c.goal[1] - c.tz) * k;
      if (Math.abs(c.goal[0] - c.tx) < 0.05 && Math.abs(c.goal[1] - c.tz) < 0.05) c.goal = null;
    }
    c.tx = clamp(c.tx, 6, MW - 6); c.tz = clamp(c.tz, 4, MH - 2);
    c.shake = this.fx.shake * 0.6;
    for (const u of this.units) {
      const d = angleDiff(u.facing, u.rfacing);
      u.rfacing += d * Math.min(1, dt * 12);
      if (!u.moving) u.ry = this.map.standH(this.idx(u.x, u.y));
    }
    this.fx.update(dt, this.map, this.time);
    // fog smoothing
    const fc = this.fogCur, v = this.visible, fd = this.fogData, ex = this.explored;
    const k = Math.min(1, dt * 7);
    for (let i = 0; i < fc.length; i++) {
      fc[i] += (v[i] - fc[i]) * k;
      fd[i * 4] = fc[i] * 255; fd[i * 4 + 1] = ex[i] * 255;
    }
    this.audio.listener.x = c.tx; this.audio.listener.z = c.tz; this.audio.listener.zoom = c.dist;
    this.heli.rot += dt * 22;
  }

  // ---------- vision ----------
  castVision(out, x, y, facing, r, half, aerial = false) {
    const m = this.map;
    const r2 = r * r;
    for (let ty = Math.max(0, y - r); ty <= Math.min(MH - 1, y + r); ty++)
      for (let tx = Math.max(0, x - r); tx <= Math.min(MW - 1, x + r); tx++) {
        const dx = tx - x, dy = ty - y, d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        if (d2 > PERIPH * PERIPH && half < Math.PI && Math.abs(angleDiff(Math.atan2(dy, dx), facing)) > half) continue;
        const i = ty * MW + tx;
        if (out[i]) continue;
        if (m.canSee(x, y, tx, ty, aerial)) out[i] = 1;
      }
  }

  updateVision() {
    const v = this.visible;
    v.fill(0);
    for (const a of this.agents) {
      if (!this.alive(a)) continue;
      if (a.downed) this.castVision(v, a.x, a.y, 0, 2, Math.PI);
      else this.castVision(v, a.x, a.y, a.facing, a.vision, AGENT_HALF);
      v[this.idx(a.x, a.y)] = 1;
    }
    for (const d of this.drones) this.castVision(v, d.x, d.y, 0, ITEMS.drone.r, Math.PI, true);
    const newly = [];
    for (let i = 0; i < v.length; i++) if (v[i]) this.explored[i] = 1;
    for (const e of this.enemies) {
      const was = e.seen;
      e.seen = !e.dead && v[this.idx(e.x, e.y)] === 1;
      if (e.seen && !e.discovered) { e.discovered = true; newly.push(e); }
      if (e.seen && !was) e.lastSeenTurn = this.turn;
    }
    if (newly.length && this.phase === 'player' && this.selected) this.audio.voice(this.selected.key, 'spotted');
    return newly;
  }

  inCone(u, tx, ty, half) {
    return Math.abs(angleDiff(Math.atan2(ty - u.y, tx - u.x), u.facing)) <= half;
  }

  // Detection range of an enemy against an agent, accounting for light, smoke and stealth.
  detectRange(e, a) {
    const i = this.idx(a.x, a.y);
    if (a.shadow > 0) return 2.2;
    if (this.map.smoke[i]) return 2.2;
    let r = e.vision * (this.map.lit[i] ? 1 : 0.6);
    if (e.vigilant) r += 2;
    return r;
  }

  enemySees(e, a) {
    if (!this.alive(a) || e.dead || e.panic) return false;
    const d = dist(e.x, e.y, a.x, a.y);
    if (e.state === 'alerted') {
      if (d > e.vision || (a.shadow > 0 && d > 3)) return false;
    } else {
      if (d > this.detectRange(e, a)) return false;
      const half = e.state === 'suspicious' || e.vigilant ? 1.22 : 0.87;
      if (d > 1.5 && !this.inCone(e, a.x, a.y, half)) return false;
    }
    return this.map.canSee(e.x, e.y, a.x, a.y);
  }

  // Tiles an unaware enemy would notice an agent on (for the red vision cones).
  enemyCone(e) {
    const key = `${e.id}:${e.x}:${e.y}:${e.facing.toFixed(2)}:${e.state}:${this.map.version}:${this.map.smokeVersion || 0}`;
    const c = this.coneCache.get(e.id);
    if (c && c.key === key) return c.tiles;
    const tiles = [];
    const half = e.state === 'suspicious' || e.vigilant ? 1.22 : 0.87;
    const r = e.vision + (e.vigilant ? 2 : 0);
    const m = this.map;
    for (let ty = Math.max(0, e.y - r); ty <= Math.min(MH - 1, e.y + r); ty++)
      for (let tx = Math.max(0, e.x - r); tx <= Math.min(MW - 1, e.x + r); tx++) {
        const d = dist(e.x, e.y, tx, ty);
        const i = ty * MW + tx;
        if (d > r || !m.walkable(i)) continue;
        if (d > 1.5 && Math.abs(angleDiff(Math.atan2(ty - e.y, tx - e.x), e.facing)) > half) continue;
        const range = e.vision * (m.lit[i] ? 1 : 0.6) + (e.vigilant ? 2 : 0);
        if (d > range) continue;
        if (m.canSee(e.x, e.y, tx, ty)) tiles.push(i);
      }
    this.coneCache.set(e.id, { key, tiles });
    return tiles;
  }

  // ---------- noise / alerts ----------
  noise(x, y, radius, source) {
    if (radius <= 0) return;
    let voiced = false;
    for (const e of this.enemies) {
      if (e.dead || e.state === 'alerted') continue;
      const d = dist(e.x, e.y, x, y);
      if (d > radius) continue;
      e.state = 'suspicious';
      e.susTurns = 3;
      e.investigate = { x: clamp(Math.round(x + (Math.random() - 0.5) * 4), 0, MW - 1), y: clamp(Math.round(y + (Math.random() - 0.5) * 4), 0, MH - 1) };
      e.facing = Math.atan2(y - e.y, x - e.x);
      if (e.seen) {
        this.ui.float(e, '?', 'sus');
        if (!voiced) { voiced = true; this.audio.voice(Math.random() < 0.5 ? 'enemyA' : 'enemyB', 'alert', { world: [e.x, e.y] }); }
      }
    }
  }

  async alertEnemy(e, agent, { sting = true } = {}) {
    if (e.dead || e.state === 'alerted') return;
    const list = [e];
    for (const o of this.enemies) {
      if (o === e || o.dead || o.state === 'alerted') continue;
      if (o.pod === e.pod || (dist(o.x, o.y, e.x, e.y) <= 5 && this.map.canSee(o.x, o.y, e.x, e.y))) list.push(o);
    }
    for (const o of list) {
      o.state = 'alerted';
      o.lastKnown = { x: agent.x, y: agent.y };
      o.facing = Math.atan2(agent.y - o.y, agent.x - o.x);
      o.investigate = null;
      if (o.seen || o === e) this.ui.float(o, '!', 'alert');
    }
    if (sting) this.audio.play('enemy_alert', { vol: 0.8 });
    this.audio.voice(Math.random() < 0.5 ? 'enemyA' : 'enemyB', 'contact', { world: [e.x, e.y], priority: true });
    if (!this.alarm && this.phase === 'player') this.ui.warn('SPOTTED! Silence every witness before the enemy turn — or they raise the alarm.');
    this.ui.refresh();
  }

  async raiseAlarm() {
    if (this.alarm) return;
    this.alarm = true;
    this.reinforceIn = 2;
    this.ui.banner('ALARM RAISED', 'Reinforcements are on the way');
    this.audio.voice('overlord', 'alarm', { priority: true });
    this.audio.loop('alarm_loop', 0.15, this.audio.sfxBus);
    setTimeout(() => this.audio.stopLoop('alarm_loop'), 9000);
    this.audio.loopVolume('tension_loop', 0.55);
    const known = this.enemies.filter((e) => !e.dead && e.state === 'alerted' && e.lastKnown).map((e) => e.lastKnown);
    for (const e of this.enemies) {
      if (e.dead || e.state === 'alerted') continue;
      e.vigilant = true;
      const near = known.find((k) => dist(k.x, k.y, e.x, e.y) < 16);
      if (near && e.type !== 'sniper') { e.state = 'suspicious'; e.susTurns = 4; e.investigate = { ...near }; }
    }
  }

  // ---------- combat ----------
  weaponOf(u) { return u.side === 'agent' ? u.weapons[u.wi || 0].key : u.weapon; }

  // Full hit chance breakdown for shooter (at sx,sy) against target (unit or {tile}).
  shotInfo(u, target, wk, sx = u.x, sy = u.y, opts = {}) {
    const W = WEAPONS[wk];
    const m = this.map;
    const isUnit = !!target.side;
    const tx = isUnit ? target.x : m.X(target.tile), ty = isUnit ? target.y : m.Y(target.tile);
    const d = dist(sx, sy, tx, ty);
    const res = { ok: false, chance: 0, crit: 0, mods: [], cover: 0, d, reason: '' };
    if (d > W.range) { res.reason = 'Out of range'; return res; }
    const s = m.los(sx, sy, tx, ty);
    if (s < 0 || (isUnit && s >= 2.5)) { res.reason = 'No line of sight'; return res; }
    const mods = res.mods;
    let aim = u.aim;
    mods.push(['Aim', u.aim]);
    const rm = Math.round(W.rangeMod(d));
    if (rm) mods.push([rm > 0 ? 'Good range' : 'Poor range', rm]);
    let crit = W.crit;
    if (!isUnit) {
      mods.push(['Stationary object', 20]);
    } else {
      // squadsight
      if (u.side === 'agent' && d > u.vision) {
        if (!W.squadsight || !this.visible[this.idx(tx, ty)]) { res.reason = 'Beyond sight range'; return res; }
        mods.push(['Squadsight', -15]);
      }
      let cover = m.coverFrom(tx, ty, sx, sy);
      if (W.pierce && cover > 0) { cover--; mods.push(['Laser burns through cover', 0]); }
      res.cover = cover;
      if (cover === 2) mods.push(['Full cover', -40]);
      else if (cover === 1) mods.push(['Half cover', -20]);
      else if (m.anyCover(tx, ty) || target.side === 'agent') { mods.push(['Flanked', 0]); crit += 40; res.flanked = true; }
      else { mods.push(['Exposed', 0]); crit += 25; res.flanked = true; }
      if (target.hunker && cover > 0) mods.push(['Hunkered down', -25]);
      const hs = m.standH(this.idx(sx, sy)), ht = m.standH(this.idx(tx, ty));
      if (hs > ht + 1) mods.push(['Height advantage', 15]);
      else if (ht > hs + 1) mods.push(['Target elevated', -10]);
      if (m.smoke[this.idx(tx, ty)]) mods.push(['Target in smoke', -25]);
      if (s > 0) mods.push(['Smoke/foliage in the way', -Math.round(s * 12)]);
      // field of view
      const facing = opts.facing ?? u.facing;
      if (u.side === 'agent' && !opts.ignoreFacing && Math.abs(angleDiff(Math.atan2(ty - sy, tx - sx), facing)) > AGENT_HALF) mods.push(['Outside field of view (snap turn)', -10]);
      if (target.side === 'enemy' && target.state !== 'alerted') { mods.push(['Ambush — unaware target', 20]); crit += 30; }
      else if (Math.abs(angleDiff(Math.atan2(sy - ty, sx - tx), target.facing)) > 1.15) { mods.push(['Blindside — outside their view', 10]); crit += 15; }
      if (target.side === 'agent' && !m.lit[this.idx(tx, ty)] && d > 6) mods.push(['Darkness', -10]);
      if (target.shadow > 0) mods.push(['Target in the shadows', -25]);
      if (u.suppressedBy && this.alive(u.suppressedBy)) mods.push(['Suppressed', -40]);
      if (opts.reaction) mods.push(['Reaction shot', -15]);
      if (opts.aimed) mods.push(['Aimed shot', 25]);
      if (u.key === 'viper' && wk === 'sniper' && !u.moved) mods.push(['Steady aim', 10]);
    }
    for (const [, v] of mods.slice(1)) aim += v;
    res.ok = true;
    res.chance = clamp(Math.round(aim), 0, 100);
    res.crit = clamp(crit, 0, 100);
    return res;
  }

  canFire(u, wk) {
    const w = u.weapons ? u.weapons.find((x) => x.key === wk) : null;
    const W = WEAPONS[wk];
    if (u.ap < 1) return 'No actions left';
    if (W.twoAP && (u.ap < 2 || u.moved)) return 'Needs a full turn (cannot move first)';
    if (w && w.ammo <= 0) return 'Reload needed';
    return null;
  }

  muzzlePos(u) {
    const h = this.map.standH(this.idx(u.x, u.y));
    return [u.rx + Math.cos(u.rfacing) * 0.45, h + 0.72, u.rz + Math.sin(u.rfacing) * 0.45];
  }
  bodyPos(t) {
    if (t.side) return [t.rx, this.map.standH(this.idx(t.x, t.y)) + 0.85, t.rz];
    const x = this.map.X(t.tile), y = this.map.Y(t.tile);
    return [x + 0.5, Math.min(1.0, this.map.obstacleH(t.tile) * 0.6 + 0.3), y + 0.5];
  }

  async fire(u, target, wk, opts = {}) {
    const W = WEAPONS[wk];
    const info = this.shotInfo(u, target, wk, u.x, u.y, { ...opts, ignoreFacing: !!opts.reaction });
    if (!info.ok) return false;
    const tx = target.side ? target.x : this.map.X(target.tile), ty = target.side ? target.y : this.map.Y(target.tile);
    u.facing = Math.atan2(ty - u.y, tx - u.x);
    const visibleShot = this.isVisible(u) || (target.side && this.isVisible(target));
    if (visibleShot) this.focus((u.rx + tx + 0.5) / 2, (u.rz + ty + 0.5) / 2);
    await this.sleep(visibleShot ? 260 : 60);
    u.shadow = 0;
    if (u.side === 'agent' && !opts.reaction) this.audio.voice(u.key, 'attack');
    const hit = Math.random() * 100 < info.chance;
    const crit = hit && target.side && Math.random() * 100 < info.crit;
    const from = this.muzzlePos(u);
    const body = this.bodyPos(target);
    let end = body;
    if (!hit) {
      const ang = Math.atan2(body[2] - from[2], body[0] - from[0]) + (Math.random() < 0.5 ? 1 : -1) * (0.08 + Math.random() * 0.12);
      const L = Math.hypot(body[0] - from[0], body[2] - from[2]) + 1.5 + Math.random() * 2;
      end = [from[0] + Math.cos(ang) * L, 0.2 + Math.random() * 1.2, from[2] + Math.sin(ang) * L];
    }
    this.audio.play(W.sfx, { pos: [u.x, u.y] });
    if (W.kind === 'laser') {
      this.audio.play('laser_charge', { pos: [u.x, u.y], vol: 0.6 });
      await this.sleep(120);
      this.fx.laser(from, end);
    } else {
      const n = W.burst || 1;
      for (let k = 0; k < n; k++) {
        const jitter = k === n - 1 ? end : [end[0] + (Math.random() - 0.5) * 0.7, end[1] + (Math.random() - 0.5) * 0.4, end[2] + (Math.random() - 0.5) * 0.7];
        this.fx.muzzle(from[0], from[1], from[2], Math.cos(u.facing), Math.sin(u.facing), u.side === 'enemy' ? [1, 0.5, 0.3] : [1, 0.85, 0.5]);
        this.fx.tracer(from, jitter, W.tracer, wk === 'sniper' || wk === 'esniper' ? 0.07 : 0.045, wk === 'sniper' ? 0.25 : 0.1);
        if (k < n - 1) await this.sleep(55);
      }
    }
    await this.sleep(90);
    if (u.side === 'agent') { this.stats.shots++; if (hit) this.stats.hits++; }
    const wrec = u.weapons?.find((w) => w.key === wk);
    if (wrec && isFinite(wrec.ammo)) wrec.ammo--;
    if (target.side) {
      if (hit) {
        let dmg = ri(W.dmg[0], W.dmg[1]);
        if (crit) dmg = Math.ceil(dmg * 1.5);
        await this.damageUnit(target, dmg, { crit, source: u });
      } else {
        this.ui.float(target, 'MISS', 'miss');
        this.audio.play('bullet_whiz', { pos: [tx, ty], vol: 0.6 });
        // stray rounds chew through cover
        const ct = this.coverTileToward(tx, ty, u.x, u.y);
        if (ct >= 0 && (W.shred || Math.random() < 0.45)) {
          const ev = [];
          this.map.damageTile(ct, ri(W.dmg[0], W.dmg[1]) * (W.shred ? 1.5 : 1), ev);
          const vh = this.map.vehicleAt(ct);
          this.fx.impact(this.map.X(ct) + 0.5, 0.7, this.map.Y(ct) + 0.5, vh ? 'metal' : 'concrete');
          this.audio.play(vh ? 'impact_metal' : 'impact_concrete', { pos: [tx, ty], vol: 0.7 });
          await this.processEvents(ev);
        } else this.fx.impact(end[0], Math.max(0.1, end[1]), end[2]);
      }
      if (this.alive(target) && target.side === 'enemy') {
        if (target.state !== 'alerted') await this.alertEnemy(target, u);
        target.lastKnown = { x: u.x, y: u.y };
      }
    } else {
      // shooting an object
      const t = target.tile;
      const vh = this.map.vehicleAt(t);
      if (hit) {
        this.fx.impact(body[0], body[1], body[2], vh || this.map.obj[t] === O.LAMP ? 'metal' : 'concrete');
        this.audio.play(vh ? 'impact_metal' : 'impact_concrete', { pos: [tx, ty], vol: 0.8 });
        const ev = [];
        this.map.damageTile(t, ri(W.dmg[0], W.dmg[1]), ev);
        await this.processEvents(ev);
      } else {
        this.fx.impact(end[0], Math.max(0.1, end[1]), end[2]);
        this.ui.floatAt(tx, ty, 'MISS', 'miss');
      }
    }
    this.noise(u.x, u.y, W.noise, u);
    if (u.side === 'agent' && !opts.reaction) { u.ap = 0; u.overwatch = false; }
    return hit;
  }

  coverTileToward(tx, ty, sx, sy) {
    const dx = sx - tx, dy = sy - ty, adx = Math.abs(dx), ady = Math.abs(dy);
    const c = [];
    if (adx > 0 && adx >= ady * 0.5) c.push([Math.sign(dx), 0]);
    if (ady > 0 && ady >= adx * 0.5) c.push([0, Math.sign(dy)]);
    let best = -1, bc = 0;
    for (const [cx, cy] of c) {
      const nx = tx + cx, ny = ty + cy;
      if (!this.map.inb(nx, ny)) continue;
      const i = this.idx(nx, ny), cv = this.map.coverOf(i);
      if (cv > bc && this.map.obj[i] !== O.BUILDING) { bc = cv; best = i; }
    }
    return best;
  }

  async damageUnit(u, dmg, { crit = false, source = null, explosive = false, fall = false, burn = false } = {}) {
    if (!this.alive(u)) return;
    if (u.side === 'agent' && u.downed) {
      if (explosive || burn) { await this.killAgent(u); }
      return;
    }
    u.hp -= dmg;
    this.ui.float(u, (crit ? 'CRIT ' : '') + '-' + dmg, crit ? 'crit' : u.side === 'agent' ? 'hurt' : 'dmg');
    const bp = this.bodyPos(u);
    this.fx.impact(bp[0], bp[1], bp[2], 'blood');
    this.audio.play('body_hit', { pos: [u.x, u.y], vol: 0.7 });
    if (Math.random() < 0.6) this.map.stains.push({ x: u.rx + (Math.random() - 0.5) * 0.4, z: u.rz + (Math.random() - 0.5) * 0.4, s: 0.6 + Math.random() * 0.5, kind: 'blood', seed: Math.random() });
    if (u.hp > 0) {
      if (u.side === 'agent') this.audio.voice(u.key, 'hurt', { priority: true });
      this.ui.refresh();
      return;
    }
    u.hp = 0;
    if (u.side === 'agent') {
      u.downed = true; u.bleed = 3; u.overwatch = false; u.hunker = false; u.ap = 0;
      this.ui.float(u, 'DOWN — BLEEDING OUT', 'hurt');
      this.audio.play('body_fall', { pos: [u.x, u.y] });
      this.audio.voice('overlord', 'agent_down', { priority: true });
      for (const e of this.enemies) if (e.mark === u.id) e.mark = null;
    } else {
      u.dead = true;
      this.rv++;
      this.occ[this.idx(u.x, u.y)] === u && (this.occ[this.idx(u.x, u.y)] = null);
      this.stats.kills++;
      this.ui.float(u, 'KILLED', 'kill');
      this.audio.play('body_fall', { pos: [u.x, u.y] });
      if (source && source.side === 'agent') setTimeout(() => this.audio.voice(source.key, 'kill'), 500);
      // nearby friends react
      const witnesses = this.enemies.filter((e) => !e.dead && e.state !== 'alerted' && dist(e.x, e.y, u.x, u.y) < 9 && this.map.canSee(e.x, e.y, u.x, u.y));
      for (const w of witnesses) {
        if (source && this.map.canSee(w.x, w.y, source.x, source.y)) await this.alertEnemy(w, source, { sting: false });
        else { w.state = 'suspicious'; w.susTurns = 3; w.investigate = { x: u.x, y: u.y }; w.vigilant = true; if (w.seen) this.ui.float(w, '?', 'sus'); }
      }
      const friend = this.enemies.find((e) => !e.dead && dist(e.x, e.y, u.x, u.y) < 10 && e.state === 'alerted');
      if (friend && Math.random() < 0.6) this.audio.voice(Math.random() < 0.5 ? 'enemyA' : 'enemyB', 'mandown', { world: [friend.x, friend.y] });
      if (u.officer) {
        for (const e of this.enemies) if (!e.dead && dist(e.x, e.y, u.x, u.y) < 9) { e.panic = true; if (e.seen) this.ui.float(e, 'PANICKED', 'sus'); }
      }
    }
    this.ui.refresh();
    this.checkEnd();
  }

  async killAgent(u) {
    u.dead = true; u.downed = false; u.hp = 0;
    this.stats.lost++;
    if (this.occ[this.idx(u.x, u.y)] === u) this.occ[this.idx(u.x, u.y)] = null;
    this.ui.float(u, 'K.I.A.', 'kill');
    this.ui.banner(`${u.name} IS DOWN`, 'Agent killed in action');
    this.audio.voice('overlord', 'agent_down', { priority: true });
    if (this.selected === u) this.selected = null;
    this.ui.refresh();
    this.checkEnd();
  }

  // ---------- world events / explosions ----------
  async processEvents(ev) {
    let changed = false;
    while (ev.length) {
      const e = ev.shift();
      changed = true;
      switch (e.type) {
        case 'explode':
          await this.sleep(e.cause === 'tanker' ? 400 : 180);
          await this.explode(e.x, e.y, e.r, e.dmg, e.env, { cause: e.cause, vehicle: true }, ev);
          break;
        case 'glass':
          this.audio.play('glass_shatter', { pos: [e.x, e.y], vol: 0.8 });
          this.fx.chunks(e.x + 0.5, 1.2, e.y + 0.5, [0.4, 0.6, 0.8], 6, 2);
          break;
        case 'destroy': {
          const p = OBJ[e.obj];
          this.stats.destroyed++;
          this.fx.chunks(e.x + 0.5, e.obj === O.BUILDING ? 2 : 0.5, e.y + 0.5, p.debris || '#777', e.obj === O.BUILDING ? 14 : 8, e.obj === O.BUILDING ? 5 : 3.5);
          for (let k = 0; k < 4; k++) this.fx.spawn({ x: e.x + Math.random(), y: 0.6, z: e.y + Math.random(), vy: 0.6, size: 0.5, size1: 1.6, col: [0.45, 0.43, 0.4, 0.55], max: 2.5, shape: 2 });
          if ([O.WALL, O.BUILDING, O.STATUE, O.CONTAINER, O.KIOSK, O.WINDOW].includes(e.obj)) this.audio.play('wall_crumble', { pos: [e.x, e.y], vol: 0.8 });
          if (e.wasRoof) {
            const u = this.occ[this.idx(e.x, e.y)];
            if (u && this.alive(u)) { this.ui.float(u, 'FELL', 'hurt'); await this.damageUnit(u, 2, { fall: true }); }
          }
          break;
        }
        case 'alarm':
          this.audio.play('car_alarm', { pos: [e.x, e.y], vol: 0.8 });
          this.carAlarm = { x: e.x, z: e.y, until: this.time + 6 };
          this.noise(e.x, e.y, 13, null);
          this.ui.floatAt(e.x, e.y, 'CAR ALARM', 'sus');
          break;
        case 'mist':
          this.audio.play('hydrant', { pos: [e.x, e.y], vol: 0.8 });
          this.map.smokeVersion = (this.map.smokeVersion || 0) + 1;
          break;
        case 'hitVehicle': break;
      }
    }
    if (changed) { this.map.computeLit(); this.updateVision(); this.ui.refresh(); }
  }

  async explode(cx, cy, r, dmg, env, opts = {}, chain = null) {
    const m = this.map;
    this.fx.explosion(cx, cy, r);
    this.audio.play(opts.vehicle ? 'car_explode' : r >= 2.4 ? 'explosion_big' : 'explosion_small', { pos: [cx, cy] });
    m.stains.push({ x: cx, z: cy, s: r * 1.6, kind: 'scorch', seed: Math.random() });
    if (cheb(cx, cy, this.camera.tx, this.camera.tz) < 30) this.focus(cx, cy);
    const ev = chain || [];
    const own = !chain;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if (!m.inb(x, y)) continue;
      const d = dist(x + 0.5, y + 0.5, cx, cy);
      if (d > r) continue;
      const i = this.idx(x, y);
      m.damageTile(i, env * (d < r * 0.5 ? 1 : 0.6), ev);
      if (opts.vehicle && Math.random() < 0.3 && m.walkable(i)) m.fire[i] = Math.max(m.fire[i], 2);
    }
    for (const u of this.units) {
      if (!this.alive(u)) continue;
      const d = dist(u.x + 0.5, u.y + 0.5, cx, cy);
      if (d <= r + 0.25) {
        const k = d < r * 0.5 ? 1 : 0.7;
        await this.damageUnit(u, Math.max(1, Math.round(dmg * k)), { explosive: true });
        if (this.alive(u) && u.side === 'enemy' && u.state !== 'alerted') { u.state = 'suspicious'; u.investigate = { x: Math.round(cx), y: Math.round(cy) }; u.susTurns = 3; }
      }
    }
    this.noise(cx, cy, 24, null);
    m.version++;
    if (own) await this.processEvents(ev);
    else { m.computeLit(); this.updateVision(); }
  }

  // Rocket flies straight and detonates on the first solid thing in its path.
  rocketImpact(u, tx, ty) {
    const m = this.map;
    const sx = u.x + 0.5, sy = u.y + 0.5, ex = tx + 0.5, ey = ty + 0.5;
    const L = dist(sx, sy, ex, ey);
    const steps = Math.ceil(L * 4);
    const h0 = m.standH(this.idx(u.x, u.y)) + 1.2, h1 = m.standH(this.idx(tx, ty)) + 0.6;
    let last = [u.x, u.y];
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const x = Math.floor(sx + (ex - sx) * t), y = Math.floor(sy + (ey - sy) * t);
      if (x === u.x && y === u.y) continue;
      const i = this.idx(x, y);
      const h = h0 + (h1 - h0) * t;
      const unit = this.occ[i];
      if (unit && unit !== u && this.alive(unit)) return { x, y, hitAt: [x, y] };
      if (m.obstacleH(i) > h - 0.3 && !(x === tx && y === ty && m.obstacleH(i) < 1.5)) return { x, y, hitAt: [x, y], blocked: true, prev: last };
      last = [x, y];
    }
    return { x: tx, y: ty, hitAt: [tx, ty] };
  }

  async throwItem(u, item, tx, ty) {
    const I = ITEMS[item];
    const m = this.map;
    u.facing = Math.atan2(ty - u.y, tx - u.x);
    u.items[item]--;
    u.ap = item === 'drone' ? u.ap - 1 : 0;
    u.shadow = 0;
    this.focus((u.rx + tx) / 2, (u.rz + ty) / 2);
    await this.sleep(200);
    const from = this.muzzlePos(u);
    if (item === 'rocket') {
      const imp = this.rocketImpact(u, tx, ty);
      this.audio.voice(u.key, 'ability', { priority: true });
      this.audio.play('rocket_launch', { pos: [u.x, u.y] });
      this.fx.muzzle(from[0], from[1], from[2], Math.cos(u.facing), Math.sin(u.facing), [1, 0.6, 0.3]);
      for (let k = 0; k < 8; k++) this.fx.spawn({ x: u.rx - Math.cos(u.facing) * 0.6, y: from[1], z: u.rz - Math.sin(u.facing) * 0.6, vx: -Math.cos(u.facing) * 3 + (Math.random() - 0.5), vy: Math.random(), vz: -Math.sin(u.facing) * 3 + (Math.random() - 0.5), drag: 2, size: 0.3, size1: 1.0, col: [0.6, 0.6, 0.6, 0.5], max: 1.5, shape: 2 });
      const to = [imp.x + 0.5, Math.max(0.5, m.standH(this.idx(imp.x, imp.y)) + 0.8), imp.y + 0.5];
      if (imp.blocked) { const [px, py] = imp.prev; to[0] = (px + imp.x) / 2 + 0.5; to[2] = (py + imp.y) / 2 + 0.5; }
      await this.fx.projectile('rocket', from, to, Math.max(0.15, dist(from[0], from[2], to[0], to[2]) / 26), 0);
      await this.explode(to[0], to[2], I.r, I.dmg, I.env, {});
      this.noise(u.x, u.y, I.noise, u);
    } else {
      this.audio.play('grenade_throw', { pos: [u.x, u.y] });
      if (item === 'frag') this.audio.voice(u.key, 'ability', { priority: true });
      if (item === 'smoke' && u.key === 'sparks') this.audio.voice('sparks', 'ability');
      if (item === 'drone') { this.audio.play('drone', { pos: [u.x, u.y] }); this.audio.voice('doc', 'ability'); }
      const to = [tx + 0.5, m.standH(this.idx(tx, ty)) + 0.15, ty + 0.5];
      const d = dist(u.x, u.y, tx, ty);
      await this.fx.projectile(item === 'drone' ? 'drone' : item, from, item === 'drone' ? [to[0], 6, to[2]] : to, 0.35 + d * 0.05, item === 'drone' ? 0.5 : 1.5 + d * 0.25);
      if (item === 'frag') {
        const seen = this.enemies.find((e) => e.seen && !e.dead && dist(e.x, e.y, tx, ty) < 3);
        if (seen) this.audio.voice(Math.random() < 0.5 ? 'enemyA' : 'enemyB', 'grenade', { world: [seen.x, seen.y], priority: true });
        await this.sleep(150);
        await this.explode(to[0], to[2], I.r, I.dmg, I.env, {});
      } else if (item === 'smoke') {
        this.audio.play('smoke_grenade', { pos: [tx, ty] });
        for (let y = Math.floor(ty - I.r); y <= Math.ceil(ty + I.r); y++) for (let x = Math.floor(tx - I.r); x <= Math.ceil(tx + I.r); x++) {
          if (!m.inb(x, y) || dist(x, y, tx, ty) > I.r) continue;
          const i = this.idx(x, y);
          m.smoke[i] = I.turns; m.mist[i] = 0;
        }
        m.smokeVersion = (m.smokeVersion || 0) + 1;
        for (let k = 0; k < 30; k++) this.fx.spawn({ x: tx + 0.5, y: 0.4, z: ty + 0.5, vx: (Math.random() - 0.5) * 6, vy: Math.random() * 1.5, vz: (Math.random() - 0.5) * 6, drag: 2.5, size: 0.5, size1: 1.6, col: [0.6, 0.62, 0.65, 0.55], max: 3, shape: 2 });
        this.updateVision();
      } else if (item === 'drone') {
        this.drones.push({ x: tx, y: ty, turns: I.turns, rx: tx + 0.5, rz: ty + 0.5 });
        this.updateVision();
      }
    }
    this.ui.refresh();
  }

  // ---------- movement ----------
  reachFor(u, maxCost = u.ap * u.mob) {
    return this.map.reach(u.x, u.y, maxCost, (i) => {
      const o = this.occ[i];
      if (!o || o === u || !this.alive(o)) return false;
      if (o.side === u.side) return false; // pass through friends
      return u.side === 'agent' ? o.seen : true;
    }, u.side === 'enemy' ? 4 : 0);
  }

  async moveUnit(u, path, { ai = false } = {}) {
    if (!path || !path.length) return;
    const m = this.map;
    const showStart = this.isVisible(u);
    if (showStart) this.audio.play('footsteps', { pos: [u.x, u.y], vol: u.side === 'agent' ? 0.55 : 0.35 });
    u.moving = true;
    u.hunker = false;
    for (let s = 0; s < path.length; s++) {
      const t = path[s];
      if (!this.alive(u) || u.downed) break;
      const nx = t % MW, ny = (t / MW) | 0;
      const blocker = this.occ[t];
      if (blocker && blocker !== u && this.alive(blocker) && blocker.side !== u.side) {
        // bumped into a hidden enemy
        if (blocker.side === 'enemy') { blocker.seen = true; await this.alertEnemy(blocker, u); }
        break;
      }
      const fromH = m.standH(this.idx(u.x, u.y)), toH = m.standH(t);
      const climb = Math.abs(toH - fromH) > 1;
      const diag = nx !== u.x && ny !== u.y;
      u.facing = Math.atan2(ny - u.y, nx - u.x);
      const sx = u.rx, sz = u.rz;
      const vis = this.isVisible(u) || this.visible[t];
      const i0 = this.idx(u.x, u.y);
      if (this.occ[i0] === u) this.occ[i0] = null;
      u.x = nx; u.y = ny;
      this.rv++;
      if (vis) {
        if (u.side === 'agent' || (ai && vis)) this.focus(nx, ny);
        await this.tween(climb ? 0.5 : diag ? 0.2 : 0.15, (k) => { u.rx = lerp(sx, nx + 0.5, k); u.rz = lerp(sz, ny + 0.5, k); u.ry = lerp(fromH, toH, k); u.walk += 0.2; });
      } else { u.rx = nx + 0.5; u.rz = ny + 0.5; u.ry = toH; }
      const stop = await this.afterStep(u, s === path.length - 1);
      if (stop) break;
    }
    u.moving = false;
    // never end on top of someone
    const here = this.idx(u.x, u.y);
    if (this.occ[here] && this.occ[here] !== u && this.alive(this.occ[here])) {
      const r = this.map.reach(u.x, u.y, 6, (i) => !!this.occ[i] && this.alive(this.occ[i]));
      let best = -1, bd = Infinity;
      for (let i = 0; i < r.dist.length; i++) if (isFinite(r.dist[i]) && r.dist[i] < bd && (!this.occ[i] || !this.alive(this.occ[i]))) { bd = r.dist[i]; best = i; }
      if (best >= 0) { u.x = best % MW; u.y = (best / MW) | 0; u.rx = u.x + 0.5; u.rz = u.y + 0.5; }
    }
    if (this.alive(u)) this.occ[this.idx(u.x, u.y)] = u;
    if (u.side === 'agent') this.updateVision();
  }

  // Reactions after every single step. Returns true to stop moving.
  async afterStep(u, last) {
    const m = this.map;
    let stop = false;
    if (u.side === 'agent') {
      this.updateVision();
      for (const e of this.enemies) {
        if (e.dead || e.state === 'alerted') continue;
        if (this.enemySees(e, u)) { await this.alertEnemy(e, u); stop = false; }
      }
    } else if (u.state !== 'alerted') {
      for (const a of this.agents) if (this.enemySees(u, a)) { await this.alertEnemy(u, a); stop = true; break; }
    } else if (u.seen === false && this.visible[this.idx(u.x, u.y)]) {
      u.seen = true;
    }
    if (u.side === 'enemy') { const v = this.visible[this.idx(u.x, u.y)] === 1; if (v && !u.discovered) { u.discovered = true; } u.seen = v; }
    // overwatch & suppression reactions
    for (const w of this.units) {
      if (!this.alive(u) || u.downed) break;
      if (!this.alive(w) || w.side === u.side || (w.side === 'agent' && w.downed)) continue;
      const suppressing = u.suppressedBy === w;
      if (!w.overwatch && !suppressing) continue;
      const wk = this.weaponOf(w);
      if (w.side === 'agent') {
        if (this.weaponAmmo(w) <= 0) { w.overwatch = false; if (suppressing) u.suppressedBy = null; continue; }
        if (!u.seen && !this.map.canSee(w.x, w.y, u.x, u.y)) continue;
        if (!this.inCone(w, u.x, u.y, AGENT_HALF + 0.3) && !suppressing) continue;
      } else {
        if (w.state !== 'alerted' || !this.enemySees(w, u)) continue;
      }
      const info = this.shotInfo(w, u, wk, w.x, w.y, { reaction: true, ignoreFacing: true });
      if (!info.ok) continue;
      w.overwatch = false;
      if (suppressing) u.suppressedBy = null;
      this.audio.play('overwatch_trigger', { vol: 0.7 });
      this.ui.float(w, suppressing ? 'SUPPRESSION FIRE' : 'OVERWATCH', 'ow');
      await this.sleep(200);
      await this.fire(w, u, wk, { reaction: true });
      if (u.side === 'enemy' && this.alive(u)) stop = true;
    }
    if (this.alive(u) && m.fire[this.idx(u.x, u.y)]) { this.ui.float(u, 'BURNING', 'hurt'); await this.damageUnit(u, 1, { burn: true }); }
    return stop || !this.alive(u) || u.downed;
  }

  // ---------- player actions ----------
  select(u) {
    if (!u || u.side !== 'agent' || !this.alive(u)) return;
    if (this.selected !== u) this.audio.voice(u.key, 'select');
    this.selected = u;
    this.cancelAction();
    this.focus(u.rx, u.rz);
    this.audio.play('ui_select', { vol: 0.4 });
    this.ui.refresh();
  }

  cancelAction() {
    this.mode = 'move'; this.action = null; this.target = null; this.targets = []; this.aoe = null; this.preview = null;
    this._reach = null;
    this.ui.refresh();
  }

  currentReach() {
    const u = this.selected;
    if (!u || u.downed || u.ap <= 0) return null;
    const key = `${u.id}:${u.x}:${u.y}:${u.ap}:${this.map.version}:${this.rv}`;
    if (this._reach && this._reachKey === key) return this._reach;
    this._reachKey = key;
    this._reach = this.reachFor(u);
    return this._reach;
  }

  // Actions the selected agent can take (drives the action bar).
  actionsFor(u) {
    if (!u) return [];
    const acts = [];
    const noAp = u.ap < 1 ? 'No actions left' : null;
    if (u.downed) return [{ id: 'none', label: 'Bleeding out', icon: '✚', disabled: `Needs DOC's medkit within ${u.bleed} turn(s)` }];
    u.weapons.forEach((w, k) => {
      const W = WEAPONS[w.key];
      acts.push({ id: 'fire', wk: w.key, wi: k, label: W.name, icon: W.icon, kind: 'target', count: isFinite(w.ammo) ? `${w.ammo}/${w.max}` : '∞',
        disabled: this.canFire(u, w.key), hint: W.twoAP ? 'Full turn' : '' });
    });
    if (u.abilities.includes('suppress')) acts.push({ id: 'suppress', label: 'Suppress', icon: '≋', kind: 'target', disabled: noAp || (u.weapons[0].ammo < 2 ? 'Needs 2 ammo' : null), hint: 'Pins target: −40 aim; shoots if it moves' });
    if (u.abilities.includes('takedown')) acts.push({ id: 'takedown', label: 'Takedown', icon: '⚔', kind: 'target', disabled: noAp, hint: 'Silent melee kill' });
    for (const [it, n] of Object.entries(u.items)) {
      const I = ITEMS[it];
      const icon = { frag: '✹', smoke: '☁', rocket: '➶', drone: '⌬', medkit: '✚' }[it];
      acts.push({ id: it, label: I.name, icon, kind: it === 'medkit' ? 'heal' : 'aoe', count: n, disabled: n <= 0 ? 'None left' : noAp });
    }
    if (u.abilities.includes('shadow')) acts.push({ id: 'shadow', label: 'Shadow', icon: '◐', kind: 'instant', disabled: noAp || (u.cooldown.shadow > 0 ? `Cooldown ${u.cooldown.shadow}` : null), hint: 'Nearly invisible for 2 turns' });
    acts.push({ id: 'overwatch', label: 'Overwatch', icon: '◉', kind: 'instant', disabled: noAp || (this.weaponAmmo(u) <= 0 ? 'Reload needed' : null), hint: 'Shoot the first enemy that moves in view' });
    acts.push({ id: 'hunker', label: 'Hunker', icon: '⛉', kind: 'instant', disabled: noAp, hint: 'Doubles cover' });
    if (u.weapons.some((w) => isFinite(w.max) && w.ammo < w.max)) acts.push({ id: 'reload', label: 'Reload', icon: '↻', kind: 'instant', disabled: noAp });
    acts.push({ id: 'face', label: 'Look', icon: '👁', kind: 'face', disabled: null, hint: 'Free: turn to face a direction' });
    if (this.map.lzTiles.has(this.idx(u.x, u.y))) acts.unshift({ id: 'extract', label: 'EXTRACT', icon: '⇪', kind: 'instant', disabled: noAp, hot: true });
    return acts;
  }
  weaponAmmo(u) { const w = u.weapons[u.wi || 0]; return w.ammo; }

  // Begin an action from the action bar.
  startAction(a) {
    const u = this.selected;
    if (!u || this.busy || this.phase !== 'player') return;
    if (a.disabled) { this.audio.play('ui_error', { vol: 0.5 }); this.ui.toast(a.disabled); return; }
    this.audio.play('ui_select', { vol: 0.4 });
    this.preview = null;
    if (a.kind === 'instant') return this.doInstant(u, a.id);
    this.action = a;
    if (a.kind === 'face') { this.mode = 'face'; this.ui.toast('Tap where to look'); this.ui.refresh(); return; }
    if (a.kind === 'aoe') {
      this.mode = 'aoe'; this.aoe = null;
      const best = this.enemies.filter((e) => e.seen && !e.dead).sort((p, q) => dist(p.x, p.y, u.x, u.y) - dist(q.x, q.y, u.x, u.y))[0];
      if (best && a.id !== 'drone' && dist(best.x, best.y, u.x, u.y) <= ITEMS[a.id].range) this.setAoe(best.x, best.y);
      this.ui.toast(a.id === 'drone' ? 'Tap where to send the drone' : 'Tap a target area');
      this.ui.refresh(); return;
    }
    this.mode = 'target';
    this.targets = this.validTargets(u, a);
    if (a.kind === 'target' && a.id === 'fire') u.wi = a.wi;
    this.target = this.targets[0] || null;
    if (!this.target && a.kind !== 'heal') this.ui.toast(a.id === 'takedown' ? 'No adjacent enemy' : 'No visible targets — tap a car, barrel or lamp to shoot it');
    if (this.target) this.focusTarget();
    this.ui.refresh();
  }

  validTargets(u, a) {
    if (a.kind === 'heal') {
      return this.agents.filter((o) => this.alive(o) && cheb(o.x, o.y, u.x, u.y) <= 1 && (o.downed || o.hp < o.maxHp))
        .sort((p, q) => (q.downed - p.downed) || (p.hp / p.maxHp - q.hp / q.maxHp));
    }
    const list = this.enemies.filter((e) => !e.dead && e.seen);
    if (a.id === 'takedown') return list.filter((e) => cheb(e.x, e.y, u.x, u.y) <= 1 && this.map.level(this.idx(e.x, e.y)) === this.map.level(this.idx(u.x, u.y)));
    const wk = a.id === 'suppress' ? u.weapons[0].key : a.wk;
    return list.map((e) => ({ e, info: this.shotInfo(u, e, wk) })).filter((x) => x.info.ok)
      .sort((p, q) => q.info.chance - p.info.chance).map((x) => x.e);
  }

  focusTarget() {
    const t = this.target, u = this.selected;
    if (!t || !u) return;
    const tx = t.side ? t.rx : this.map.X(t.tile) + 0.5, tz = t.side ? t.rz : this.map.Y(t.tile) + 0.5;
    this.focus((u.rx + tx) / 2, (u.rz + tz) / 2);
  }

  targetInfo() {
    const u = this.selected, a = this.action, t = this.target;
    if (!u || !a || !t) return null;
    if (a.id === 'fire') return this.shotInfo(u, t, a.wk);
    if (a.id === 'suppress') return { ok: true, chance: 100, mods: [['Pins the target down', 0], ['Target aim', -40]], crit: 0 };
    if (a.id === 'takedown') {
      const c = t.state !== 'alerted' ? 95 : 65;
      return { ok: true, chance: c, crit: 0, mods: [[t.state !== 'alerted' ? 'Unaware target' : 'Target is alert', c]] };
    }
    if (a.kind === 'heal') return { ok: true, chance: 100, crit: 0, mods: [[t.downed ? 'Revive (3 HP)' : `Heal +${ITEMS.medkit.heal}`, 0]] };
    return null;
  }

  setAoe(tx, ty) {
    const u = this.selected, a = this.action;
    const I = ITEMS[a.id];
    if (!this.map.inb(tx, ty)) return;
    const d = dist(u.x, u.y, tx, ty);
    if (d > I.range) { this.ui.toast('Out of range'); this.audio.play('ui_error', { vol: 0.4 }); return; }
    if (!this.explored[this.idx(tx, ty)]) { this.ui.toast('Unknown area'); return; }
    if (a.id !== 'rocket' && a.id !== 'drone' && this.map.los(u.x, u.y, tx, ty) < 0) {
      // grenades arc over low obstacles but not through walls
      const s = this.throwClear(u, tx, ty);
      if (!s) { this.ui.toast('No clear throw'); this.audio.play('ui_error', { vol: 0.4 }); return; }
    }
    let impact = null;
    if (a.id === 'rocket') impact = this.rocketImpact(u, tx, ty);
    const cx = impact ? impact.x : tx, cy = impact ? impact.y : ty;
    this.aoe = { x: tx, y: ty, cx, cy, r: I.r, impact };
    this.audio.play('ui_select', { vol: 0.3 });
    this.ui.refresh();
  }

  throwClear(u, tx, ty) {
    const m = this.map;
    const sx = u.x + 0.5, sy = u.y + 0.5, ex = tx + 0.5, ey = ty + 0.5;
    const L = dist(sx, sy, ex, ey), n = Math.ceil(L * 3);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      const x = Math.floor(sx + (ex - sx) * t), y = Math.floor(sy + (ey - sy) * t);
      if ((x === u.x && y === u.y) || (x === tx && y === ty)) continue;
      const h = 1.2 + (1.5 + L * 0.25) * 4 * t * (1 - t);
      if (m.obstacleH(this.idx(x, y)) > h) return false;
    }
    return true;
  }

  aoeAffected() {
    if (!this.aoe) return [];
    const { cx, cy, r } = this.aoe;
    return this.units.filter((o) => this.alive(o) && (o.side === 'agent' || o.seen) && dist(o.x, o.y, cx, cy) <= r + 0.25);
  }

  async confirm() {
    const u = this.selected, a = this.action;
    if (!u || this.busy) return;
    if (this.mode === 'target' && this.target) {
      const t = this.target;
      this.busy = true; this.ui.refresh();
      try {
        if (a.id === 'fire') await this.fire(u, t, a.wk);
        else if (a.id === 'suppress') await this.suppress(u, t);
        else if (a.id === 'takedown') await this.takedown(u, t);
        else if (a.kind === 'heal') await this.medkit(u, t);
      } finally { this.busy = false; }
      this.afterAction(u);
    } else if (this.mode === 'aoe' && this.aoe) {
      this.busy = true; this.ui.refresh();
      try { await this.throwItem(u, a.id, this.aoe.x, this.aoe.y); } finally { this.busy = false; }
      this.afterAction(u);
    }
  }

  async doInstant(u, id) {
    if (id === 'overwatch') { u.overwatch = true; u.ap = 0; this.ui.float(u, 'OVERWATCH', 'ow'); this.audio.voice(u.key, 'overwatch', { priority: true }); }
    else if (id === 'hunker') { u.hunker = true; u.ap = 0; this.ui.float(u, 'HUNKERED', 'ow'); this.audio.play('hunker', { pos: [u.x, u.y] }); }
    else if (id === 'reload') { for (const w of u.weapons) if (isFinite(w.max)) w.ammo = w.max; u.ap -= 1; this.audio.play('reload', { pos: [u.x, u.y] }); this.ui.float(u, 'RELOADED', 'ow'); }
    else if (id === 'shadow') { u.shadow = 2; u.cooldown.shadow = 4; u.ap -= 1; this.ui.float(u, 'SHADOW', 'ow'); this.audio.voice('ghost', 'ability', { priority: true }); }
    else if (id === 'extract') { await this.extract(u); return; }
    this.afterAction(u);
  }

  async suppress(u, t) {
    u.facing = Math.atan2(t.y - u.y, t.x - u.x);
    this.audio.voice(u.key, 'attack');
    const W = WEAPONS[u.weapons[0].key];
    this.audio.play(W.sfx, { pos: [u.x, u.y] });
    const from = this.muzzlePos(u), b = this.bodyPos(t);
    for (let k = 0; k < 10; k++) {
      const end = [b[0] + (Math.random() - 0.5) * 2.2, 0.2 + Math.random() * 1.3, b[2] + (Math.random() - 0.5) * 2.2];
      this.fx.muzzle(from[0], from[1], from[2], Math.cos(u.facing), Math.sin(u.facing));
      this.fx.tracer(from, end, W.tracer);
      this.fx.impact(end[0], end[1], end[2]);
      await this.sleep(50);
    }
    u.weapons[0].ammo -= 2;
    t.suppressedBy = u;
    this.ui.float(t, 'SUPPRESSED', 'sus');
    if (t.state !== 'alerted') await this.alertEnemy(t, u);
    this.noise(u.x, u.y, W.noise, u);
    u.ap = 0;
  }

  async takedown(u, t) {
    const c = t.state !== 'alerted' ? 95 : 65;
    u.facing = Math.atan2(t.y - u.y, t.x - u.x);
    await this.tween(0.15, (k) => { u.rx = lerp(u.x + 0.5, (u.x + t.x) / 2 + 0.5, k * 0.6); u.rz = lerp(u.y + 0.5, (u.y + t.y) / 2 + 0.5, k * 0.6); });
    if (Math.random() * 100 < c) {
      this.ui.float(u, 'TAKEDOWN', 'kill');
      t.hp = 1;
      await this.damageUnit(t, 99, { source: u });
    } else {
      this.ui.float(t, 'RESISTED', 'miss');
      await this.alertEnemy(t, u);
    }
    await this.tween(0.15, (k) => { u.rx = lerp(u.rx, u.x + 0.5, k); u.rz = lerp(u.rz, u.y + 0.5, k); });
    u.ap = 0;
  }

  async medkit(u, t) {
    u.items.medkit--;
    u.ap -= 1;
    this.audio.play('medkit', { pos: [u.x, u.y] });
    this.audio.voice('doc', 'ability', { priority: true });
    if (t.downed) { t.downed = false; t.hp = 3; t.bleed = 0; this.ui.float(t, 'REVIVED', 'heal'); }
    else { const h = Math.min(ITEMS.medkit.heal, t.maxHp - t.hp); t.hp += h; this.ui.float(t, '+' + h, 'heal'); }
    for (let k = 0; k < 12; k++) this.fx.spawn({ x: t.rx, y: 0.6, z: t.rz, vx: (Math.random() - 0.5), vy: 1 + Math.random(), vz: (Math.random() - 0.5), size: 0.08, col: [0.4, 1, 0.6, 1], max: 1, add: true, shape: 3 });
  }

  async extract(u) {
    this.busy = true;
    u.ap = 0;
    this.audio.voice(u.key, 'extract', { priority: true });
    const sx = u.rx, sz = u.rz, sy = u.ry;
    u.moving = true;
    await this.tween(1.1, (k) => { u.rx = lerp(sx, this.heli.x, k); u.rz = lerp(sz, this.heli.z, k); u.ry = lerp(sy, this.heli.y - 1, k * k); });
    u.extracted = true; u.moving = false;
    if (this.occ[this.idx(u.x, u.y)] === u) this.occ[this.idx(u.x, u.y)] = null;
    this.stats.extracted++;
    setTimeout(() => this.audio.voice('pilot', 'boarded'), 1800);
    this.ui.banner(`${u.name} EXTRACTED`, `${this.stats.extracted} / 5 aboard`);
    this.busy = false;
    if (this.selected === u) this.selected = null;
    this.updateVision();
    this.checkEnd();
    this.afterAction(null);
  }

  afterAction(u) {
    this.cancelAction();
    this._reach = null;
    if (this.phase !== 'player') return;
    if (u && this.alive(u) && u.ap > 0) { this.ui.refresh(); return; }
    const next = this.agents.find((a) => this.alive(a) && !a.downed && a.ap > 0);
    if (next) { this.selected = next; this.focus(next.rx, next.rz); this.ui.refresh(); }
    else { this.selected = null; this.ui.refresh(); setTimeout(() => { if (this.phase === 'player' && !this.busy) this.endTurn(); }, 700); }
  }

  // Tap on a world tile (or a unit) during the player's turn.
  async tap(tile, unit, ground = tile) {
    if (this.phase !== 'player' || this.busy) return;
    const u = this.selected;
    const m = this.map;
    // in move/look modes, a tap on a car or prop means the floor behind it
    if ((this.mode === 'move' || this.mode === 'face' || this.mode === 'aoe') && tile >= 0 && !m.walkable(tile) && ground >= 0 && m.walkable(ground)) tile = ground;
    if (this.mode === 'face' && u && tile >= 0) {
      u.facing = Math.atan2(m.Y(tile) - u.y, m.X(tile) - u.x);
      this.updateVision();
      this.cancelAction();
      return;
    }
    if (this.mode === 'aoe' && tile >= 0) {
      if (this.aoe && this.aoe.x === m.X(tile) && this.aoe.y === m.Y(tile)) return this.confirm();
      this.setAoe(m.X(tile), m.Y(tile));
      return;
    }
    if (this.mode === 'target') {
      if (unit && this.targets.includes(unit)) {
        if (this.target === unit) return this.confirm();
        this.target = unit; this.focusTarget(); this.audio.play('ui_select', { vol: 0.3 }); this.ui.refresh(); return;
      }
      if (this.action.id === 'fire' && tile >= 0 && OBJ[m.obj[tile]].shootable && !unit) {
        const info = this.shotInfo(u, { tile }, this.action.wk);
        if (info.ok) {
          if (this.target && this.target.tile === tile) return this.confirm();
          this.target = { tile }; this.ui.refresh(); this.audio.play('ui_select', { vol: 0.3 }); return;
        }
        this.ui.toast(info.reason); return;
      }
      if (unit && unit.side === 'agent') { this.select(unit); return; }
      this.cancelAction();
      return;
    }
    // move mode
    if (unit && unit.side === 'agent' && this.alive(unit)) { this.select(unit); return; }
    if (!u) return;
    if (unit && unit.side === 'enemy' && unit.seen && !unit.dead) {
      const acts = this.actionsFor(u);
      const fire = acts.find((a) => a.id === 'fire' && !a.disabled && this.shotInfo(u, unit, a.wk).ok);
      if (fire) { this.startAction(fire); this.target = unit; this.focusTarget(); this.ui.refresh(); }
      else this.ui.toast(acts.find((a) => a.id === 'fire')?.disabled || 'No shot on that target');
      return;
    }
    if (tile < 0 || u.downed || u.ap <= 0) return;
    const r = this.currentReach();
    if (!r || !isFinite(r.dist[tile]) || tile === this.idx(u.x, u.y) || (this.occ[tile] && this.alive(this.occ[tile]) && this.occ[tile] !== u)) {
      this.preview = null; this.ui.refresh(); return;
    }
    if (this.preview && this.preview.tile === tile) {
      const path = this.preview.path;
      const ap = this.preview.ap;
      this.preview = null;
      this.busy = true; this.ui.refresh();
      u.ap -= ap; u.moved = true;
      if (Math.random() < 0.5) this.audio.voice(u.key, 'move');
      try { await this.moveUnit(u, path); } finally { this.busy = false; }
      this._reach = null;
      this.afterAction(u);
      this.checkMilestones(u);
      return;
    }
    const path = m.pathTo(r, tile);
    const cost = r.dist[tile];
    const ap = cost <= u.mob ? 1 : 2;
    const cone = this.enemies.some((e) => e.seen && !e.dead && e.state !== 'alerted' && this.enemyCone(e).includes(tile));
    this.preview = { tile, path, ap, cost, danger: cone, lit: !!m.lit[tile], cover: m.coverSides(m.X(tile), m.Y(tile)) };
    this.audio.play('ui_select', { vol: 0.25 });
    this.ui.refresh();
  }

  checkMilestones(u) {
    if (!this.lines.halfway && u.x > 50) { this.lines.halfway = true; setTimeout(() => this.audio.voice('overlord', 'halfway'), 900); }
    if (!this.lines.lzNear && u.x > 76) { this.lines.lzNear = true; setTimeout(() => this.audio.voice('pilot', 'lz_near', { priority: true }), 900); }
  }

  // ---------- turn flow ----------
  async start() {
    this.phase = 'intro';
    this.audio.loop('ambient_loop', 0.5);
    this.audio.loop('tension_loop', 0.28);
    this.audio.loop('heli_loop', 0.0, this.audio.sfxBus);
    this.ui.banner('PROCEED TO THE HELICOPTER', 'Extraction is on the far side of the city');
    const dur = this.audio.voice('overlord', 'intro', { priority: true }) || 4;
    const t0 = this.time;
    const sx = this.camera.tx;
    const tx = 8;
    await this.tween(Math.min(4.5, Math.max(3, dur * 0.3)), (k) => { const e = k * k * (3 - 2 * k); this.camera.tx = lerp(sx, tx, e); this.camera.tz = 30; this.camera.dist = lerp(34, 26, e); });
    void t0;
    this.phase = 'player';
    this.startPlayerTurn(true);
  }

  startPlayerTurn(first = false) {
    const m = this.map;
    if (!first) {
      this.turn++;
      for (let i = 0; i < m.n; i++) {
        if (m.smoke[i]) { m.smoke[i]--; if (!m.smoke[i]) m.mist[i] = 0; }
        if (m.fire[i]) m.fire[i]--;
      }
      m.smokeVersion = (m.smokeVersion || 0) + 1;
      m.computeLit();
      this.drones = this.drones.filter((d) => --d.turns > 0);
    }
    for (const a of this.agents) {
      if (!this.alive(a)) continue;
      a.overwatch = false; a.hunker = false; a.moved = false;
      if (a.shadow > 0) a.shadow--;
      for (const k in a.cooldown) if (a.cooldown[k] > 0) a.cooldown[k]--;
      if (a.downed) {
        a.ap = 0;
        if (!first && --a.bleed <= 0) this.killAgent(a);
        else this.ui.float(a, `BLEEDING OUT (${a.bleed})`, 'hurt');
      } else a.ap = 2;
    }
    for (const e of this.enemies) { e.suppressedBy = null; }
    this.phase = 'player';
    this.updateVision();
    if (this.checkEnd()) return;
    this.ui.banner(`TURN ${this.turn}`, this.alarm ? `ALARM RAISED — reinforcements in ${this.reinforceIn}` : 'You are undetected');
    this.audio.play('turn_player', { vol: 0.55 });
    const first1 = this.agents.find((a) => this.alive(a) && !a.downed);
    this.selected = first1 || null;
    if (first1 && !first) this.focus(first1.rx, first1.rz);
    if (this.turn % 7 === 0 && this.lines.lzNear) this.audio.voice('pilot', 'hurry');
    this.cancelAction();
    // if nobody can act (all downed), skip ahead
    if (!first1) setTimeout(() => this.endTurn(), 1200);
  }

  async endTurn() {
    if (this.phase !== 'player' || this.busy) return;
    this.cancelAction();
    this.selected = null;
    this.phase = 'enemy';
    this.busy = true;
    this.ui.refresh();
    this.ui.banner('ENEMY ACTIVITY', '');
    this.audio.play('turn_enemy', { vol: 0.5 });
    await this.sleep(700);
    if (!this.alarm && this.enemies.some((e) => !e.dead && e.state === 'alerted')) await this.raiseAlarm();
    if (this.alarm) {
      this.reinforceIn--;
      if (this.reinforceIn <= 0) { await this.reinforce(); this.reinforceIn = 3; }
    }
    try { await this.ai.takeTurn(); } catch (err) { console.error(err); }
    this.busy = false;
    if (this.phase === 'over') return;
    for (const e of this.enemies) if (e.panic) e.panic = false;
    this.startPlayerTurn();
  }

  async reinforce() {
    const front = Math.max(...this.agents.filter((a) => this.alive(a)).map((a) => a.x), 10);
    const n = this.diff.reinforce;
    const spawned = [];
    for (let k = 0; k < n; k++) {
      for (let tries = 0; tries < 60; tries++) {
        const x = clamp(Math.round(front + 8 + Math.random() * 14), 20, 95);
        const y = Math.random() < 0.5 ? 1 + Math.floor(Math.random() * 3) : MH - 2 - Math.floor(Math.random() * 3);
        const i = this.idx(x, y);
        if (!this.map.walkable(i) || this.occ[i] || this.map.isRoof(i)) continue;
        const near = this.agents.filter((a) => this.alive(a)).sort((p, q) => dist(p.x, p.y, x, y) - dist(q.x, q.y, x, y))[0];
        const e = this.addEnemy({ type: k === 0 && Math.random() < 0.4 ? 'gunner' : Math.random() < 0.3 ? 'grenadier' : 'trooper', x, y, facing: 0, alerted: true, lastKnown: near ? { x: near.x, y: near.y } : null, pod: 77777 + this.turn });
        e.state = 'alerted';
        spawned.push(e);
        this.fx.spawn({ x: x + 0.5, y: 0.5, z: y + 0.5, size: 0.6, size1: 2, col: [0.5, 0.5, 0.5, 0.5], max: 2, shape: 2 });
        break;
      }
    }
    if (spawned.length) {
      this.ui.banner('REINFORCEMENTS', `${spawned.length} hostiles inbound`);
      this.audio.voice('overlord', 'reinforce', { priority: true });
      await this.sleep(900);
    }
    this.updateVision();
  }

  checkEnd() {
    if (this.phase === 'over') return true;
    const left = this.agents.filter((a) => this.alive(a));
    if (left.length) return false;
    this.phase = 'over';
    const win = this.stats.extracted > 0;
    this.audio.stopLoop('tension_loop');
    this.audio.play(win ? 'victory' : 'defeat', { vol: 0.8 });
    setTimeout(() => this.audio.voice('overlord', win ? 'victory' : 'defeat', { priority: true }), 1500);
    if (win) this.tween(6, (k) => { this.heli.leaving = k; });
    setTimeout(() => this.ui.showEnd(win, this.stats, this.turn), 2200);
    return true;
  }

  // ---------- rendering ----------
  frame(renderer, cssW, cssH) {
    const m = this.map;
    if (this.scene.version !== m.version) this.scene.buildStatic(m);
    const cam = this.camera.matrices(cssW, cssH);
    const dyn = this.scene.dyn;
    dyn.box.clear(); dyn.cyl.clear(); dyn.sph.clear();
    const decals = this.decals; decals.clear();
    this.partsA.clear(); this.partsD.clear(); this.beams.clear();
    const view = this.viewRect(cssW, cssH);
    const visible = this._visChunks || (this._visChunks = new Uint8Array(NCH));
    for (let cz = 0; cz < CHZ; cz++) for (let cx = 0; cx < CHX; cx++)
      visible[cz * CHX + cx] = (cx + 1) * CH > view[0] && cx * CH < view[2] && (cz + 1) * CH > view[1] && cz * CH < view[3] ? 1 : 0;

    const dynLights = this.fx.dynLights();
    this.drawWorldDecals(decals);
    this.drawUnits(dyn, decals, dynLights);
    this.drawHeli(dyn, dynLights);
    this.drawUI(decals);
    for (const d of this.drones) {
      d.rx += (d.x + 0.5 - d.rx) * 0.1; d.rz += (d.y + 0.5 - d.rz) * 0.1;
      const y = 5.5 + Math.sin(this.time * 3) * 0.15;
      dyn.box.add(d.rx, y, d.rz, 0.5, 0.12, 0.5, this.time, [0.15, 0.15, 0.18], 0, 0, 0, 0, 1);
      for (const [ox, oz] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) dyn.cyl.add(d.rx + ox, y + 0.12, d.rz + oz, 0.35, 0.02, 0.35, 0, [0.4, 0.4, 0.45], 0, 0, 0, 0, 1);
      dyn.sph.add(d.rx, y - 0.1, d.rz, 0.12, 0.12, 0.12, 0, [0.3, 1, 0.5], 4, 3, 0, 0, 1);
      decals.push(d.x + 0.5, 0.12, d.y + 0.5, 0, ITEMS.drone.r * 2, ITEMS.drone.r * 2, 9, 0, 0.3, 1, 0.5, 0.35, 0.02, 0, 1, 0);
      dynLights.push([d.rx, y - 1, d.rz, 6, 0.4, 1, 0.6, 1.2]);
    }
    // fires light the scene
    const fires = [];
    for (const v of m.vehicles) if (v.wreck && v.tiles.some((t) => m.fire[t])) fires.push([v.cx, v.cy]);
    for (let i = 0; i < m.n && fires.length < 14; i++) if (m.fire[i] && m.veh[i] < 0) fires.push([m.X(i) + 0.5, m.Y(i) + 0.5]);
    for (const [x, z] of fires) dynLights.push([x, 1.4, z, 7, 1, 0.45, 0.12, 2.6 * (0.75 + 0.25 * Math.sin(this.time * 17 + x))]);
    if (this.carAlarm && this.time < this.carAlarm.until) {
      const on = Math.sin(this.time * 12) > 0;
      if (on) dynLights.push([this.carAlarm.x, 1.2, this.carAlarm.z, 5, 1, 0.6, 0.1, 2.5]);
    }
    this.fx.write({ pa: this.partsA, pd: this.partsD, beams: this.beams, decals }, dyn, this.time, this.camera.tx, this.camera.tz);
    const lights = this.scene.gatherLights(dynLights, this.camera.tx, this.camera.tz, this.time, view, this.explored);
    renderer.setFog(MW, MH, this.fogData);
    renderer.render({
      viewProj: cam.vp, lightVP: this.lightVP, camPos: cam.eye, camRight: cam.right, camUp: cam.up,
      mapW: MW, mapH: MH, time: this.time, moonDir: MOON_DIR, moonCol: [0.2, 0.24, 0.36], ambient: [0.05, 0.06, 0.09],
      lights, staticSets: this.scene.sets, staticVersion: this.scene.version, objCount: this.scene.objCount,
      draws: this.scene.drawRanges(visible), marks: this.scene.marks,
      dynSets: dyn, decals, partsAlpha: this.partsA, partsAdd: this.partsD, beams: this.beams,
    });
  }

  // World-space xz rectangle the camera can see: the frustum's footprint on the ground and at
  // rooftop height (tall buildings just off-screen still lean into view), plus a margin.
  viewRect(w, h) {
    const cam = this.camera;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      const { o, d } = cam.ray(px, py, w, h);
      for (const planeY of [0, 18]) {
        const t = d[1] < -0.02 ? (planeY - o[1]) / d[1] : 200;
        const x = o[0] + d[0] * Math.max(0, t), z = o[2] + d[2] * Math.max(0, t);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
    }
    const m = 3;
    return [x0 - m, z0 - m, x1 + m, z1 + m];
  }

  drawWorldDecals(decals) {
    const m = this.map;
    for (const s of m.stains) {
      if (s.kind === 'scorch') decals.push(s.x, 0.11, s.z, s.seed * 6, s.s, s.s, 4, 0, 0.01, 0.01, 0.01, 0.8, 0, s.seed, 0, 0);
      else decals.push(s.x, 0.11, s.z, s.seed * 6, s.s, s.s, 4, 0, 0.22, 0.0, 0.0, 0.75, 0, s.seed, 0, 0);
    }
    const lz = this.lz;
    const pulse = 0.55 + 0.3 * Math.sin(this.time * 3);
    decals.push((lz.x0 + lz.x1 + 1) / 2, 0.13, (lz.y0 + lz.y1 + 1) / 2, 0, lz.x1 - lz.x0 + 1, lz.y1 - lz.y0 + 1, 3, 0, 0.3, 1, 0.5, pulse, 0.05, 0, 1, 0);
    decals.push((lz.x0 + lz.x1 + 1) / 2, 0.12, (lz.y0 + lz.y1 + 1) / 2, 0, lz.x1 - lz.x0 + 1, lz.y1 - lz.y0 + 1, 0, 0, 0.2, 1, 0.4, 0.08, 0.2, 0, 1, 0);
  }

  drawUnits(dyn, decals, lights) {
    const m = this.map;
    for (const u of this.units) {
      if (u.extracted && !u.moving) continue;
      const isAgent = u.side === 'agent';
      const show = isAgent || (u.dead ? this.explored[this.idx(u.x, u.y)] && this.fogCur[this.idx(u.x, u.y)] > 0.05 : u.seen || this.fogCur[this.idx(u.x, u.y)] > 0.5 && u.seen);
      if (!show) continue;
      const y = u.ry;
      const col = lin(isAgent ? '#2a3038' : u.color);
      const acc = isAgent ? lin(u.color) : [1, 0.08, 0.04];
      const lying = u.dead || u.downed;
      const f = u.rfacing, cf = Math.cos(f), sf = Math.sin(f);
      const at = (fw, rt) => [u.rx + cf * fw - sf * rt, u.rz + sf * fw + cf * rt];
      if (lying) {
        const [bx, bz] = at(-0.3, 0);
        dyn.box.add(bx, y + 0.05, bz, 0.75, 0.22, 0.4, f, scale3(col, u.dead && !isAgent ? 0.6 : 1));
        const [hx, hz] = at(0.2, 0);
        dyn.sph.add(hx, y + 0.02, hz, 0.25, 0.25, 0.25, 0, isAgent ? lin('#c79a76') : lin('#2a2a2a'));
        if (isAgent && u.downed) {
          dyn.box.add(bx, y + 0.27, bz, 0.5, 0.06, 0.42, f, acc, 4, 1.5 + Math.sin(this.time * 6));
          decals.push(u.rx, y + 0.1, u.rz, 0, 1.3, 1.3, 1, 0, 1, 0.15, 0.1, 0.5 + 0.4 * Math.sin(this.time * 6), 0.12, 0, 1, 0);
        }
        continue;
      }
      const bob = u.moving ? Math.abs(Math.sin(u.walk * 3)) * 0.05 : 0;
      const yy = y + bob;
      const bulky = u.def?.bulky ? 1.18 : 1;
      dyn.box.add(u.rx, yy, u.rz, 0.24, 0.42, 0.34 * bulky, f, scale3(col, 0.7));
      dyn.box.add(u.rx, yy + 0.4, u.rz, 0.3 * bulky, 0.42, 0.46 * bulky, f, col);
      dyn.box.add(u.rx, yy + 0.66, u.rz, 0.32 * bulky, 0.1, 0.48 * bulky, f, acc, isAgent ? 4 : 0, isAgent ? 1.6 : 0.3);
      const [px, pz] = at(-0.2, 0);
      dyn.box.add(px, yy + 0.42, pz, 0.14, 0.34, 0.34, f, u.type === 'grenadier' ? lin('#3a4a22') : scale3(col, 0.8));
      dyn.sph.add(u.rx, yy + 0.8, u.rz, 0.27, 0.27, 0.27, 0, isAgent ? lin('#c79a76') : lin('#1d1d22'));
      if (!isAgent) {
        dyn.sph.add(u.rx, yy + 0.92, u.rz, 0.3, 0.16, 0.3, 0, lin(u.officer ? '#1a1a26' : '#2a2c30'));
        const [vx, vz] = at(0.11, 0);
        dyn.box.add(vx, yy + 0.9, vz, 0.07, 0.06, 0.2, f, [1, 0.05, 0.03], 4, 3.5);
        if (u.officer) dyn.cyl.add(u.rx, yy + 1.02, u.rz, 0.34, 0.04, 0.34, 0, [1, 0.75, 0.2], 4, 1.5);
      } else {
        dyn.sph.add(u.rx, yy + 0.86, u.rz, 0.29, 0.18, 0.29, 0, lin('#22262c'));
        const [gx, gz] = at(0.12, 0);
        dyn.box.add(gx, yy + 0.9, gz, 0.06, 0.07, 0.22, f, acc, 4, 2.5);
      }
      const wk = this.weaponOf(u);
      const glen = wk === 'sniper' || wk === 'esniper' ? 0.95 : wk === 'mg' || wk === 'emg' ? 0.75 : wk === 'laser' || wk === 'pistol' ? 0.35 : 0.6;
      const [wx, wz] = at(glen / 2 - 0.02, 0.17);
      dyn.box.add(wx, yy + 0.6, wz, glen, 0.08, 0.08, f, wk === 'laser' ? [0.6, 0.6, 0.7] : [0.05, 0.05, 0.06], wk === 'laser' ? 3 : 0);
      if (wk === 'mg' && u.items?.rocket > 0) {
        const [rx, rz] = at(-0.12, -0.12);
        dyn.cyl.add(rx, yy + 0.55, rz, 0.16, 0.9, 0.16, f, lin('#3b4a33'), 0, 0, -1.2);
      }
      if (isAgent) {
        // tactical light so agents read in the dark
        lights.push([u.rx + cf * 0.6, yy + 1.4, u.rz + sf * 0.6, 4, ...lin(u.color).map((c) => c * 0.5 + 0.2), 0.9]);
        const sel = this.selected === u;
        decals.push(u.rx, yy + 0.04, u.rz, 0, sel ? 1.25 : 1.05, sel ? 1.25 : 1.05, sel ? 9 : 1, 0, ...rgb(u.color), sel ? 0.95 : 0.6, sel ? 0.1 : 0.07, 0, 1, 0);
        if (u.overwatch) decals.push(u.rx, yy + 0.05, u.rz, f, 1.6, 1.6, 6, 0, 0.3, 0.8, 1, 0.5, 0, 0, 1, 0);
        if (u.shadow > 0) decals.push(u.rx, yy + 0.05, u.rz, 0, 1.6, 1.6, 2, 0, 0.3, 0.1, 0.5, 0.45, 0.6, 0, 1, 0);
      } else {
        const tgt = this.target === u;
        const c = u.state === 'alerted' ? [1, 0.15, 0.1] : u.state === 'suspicious' ? [1, 0.7, 0.1] : [0.9, 0.9, 0.9];
        decals.push(u.rx, yy + 0.04, u.rz, 0, 1.05, 1.05, 1, 0, ...c, 0.55, 0.07, 0, 1, 0);
        if (tgt) decals.push(u.rx, yy + 0.06, u.rz, this.time, 1.7, 1.7, 5, 0, 1, 0.2, 0.15, 0.95, 0, 0, 1, 0);
      }
    }
    // sniper laser sights (visible through fog)
    for (const e of this.enemies) {
      if (e.dead || !e.mark) continue;
      const a = this.units.find((x) => x.id === e.mark);
      if (!a || !this.alive(a)) continue;
      const from = [e.rx + Math.cos(e.rfacing) * 0.5, e.ry + 0.65, e.rz + Math.sin(e.rfacing) * 0.5];
      const to = [a.rx, a.ry + 0.8, a.rz];
      const flick = 0.75 + 0.25 * Math.sin(this.time * 9);
      this.beams.push(...from, 0.035, ...to, 3, 1, 0.08, 0.06, flick);
      decals.push(a.rx, a.ry + 0.06, a.rz, 0, 0.35, 0.35, 2, 0, 1, 0.1, 0.1, 0.9, 0.5, 0, 1, 0);
    }
  }

  drawHeli(dyn, lights) {
    const h = this.heli;
    const lv = h.leaving;
    const x = h.x + lv * lv * 40, y = h.y + Math.sin(this.time * 1.3) * 0.12 + lv * 18, z = h.z - lv * 10;
    const yaw = Math.PI + Math.sin(this.time * 0.4) * 0.05;
    const body = lin('#2b3326'), dark = lin('#161a14');
    const fw = (d) => [x + Math.cos(yaw) * d, z + Math.sin(yaw) * d];
    dyn.sph.add(x, y - 0.8, z, 3.4, 1.7, 1.8, yaw, body, 0, 0, 0, 0, 1);
    const [cx, cz] = fw(1.2);
    dyn.sph.add(cx, y - 0.55, cz, 1.4, 1.1, 1.4, yaw, [0.03, 0.05, 0.08], 3, 0.15, 0, 0, 1);
    const [tx, tz] = fw(-3.2);
    dyn.box.add(tx, y - 0.1, tz, 3.6, 0.35, 0.35, yaw, body, 0, 0, 0, 0, 1);
    const [fx, fz] = fw(-4.9);
    dyn.box.add(fx, y - 0.2, fz, 0.6, 1.1, 0.12, yaw, body, 0, 0, 0, 0, 1);
    dyn.box.add(fx, y + 0.35, fz + 0.1, 0.8, 0.05, 0.08, this.time * 40, dark, 0, 0, 0, 0, 1);
    for (const s of [-0.75, 0.75]) {
      const ox = -Math.sin(yaw) * s, oz = Math.cos(yaw) * s;
      dyn.box.add(x + ox, y - 1.45, z + oz, 3.0, 0.08, 0.1, yaw, dark, 0, 0, 0, 0, 1);
    }
    dyn.cyl.add(x, y + 0.85, z, 0.3, 0.35, 0.3, 0, dark, 0, 0, 0, 0, 1);
    for (let k = 0; k < 2; k++) dyn.box.add(x, y + 1.2, z, 7.5, 0.04, 0.32, h.rot + (k * Math.PI) / 2, dark, 0, 0, 0, 0, 1);
    const blink = Math.sin(this.time * 5) > 0.6 ? 4 : 0.5;
    const [lx, lz] = fw(-1);
    dyn.sph.add(lx - Math.sin(yaw) * 0.9, y - 0.6, lz + Math.cos(yaw) * 0.9, 0.15, 0.15, 0.15, 0, [1, 0.05, 0.05], 4, blink, 0, 0, 1);
    dyn.sph.add(lx + Math.sin(yaw) * 0.9, y - 0.6, lz - Math.cos(yaw) * 0.9, 0.15, 0.15, 0.15, 0, [0.05, 1, 0.2], 4, blink, 0, 0, 1);
    // sweeping searchlight
    const sw = this.time * 0.6;
    const gx = x + Math.cos(sw) * 3.5 - 1.5, gz = z + Math.sin(sw * 1.3) * 3.5;
    if (lv < 0.5) {
      lights.push([gx, 1.8, gz, 6.5, 0.8, 0.9, 1, 3.2]);
      this.beams.push(cx, y - 0.9, cz, 0.35, gx, 0.1, gz, 0.3, 0.6, 0.7, 0.8, 0.12);
      this.decals.push(gx, 0.14, gz, 0, 3.5, 3.5, 2, 0, 0.8, 0.9, 1, 0.12, 0.6, 0, 1, 0);
    }
    if (Math.random() < 0.5 && lv < 0.2) {
      const a = Math.random() * 6.28;
      this.fx.spawn({ x: x + Math.cos(a) * 2, y: 0.2, z: z + Math.sin(a) * 2, vx: Math.cos(a) * 4, vy: 0.3, vz: Math.sin(a) * 4, drag: 1.5, size: 0.3, size1: 1.0, col: [0.5, 0.5, 0.52, 0.25], max: 1.2, shape: 2, noFog: 1 });
    }
    // rotor volume follows how close the camera is
    const d = dist(this.camera.tx, this.camera.tz, x, z);
    this.audio.loopVolume('heli_loop', lv > 0.9 ? 0 : clamp(1 - d / 45, 0.03, 0.7));
  }

  drawUI(decals) {
    const m = this.map;
    const u = this.selected;
    if (this.phase !== 'player' || !u || this.busy) return;
    // enemy vision cones for visible unaware enemies
    for (const e of this.enemies) {
      if (!e.seen || e.dead || e.state === 'alerted') continue;
      const col = e.state === 'suspicious' ? [1, 0.6, 0.1] : [1, 0.15, 0.1];
      for (const i of this.enemyCone(e)) decals.push(m.X(i) + 0.5, m.standH(i) + 0.13, m.Y(i) + 0.5, 0, 0.96, 0.96, 0, 0, ...col, 0.16, 0.3, 0, 1, 0);
    }
    if (this.mode === 'move' && !u.downed && u.ap > 0) {
      const r = this.currentReach();
      if (r) {
        for (let i = 0; i < r.dist.length; i++) {
          const d = r.dist[i];
          if (!isFinite(d) || d === 0) continue;
          if (this.occ[i] && this.alive(this.occ[i])) continue;
          const one = d <= u.mob && u.ap >= 1;
          decals.push(m.X(i) + 0.5, m.standH(i) + 0.14, m.Y(i) + 0.5, 0, 0.92, 0.92, 0, 0, ...(one ? [0.2, 0.65, 1] : [1, 0.8, 0.2]), 0.17, 0.25, 0, 1, 0);
        }
      }
      const p = this.preview;
      if (p) {
        const pts = [this.idx(u.x, u.y), ...p.path];
        for (let k = 1; k < pts.length; k++) {
          const a = pts[k - 1], b = pts[k];
          const ax = m.X(a) + 0.5, az = m.Y(a) + 0.5, bx = m.X(b) + 0.5, bz = m.Y(b) + 0.5;
          const mx = (ax + bx) / 2, mz = (az + bz) / 2, len = Math.hypot(bx - ax, bz - az);
          decals.push(mx, Math.max(m.standH(a), m.standH(b)) + 0.16, mz, Math.atan2(bz - az, bx - ax), len, 0.12, 0, 0, 1, 1, 1, 0.75, 0.4, 0, 1, 0);
        }
        const dx = m.X(p.tile) + 0.5, dz = m.Y(p.tile) + 0.5, dh = m.standH(p.tile) + 0.17;
        const pc = p.danger ? [1, 0.25, 0.2] : p.ap === 1 ? [0.35, 0.8, 1] : [1, 0.85, 0.3];
        decals.push(dx, dh, dz, 0, 0.98, 0.98, 3, 0, ...pc, 1, 0.12, 0, 1, 0);
        p.cover.forEach((c, k) => {
          if (!c) return;
          const [ox, oz] = DIR4[k];
          const cc = c === 2 ? [0.3, 0.75, 1] : [1, 0.85, 0.35];
          decals.push(dx + ox * 0.42, dh + 0.01, dz + oz * 0.42, 0, ox ? 0.14 : 0.8, oz ? 0.14 : 0.8, 0, 0, ...cc, 0.95, 0.3, 0, 1, 0);
        });
      }
    }
    if (this.mode === 'aoe' && this.aoe) {
      const a = this.aoe;
      const r = a.r;
      decals.push(a.cx + 0.5, m.standH(this.idx(a.cx, a.cy)) + 0.2, a.cy + 0.5, 0, r * 2, r * 2, this.action.id === 'drone' ? 9 : 1, 0, ...(this.action.id === 'smoke' ? [0.7, 0.8, 0.9] : this.action.id === 'drone' ? [0.3, 1, 0.5] : [1, 0.35, 0.2]), 0.9, 0.04, 0, 1, 0);
      if (this.action.id !== 'drone') decals.push(a.cx + 0.5, m.standH(this.idx(a.cx, a.cy)) + 0.19, a.cy + 0.5, 0, r * 2, r * 2, 2, 0, ...(this.action.id === 'smoke' ? [0.6, 0.65, 0.7] : [1, 0.3, 0.15]), 0.2, 0.2, 0, 1, 0);
      if (a.impact) {
        const from = this.muzzlePos(u);
        this.beams.push(...from, 0.03, a.cx + 0.5, 1.0, a.cy + 0.5, 1, 1, 0.5, 0.2, 0.6);
        if (a.impact.blocked) decals.push(a.cx + 0.5, 0.2, a.cy + 0.5, 0, 0.9, 0.9, 5, 0, 1, 0.8, 0.2, 1, 0, 0, 1, 0);
      }
    }
    if (this.mode === 'target' && this.target && !this.target.side) {
      const t = this.target.tile;
      decals.push(m.X(t) + 0.5, 0.2, m.Y(t) + 0.5, this.time, 1.5, 1.5, 5, 0, 1, 0.3, 0.2, 0.95, 0, 0, 1, 0);
    }
  }
}
