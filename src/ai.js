import { MW, O, OBJ, ITEMS } from './defs.js';
import { dist, cheb } from './util.js';

const IDEAL = { trooper: 6, gunner: 8, grenadier: 6, officer: 7, sniper: 14 };

export class EnemyAI {
  constructor(game) { this.g = game; }

  async takeTurn() {
    const g = this.g;
    const near = (e) => Math.min(...g.agents.filter((a) => g.alive(a)).map((a) => dist(a.x, a.y, e.x, e.y)), 999);
    const order = g.enemies.filter((e) => !e.dead).sort((a, b) => (a.state === 'alerted') - (b.state === 'alerted') || near(a) - near(b));
    for (const e of order) {
      if (g.phase === 'over') return;
      if (e.dead) continue;
      e.overwatch = false; e.hunker = false;
      if (e.panic) { if (e.seen) { g.ui.float(e, 'PANICKED', 'sus'); await g.sleep(250); } continue; }
      const wasSeen = e.seen;
      await this.act(e);
      if (wasSeen || e.seen) await g.sleep(220);
    }
  }

  async act(e) {
    if (e.state === 'alerted') return this.combat(e);
    if (e.state === 'suspicious') return this.investigate(e);
    return this.idle(e);
  }

  // Path toward (tx,ty), truncated to maxCost and to tiles not occupied.
  pathToward(e, tx, ty, maxCost) {
    const g = this.g, m = g.map;
    const r = g.reachFor(e, 80);
    let goal = m.idx(tx, ty);
    if (!isFinite(r.dist[goal]) || (g.occ[goal] && g.occ[goal] !== e && g.alive(g.occ[goal]))) {
      // nearest reachable free tile to the goal
      let best = -1, bd = Infinity;
      for (let y = Math.max(0, ty - 4); y <= Math.min(m.h - 1, ty + 4); y++) for (let x = Math.max(0, tx - 4); x <= Math.min(MW - 1, tx + 4); x++) {
        const i = m.idx(x, y);
        if (!isFinite(r.dist[i]) || (g.occ[i] && g.occ[i] !== e && g.alive(g.occ[i]))) continue;
        const d = dist(x, y, tx, ty) * 10 + r.dist[i] * 0.1;
        if (d < bd) { bd = d; best = i; }
      }
      if (best < 0) return [];
      goal = best;
    }
    const full = m.pathTo(r, goal) || [];
    const out = [];
    for (const t of full) { if (r.dist[t] > maxCost) break; out.push(t); }
    while (out.length && g.occ[out[out.length - 1]] && g.alive(g.occ[out[out.length - 1]])) out.pop();
    return out;
  }

  async idle(e) {
    const g = this.g;
    if (e.patrol && e.patrol.length > 1) {
      let tx, ty;
      if (e.follower) {
        const lead = g.enemies.find((o) => o !== e && !o.dead && o.pod === e.pod && !o.follower);
        if (lead) { tx = lead.x; ty = lead.y; } else e.follower = false;
      }
      if (tx === undefined) {
        const wp = e.patrol[e.patrolIdx % e.patrol.length];
        [tx, ty] = wp;
        if (dist(e.x, e.y, tx, ty) < 2) { e.patrolIdx++; [tx, ty] = e.patrol[e.patrolIdx % e.patrol.length]; }
      }
      const path = this.pathToward(e, tx, ty, e.mob);
      if (e.follower && path.length) path.pop();
      await g.moveUnit(e, path, { ai: true });
    } else {
      e.scan = (e.scan || 0) + 1;
      const swing = e.type === 'sniper' ? 0.5 : 0.85;
      e.facing = e.baseFacing + [0, swing, 0, -swing][e.scan % 4];
      for (const a of g.agents) if (g.enemySees(e, a)) { await g.alertEnemy(e, a); break; }
    }
  }

  async investigate(e) {
    const g = this.g;
    if (!e.investigate) { e.state = 'unaware'; return; }
    const { x, y } = e.investigate;
    if (dist(e.x, e.y, x, y) > 1.5 && e.type !== 'sniper') {
      const path = this.pathToward(e, x, y, e.mob);
      await g.moveUnit(e, path, { ai: true });
      if (e.state === 'alerted' || e.dead) return;
    } else {
      e.facing += Math.PI * (0.5 + Math.random());
      for (const a of g.agents) if (g.enemySees(e, a)) { await g.alertEnemy(e, a); return; }
    }
    if (--e.susTurns <= 0) {
      e.state = 'unaware'; e.investigate = null; e.vigilant = true;
      e.patrol = null; e.guard = true; e.baseFacing = e.facing;
    }
  }

  knownAgents() {
    const g = this.g;
    const alerted = g.enemies.filter((o) => !o.dead && o.state === 'alerted' && !o.panic);
    return g.agents.filter((a) => g.alive(a) && !a.downed && alerted.some((o) => g.enemySees(o, a)));
  }

  async combat(e) {
    const g = this.g, m = g.map;
    const known = this.knownAgents();
    for (const a of known) for (const o of g.enemies) if (!o.dead && o.state === 'alerted' && (!o.lastKnown || dist(o.x, o.y, a.x, a.y) < dist(o.x, o.y, o.lastKnown.x, o.lastKnown.y))) o.lastKnown = { x: a.x, y: a.y };
    if (e.type === 'sniper') return this.sniper(e, known);
    // far from the fight: hold position and stay watchful instead of swarming
    const near = Math.min(...known.map((a) => dist(a.x, a.y, e.x, e.y)), e.lastKnown ? dist(e.lastKnown.x, e.lastKnown.y, e.x, e.y) : Infinity);
    if (near > 22) { e.facing += 0.7; e.vigilant = true; return; }
    const suppressed = e.suppressedBy && g.alive(e.suppressedBy);

    if (!known.length) {
      // hunt the last known position
      const lk = e.lastKnown;
      if (!lk || suppressed) { e.facing += 0.8; return; }
      const path = this.pathToward(e, lk.x, lk.y, e.mob * 2);
      await g.moveUnit(e, path, { ai: true });
      if (e.dead) return;
      if (dist(e.x, e.y, lk.x, lk.y) < 2.5) { e.lastKnown = null; e.state = 'suspicious'; e.susTurns = 2; e.investigate = null; e.vigilant = true; }
      if (this.knownAgents().length) { e.overwatch = true; if (e.seen) g.ui.float(e, 'OVERWATCH', 'ow'); }
      return;
    }

    // grenadier: punish clustered or well-covered agents
    if (e.grenades > 0 && !suppressed) {
      let best = null;
      for (const a of known) {
        if (dist(e.x, e.y, a.x, a.y) > ITEMS.frag.range) continue;
        const hits = known.filter((b) => dist(a.x, a.y, b.x, b.y) <= ITEMS.frag.r).length;
        const friendly = g.enemies.some((o) => !o.dead && dist(o.x, o.y, a.x, a.y) <= ITEMS.frag.r + 0.5);
        if (friendly) continue;
        const cover = m.coverFrom(a.x, a.y, e.x, e.y);
        const score = hits * 2 + cover;
        if (!best || score > best.score) best = { a, score };
      }
      if (best && best.score >= 3 && g.throwClear(e, best.a.x, best.a.y)) {
        e.grenades--;
        e.facing = Math.atan2(best.a.y - e.y, best.a.x - e.x);
        if (e.seen || g.visible[m.idx(best.a.x, best.a.y)]) g.focus(best.a.x, best.a.y);
        g.audio.voice(Math.random() < 0.5 ? 'enemyA' : 'enemyB', 'grenade', { world: [e.x, e.y], priority: true });
        g.audio.play('grenade_throw', { pos: [e.x, e.y] });
        const from = g.muzzlePos(e);
        const to = [best.a.x + 0.5, m.standH(m.idx(best.a.x, best.a.y)) + 0.15, best.a.y + 0.5];
        await g.fx.projectile('frag', from, to, 0.5 + dist(e.x, e.y, best.a.x, best.a.y) * 0.05, 2.5);
        await g.explode(to[0], to[2], ITEMS.frag.r, 3, ITEMS.frag.env, {});
        return;
      }
    }

    // reposition
    if (!suppressed) {
      const here = m.idx(e.x, e.y);
      const r = g.reachFor(e, e.mob);
      let cands = [];
      for (let i = 0; i < r.dist.length; i++) if (isFinite(r.dist[i]) && (!g.occ[i] || g.occ[i] === e || !g.alive(g.occ[i]))) cands.push(i);
      if (cands.length > 140) { cands = cands.filter((i) => i === here || Math.random() < 140 / cands.length); }
      let best = here, bestScore = this.scoreTile(e, e.x, e.y, known, 0) + 0.8;
      for (const i of cands) {
        if (i === here) continue;
        const s = this.scoreTile(e, m.X(i), m.Y(i), known, r.dist[i]);
        if (s > bestScore) { bestScore = s; best = i; }
      }
      if (best !== here) {
        const path = m.pathTo(r, best);
        if (Math.random() < 0.25) g.audio.voice(Math.random() < 0.5 ? 'enemyA' : 'enemyB', 'flank', { world: [e.x, e.y] });
        await g.moveUnit(e, path, { ai: true });
        if (e.dead || e.panic) return;
      }
    }

    // shoot
    const shots = this.knownAgents()
      .map((a) => ({ a, info: g.shotInfo(e, a, e.weapon) }))
      .filter((s) => s.info.ok)
      .map((s) => ({ ...s, score: s.info.chance + (s.a.hp <= 4 ? 15 : 0) + (s.info.flanked ? 10 : 0) - (s.a.shadow > 0 ? 30 : 0) }))
      .sort((p, q) => q.score - p.score);
    const pick = shots[0];
    if (pick && pick.info.chance >= (suppressed ? 25 : 12)) {
      await g.fire(e, pick.a, e.weapon);
    } else if (suppressed) {
      e.hunker = true;
      if (e.seen) g.ui.float(e, 'HUNKERED', 'ow');
    } else {
      e.overwatch = true;
      if (e.seen) g.ui.float(e, 'OVERWATCH', 'ow');
    }
  }

  scoreTile(e, tx, ty, known, cost) {
    const g = this.g, m = g.map;
    const i = m.idx(tx, ty);
    let s = 0, bestShot = 0, nearest = Infinity;
    const W = e.weapon;
    for (const a of known) {
      const d = dist(tx, ty, a.x, a.y);
      nearest = Math.min(nearest, d);
      if (!m.canSee(a.x, a.y, tx, ty)) { s += 0.6; continue; }
      const c = m.coverFrom(tx, ty, a.x, a.y);
      s += c === 2 ? 3 : c === 1 ? 1.4 : -3.2;
      const info = g.shotInfo(e, a, W, tx, ty, { ignoreFacing: true });
      if (info.ok) bestShot = Math.max(bestShot, info.chance + (info.flanked ? 12 : 0));
    }
    s += bestShot / 11;
    const ideal = IDEAL[e.type] || 6;
    if (nearest < Infinity) s -= Math.abs(nearest - ideal) * 0.22;
    if (nearest < 2) s -= 2;
    if (m.fire[i]) s -= 10;
    if (m.smoke[i]) s += 0.8;
    if (m.isRoof(i)) s += 0.6;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = tx + dx, ny = ty + dy;
      if (!m.inb(nx, ny)) continue;
      const ni = m.idx(nx, ny);
      const o = m.obj[ni];
      if (OBJ[o].explode) s -= 1.2;
      const v = m.vehicleAt(ni);
      if (v && !v.wreck && v.hp <= 5) s -= 1;
      const u = g.occ[ni];
      if (u && u !== e && u.side === 'enemy' && g.alive(u)) s -= 0.8;
    }
    return s - cost * 0.04;
  }

  async sniper(e, known) {
    const g = this.g;
    let target = e.mark ? g.agents.find((a) => a.id === e.mark) : null;
    if (target && (!g.alive(target) || target.downed || !g.enemySees(e, target))) { target = null; e.mark = null; }
    if (target) {
      const info = g.shotInfo(e, target, e.weapon, e.x, e.y, { aimed: true });
      if (info.ok) {
        if (e.seen || g.isVisible(target)) g.focus((e.x + target.x) / 2, (e.y + target.y) / 2);
        await g.fire(e, target, e.weapon, { aimed: true });
        if (g.alive(target) && !target.downed && g.enemySees(e, target)) e.mark = target.id; else e.mark = null;
        return;
      }
    }
    // paint a new target: they get one turn to break line of sight
    const vis = known.filter((a) => g.enemySees(e, a)).map((a) => ({ a, info: g.shotInfo(e, a, e.weapon) })).filter((x) => x.info.ok).sort((p, q) => q.info.chance - p.info.chance);
    if (vis.length) {
      const a = vis[0].a;
      e.mark = a.id;
      e.facing = Math.atan2(a.y - e.y, a.x - e.x);
      g.focus((e.x + a.x) / 2, (e.y + a.y) / 2);
      g.ui.float(a, 'SNIPER LASER!', 'hurt');
      g.ui.warn(`A sniper has painted ${a.name}. Break line of sight or smoke them before it fires!`);
      if (!g.lines.sniper) { g.lines.sniper = true; g.audio.voice('overlord', 'sniper_warn', { priority: true }); }
      await g.sleep(700);
    } else {
      e.facing += 0.6;
    }
  }
}
