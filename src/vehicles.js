// Vehicle models converted from Kenney's Car Kit (CC0) by tools/build-vehicles.py.
export const VEH_MODELS = ['sedan', 'sedan-sports', 'hatchback-sports', 'suv', 'suv-luxury', 'van', 'truck', 'taxi', 'police',
  'delivery', 'garbage-truck', 'ambulance', 'firetruck'];

// Filled in by the renderer once assets/vehicles has loaded; until then (or if it fails)
// vehicles keep their box-built look.
export const VEH = { ready: false, models: {} };

// [model, weight]; buses and tankers have no model in the kit and stay box-built
const PICK = {
  car: [['sedan', 20], ['hatchback-sports', 14], ['suv', 14], ['suv-luxury', 9], ['sedan-sports', 8], ['van', 12], ['truck', 10], ['taxi', 9], ['police', 4]],
  truck: [['delivery', 55], ['garbage-truck', 20], ['ambulance', 15], ['firetruck', 10]],
};

export function pickModel(v) {
  const list = VEH.ready && PICK[v.kind];
  if (!list) return null;
  const total = list.reduce((s, [, w]) => s + w, 0);
  let r = v.seed * total;
  for (const [name, w] of list) { if ((r -= w) < 0) return VEH.models[name] ? name : null; }
  return null;
}
