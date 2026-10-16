# Proceed to the Helicopter

Turn-based tactics game (WebGPU, touch-first for iPad). Get five agents across a destructible night city to the extraction helicopter.

## Run

```sh
npm run serve        # http://localhost:8080
```

WebGPU only works in a secure context: `localhost` or HTTPS. Opening the game on an iPad over plain `http://<lan-ip>` will not work. Host it on HTTPS (or use the published artifact link).

## Audio

All sound effects and voice lines are pre-generated with ElevenLabs into `assets/audio/`. The API key is only used at build time and is never shipped to the browser.

```sh
ELEVENLABS_API_KEY=sk_... npm run audio            # generate missing files
ELEVENLABS_API_KEY=sk_... node tools/generate-audio.mjs --force   # regenerate all
```

Edit `tools/audio-manifest.mjs` to change lines, voices or sound prompts.

## Code map

| File | Role |
|---|---|
| `src/renderer.js` | WebGPU: instanced meshes, shadow map, point lights, fog-of-war, decals, particles, beams |
| `src/scene.js` | Turns the city into geometry and lights |
| `src/mapgen.js` | Procedural city, vehicles, enemy placement |
| `src/map.js` | Tiles, 2.5D line of sight, cover, pathfinding, destruction |
| `src/game.js` | Turns, vision, stealth, combat, explosions, abilities |
| `src/ai.js` | Enemy patrols, investigation, cover-seeking combat, sniper lasers |
| `src/ui.js`, `src/input.js` | HUD, touch/pinch/pan input |
