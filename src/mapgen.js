import { MW, MH, F, O, OBJ, VEHICLES, CAR_COLORS, DIFFICULTY } from './defs.js';
import { makeRng, dist } from './util.js';
import { GameMap, DIR4 } from './map.js';

const VR = [12, 34, 56, 78]; // vertical roads occupy x..x+3
const HR = [7, 28, 49];      // horizontal roads occupy y..y+3
const COLS = [[0, 10], [17, 32], [39, 54], [61, 76], [83, 99]];
const ROWS = [[0, 5], [12, 26], [33, 47], [54, 59]];
const FACADES = ['#4a4f57', '#5b5148', '#3f4650', '#6a5e52', '#474038', '#55606a', '#3b3f45', '#61584f', '#504a5c', '#3d4a48'];
const NEONS = ['#ff2d95', '#22e4ff', '#ffcc33', '#7a5cff', '#36ff8f', '#ff5a36'];
export const LZ = { x0: 92, y0: 28, x1: 96, y1: 32, cx: 94.5, cy: 30.5 };
export const START = [[2, 28], [2, 30], [3, 29], [1, 29], [3, 31]];

export function generateMap(seed, diffKey = 'veteran') {
  const R = makeRng(seed);
  const m = new GameMap();
  const idx = (x, y) => m.idx(x, y);
  const fillF = (x0, y0, x1, y1, f) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (m.inb(x, y)) m.floor[idx(x, y)] = f;
  };
  const free = (x, y) => m.inb(x, y) && m.obj[idx(x, y)] === O.NONE && m.ladder[idx(x, y)] < 0;
  const put = (x, y, o, extra) => (free(x, y) ? (m.setObj(x, y, o, extra), true) : false);
  const isRoadTile = (x, y) => m.inb(x, y) && m.floor[idx(x, y)] === F.ROAD;
  const inVR = (x) => VR.some((v) => x >= v && x <= v + 3);
  const inHR = (y) => HR.some((h) => y >= h && y <= h + 3);
  const nearIntersection = (x, y) => VR.some((v) => x >= v - 2 && x <= v + 5) && HR.some((h) => y >= h - 2 && y <= h + 5);
  const reserved = new Set(); // tiles kept clear (start area, LZ)

  // ---------- roads ----------
  for (const x of VR) fillF(x, 0, x + 3, MH - 1, F.ROAD);
  for (const y of HR) fillF(0, y, MW - 1, y + 3, F.ROAD);

  const mark = (x, z, sx, sz, col, a = 0.55) => m.marks.push({ x, z, sx, sz, rot: 0, col, a });
  const YEL = [0.85, 0.66, 0.18], WHT = [0.8, 0.8, 0.78];
  for (const v of VR) for (let y = 0; y < MH; y++) {
    if (inHR(y)) continue;
    mark(v + 2, y + 0.5, 0.07, 1, YEL, 0.6);
    if (y % 2 === 0) { mark(v + 1, y + 0.5, 0.06, 0.6, WHT, 0.4); mark(v + 3, y + 0.5, 0.06, 0.6, WHT, 0.4); }
  }
  for (const h of HR) for (let x = 0; x < MW; x++) {
    if (inVR(x) || x > 82) continue;
    mark(x + 0.5, h + 2, 1, 0.07, YEL, 0.6);
    if (x % 2 === 0) { mark(x + 0.5, h + 1, 0.6, 0.06, WHT, 0.4); mark(x + 0.5, h + 3, 0.6, 0.06, WHT, 0.4); }
  }
  for (const v of VR) for (const h of HR) {
    for (let k = 0; k < 7; k++) {
      const xx = v + 0.3 + k * 0.57;
      mark(xx, h - 0.5, 0.3, 0.85, WHT, 0.5);
      mark(xx, h + 4.5, 0.3, 0.85, WHT, 0.5);
      const yy = h + 0.3 + k * 0.57;
      if (v - 1 >= 0) mark(v - 0.5, yy, 0.85, 0.3, WHT, 0.5);
      mark(v + 4.5, yy, 0.85, 0.3, WHT, 0.5);
    }
  }

  // ---------- vehicles ----------
  const addVehicle = (kind, x, y, horiz, color) => {
    const V = VEHICLES[kind];
    const sx = horiz ? V.l : V.w, sy = horiz ? V.w : V.l;
    for (let yy = y; yy < y + sy; yy++) for (let xx = x; xx < x + sx; xx++)
      if (!free(xx, yy) || reserved.has(idx(xx, yy))) return null;
    const id = m.vehicles.length;
    const v = { id, kind, x, y, sx, sy, horiz, flip: R.chance(0.5), color: color || R.pick(CAR_COLORS),
      hp: V.hp, maxHp: V.hp, wreck: false, tiles: [], cx: x + sx / 2, cy: y + sy / 2, seed: R() };
    for (let yy = y; yy < y + sy; yy++) for (let xx = x; xx < x + sx; xx++) {
      const i = idx(xx, yy);
      m.obj[i] = kind === 'car' ? O.CAR : O.TRUCK; m.veh[i] = id; v.tiles.push(i);
    }
    m.vehicles.push(v);
    return v;
  };
  const truckColor = () => R.pick(['#c9c3b5', '#7d2b22', '#2f4b6b', '#e0b13a', '#3b5e3b', '#d8d8d8']);

  // reserve start & LZ
  for (let y = 27; y <= 32; y++) for (let x = 0; x <= 5; x++) reserved.add(idx(x, y));
  for (let y = LZ.y0; y <= LZ.y1; y++) for (let x = LZ.x0; x <= LZ.x1; x++) { reserved.add(idx(x, y)); m.lzTiles.add(idx(x, y)); }

  // ---------- buildings ----------
  const building = (x0, y0, x1, y1, h, roof = false, extra = {}) => {
    const id = m.buildings.length;
    const b = { id, x0, y0, x1, y1, h, roof, color: R.pick(FACADES), ...extra };
    m.buildings.push(b);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = idx(x, y);
      m.obj[i] = O.BUILDING; m.hp[i] = OBJ[O.BUILDING].hp * (h > 6 ? 1.6 : 1);
      m.bh[i] = h; m.roof[i] = roof ? 1 : 0; m.bid[i] = id;
    }
    // rooftop clutter
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const nAc = Math.min(6, Math.floor(area / 10) + 1);
    for (let k = 0; k < nAc; k++) {
      const x = R.int(x0, x1), y = R.int(y0, y1);
      m.decor.push({ kind: roof ? 'vent' : 'ac', i: idx(x, y), x: x + R.range(0.3, 0.7), z: y + R.range(0.3, 0.7), y: h, s: R.range(0.5, 0.9), seed: R() });
    }
    if (!roof && R.chance(0.3) && area > 12) {
      const x = R.int(x0, x1), y = R.int(y0, y1);
      m.decor.push({ kind: 'tower', i: idx(x, y), x: x + 0.5, z: y + 0.5, y: h });
    }
    if (!roof && h > 9 && R.chance(0.5)) {
      const x = R.int(x0, x1), y = R.int(y0, y1);
      m.decor.push({ kind: 'antenna', i: idx(x, y), x: x + 0.5, z: y + 0.5, y: h, seed: R() });
    }
    // neon signs on street-facing walls
    if (!roof && R.chance(0.55)) {
      const sides = [];
      for (let x = x0; x <= x1; x++) { sides.push([x, y1, 0, 1]); sides.push([x, y0, 0, -1]); }
      for (let y = y0; y <= y1; y++) { sides.push([x1, y, 1, 0]); sides.push([x0, y, -1, 0]); }
      const good = sides.filter(([x, y, dx, dy]) => {
        const nx = x + dx, ny = y + dy;
        return m.inb(nx, ny) && [F.SIDEWALK, F.ROAD, F.PLAZA].includes(m.floor[idx(nx, ny)]) && m.obj[idx(nx, ny)] !== O.BUILDING;
      });
      for (let k = 0; k < Math.min(2, good.length); k++) {
        const [x, y, dx, dy] = R.pick(good);
        const col = R.pick(NEONS);
        m.decor.push({ kind: 'neon', i: idx(x, y), x: x + 0.5 + dx * 0.52, z: y + 0.5 + dy * 0.52, y: R.range(2.4, Math.min(h - 0.6, 5)),
          dx, dy, col, lx: x + 0.5 + dx * 1.6, lz: y + 0.5 + dy * 1.6, seed: R(), tall: R.chance(0.5) });
      }
    }
    return b;
  };

  const lotFloor = (l, f) => fillF(l.x0, l.y0, l.x1, l.y1, f);
  const lotTiles = (l) => {
    const t = [];
    for (let y = l.y0; y <= l.y1; y++) for (let x = l.x0; x <= l.x1; x++) t.push([x, y]);
    return t;
  };
  const W_ = (l) => l.x1 - l.x0 + 1, H_ = (l) => l.y1 - l.y0 + 1;

  function office(l, tall = false) {
    lotFloor(l, F.ALLEY);
    const horiz = W_(l) >= H_(l);
    const len = horiz ? W_(l) : H_(l);
    let pos = 0;
    while (pos < len) {
      let s = Math.min(len - pos, R.int(4, 9));
      if (len - pos - s < 4) s = len - pos;
      const a = pos, b = pos + s - 1;
      const h = tall ? R.range(8, 15) : R.range(5, 12);
      if (horiz) building(l.x0 + a, l.y0, l.x0 + b, l.y1, h);
      else building(l.x0, l.y0 + a, l.x1, l.y0 + b, h);
      pos += s + R.int(1, 2);
    }
    for (const [x, y] of lotTiles(l)) {
      if (!free(x, y)) continue;
      if (R.chance(0.12)) put(x, y, R.pick([O.DUMPSTER, O.CRATE, O.CRATES, O.BARREL, O.DUMPSTER]));
    }
  }

  function ring(l, f) {
    lotFloor(l, f);
    return { x0: l.x0 + 1, y0: l.y0 + 1, x1: l.x1 - 1, y1: l.y1 - 1 };
  }

  function lowrise(l) {
    if (W_(l) < 5 || H_(l) < 5) return office(l);
    const b = ring(l, F.ALLEY);
    building(b.x0, b.y0, b.x1, b.y1, R.range(3.0, 3.6), true);
    // clutter in the ring first, then ladders on free tiles
    for (const [x, y] of lotTiles(l)) if (free(x, y) && R.chance(0.08)) put(x, y, R.pick([O.DUMPSTER, O.CRATE, O.BARREL]));
    const cands = [];
    for (let x = b.x0 + 1; x < b.x1; x++) { cands.push([x, b.y0 - 1, 1]); cands.push([x, b.y1 + 1, 3]); }
    for (let y = b.y0 + 1; y < b.y1; y++) { cands.push([b.x0 - 1, y, 0]); cands.push([b.x1 + 1, y, 2]); }
    R.shuffle(cands);
    let placed = 0;
    for (const [x, y, d] of cands) {
      if (placed >= 2) break;
      if (!free(x, y)) continue;
      m.ladder[idx(x, y)] = d; placed++;
    }
  }

  function interior(l, kind = 'office') {
    const b = W_(l) >= 6 && H_(l) >= 6 ? ring(l, F.SIDEWALK) : { ...l };
    fillF(b.x0, b.y0, b.x1, b.y1, F.INTERIOR);
    const bd = { id: m.buildings.length, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, h: 2.7, interior: true, color: R.pick(FACADES) };
    m.buildings.push(bd);
    const perim = [];
    for (let x = b.x0; x <= b.x1; x++) { perim.push([x, b.y0, 0, -1]); perim.push([x, b.y1, 0, 1]); }
    for (let y = b.y0 + 1; y < b.y1; y++) { perim.push([b.x0, y, -1, 0]); perim.push([b.x1, y, 1, 0]); }
    for (const [x, y] of perim) {
      const corner = (x === b.x0 || x === b.x1) && (y === b.y0 || y === b.y1);
      const k = x + y;
      const o = !corner && k % 3 === 1 && R.chance(0.75) ? O.WINDOW : O.WALL;
      m.setObj(x, y, o, { meta: bd.id });
      m.bid[idx(x, y)] = bd.id;
    }
    // doors: one per side on 2-4 sides
    const sides = R.shuffle([0, 1, 2, 3]).slice(0, R.int(2, 4));
    for (const s of sides) {
      const opts = perim.filter(([x, y, dx, dy]) => {
        const corner = (x === b.x0 || x === b.x1) && (y === b.y0 || y === b.y1);
        const ok = [[0, -1], [0, 1], [-1, 0], [1, 0]][s];
        return !corner && dx === ok[0] && dy === ok[1] && m.inb(x + dx, y + dy) && m.obj[idx(x + dx, y + dy)] === O.NONE;
      });
      if (!opts.length) continue;
      const [x, y] = R.pick(opts);
      m.setObj(x, y, O.DOOR);
    }
    // partition wall
    const iw = b.x1 - b.x0 - 1, ih = b.y1 - b.y0 - 1;
    if (iw >= 8) {
      const px = R.int(b.x0 + 3, b.x1 - 3);
      const gap = R.int(b.y0 + 1, b.y1 - 1);
      for (let y = b.y0 + 1; y < b.y1; y++) if (Math.abs(y - gap) > 0 && !(y === gap + 2 && ih > 7)) m.setObj(px, y, O.WALL, { meta: bd.id });
    } else if (ih >= 8) {
      const py = R.int(b.y0 + 3, b.y1 - 3);
      const gap = R.int(b.x0 + 1, b.x1 - 1);
      for (let x = b.x0 + 1; x < b.x1; x++) if (x !== gap) m.setObj(x, py, O.WALL, { meta: bd.id });
    }
    // furniture, keeping doorway approaches clear
    const nearDoor = (x, y) => DIR4.some(([dx, dy]) => m.inb(x + dx, y + dy) && m.obj[idx(x + dx, y + dy)] === O.DOOR);
    const nearWall = (x, y) => DIR4.some(([dx, dy]) => m.obj[idx(x + dx, y + dy)] === O.WALL);
    for (let y = b.y0 + 1; y < b.y1; y++) for (let x = b.x0 + 1; x < b.x1; x++) {
      if (!free(x, y) || nearDoor(x, y)) continue;
      const r = R();
      if (kind === 'warehouse') {
        if (r < 0.12) put(x, y, O.CRATES); else if (r < 0.22) put(x, y, O.CRATE); else if (r < 0.25) put(x, y, O.BARREL);
      } else if (kind === 'store') {
        if (r < 0.14 && !nearWall(x, y)) put(x, y, O.SHELF); else if (r < 0.2) put(x, y, O.DESK);
      } else if (r < 0.12) put(x, y, O.DESK); else if (r < 0.16 && nearWall(x, y)) put(x, y, O.SHELF);
    }
    m.decor.push({ kind: 'ceiling', i: -1, lx: (b.x0 + b.x1 + 1) / 2, lz: (b.y0 + b.y1 + 1) / 2, bid: bd.id, col: R.pick(['#ffd9a0', '#bfe3ff', '#ffe7c4']), seed: R() });
    return b;
  }

  function park(l) {
    lotFloor(l, F.GRASS);
    const mx = Math.floor((l.x0 + l.x1) / 2), my = Math.floor((l.y0 + l.y1) / 2);
    fillF(l.x0, my, l.x1, my, F.PLAZA);
    fillF(mx, l.y0, mx, l.y1, F.PLAZA);
    if (W_(l) >= 9 && H_(l) >= 9) {
      fillF(mx - 1, my - 1, mx + 1, my + 1, F.PLAZA);
      put(mx, my, O.STATUE);
    }
    for (let k = 0; k < 3; k++) {
      const horiz = R.chance(0.5), len = R.int(3, 5);
      const x = R.int(l.x0, l.x1 - (horiz ? len : 0)), y = R.int(l.y0, l.y1 - (horiz ? 0 : len));
      for (let j = 0; j < len; j++) {
        const xx = horiz ? x + j : x, yy = horiz ? y : y + j;
        if (m.floor[idx(xx, yy)] === F.GRASS) put(xx, yy, O.HEDGE);
      }
    }
    for (const [x, y] of lotTiles(l)) {
      const f = m.floor[idx(x, y)];
      if (f === F.GRASS && R.chance(0.13) && !DIR4.some(([dx, dy]) => m.inb(x + dx, y + dy) && m.obj[idx(x + dx, y + dy)] === O.TREE)) put(x, y, O.TREE);
      else if (f === F.PLAZA && R.chance(0.08)) put(x, y, O.BENCH);
    }
    put(l.x0, my, O.LAMP); put(l.x1, my, O.LAMP);
  }

  function parking(l) {
    lotFloor(l, F.PARKING);
    for (let y = l.y0 + 1; y + 1 <= l.y1 - 1; y += 4) {
      for (let x = l.x0 + 1; x <= l.x1 - 1; x++) {
        mark(x, y + 1, 0.05, 2, WHT, 0.35);
        if (R.chance(0.62)) addVehicle('car', x, y, false);
      }
    }
    if (R.chance(0.7)) {
      const x = R.int(l.x0, l.x1 - 4), y = l.y0 + 3;
      addVehicle('truck', x, y, true, truckColor());
    }
    put(l.x0, l.y0, O.KIOSK);
    put(l.x1, l.y1, O.LAMP); put(l.x0, l.y1, O.LAMP);
  }

  function gas(l) {
    lotFloor(l, F.PARKING);
    const storeR = { x0: l.x1 - 4, y0: l.y0, x1: l.x1, y1: l.y0 + 3 };
    interior(storeR, 'store');
    const islands = [l.y0 + 2, l.y0 + 6].filter((y) => y < l.y1 - 1);
    for (const y of islands) {
      for (const x of [l.x0 + 2, l.x0 + 5]) {
        if (x >= storeR.x0 - 1) continue;
        put(x, y, O.PUMP);
        if (R.chance(0.5)) addVehicle('car', x + 1, y - 1, false);
      }
    }
    m.decor.push({ kind: 'gassign', i: idx(l.x0, l.y1), x: l.x0 + 0.5, z: l.y1 + 0.5, y: 0, col: '#ff5a36' });
    m.decor.push({ kind: 'canopy', i: -1, x0: l.x0 + 1, z0: l.y0 + 1, x1: Math.min(l.x0 + 7, storeR.x0 - 1), z1: Math.min(l.y0 + 8, l.y1) });
    addVehicle('tanker', l.x0 + 1, l.y1 - 2, true, '#d8d8d8') || addVehicle('tanker', l.x0 + 1, l.y1 - 1, true, '#d8d8d8');
    for (let k = 0; k < 4; k++) put(R.int(l.x0, l.x1), R.int(l.y0, l.y1), O.BARREL);
    put(l.x0, l.y0, O.LAMP);
  }

  function construction(l) {
    lotFloor(l, F.DIRT);
    for (let k = 0; k < 3; k++) {
      const horiz = R.chance(0.5);
      const w = horiz ? 3 : 2, h = horiz ? 2 : 3;
      const x = R.int(l.x0 + 1, l.x1 - w), y = R.int(l.y0 + 1, l.y1 - h);
      let ok = true;
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (!free(xx, yy)) ok = false;
      if (!ok) continue;
      const c = R.int(0, 5);
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) put(xx, yy, O.CONTAINER, { meta: c });
    }
    // half-built walls
    const wx = R.int(l.x0 + 1, l.x1 - 5), wy = R.int(l.y0 + 1, l.y1 - 4);
    for (let x = wx; x < wx + 5; x++) if (R.chance(0.7)) put(x, wy, O.WALL, { meta: 999 });
    for (let y = wy; y < wy + 4; y++) if (R.chance(0.6)) put(wx, y, O.WALL, { meta: 999 });
    for (const [x, y] of lotTiles(l)) {
      if (!free(x, y)) continue;
      const r = R();
      if (r < 0.05) put(x, y, O.CRATES); else if (r < 0.1) put(x, y, O.CRATE);
      else if (r < 0.13) put(x, y, O.SANDBAG); else if (r < 0.15) put(x, y, O.BARREL);
    }
    for (let x = l.x0; x <= l.x1; x++) { if (R.chance(0.35)) put(x, l.y0, O.BARRIER); if (R.chance(0.35)) put(x, l.y1, O.BARRIER); }
    m.decor.push({ kind: 'crane', i: -1, x: l.x0 + 1.5, z: l.y1 - 1.5, y: 0, rot: R.range(0, Math.PI * 2) });
    put(l.x1, l.y0 + 1, O.LAMP);
  }

  function plaza(l) {
    lotFloor(l, F.PLAZA);
    const mx = Math.floor((l.x0 + l.x1) / 2), my = Math.floor((l.y0 + l.y1) / 2);
    put(mx, my, O.STATUE);
    for (const [x, y] of lotTiles(l)) {
      if (!free(x, y)) continue;
      if ((x - l.x0) % 3 === 1 && (y - l.y0) % 4 === 1 && R.chance(0.7)) put(x, y, R.chance(0.5) ? O.PLANTER : O.TREE);
      else if (R.chance(0.04)) put(x, y, O.BENCH);
      else if (R.chance(0.015)) put(x, y, O.KIOSK);
    }
    put(l.x0, l.y0, O.LAMP); put(l.x1, l.y1, O.LAMP);
  }

  // ---------- assign lots ----------
  const lots = [];
  for (let ci = 0; ci < COLS.length; ci++) for (let ri = 0; ri < ROWS.length; ri++) {
    const [x0, x1] = COLS[ci], [y0, y1] = ROWS[ri];
    const edge = ri === 0 || ri === 3;
    if (ci === 4 && !edge) {
      // LZ column: helipad plaza in the middle, lots at the far ends
      if (ri === 1) lots.push({ x0, y0, x1, y1: 19, type: 'lowrise' });
      else lots.push({ x0, y0: 40, x1, y1, type: 'interior' });
      continue;
    }
    if (ci === 0 && !edge) {
      lots.push({ x0, y0, x1, y1, type: ri === 1 ? 'lowrise' : 'warehouse' });
      continue;
    }
    if (edge) {
      // edge rows: tall towers, occasionally a lowrise for perches
      let x = x0;
      while (x <= x1) {
        let w = Math.min(x1 - x + 1, R.int(5, 9));
        if (x1 - x + 1 - w < 5) w = x1 - x + 1;
        lots.push({ x0: x, y0, x1: x + w - 1, y1, type: R.chance(0.25) ? 'lowrise' : 'tower' });
        x += w + 1;
      }
      continue;
    }
    const b = { x0, y0, x1, y1 };
    if (R.chance(0.7)) {
      if (R.chance(0.5)) {
        const sx = R.int(x0 + 6, x1 - 7);
        lots.push({ x0, y0, x1: sx, y1 }, { x0: sx + 3, y0, x1, y1 });
        fillF(sx + 1, y0, sx + 2, y1, F.ALLEY);
      } else {
        const sy = R.int(y0 + 6, y1 - 7);
        lots.push({ x0, y0, x1, y1: sy }, { x0, y0: sy + 3, x1, y1 });
        fillF(x0, sy + 1, x1, sy + 2, F.ALLEY);
      }
    } else lots.push(b);
  }
  const wanted = R.shuffle(['parking', 'park', 'gas', 'construction', 'interior', 'store', 'lowrise', 'lowrise', 'plaza', 'interior']);
  const filler = ['office', 'lowrise', 'interior', 'office', 'warehouse', 'park', 'parking', 'plaza'];
  for (const l of lots) {
    if (l.type) continue;
    const big = W_(l) >= 11 && H_(l) >= 9;
    let t = null;
    for (let k = 0; k < wanted.length; k++) {
      const c = wanted[k];
      if ((c === 'gas' || c === 'parking' || c === 'construction') && !big) continue;
      t = c; wanted.splice(k, 1); break;
    }
    l.type = t || R.pick(filler);
  }
  for (const l of lots) {
    switch (l.type) {
      case 'tower': office(l, true); break;
      case 'office': office(l); break;
      case 'lowrise': lowrise(l); break;
      case 'interior': interior(l, 'office'); break;
      case 'store': interior(l, 'store'); break;
      case 'warehouse': interior(l, 'warehouse'); break;
      case 'park': park(l); break;
      case 'parking': parking(l); break;
      case 'gas': gas(l); break;
      case 'construction': construction(l); break;
      case 'plaza': plaza(l); break;
    }
  }

  // ---------- helipad plaza ----------
  fillF(83, 20, 99, 39, F.PLAZA);
  for (let y = 20; y <= 39; y++) for (let x = 83; x <= 99; x++) {
    if (dist(x + 0.5, y + 0.5, LZ.cx, LZ.cy) < 4.6) m.floor[idx(x, y)] = F.HELIPAD;
  }
  for (const [x, y] of [[86, 22], [86, 37], [98, 21], [98, 38], [89, 26], [89, 35]]) put(x, y, O.LAMP);
  for (let x = 87; x <= 98; x++) { if (x % 4 !== 0) { put(x, 23, O.SANDBAG); put(x, 37, O.SANDBAG); } }
  for (let y = 25; y <= 35; y++) if (y % 3 !== 0 && (y < 28 || y > 32)) put(87, y, O.SANDBAG);
  for (const [x, y] of [[84, 25], [84, 34], [91, 25], [91, 35], [97, 25], [97, 35], [85, 29], [85, 31]]) put(x, y, R.pick([O.CRATES, O.CRATE, O.BARRIER]));
  addVehicle('truck', 84, 20, true, '#3b4a33');
  addVehicle('truck', 93, 38, true, '#3b4a33');
  m.decor.push({ kind: 'helipadH', i: -1, x: LZ.cx, z: LZ.cy });

  // ---------- streets ----------
  const sidewalkNextToRoad = (x, y) => m.floor[idx(x, y)] === F.SIDEWALK && DIR4.some(([dx, dy]) => isRoadTile(x + dx, y + dy));
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    if (!sidewalkNextToRoad(x, y) || !free(x, y)) continue;
    if ((x * 7 + y * 3) % 9 === 0 && !nearIntersection(x, y)) put(x, y, O.LAMP);
    else if (R.chance(0.03)) put(x, y, O.HYDRANT);
    else if (R.chance(0.025)) put(x, y, R.pick([O.BENCH, O.DUMPSTER, O.PLANTER]));
  }
  // parked cars and traffic in vertical roads
  for (const v of VR) {
    for (const lane of [v, v + 3]) {
      for (let y = 0; y < MH - 1; y++) {
        if (inHR(y) || inHR(y + 1) || nearIntersection(lane, y) && R.chance(0.6)) continue;
        if (R.chance(0.33) && addVehicle('car', lane, y, false)) y += 2;
      }
    }
    for (let y = 1; y < MH - 6; y++) {
      if (inHR(y) || inHR(y + 5)) continue;
      const r = R();
      if (r < 0.04) { if (addVehicle('truck', v + 1, y, false, truckColor())) y += 6; }
      else if (r < 0.05) { if (addVehicle('bus', v + 1, y, false, '#d9a31f')) y += 8; }
      else if (r < 0.08) { if (addVehicle('car', v + R.int(1, 2), y, false)) y += 3; }
    }
  }
  for (const h of HR) {
    for (const lane of [h, h + 3]) {
      for (let x = 0; x < 82; x++) {
        if (inVR(x) || inVR(x + 1) || reserved.has(idx(x, lane))) continue;
        if (R.chance(0.3) && addVehicle('car', x, lane, true)) x += 2;
      }
    }
    for (let x = 8; x < 76; x++) {
      if (inVR(x) || inVR(x + 5)) continue;
      const r = R();
      if (r < 0.035) { if (addVehicle('truck', x, h + 1, true, truckColor())) x += 6; }
      else if (r < 0.045) { if (addVehicle('bus', x, h + 1, true, '#d9a31f')) x += 8; }
      else if (r < 0.07) { if (addVehicle('car', x, h + R.int(1, 2), true)) x += 3; }
    }
  }
  // roadblocks on the main avenue (with gaps so it stays passable)
  const roadblocks = [45, 68];
  for (const rx of roadblocks) {
    for (let y = 28; y <= 31; y++) { const i = idx(rx, y); if (m.obj[i] === O.NONE || m.obj[i] === O.CAR) { if (m.veh[i] < 0) m.obj[i] = O.NONE; } }
    for (const y of [28, 29, 31]) put(rx, y, y === 29 ? O.BARRIER : O.SANDBAG);
    put(rx + 1, 27, O.SANDBAG); put(rx + 1, 32, O.SANDBAG);
    addVehicle('truck', rx + 2, 28, false, '#3b4a33');
  }
  // insertion van at the start
  addVehicle('truck', 6, 29, true, '#20252b');
  for (const [x, y] of [[0, 27], [5, 27], [0, 32]]) put(x, y, O.CRATE);

  // ---------- connectivity check ----------
  const startI = idx(...START[0]), lzI = idx(Math.floor(LZ.cx), Math.floor(LZ.cy));
  let r = m.reach(START[0][0], START[0][1], 999, () => false);
  if (!isFinite(r.dist[lzI])) {
    for (let x = 0; x < MW; x++) for (const y of [29, 30]) {
      const i = idx(x, y);
      if (m.obj[i] !== O.BUILDING && m.veh[i] < 0) m.obj[i] = O.NONE;
    }
    r = m.reach(START[0][0], START[0][1], 999, () => false);
  }

  m.computeLit();
  const enemies = placeEnemies(m, R, diffKey, r.dist);
  return { map: m, enemies, start: START, lz: LZ, startI };
}

function placeEnemies(m, R, diffKey, reachDist) {
  const D = DIFFICULTY[diffKey];
  const out = [];
  const taken = new Set();
  let total = D.enemies;
  const ok = (x, y, minX = 24) => {
    if (!m.inb(x, y) || x < minX) return false;
    const i = m.idx(x, y);
    return m.walkable(i) && !taken.has(i) && !m.lzTiles.has(i) && isFinite(reachDist[i]) && m.ladder[i] < 0;
  };
  const add = (type, x, y, extra = {}) => {
    taken.add(m.idx(x, y));
    out.push({ type, x, y, facing: extra.facing ?? R.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]), ...extra });
    total--;
  };
  const near = (cx, cy, rad) => {
    for (let k = 0; k < 40; k++) {
      const x = Math.round(cx + R.range(-rad, rad)), y = Math.round(cy + R.range(-rad, rad));
      if (ok(x, y)) return [x, y];
    }
    return null;
  };
  const faceToward = (x, y, tx, ty) => Math.atan2(ty - y, tx - x);

  // snipers: roof edges and windows
  const perches = [];
  for (let i = 0; i < m.n; i++) {
    const x = m.X(i), y = m.Y(i);
    if (x < 26) continue;
    if (m.isRoof(i)) {
      for (const [dx, dy] of DIR4) {
        const ni = m.idx(x + dx, y + dy);
        if (m.inb(x + dx, y + dy) && !m.isRoof(ni) && m.obj[ni] !== O.BUILDING) { perches.push([x, y, Math.atan2(dy, dx)]); break; }
      }
    } else if (m.floor[i] === F.INTERIOR && m.walkable(i)) {
      for (const [dx, dy] of DIR4) {
        if (m.obj[m.idx(x + dx, y + dy)] === O.WINDOW) { perches.push([x, y, Math.atan2(dy, dx)]); break; }
      }
    }
  }
  R.shuffle(perches);
  const snipers = [];
  const nSnipers = Math.round(D.enemies * 0.15);
  for (const [x, y, f] of perches) {
    if (snipers.length >= nSnipers) break;
    if (!ok(x, y, 26) || snipers.some(([sx, sy]) => dist(sx, sy, x, y) < 12)) continue;
    snipers.push([x, y]);
    add('sniper', x, y, { facing: f, guard: true });
  }

  // LZ defenders
  const pod = () => out.length + 1000 + Math.floor(R() * 1e6);
  const lzPod = pod();
  for (const [t, x, y] of [['gunner', 88, 24], ['trooper', 90, 36], ['officer', 95, 24], ['trooper', 88, 33], ['grenadier', 97, 36]]) {
    const p = ok(x, y) ? [x, y] : near(x, y, 2);
    if (p) add(t, p[0], p[1], { pod: lzPod, facing: Math.PI, guard: true });
  }
  // checkpoints
  for (const rx of [45, 68]) {
    const cp = pod();
    for (const [t, dx, dy] of [['gunner', 1, 30], ['trooper', 1, 28], ['trooper', 2, 33]]) {
      const p = ok(rx + dx, dy) ? [rx + dx, dy] : near(rx + dx, dy, 2);
      if (p) add(t, p[0], p[1], { pod: cp, facing: Math.PI, guard: true });
    }
  }
  // patrols on streets
  const nPatrol = diffKey === 'legend' ? 4 : 3;
  const streetSpots = [];
  for (let i = 0; i < m.n; i++) {
    const x = m.X(i), y = m.Y(i);
    if (x >= 26 && x <= 90 && (m.floor[i] === F.SIDEWALK || m.floor[i] === F.ROAD) && m.walkable(i)) streetSpots.push([x, y]);
  }
  for (let k = 0; k < nPatrol && total > 2; k++) {
    const [x, y] = R.pick(streetSpots);
    const route = [[x, y]];
    for (let j = 0; j < 3; j++) {
      const cand = streetSpots.filter(([sx, sy]) => dist(sx, sy, x, y) > 8 && dist(sx, sy, x, y) < 22);
      if (cand.length) route.push(R.pick(cand));
    }
    const pp = pod();
    const a = ok(x, y) ? [x, y] : near(x, y, 2);
    if (!a) continue;
    add('trooper', a[0], a[1], { pod: pp, patrol: route });
    const b = near(a[0], a[1], 1.5);
    if (b) add(R.chance(0.5) ? 'grenadier' : 'trooper', b[0], b[1], { pod: pp, patrol: route, follower: true });
  }
  // guard pods spread across the city
  const centers = [];
  let officers = 1;
  for (let tries = 0; tries < 600 && total > 0; tries++) {
    const cx = R.int(24, 90), cy = R.int(2, MH - 3);
    if (!ok(cx, cy) || centers.some(([x, y]) => dist(x, y, cx, cy) < 8)) continue;
    centers.push([cx, cy]);
    const size = Math.min(total, R.int(2, 4));
    const pp = pod();
    const facing = R.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI * 0.75, -Math.PI * 0.75]);
    for (let j = 0; j < size; j++) {
      const p = j === 0 ? [cx, cy] : near(cx, cy, 2.5);
      if (!p) continue;
      let t = R.pick(['trooper', 'trooper', 'trooper', 'gunner', 'grenadier']);
      if (j === 0 && officers < 3 && R.chance(0.3)) { t = 'officer'; officers++; }
      add(t, p[0], p[1], { pod: pp, facing: facing + R.range(-0.5, 0.5), guard: true });
    }
  }
  return out;
}
