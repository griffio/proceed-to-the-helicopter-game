# Proceed to the Helicopter

A turn-based tactics game in the spirit of XCOM, rendered with WebGPU and built touch-first for iPad.

Your five-agent cell has been burned. Get them across a rain-soaked, destructible night city, past dozens of hostiles, to the helicopter waiting on the far side.

![Title screen](docs/screenshots/title.jpg)

## Gameplay

### Stealth first

Each agent sees in a 120° cone, and the rest of the city stays under fog of war. Enemies you can see show their vision cones as red tiles. Lit areas get you spotted from further away, so shooting out street lamps buys you darkness. If an enemy spots you, kill them before the enemy turn or they raise the alarm and reinforcements start arriving.

![Squad closing on an unaware guard post, with enemy vision cones](docs/screenshots/stealth.jpg)

### Every shot is explained

Hit chance comes from cover, range, smoke and trees in the way, height, darkness and field of view. Shooting an enemy who is unaware or looking the other way is much easier. The panel lists every modifier before you fire.

![Sniper shot breakdown on an unaware gunner](docs/screenshots/aim.jpg)

### The city breaks

Rockets and grenades flatten walls and cover, and agents on a destroyed roof fall. Cars catch fire and explode when shot enough, and set off alarms that lure guards. Fuel barrels, pumps and the tanker chain-react. Missed shots wear down whatever the target is hiding behind.

![A car exploding beside an enemy patrol](docs/screenshots/explosion.jpg)

### Look anywhere

Twist two fingers to rotate the view a full 360°, for example to see around a tall building. The ↺ ↻ buttons turn 90° at a time and the compass faces north again.

![Rotated view of a burning street](docs/screenshots/rotated.jpg)

### Get to the landing zone

Step an agent onto the green landing zone and press **Extract**. The helipad is ringed with sandbags and guarded. The mission ends when every agent is aboard or down, and your rating depends on how many made it.

![The helicopter over the landing zone](docs/screenshots/helicopter.jpg)

## The squad

| Agent | Role | Kit |
|---|---|---|
| **Viper** | Sniper | Sniper rifle (needs a full turn, can hit anything the squad sees), pistol |
| **Bulldog** | Heavy | Machine gun that shreds cover and pins enemies down, 2 rockets, frag grenade |
| **Ghost** | Infiltrator | Near-silent laser pistol that burns through cover, knife takedowns, short-term stealth |
| **Sparks** | Demolitions | SMG, 3 frag grenades, 2 smoke grenades |
| **Doc** | Medic / Tech | Carbine, medkits that heal and revive downed agents, recon drone, smoke grenade |

Enemies include troopers, machine gunners, grenadiers, officers (killing one panics their squad) and snipers. A sniper paints its target with a red laser that shows through the fog, then fires on its next turn unless you break line of sight. There are three difficulties: Recruit (24 hostiles), Veteran (34) and Legend (46).

## Controls

| | iPad | Desktop |
|---|---|---|
| Move | Tap a tile to preview, tap again to go | Click twice |
| Aim | Tap an enemy, check the odds, press **Fire** | Click, then Enter |
| Pan | Drag | Drag, WASD or arrow keys |
| Zoom | Pinch | Mouse wheel |
| Rotate | Twist two fingers, or ↺ ↻ | Q / E |
| Next agent | Tap a squad card | Tab |
| End turn | **End Turn** | Space |

## Run it

```sh
npm run serve        # http://localhost:8080
```

WebGPU only runs in a secure context, meaning `localhost` or HTTPS. An iPad opening the game over plain `http://<lan-ip>` won't get WebGPU, so host it on HTTPS. On iPad it needs Safari on iPadOS 26 or later.

There is no build step. The game is plain ES modules loaded straight from `src/`.

### Deploy to GitHub Pages

`.github/workflows/deploy-pages.yml` publishes the game on every push to `master` (or run it by hand from the Actions tab). GitHub Pages serves over HTTPS, so it works on iPad.

One-time setup: in the repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**. The game is then served at `https://<user>.github.io/<repo>/`.

## Audio

All sound effects and voice lines are pre-generated with ElevenLabs into `assets/audio/` and played with the Web Audio API, with a radio filter on the squad's voices. The API key is only used when generating, never shipped to the browser.

```sh
ELEVENLABS_API_KEY=sk_... npm run audio                           # generate missing files
ELEVENLABS_API_KEY=sk_... node tools/generate-audio.mjs --force   # regenerate everything
```

To change a line, a voice or a sound prompt, edit `tools/audio-manifest.mjs`, delete the matching `.mp3` and run the generator again.

## How it's built

| File | Role |
|---|---|
| `src/renderer.js` | WebGPU renderer: instanced meshes, cached shadow map, point lights, wet-street reflections, fog of war, decals, particles and beams |
| `src/scene.js` | Turns the city into geometry and lights, in 10×10-tile chunks for frustum culling |
| `src/mapgen.js` | Procedural city, vehicles and enemy placement |
| `src/map.js` | Tiles, height-aware line of sight, cover, pathfinding, destruction |
| `src/game.js` | Turns, vision, stealth, combat, explosions, abilities |
| `src/ai.js` | Enemy patrols, investigation, cover-seeking combat, sniper lasers |
| `src/fx.js` | Particles, tracers, lasers, debris, projectiles, rain |
| `src/ui.js`, `src/input.js` | HUD, minimap, touch gestures |
| `src/audio.js` | Sound playback and the radio voice chain |

Rendering notes:
- Only the visible part of the city is drawn.
- Building shadows are rendered once and only redrawn when something is destroyed.
- Pixels in unexplored fog skip lighting entirely.
- The game lowers its render resolution if it can't hold about 40 fps.
