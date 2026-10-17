// Static game data: tiles, objects, weapons, agents, enemies.

export const MW = 100, MH = 60;

export const F = { ROAD: 0, SIDEWALK: 1, GRASS: 2, INTERIOR: 3, PARKING: 4, PLAZA: 5, DIRT: 6, HELIPAD: 7, ALLEY: 8 };
export const FLOOR = [
  { name: 'Road', col: '#1d2024', mat: 1, tex: 'asphalt', h: 0 },
  { name: 'Sidewalk', col: '#55575b', mat: 6, tex: 'sidewalk', h: 0.07 },
  { name: 'Grass', col: '#1f3320', mat: 5, tex: 'grass', h: 0.04 },
  { name: 'Interior', col: '#5a4434', mat: 6, tex: 'floor', h: 0.05 },
  { name: 'Parking', col: '#26282c', mat: 1, tex: 'asphalt', h: 0 },
  { name: 'Plaza', col: '#615a52', mat: 6, tex: 'plaza', h: 0.06 },
  { name: 'Dirt', col: '#3f3426', mat: 0, tex: 'dirt', h: 0.02 },
  { name: 'Helipad', col: '#3b4148', mat: 6, tex: 'concrete', h: 0.09 },
  { name: 'Alley', col: '#2c2a28', mat: 1, tex: 'asphalt', h: 0.02 },
];

export const O = {
  NONE: 0, WALL: 1, WINDOW: 2, BUILDING: 3, CAR: 4, TRUCK: 5, CRATE: 6, CRATES: 7, BARRIER: 8, SANDBAG: 9,
  DUMPSTER: 10, BARREL: 11, HYDRANT: 12, TREE: 13, LAMP: 14, PUMP: 15, HEDGE: 16, BENCH: 17, STATUE: 18,
  CONTAINER: 19, RUBBLE: 20, DESK: 21, SHELF: 22, PLANTER: 23, DOOR: 24, KIOSK: 25,
};

// walk: passable. cover: 0 none, 1 half, 2 full. h: line-of-sight blocking height.
// peek: a unit right next to it can lean around it (it never blocks LOS for adjacent shooters/targets).
// to: what it becomes when destroyed. shootable: can be targeted directly.
export const OBJ = [];
const def = (id, p) => (OBJ[id] = { name: '', walk: false, cover: 0, h: 0, hp: 10, peek: true, to: O.NONE, moveCost: 1, ...p });
def(O.NONE, { walk: true, hp: 0 });
def(O.WALL, { name: 'Wall', cover: 2, h: 2.7, hp: 14, peek: false, to: O.RUBBLE, debris: '#7a756c' });
def(O.WINDOW, { name: 'Window', cover: 2, h: 0.95, hp: 8, peek: false, to: O.RUBBLE, debris: '#7a756c', shootable: true });
def(O.BUILDING, { name: 'Building', cover: 2, h: 99, hp: 30, peek: false, to: O.RUBBLE, debris: '#6d6a66' });
def(O.CAR, { name: 'Car', cover: 1, h: 1.25, shootable: true, vehicle: true });
def(O.TRUCK, { name: 'Truck', cover: 2, h: 2.7, shootable: true, vehicle: true });
def(O.CRATE, { name: 'Crate', cover: 1, h: 1.0, hp: 6, debris: '#7a5a34' });
def(O.CRATES, { name: 'Crate stack', cover: 2, h: 2.1, hp: 12, to: O.CRATE, debris: '#7a5a34' });
def(O.BARRIER, { name: 'Barrier', cover: 1, h: 1.0, hp: 16, to: O.RUBBLE, debris: '#9a9a96' });
def(O.SANDBAG, { name: 'Sandbags', cover: 1, h: 1.0, hp: 14, debris: '#8a7b58' });
def(O.DUMPSTER, { name: 'Dumpster', cover: 1, h: 1.35, hp: 14, debris: '#2f5a3a' });
def(O.BARREL, { name: 'Fuel barrel', cover: 1, h: 1.0, hp: 2, shootable: true, explode: { r: 1.9, dmg: 4, env: 10 }, debris: '#a33' });
def(O.HYDRANT, { name: 'Hydrant', cover: 0, h: 0.6, hp: 3, shootable: true, mist: true, debris: '#b22' });
def(O.TREE, { name: 'Tree', cover: 1, h: 0, hp: 10, foliage: true, debris: '#2b4a22' });
def(O.LAMP, { name: 'Street lamp', cover: 0, h: 0, hp: 2, shootable: true, debris: '#444' });
def(O.PUMP, { name: 'Fuel pump', cover: 1, h: 1.6, hp: 3, shootable: true, explode: { r: 2.6, dmg: 5, env: 16 }, debris: '#ddd' });
def(O.HEDGE, { name: 'Hedge', cover: 1, h: 1.0, hp: 6, debris: '#2b4a22' });
def(O.BENCH, { name: 'Bench', cover: 1, h: 0.7, hp: 5, debris: '#6a4a2a' });
def(O.STATUE, { name: 'Statue', cover: 2, h: 3.2, hp: 30, to: O.RUBBLE, debris: '#8a8a80' });
def(O.CONTAINER, { name: 'Container', cover: 2, h: 2.6, hp: 30, to: O.RUBBLE, debris: '#5a4a3a' });
def(O.RUBBLE, { name: 'Rubble', walk: true, moveCost: 1.6, cover: 1, h: 0.6, hp: 0 });
def(O.DESK, { name: 'Desk', cover: 1, h: 0.85, hp: 6, debris: '#6a4a2a' });
def(O.SHELF, { name: 'Shelves', cover: 2, h: 2.0, hp: 8, debris: '#555' });
def(O.PLANTER, { name: 'Planter', cover: 1, h: 0.9, hp: 12, to: O.RUBBLE, debris: '#888' });
def(O.DOOR, { name: 'Doorway', walk: true, hp: 0 });
def(O.KIOSK, { name: 'Kiosk', cover: 2, h: 2.4, hp: 14, to: O.RUBBLE, debris: '#666' });

export const VEHICLES = {
  car: { w: 1, l: 2, hp: 9, explode: { r: 2.2, dmg: 4, env: 9 }, alarm: true },
  truck: { w: 2, l: 4, hp: 20, explode: { r: 2.6, dmg: 5, env: 12 } },
  bus: { w: 2, l: 6, hp: 26, explode: { r: 2.6, dmg: 5, env: 12 } },
  tanker: { w: 2, l: 5, hp: 14, explode: { r: 4.5, dmg: 8, env: 30 } },
};

export const CAR_COLORS = ['#8b1e24', '#1f4f8b', '#d9d6cf', '#222326', '#c99a2e', '#3f6f3a', '#6b6f75', '#5a2a6b', '#b55b1f', '#0f6f77'];

// rangeMod(distance) returns aim modifier.
export const WEAPONS = {
  sniper: { name: 'Sniper Rifle', icon: '⌖', dmg: [5, 7], ammo: 3, crit: 25, noise: 20, range: 40, twoAP: true, squadsight: true,
    rangeMod: (d) => (d <= 3 ? -25 : d <= 6 ? -10 : 5), sfx: 'sniper_shot', tracer: [1, 0.85, 0.5], kind: 'bullet' },
  pistol: { name: 'Pistol', icon: '⁍', dmg: [2, 3], ammo: Infinity, crit: 5, noise: 10, range: 12,
    rangeMod: (d) => (d <= 5 ? 10 : 10 - (d - 5) * 4), sfx: 'pistol_shot', tracer: [1, 0.8, 0.5], kind: 'bullet' },
  mg: { name: 'Machine Gun', icon: '⁂', dmg: [4, 6], ammo: 4, crit: 5, noise: 18, range: 17, shred: true, burst: 7,
    rangeMod: (d) => (d <= 9 ? 5 : 5 - (d - 9) * 3), sfx: 'mg_burst', tracer: [1, 0.7, 0.3], kind: 'bullet' },
  smg: { name: 'SMG', icon: '⁑', dmg: [3, 5], ammo: 5, crit: 10, noise: 14, range: 13, burst: 3,
    rangeMod: (d) => (d <= 4 ? 20 : 20 - (d - 4) * 5), sfx: 'smg_burst', tracer: [1, 0.85, 0.4], kind: 'bullet' },
  carbine: { name: 'Carbine', icon: '⁑', dmg: [3, 5], ammo: 4, crit: 10, noise: 15, range: 15, burst: 3,
    rangeMod: (d) => (d <= 10 ? 5 : 5 - (d - 10) * 3), sfx: 'smg_burst', tracer: [1, 0.85, 0.4], kind: 'bullet' },
  laser: { name: 'Laser Pistol', icon: '✶', dmg: [4, 5], ammo: 6, crit: 15, noise: 5, range: 15, pierce: true,
    rangeMod: (d) => (d <= 10 ? 10 : 10 - (d - 10) * 5), sfx: 'laser_pistol', tracer: [1, 0.15, 0.25], kind: 'laser' },
  // enemy weapons
  rifle: { name: 'Rifle', dmg: [3, 4], ammo: 99, crit: 5, noise: 16, range: 15, burst: 3,
    rangeMod: (d) => (d <= 8 ? 0 : -(d - 8) * 3), sfx: 'smg_burst', tracer: [1, 0.4, 0.3], kind: 'bullet' },
  emg: { name: 'LMG', dmg: [4, 5], ammo: 99, crit: 5, noise: 18, range: 16, burst: 6, shred: true,
    rangeMod: (d) => (d <= 9 ? 0 : -(d - 9) * 3), sfx: 'mg_burst', tracer: [1, 0.35, 0.25], kind: 'bullet' },
  esniper: { name: 'Marksman Rifle', dmg: [4, 6], ammo: 99, crit: 20, noise: 20, range: 30,
    rangeMod: (d) => (d <= 4 ? -20 : 5), sfx: 'sniper_shot', tracer: [1, 0.3, 0.3], kind: 'bullet' },
};

export const ITEMS = {
  frag: { name: 'Frag Grenade', range: 10, r: 1.6, dmg: 4, env: 12, noise: 22 },
  smoke: { name: 'Smoke Grenade', range: 10, r: 2.2, turns: 2 },
  rocket: { name: 'Rocket', range: 16, r: 2.6, dmg: 6, env: 24, noise: 26 },
  drone: { name: 'Recon Drone', range: 12, r: 7, turns: 2 },
  medkit: { name: 'Medkit', heal: 5 },
};

export const AGENTS = [
  { key: 'viper', name: 'VIPER', role: 'Sniper', color: '#4fd8ff', hp: 7, aim: 78, mob: 5, vision: 13,
    weapons: ['sniper', 'pistol'], items: {}, abilities: [],
    blurb: 'Sniper rifle needs a full turn (no moving) but can hit anything the squad can see.' },
  { key: 'bulldog', name: 'BULLDOG', role: 'Heavy', color: '#ffad3b', hp: 11, aim: 62, mob: 5, vision: 11,
    weapons: ['mg'], items: { rocket: 2, frag: 1 }, abilities: ['suppress'],
    blurb: 'Machine gun shreds cover. Rockets level walls, cars and anyone behind them.' },
  { key: 'ghost', name: 'GHOST', role: 'Infiltrator', color: '#b48cff', hp: 7, aim: 74, mob: 7, vision: 12,
    weapons: ['laser'], items: {}, abilities: ['takedown', 'shadow'],
    blurb: 'Near-silent laser burns through cover. Knife takedowns on unaware enemies.' },
  { key: 'sparks', name: 'SPARKS', role: 'Demolitions', color: '#8dff6a', hp: 8, aim: 66, mob: 6, vision: 11,
    weapons: ['smg'], items: { frag: 3, smoke: 2 }, abilities: [],
    blurb: 'Grenades destroy cover. Smoke blocks sight lines and makes the team hard to hit.' },
  { key: 'doc', name: 'DOC', role: 'Medic / Tech', color: '#ff7ccf', hp: 8, aim: 66, mob: 6, vision: 11,
    weapons: ['carbine'], items: { medkit: 3, drone: 2, smoke: 1 }, abilities: [],
    blurb: 'Medkits heal and revive downed agents. Recon drone sees over everything.' },
];

export const ENEMIES = {
  trooper: { name: 'Trooper', hp: 5, aim: 60, mob: 6, vision: 12, weapon: 'rifle', color: '#6e2a26' },
  gunner: { name: 'Gunner', hp: 8, aim: 55, mob: 5, vision: 12, weapon: 'emg', color: '#4a2222', bulky: true },
  sniper: { name: 'Sniper', hp: 4, aim: 72, mob: 5, vision: 18, weapon: 'esniper', color: '#3d3226' },
  grenadier: { name: 'Grenadier', hp: 5, aim: 58, mob: 6, vision: 12, weapon: 'rifle', color: '#4f4422', grenades: 1 },
  officer: { name: 'Officer', hp: 7, aim: 66, mob: 6, vision: 13, weapon: 'rifle', color: '#24242e', officer: true },
};

export const DIFFICULTY = {
  recruit: { label: 'Recruit', enemies: 24, aim: -10, reinforce: 2 },
  veteran: { label: 'Veteran', enemies: 34, aim: 0, reinforce: 3 },
  legend: { label: 'Legend', enemies: 46, aim: 6, reinforce: 4 },
};
