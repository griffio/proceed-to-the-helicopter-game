import { MW, MH, F, FLOOR, O, OBJ, VEHICLES } from './defs.js';
import { Heap, cheb } from './util.js';

export const DIR4 = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export const DIR8 = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];
const EYE = 1.45, BODY = 1.35;

export class GameMap {
  constructor() {
    const n = MW * MH;
    this.w = MW; this.h = MH; this.n = n;
    this.floor = new Uint8Array(n).fill(F.SIDEWALK);
    this.obj = new Uint8Array(n);
    this.hp = new Float32Array(n);
    this.bh = new Float32Array(n);
    this.roof = new Uint8Array(n);
    this.bid = new Int16Array(n).fill(-1);
    this.veh = new Int16Array(n).fill(-1);
    this.ladder = new Int8Array(n).fill(-1);
    this.glass = new Uint8Array(n);
    this.smoke = new Uint8Array(n);
    this.mist = new Uint8Array(n);
    this.fire = new Uint8Array(n);
    this.lit = new Uint8Array(n);
    this.meta = new Uint16Array(n);
    this.vehicles = [];
    this.buildings = [];
    this.decor = [];
    this.marks = [];
    this.stains = [];
    this.version = 0;
    this.lzTiles = new Set();
  }

  idx(x, y) { return y * MW + x; }
  inb(x, y) { return x >= 0 && y >= 0 && x < MW && y < MH; }
  X(i) { return i % MW; }
  Y(i) { return (i / MW) | 0; }

  setObj(x, y, o, extra = {}) {
    const i = this.idx(x, y);
    this.obj[i] = o;
    this.hp[i] = extra.hp ?? OBJ[o].hp;
    if (o === O.WINDOW) this.glass[i] = 1;
    if (extra.meta !== undefined) this.meta[i] = extra.meta;
    return i;
  }

  isRoof(i) { return this.obj[i] === O.BUILDING && this.roof[i] === 1; }
  walkable(i) { return OBJ[this.obj[i]].walk || this.isRoof(i); }
  level(i) { return this.isRoof(i) ? 1 : 0; }
  standH(i) { return this.isRoof(i) ? this.bh[i] : FLOOR[this.floor[i]].h; }
  obstacleH(i) {
    const o = this.obj[i];
    if (o === O.BUILDING) return this.bh[i];
    return OBJ[o].h;
  }
  coverOf(i) { return OBJ[this.obj[i]].cover; }

  // Line of sight from tile A's eyes to a standing body at tile B.
  // Returns -1 if blocked, otherwise the amount of smoke/foliage crossed.
  los(ax, ay, bx, by, aerial = false) {
    if (ax === bx && ay === by) return 0;
    const ia = this.idx(ax, ay), ib = this.idx(bx, by);
    const h0 = aerial ? 9 : this.standH(ia) + EYE;
    const h1 = this.standH(ib) + BODY;
    const dx = bx - ax, dy = by - ay;
    const sx = Math.sign(dx), sy = Math.sign(dy);
    const tdx = dx ? 1 / Math.abs(dx) : Infinity, tdy = dy ? 1 / Math.abs(dy) : Infinity;
    let tmx = dx ? 0.5 / Math.abs(dx) : Infinity, tmy = dy ? 0.5 / Math.abs(dy) : Infinity;
    let x = ax, y = ay, smoke = 0;
    for (let guard = 0; guard < 400; guard++) {
      let t;
      if (Math.abs(tmx - tmy) < 1e-9) {
        t = tmx;
        // passing exactly through a corner: blocked only if both side cells block
        const lh = h0 + (h1 - h0) * t;
        const c1 = this._blocks(x + sx, y, lh, ax, ay, bx, by, aerial);
        const c2 = this._blocks(x, y + sy, lh, ax, ay, bx, by, aerial);
        if (c1 && c2) return -1;
        tmx += tdx; tmy += tdy; x += sx; y += sy;
      } else if (tmx < tmy) { t = tmx; tmx += tdx; x += sx; }
      else { t = tmy; tmy += tdy; y += sy; }
      if (x === bx && y === by) return smoke;
      const lh = h0 + (h1 - h0) * t;
      if (this._blocks(x, y, lh, ax, ay, bx, by, aerial)) return -1;
      const i = this.idx(x, y);
      if (this.smoke[i]) smoke += 1;
      if (this.obj[i] === O.TREE && lh < 4) smoke += 0.75;
    }
    return smoke;
  }

  _blocks(x, y, lh, ax, ay, bx, by, aerial) {
    if (!this.inb(x, y)) return true;
    const i = this.idx(x, y);
    const oh = this.obstacleH(i);
    if (oh <= lh) return false;
    if (!aerial && OBJ[this.obj[i]].peek) {
      const nearA = cheb(x, y, ax, ay) <= 1, nearB = cheb(x, y, bx, by) <= 1;
      if (nearA !== nearB) return false; // lean around cover next to shooter or target
    }
    return true;
  }

  // Can a unit at A see a unit at B? (smoke >= 2.5 blocks sight entirely)
  canSee(ax, ay, bx, by, aerial = false) {
    const s = this.los(ax, ay, bx, by, aerial);
    return s >= 0 && s < 2.5;
  }

  // Directional cover at target tile T against a shooter at S: 0, 1 (half) or 2 (full).
  coverFrom(tx, ty, sx, sy) {
    const ti = this.idx(tx, ty);
    const dx = sx - tx, dy = sy - ty, adx = Math.abs(dx), ady = Math.abs(dy);
    const tRoof = this.isRoof(ti);
    const shooterLower = this.standH(this.idx(sx, sy)) + 0.5 < this.standH(ti);
    let best = 0;
    const check = (cx, cy) => {
      const nx = tx + cx, ny = ty + cy;
      if (!this.inb(nx, ny) || (nx === sx && ny === sy)) return;
      const ni = this.idx(nx, ny);
      if (tRoof) {
        if (!this.isRoof(ni) && shooterLower) best = Math.max(best, 1); // parapet
        return;
      }
      if (this.isRoof(ni)) { best = 2; return; }
      best = Math.max(best, this.coverOf(ni));
    };
    if (adx > 0 && adx >= ady * 0.5) check(Math.sign(dx), 0);
    if (ady > 0 && ady >= adx * 0.5) check(0, Math.sign(dy));
    return best;
  }

  anyCover(tx, ty) {
    for (const [dx, dy] of DIR4) {
      const nx = tx + dx, ny = ty + dy;
      if (this.inb(nx, ny) && this.coverOf(this.idx(nx, ny)) > 0) return true;
    }
    return false;
  }

  // Max cover level around a tile (for UI shields).
  coverSides(tx, ty) {
    return DIR4.map(([dx, dy]) => {
      const nx = tx + dx, ny = ty + dy;
      if (!this.inb(nx, ny)) return 0;
      const ni = this.idx(nx, ny), ti = this.idx(tx, ty);
      if (this.isRoof(ti)) return this.isRoof(ni) ? 0 : 1;
      return this.isRoof(ni) ? 2 : this.coverOf(ni);
    });
  }

  ladderLink(a, b, d) {
    // ground a with ladder in direction d to roof b
    return this.ladder[a] === d && this.isRoof(b);
  }

  // Dijkstra flood. blocked(i) -> true if tile can't be entered.
  reach(sx, sy, maxCost, blocked, hazardCost = 0) {
    const n = this.n;
    const dist = new Float32Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const s = this.idx(sx, sy);
    dist[s] = 0;
    const heap = new Heap();
    heap.push(s, 0);
    while (heap.size) {
      const a = heap.pop();
      const da = dist[a];
      if (da > maxCost) continue;
      const ax = a % MW, ay = (a / MW) | 0, la = this.level(a);
      for (let k = 0; k < 8; k++) {
        const [dx, dy] = DIR8[k];
        const bx = ax + dx, by = ay + dy;
        if (!this.inb(bx, by)) continue;
        const b = by * MW + bx;
        if (!this.walkable(b) || blocked(b)) continue;
        const lb = this.level(b);
        let cost;
        if (k < 4) {
          if (la === lb) cost = 1;
          else if (la === 0 && this.ladderLink(a, b, k)) cost = 2.5;
          else if (la === 1 && this.ladderLink(b, a, (k + 2) % 4)) cost = 2.5;
          else continue;
        } else {
          if (la !== lb) continue;
          const i1 = ay * MW + bx, i2 = by * MW + ax;
          if (!this.walkable(i1) || !this.walkable(i2) || this.level(i1) !== la || this.level(i2) !== la) continue;
          cost = 1.5;
        }
        cost *= OBJ[this.obj[b]].moveCost;
        if (hazardCost && this.fire[b]) cost += hazardCost;
        const nd = da + cost;
        if (nd < dist[b] && nd <= maxCost) {
          dist[b] = nd; prev[b] = a;
          heap.push(b, nd);
        }
      }
    }
    return { dist, prev, start: s };
  }

  pathTo(reach, target) {
    if (!isFinite(reach.dist[target])) return null;
    const p = [];
    for (let c = target; c !== -1 && c !== reach.start; c = reach.prev[c]) p.push(c);
    p.reverse();
    return p;
  }

  vehicleAt(i) { const v = this.veh[i]; return v >= 0 ? this.vehicles[v] : null; }

  // Applies damage to whatever occupies tile i. Pushes world events into `ev`.
  damageTile(i, dmg, ev) {
    const o = this.obj[i];
    if (o === O.NONE || o === O.DOOR || o === O.RUBBLE) return;
    const x = this.X(i), y = this.Y(i);
    const p = OBJ[o];
    if (p.vehicle) {
      const v = this.vehicleAt(i);
      if (!v || v.wreck) return;
      v.hp -= dmg;
      ev.push({ type: 'hitVehicle', v });
      if (v.hp <= 0) {
        v.wreck = true;
        for (const t of v.tiles) this.fire[t] = 3;
        const e = VEHICLES[v.kind].explode;
        ev.push({ type: 'explode', x: v.cx, y: v.cy, ...e, cause: v.kind });
        this.version++;
      } else if (VEHICLES[v.kind].alarm && !v.alarmed) {
        v.alarmed = true;
        ev.push({ type: 'alarm', x: v.cx, y: v.cy });
      }
      return;
    }
    if (o === O.WINDOW && this.glass[i]) {
      this.glass[i] = 0;
      ev.push({ type: 'glass', x, y });
      this.version++;
    }
    this.hp[i] -= dmg;
    if (this.hp[i] > 0) return;
    // destroyed
    const wasRoof = this.isRoof(i);
    this.obj[i] = p.to;
    this.hp[i] = OBJ[p.to].hp;
    if (o === O.BUILDING) {
      this.bh[i] = 0; this.roof[i] = 0;
      if (this.floor[i] === F.INTERIOR) this.floor[i] = F.DIRT;
      this.decor = this.decor.filter((d) => d.i !== i);
    }
    ev.push({ type: 'destroy', x, y, obj: o, wasRoof });
    if (p.explode) ev.push({ type: 'explode', x: x + 0.5, y: y + 0.5, ...p.explode, cause: p.name });
    if (p.mist) {
      for (const [dx, dy] of [[0, 0], ...DIR8]) {
        const nx = x + dx, ny = y + dy;
        if (!this.inb(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        this.smoke[ni] = Math.max(this.smoke[ni], 3); this.mist[ni] = 1;
      }
      ev.push({ type: 'mist', x, y });
    }
    if (o === O.LAMP) this.computeLit();
    this.version++;
  }

  computeLit() {
    this.lit.fill(0);
    const light = (cx, cy, r) => {
      for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(MH - 1, Math.ceil(cy + r)); y++)
        for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(MW - 1, Math.ceil(cx + r)); x++)
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.lit[y * MW + x] = 1;
    };
    for (let i = 0; i < this.n; i++) {
      if (this.obj[i] === O.LAMP) light(this.X(i) + 0.5, this.Y(i) + 0.5, 5.5);
      if (this.fire[i]) light(this.X(i) + 0.5, this.Y(i) + 0.5, 3.5);
    }
    for (const d of this.decor) if (d.kind === 'neon') light(d.lx, d.lz, 3.5);
  }
}
