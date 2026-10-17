import { MW, MH, F, FLOOR, O } from './defs.js';
import { lin, hash2, scale3, mix3, mat4 } from './util.js';
import { Instances, FlatList } from './renderer.js';
import { DIR4 } from './map.js';
import { tex } from './textures.js';
import { clamp } from './util.js';

// Static geometry is grouped into 10x10-tile chunks so the renderer can skip off-screen ones.
export const CH = 10, CHX = Math.ceil(MW / CH), CHZ = Math.ceil(MH / CH), NCH = CHX * CHZ;
export const chunkIndex = (x, z) => clamp(Math.floor(z / CH), 0, CHZ - 1) * CHX + clamp(Math.floor(x / CH), 0, CHX - 1);
const MESH = ['box', 'cyl', 'sph'];
const append = (dst, src) => {
  while ((dst.n + src.n) * 16 > dst.f.length) dst.grow();
  dst.f.set(src.f.subarray(0, src.n * 16), dst.n * 16);
  dst.n += src.n;
};

const CONTAINER_COLS = ['#8a3b26', '#2a5a7a', '#5a6b2a', '#a8742a', '#4a3a6a', '#6b6b6b'];
const WOOD = lin('#6e4c2a'), METAL = lin('#3a3d42'), DARK = lin('#141518'), CONCRETE = lin('#8d8a82');
const GLASS = lin('#0c1622'), CHAR = [0.012, 0.011, 0.01];

export class SceneBuilder {
  constructor() {
    this.sets = { box: new Instances(16384), cyl: new Instances(2048), sph: new Instances(1024) };
    this.dyn = { box: new Instances(2048), cyl: new Instances(512), sph: new Instances(512) };
    this.objCount = { box: 0, cyl: 0, sph: 0 };
    this.ranges = null;
    this.chunks = Array.from({ length: NCH }, () => ({ box: new Instances(64), cyl: new Instances(16), sph: new Instances(16), ground: new Instances(128) }));
    this.version = -1;
    this.staticLights = [];
    this.marks = new FlatList(16, 4096);
  }

  chunkAt(x, z) { return this.chunks[chunkIndex(x, z)]; }

  buildStatic(map) {
    for (const c of this.chunks) { c.box.clear(); c.cyl.clear(); c.sph.clear(); c.ground.clear(); }
    const lights = (this.staticLights = []);
    // ground is kept apart: it never casts shadows and is drawn last so early-z rejects hidden floor
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      const i = y * MW + x;
      if (map.obj[i] === O.BUILDING && map.bh[i] > 0) continue;
      const f = FLOOR[map.floor[i]];
      const v = 0.9 + hash2(x, y) * 0.2;
      this.chunkAt(x, y).ground.add(x + 0.5, -0.3, y + 0.5, 1, 0.3 + f.h, 1, 0, scale3(lin(f.col), v), tex(f.mat, f.tex));
    }

    const bcol = (i) => { const b = map.buildings[map.bid[i]]; return b ? lin(b.color) : CONCRETE; };
    const wallCol = (i) => {
      const m = map.meta[i];
      if (m === 999) return CONCRETE;
      const b = map.buildings[m];
      return b ? mix3(lin(b.color), [0.5, 0.48, 0.45], 0.45) : CONCRETE;
    };
    // facade per building, wall material per owner, with the odd tag or fly-poster on top
    const FACADES = ['brick', 'brick', 'concrete', 'stucco'];
    const facade = (bid) => FACADES[Math.floor(hash2(bid * 7 + 3, 11) * FACADES.length)];
    const wallBase = (i) => map.meta[i] === 999 || hash2(map.meta[i] * 3 + 1, 5) < 0.5 ? 'concrete' : 'brick';
    const wallTex = (i, x, y) => {
      const h = hash2(x * 5 + 2, y * 3 + 9);
      return h < 0.16 ? 'graffiti' : h < 0.24 ? 'posters' : wallBase(i);
    };
    const along = (x, y) => {
      // wall orientation: true if the wall runs along x
      const l = map.inb(x - 1, y) ? map.obj[map.idx(x - 1, y)] : 0, r = map.inb(x + 1, y) ? map.obj[map.idx(x + 1, y)] : 0;
      return [O.WALL, O.WINDOW, O.DOOR].includes(l) || [O.WALL, O.WINDOW, O.DOOR].includes(r);
    };

    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      const i = y * MW + x, o = map.obj[i];
      const { box, cyl, sph } = this.chunkAt(x, y);
      const cx = x + 0.5, cz = y + 0.5, h = hash2(x * 3 + 1, y * 7 + 2);
      const fh = FLOOR[map.floor[i]].h;
      switch (o) {
        case O.BUILDING: {
          const bh = map.bh[i];
          box.add(cx, 0, cz, 1, bh, 1, 0, bcol(i), tex(2, facade(map.bid[i])), 0, 0, 0, 0, (map.bid[i] * 0.137) % 1);
          if (map.roof[i]) {
            const c = scale3(bcol(i), 0.8);
            DIR4.forEach(([dx, dy]) => {
              const ni = map.inb(x + dx, y + dy) ? map.idx(x + dx, y + dy) : -1;
              if (ni >= 0 && map.isRoof(ni)) return;
              box.add(cx + dx * 0.45, bh, cz + dy * 0.45, dx ? 0.1 : 1, 0.35, dy ? 0.1 : 1, 0, c, tex(6, 'concrete'));
            });
          }
          break;
        }
        case O.WALL: box.add(cx, 0, cz, 1, 2.7, 1, 0, wallCol(i), tex(6, wallTex(i, x, y))); break;
        case O.WINDOW: {
          const c = wallCol(i), ax = along(x, y), wm = tex(6, wallBase(i));
          box.add(cx, 0, cz, 1, 0.95, 1, 0, c, wm);
          box.add(cx, 2.2, cz, 1, 0.5, 1, 0, c, wm);
          if (ax) { box.add(cx - 0.47, 0.95, cz, 0.06, 1.25, 1, 0, c, wm); box.add(cx + 0.47, 0.95, cz, 0.06, 1.25, 1, 0, c, wm); }
          else { box.add(cx, 0.95, cz - 0.47, 1, 1.25, 0.06, 0, c, wm); box.add(cx, 0.95, cz + 0.47, 1, 1.25, 0.06, 0, c, wm); }
          if (map.glass[i]) box.add(cx, 0.95, cz, ax ? 0.94 : 0.06, 1.25, ax ? 0.06 : 0.94, 0, [0.05, 0.09, 0.14], 3, 0.12);
          break;
        }
        case O.RUBBLE:
          for (let k = 0; k < 4; k++) {
            const a = hash2(x * 11 + k, y * 13), b = hash2(x * 17, y * 5 + k);
            box.add(x + 0.2 + a * 0.6, fh, y + 0.2 + b * 0.6, 0.3 + a * 0.3, 0.2 + b * 0.35, 0.3 + b * 0.3, a * 6, scale3(CONCRETE, 0.5 + b * 0.4), tex(0, 'concrete'), 0, (a - 0.5) * 0.6, (b - 0.5) * 0.6);
          }
          break;
        case O.CRATE: box.add(cx, fh, cz, 0.82, 0.82, 0.82, h * 0.6, scale3(WOOD, 0.8 + h * 0.4), tex(0, 'floor')); break;
        case O.CRATES:
          box.add(cx, fh, cz, 0.9, 0.95, 0.9, h * 0.3, scale3(WOOD, 0.8 + h * 0.3), tex(0, 'floor'));
          box.add(cx + 0.05, fh + 0.95, cz - 0.05, 0.8, 0.95, 0.8, h * 0.7 + 0.2, scale3(WOOD, 0.7 + h * 0.3), tex(0, 'floor'));
          break;
        case O.BARRIER: {
          const ax = along(x, y) || !map.inb(x, y - 1) || map.obj[map.idx(x, y - 1)] !== O.BARRIER;
          box.add(cx, fh, cz, ax ? 0.98 : 0.45, 0.9, ax ? 0.45 : 0.98, 0, lin('#9a9890'), tex(6, 'concrete'));
          box.add(cx, fh + 0.6, cz, ax ? 0.99 : 0.47, 0.12, ax ? 0.47 : 0.99, 0, lin('#b02a1e'), 0, 0.2);
          break;
        }
        case O.SANDBAG:
          box.add(cx, fh, cz, 0.95, 0.45, 0.8, 0, lin('#7f7152'));
          box.add(cx, fh + 0.45, cz, 0.85, 0.42, 0.7, 0.1, lin('#8a7b58'));
          break;
        case O.DUMPSTER:
          box.add(cx, fh, cz, 0.95, 1.15, 0.8, 0, lin('#1f4a2c'), tex(0, 'metal'));
          box.add(cx, fh + 1.15, cz, 0.97, 0.08, 0.82, 0, lin('#163420'), tex(0, 'metal'));
          break;
        case O.BARREL:
          cyl.add(cx, fh, cz, 0.62, 1.0, 0.62, 0, lin('#9a1f16'));
          cyl.add(cx, fh + 0.55, cz, 0.64, 0.14, 0.64, 0, lin('#e0b020'), 0, 0.5);
          break;
        case O.HYDRANT:
          cyl.add(cx, fh, cz, 0.3, 0.5, 0.3, 0, lin('#b3241c'));
          sph.add(cx, fh + 0.38, cz, 0.3, 0.3, 0.3, 0, lin('#b3241c'));
          break;
        case O.TREE: {
          cyl.add(cx, fh, cz, 0.2, 1.7, 0.2, 0, lin('#3a2a1a'));
          const g = scale3(lin('#24421f'), 0.8 + h * 0.4);
          sph.add(cx, fh + 1.3, cz, 1.5, 1.4, 1.5, h * 6, g, 5);
          sph.add(cx + 0.2, fh + 2.2, cz - 0.15, 1.1, 1.0, 1.1, 0, scale3(g, 1.15), 5);
          break;
        }
        case O.LAMP: {
          cyl.add(cx, fh, cz, 0.12, 4.0, 0.12, 0, DARK);
          // arm points toward the nearest road
          let ax = 0, az = 0;
          for (const [dx, dy] of DIR4) if (map.inb(x + dx, y + dy) && map.floor[map.idx(x + dx, y + dy)] === F.ROAD) { ax = dx; az = dy; break; }
          box.add(cx + ax * 0.35, fh + 3.9, cz + az * 0.35, ax ? 0.8 : 0.12, 0.08, az ? 0.8 : 0.12, 0, DARK);
          box.add(cx + ax * 0.7, fh + 3.75, cz + az * 0.7, 0.32, 0.12, 0.32, 0, [1, 0.7, 0.35], 4, 4);
          lights.push([cx + ax * 0.7, 3.6, cz + az * 0.7, 8, 1.0, 0.6, 0.28, 2.6, 0]);
          break;
        }
        case O.PUMP:
          box.add(cx, fh, cz, 0.55, 1.55, 0.85, 0, lin('#d8d6d0'));
          box.add(cx, fh + 0.9, cz, 0.58, 0.35, 0.6, 0, [0.2, 0.9, 0.4], 4, 1.4);
          box.add(cx, fh + 1.45, cz, 0.6, 0.12, 0.9, 0, lin('#c2271c'), 0, 0.3);
          break;
        case O.HEDGE: box.add(cx, fh, cz, 1, 0.95, 1, 0, scale3(lin('#22401c'), 0.85 + h * 0.3), 5); break;
        case O.BENCH:
          box.add(cx, fh + 0.3, cz, 0.9, 0.12, 0.42, 0, WOOD);
          box.add(cx, fh, cz, 0.08, 0.3, 0.38, 0, METAL);
          box.add(cx, fh + 0.42, cz + 0.18, 0.9, 0.3, 0.06, 0, WOOD);
          break;
        case O.STATUE:
          box.add(cx, fh, cz, 0.95, 1.0, 0.95, 0, lin('#77756c'), tex(6, 'concrete'));
          cyl.add(cx, fh + 1.0, cz, 0.42, 1.6, 0.42, 0, lin('#4d5a46'), 0);
          sph.add(cx, fh + 2.55, cz, 0.38, 0.38, 0.38, 0, lin('#4d5a46'));
          box.add(cx + 0.25, fh + 2.0, cz, 0.6, 0.12, 0.12, 0.8, lin('#4d5a46'), 0, 0, 0.9);
          break;
        case O.CONTAINER: {
          const c = lin(CONTAINER_COLS[map.meta[i] % CONTAINER_COLS.length]);
          box.add(cx, fh, cz, 1.0, 2.6, 1.0, 0, c, tex(0, 'metal'));
          box.add(cx, fh + 2.6, cz, 0.94, 0.04, 0.94, 0, scale3(c, 0.7), tex(0, 'metal'));
          break;
        }
        case O.DESK:
          box.add(cx, fh, cz, 0.9, 0.75, 0.6, h, lin('#5a4128'));
          box.add(cx, fh + 0.75, cz, 0.08, 0.3, 0.4, h, [0.4, 0.75, 1], 4, 1.2);
          break;
        case O.SHELF: box.add(cx, fh, cz, 0.95, 2.0, 0.55, along(x, y) ? 0 : Math.PI / 2, lin('#4a4d52')); break;
        case O.PLANTER:
          box.add(cx, fh, cz, 0.9, 0.7, 0.9, 0, CONCRETE, tex(6, 'concrete'));
          box.add(cx, fh + 0.7, cz, 0.75, 0.25, 0.75, 0, lin('#2c4a22'), 5);
          break;
        case O.KIOSK:
          box.add(cx, fh, cz, 0.95, 2.2, 0.95, 0, lin('#35505a'), tex(0, 'metal'));
          box.add(cx, fh + 1.6, cz, 0.97, 0.3, 0.97, 0, [1, 0.8, 0.3], 4, 1.5);
          break;
      }
      // ladders
      const ld = map.ladder[i];
      if (ld >= 0) {
        const [dx, dy] = DIR4[ld];
        const tx = x + dx, ty = y + dy;
        const top = map.inb(tx, ty) ? map.bh[map.idx(tx, ty)] : 3;
        const lx = cx + dx * 0.44, lz = cz + dy * 0.44;
        const ox = dy ? 0.22 : 0, oz = dx ? 0.22 : 0;
        box.add(lx - ox, 0, lz - oz, 0.06, top + 0.6, 0.06, 0, lin('#9a9a9a'));
        box.add(lx + ox, 0, lz + oz, 0.06, top + 0.6, 0.06, 0, lin('#9a9a9a'));
        for (let r = 0.3; r < top; r += 0.4) box.add(lx, r, lz, dy ? 0.44 : 0.05, 0.04, dx ? 0.44 : 0.05, 0, lin('#8a8a8a'));
      }
    }

    // vehicles
    for (const v of map.vehicles) this.vehicle(v);

    // decor
    for (const d of map.decor) {
      const { box, cyl, sph } = this.chunkAt(d.x ?? d.lx ?? d.x0, d.z ?? d.lz ?? d.z0);
      switch (d.kind) {
        case 'ac':
          box.add(d.x, d.y, d.z, d.s, 0.55, d.s * 0.8, 0, lin('#7a7d80'));
          cyl.add(d.x, d.y + 0.55, d.z, d.s * 0.5, 0.05, d.s * 0.5, 0, lin('#2a2c2e'));
          break;
        case 'vent': box.add(d.x, d.y, d.z, 0.35, 0.35, 0.35, 0, lin('#6a6d70')); break;
        case 'tower':
          for (const [ox, oz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]]) box.add(d.x + ox, d.y, d.z + oz, 0.08, 1.3, 0.08, 0, METAL);
          cyl.add(d.x, d.y + 1.3, d.z, 1.4, 1.6, 1.4, 0, lin('#5a4030'));
          sph.add(d.x, d.y + 2.6, d.z, 1.45, 0.7, 1.45, 0, lin('#3a3a3a'));
          break;
        case 'antenna':
          cyl.add(d.x, d.y, d.z, 0.08, 4, 0.08, 0, METAL);
          sph.add(d.x, d.y + 4, d.z, 0.2, 0.2, 0.2, 0, [1, 0.05, 0.05], 4, 3, 0, 0, 1);
          break;
        case 'neon': {
          const c = lin(d.col);
          const w = d.tall ? 0.5 : 1.6, hgt = d.tall ? 1.8 : 0.5;
          box.add(d.x, d.y, d.z, d.dx ? 0.1 : w, hgt, d.dy ? 0.1 : w, 0, c, 4, 3.5, 0, 0, 1);
          lights.push([d.lx, 2.6, d.lz, 6.5, c[0], c[1], c[2], 2.2, d.seed]);
          break;
        }
        case 'ceiling': {
          const c = lin(d.col);
          lights.push([d.lx, 2.3, d.lz, 6, c[0], c[1], c[2], 1.6, -1]);
          break;
        }
        case 'gassign':
          box.add(d.x, 0, d.z, 0.2, 4.5, 0.2, 0, METAL);
          box.add(d.x, 4.5, d.z, 1.6, 1.0, 0.25, 0, lin(d.col), 4, 2.5, 0, 0, 1);
          lights.push([d.x, 4, d.z + 0.6, 6, 1, 0.3, 0.15, 1.6, 0.3]);
          break;
        case 'canopy': {
          const { x0, z0, x1, z1 } = d;
          for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) box.add(px + 0.5, 0, pz + 0.5, 0.25, 3.6, 0.25, 0, lin('#cfcfcf'));
          const wx = x1 - x0, wz = z1 - z0;
          box.add((x0 + x1) / 2 + 0.5, 3.6, z0 + 0.5, wx + 0.3, 0.3, 0.25, 0, lin('#c2271c'), 0, 0.4);
          box.add((x0 + x1) / 2 + 0.5, 3.6, z1 + 0.5, wx + 0.3, 0.3, 0.25, 0, lin('#c2271c'), 0, 0.4);
          box.add(x0 + 0.5, 3.6, (z0 + z1) / 2 + 0.5, 0.25, 0.3, wz + 0.3, 0, lin('#c2271c'), 0, 0.4);
          box.add(x1 + 0.5, 3.6, (z0 + z1) / 2 + 0.5, 0.25, 0.3, wz + 0.3, 0, lin('#c2271c'), 0, 0.4);
          lights.push([(x0 + x1) / 2 + 0.5, 3.3, (z0 + z1) / 2 + 0.5, 9, 0.85, 0.95, 1, 2.2, -1]);
          break;
        }
        case 'crane': {
          const yl = lin('#c9a227');
          box.add(d.x, 0, d.z, 1.6, 0.6, 1.6, 0, CONCRETE);
          box.add(d.x, 0.6, d.z, 0.7, 17, 0.7, 0, yl);
          const c = Math.cos(d.rot), s = Math.sin(d.rot);
          box.add(d.x + c * 4, 17.6, d.z + s * 4, 14, 0.6, 0.6, d.rot, yl);
          box.add(d.x - c * 3.5, 17.2, d.z - s * 3.5, 1.6, 1.0, 1.0, d.rot, CONCRETE);
          box.add(d.x + c * 10, 10, d.z + s * 10, 0.04, 7.6, 0.04, 0, METAL);
          sph.add(d.x, 18.2, d.z, 0.3, 0.3, 0.3, 0, [1, 0.05, 0.05], 4, 3, 0, 0, 1);
          break;
        }
      }
    }

    // static ground markings
    const mk = this.marks; mk.clear();
    for (const m of map.marks) mk.push(m.x, 0.012, m.z, m.rot, m.sx, m.sz, 0, 0, ...lin3(m.col), m.a, 0.15, 0, 0, 0);
    for (const d of map.decor) if (d.kind === 'helipadH') {
      mk.push(d.x, 0.1, d.z, 0, 4.2, 4.2, 7, 0, 0.85, 0.85, 0.8, 0.7, 0, 0, 1, 0);
      mk.push(d.x, 0.1, d.z, 0, 8.6, 8.6, 1, 0, 0.9, 0.75, 0.1, 0.8, 0.04, 0, 1, 0);
    }
    // concatenate chunks: [objects by chunk][ground by chunk], remembering each chunk's range
    const S = this.sets;
    const R = (this.ranges = { box: [], cyl: [], sph: [], ground: [] });
    for (const m of MESH) {
      S[m].clear();
      for (const c of this.chunks) { R[m].push([S[m].n, c[m].n]); append(S[m], c[m]); }
    }
    this.objCount = { box: S.box.n, cyl: S.cyl.n, sph: S.sph.n };
    for (const c of this.chunks) { R.ground.push([S.box.n, c.ground.n]); append(S.box, c.ground); }
    this.version = map.version;
  }

  // Draw ranges for the visible chunks, with neighbouring ranges merged into one draw.
  drawRanges(visible) {
    const out = {};
    const merge = (list) => {
      const r = [];
      for (let c = 0; c < NCH; c++) {
        if (!visible[c] || !list[c][1]) continue;
        const [s, n] = list[c];
        const last = r[r.length - 1];
        if (last && last[0] + last[1] === s) last[1] += n; else r.push([s, n]);
      }
      return r;
    };
    for (const m of MESH) out[m] = merge(this.ranges[m]);
    out.ground = merge(this.ranges.ground);
    return out;
  }

  vehicle(v) {
    const { box, cyl } = this.chunkAt(v.cx, v.cy);
    const yaw = (v.horiz ? 0 : Math.PI / 2) + (v.flip ? Math.PI : 0);
    const fx = Math.cos(yaw), fz = Math.sin(yaw), rx = -fz, rz = fx;
    const at = (f, r) => [v.cx + fx * f + rx * r, v.cy + fz * f + rz * r];
    const wreck = v.wreck;
    const body = wreck ? CHAR : lin(v.color);
    const tilt = wreck ? (v.seed - 0.5) * 0.12 : 0;
    const wheel = (f, r, size) => { const [x, z] = at(f, r); cyl.add(x, size / 2, z, size, 0.22, size, yaw, [0.02, 0.02, 0.02], 0, 0, 0, Math.PI / 2); };
    if (v.kind === 'car') {
      box.add(v.cx, 0.18, v.cy, 1.85, 0.5, 0.86, yaw, body, 0, 0, tilt);
      const [cx, cz] = at(-0.1, 0);
      box.add(cx, 0.68, cz, 1.0, 0.42, 0.78, yaw, wreck ? CHAR : GLASS, wreck ? 0 : 3);
      box.add(cx, 1.08, cz, 0.85, 0.05, 0.74, yaw, body);
      for (const f of [-0.6, 0.6]) for (const r of [-0.38, 0.38]) wheel(f, r, 0.36);
      if (!wreck) {
        for (const r of [-0.3, 0.3]) {
          const [hx, hz] = at(0.93, r); box.add(hx, 0.4, hz, 0.04, 0.1, 0.18, yaw, [1, 0.95, 0.8], 4, 3);
          const [tx, tz] = at(-0.93, r); box.add(tx, 0.42, tz, 0.04, 0.1, 0.2, yaw, [1, 0.05, 0.03], 4, 2);
        }
      }
    } else if (v.kind === 'truck') {
      const L = v.sx > v.sy ? v.sx : v.sy;
      const [ax, az] = at(L / 2 - 0.75, 0);
      box.add(ax, 0.3, az, 1.3, 1.5, 1.8, yaw, wreck ? CHAR : lin('#d0d0d0'), 0, 0, tilt);
      const [wx, wz] = at(L / 2 - 0.25, 0);
      box.add(wx, 1.0, wz, 0.3, 0.6, 1.7, yaw, wreck ? CHAR : GLASS, 3);
      const [bx, bz] = at(-0.7, 0);
      box.add(bx, 0.35, bz, L - 1.6, 2.3, 1.9, yaw, body, 0, 0, tilt);
      for (const f of [L / 2 - 0.8, -0.6, -L / 2 + 0.6]) for (const r of [-0.85, 0.85]) wheel(f, r, 0.6);
      if (!wreck) { const [hx, hz] = at(L / 2 - 0.08, 0); box.add(hx, 0.55, hz, 0.05, 0.12, 1.4, yaw, [1, 0.95, 0.8], 4, 3); }
    } else if (v.kind === 'bus') {
      box.add(v.cx, 0.3, v.cy, 5.8, 2.4, 1.9, yaw, body, 0, 0, tilt);
      box.add(v.cx, 1.35, v.cy, 5.82, 0.7, 1.92, yaw, wreck ? CHAR : GLASS, 3, wreck ? 0 : 0.15);
      box.add(v.cx, 2.7, v.cy, 5.6, 0.08, 1.7, yaw, wreck ? CHAR : lin('#e8e8e0'));
      for (const f of [2, -2]) for (const r of [-0.85, 0.85]) wheel(f, r, 0.7);
    } else if (v.kind === 'tanker') {
      const [ax, az] = at(1.8, 0);
      box.add(ax, 0.3, az, 1.3, 1.6, 1.8, yaw, wreck ? CHAR : lin('#7a1a14'));
      const [tx, tz] = at(-0.5, 0);
      cyl.add(tx, 1.15, tz, 1.75, 3.6, 1.75, yaw, wreck ? CHAR : lin('#c8c8c8'), 3, 0, Math.PI / 2);
      box.add(tx, 1.1, tz, 3.4, 0.25, 1.82, yaw, wreck ? CHAR : lin('#c2271c'), 0, 0.3);
      for (const f of [1.8, -0.5, -1.8]) for (const r of [-0.85, 0.85]) wheel(f, r, 0.6);
    }
  }

  // Light list for this frame: static + dynamic, closest to the camera first.
  gatherLights(dynamicLights, cx, cz, time, view, explored) {
    const all = [];
    const inView = (l) => l[0] + l[3] > view[0] && l[0] - l[3] < view[2] && l[2] + l[3] > view[1] && l[2] - l[3] < view[3];
    for (const l of this.staticLights) {
      if (!inView(l)) continue;
      const tx = clamp(Math.floor(l[0]), 0, MW - 1), tz = clamp(Math.floor(l[2]), 0, MH - 1);
      if (!explored[tz * MW + tx]) continue;
      const d = (l[0] - cx) ** 2 + (l[2] - cz) ** 2;
      let k = l[7];
      if (l[8] > 0) { const t = time * 7 + l[8] * 50; k *= Math.sin(t) > 0.97 || Math.sin(t * 0.37) > 0.995 ? 0.25 : 1; }
      all.push([d, [l[0], l[1], l[2], l[3], l[4], l[5], l[6], k]]);
    }
    for (const l of dynamicLights) if (inView(l)) all.push([((l[0] - cx) ** 2 + (l[2] - cz) ** 2) * 0.25, l]);
    all.sort((a, b) => a[0] - b[0]);
    return all.slice(0, 32).map((a) => a[1]);
  }
}

const lin3 = (c) => c;

// Orthographic light covering the whole map.
export function lightMatrix(dir) {
  const c = [MW / 2, 0, MH / 2];
  const eye = [c[0] + dir[0] * 80, dir[1] * 80, c[2] + dir[2] * 80];
  const view = mat4.lookAt(eye, c, [0, 1, 0]);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const x of [0, MW]) for (const y of [-1, 22]) for (const z of [0, MH]) {
    const p = mat4.xform(view, x, y, z);
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
    minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]);
  }
  const proj = mat4.ortho(minX, maxX, minY, maxY, -maxZ - 1, -minZ + 1);
  return mat4.mul(proj, view);
}
