# Roadmap

Ideas for where the game could go next. Nothing here is committed or scheduled. Each idea says which existing systems it builds on, so it's clear how much is new and how much is wiring.

The theme running through most of them is **setting up a kill zone before the fight starts**. Darkness, noise and the destructible city are already in the game; these features give the squad more ways to use them on purpose.

## Traps and explosives

### Tripwire

Sparks strings a wire between two adjacent walls, cars or posts. The first enemy to walk through it trips a charge or a flare. A wire on a lit tile is easy to spot and an alert enemy will step over it, so it works best in the dark on a patrol route.

*Builds on:* tile objects in `map.js`, enemy movement in `ai.js`, the lit-tile map that **Kill Light** already changes.

### Claymore

A directional mine that fires a cone of shrapnel in the direction it was placed when an enemy enters the cone. It shreds half cover like the machine gun does. Enemies who see it go around it, and a suspicious enemy may disarm it.

**The tactic:** shoot out the street lamp over an alley, plant a claymore facing the dark, then make a noise at the far end so the patrol comes through.

*Builds on:* the cone maths used for vision cones, `shred` from the MG, `noise()` and enemy investigation.

### C4

Plant a charge on an adjacent car, truck, tanker, wall, door or fuel pump. Choose how to set it off:

- **Timer:** it goes off after 1–3 turns. You don't need to stay in sight, but enemies might walk past, or might find and defuse it.
- **Remote:** a 1 AP **Detonate** action, available to the agent who planted it as long as they're up. If they go down, the charge is dead weight until someone picks up the detonator.

A car with C4 goes off with its normal vehicle explosion plus the charge, so a tanker or a row of parked cars turns into a chain reaction. On a wall, C4 blows a new doorway, giving a route that doesn't go through the guarded street.

*Builds on:* vehicle explosions and chain reactions, wall destruction to `RUBBLE`, the AP and action system in `game.js`.

### Decoys and lures

- **Thrown noisemaker:** a bottle or coin thrown at a tile makes a small noise there, which draws one nearby enemy to investigate without raising the alarm.
- **Trigger a car alarm on purpose:** Doc hacks a car to set off its alarm, pulling the patrol toward it. Pair it with C4 on the same car.
- **Fake radio chatter:** Doc spoofs the enemy radio to send one squad to a different place for a turn.

*Builds on:* `noise()`, car alarms already drawing guards, the suspicious state in `ai.js`.

## Darkness and the city

### Power grid

Each block is fed by a transformer box. Shooting it or planting C4 on it blacks out every street lamp and lit window in the block at once, which is a big step up from shooting lamps out one by one. Enemies send someone to fix it, and that person makes an easy target.

*Builds on:* `computeLit()` in `map.js`, the point lights in `renderer.js`, lit windows on buildings.

### Water and electricity

A burst hydrant floods the tiles around it. Shooting a lamp or transformer into the water electrocutes anyone standing in it.

*Builds on:* hydrant mist, shootable lamps.

### Weather that changes

- **Heavy rain** masks sound, so noise travels a shorter distance.
- **Lightning** briefly lights the whole map. Everyone in the open, agents and enemies alike, can be seen for a moment.
- **Fog banks** roll through and cut vision range in part of the map.

*Builds on:* the rain particles in `fx.js`, the vision and noise radii.

### Sewers and rooftops

- **Manholes** connect underground. Climbing down takes an agent off the map, and they come out at another manhole the next turn.
- **Zip lines** between rooftops reward the height bonus and let snipers move without touching the street.

*Builds on:* pathfinding in `map.js`, roofs agents can already stand on.

## Stealth

- **Bodies are found.** An enemy who finds a body raises the alarm unless the body has been dragged into a dumpster, hedge or the dark. Ghost drags bodies at no extra cost.
- **Hiding places.** An agent can hide in a dumpster or hedge. They can't be seen unless an enemy searches that exact tile, but they can't act.
- **Disguise.** After a takedown, Ghost takes the uniform. Unaware enemies ignore Ghost at a distance, but officers and anyone close up will see through it.
- **Footprints in the rain.** Agents who walk through puddles leave a trail that an alert enemy can follow for a turn.

## Squad

- **Carry a downed agent.** Any agent can pick up a downed teammate and carry them at half speed, then extract with them. This turns "leave them or save them" into a real choice.
- **Bulldog breach.** Kick in a door or barge through a weak wall, stunning anyone behind it.
- **Viper ricochet.** A shot off a car or container to hit a target behind cover, at a big aim penalty.
- **Doc hacks.** Take over a security camera to see through it, or turn an enemy turret.
- **Sparks salvage.** Pick up an enemy grenadier's grenades and gunners' ammunition.

## Enemies

- **Security cameras** sweep a cone on a fixed pattern. They can be shot out, which is noisy, or hacked, which is quiet.
- **Dog handlers.** Dogs see through smoke and Ghost's shadow, and follow scent trails. They're fast but fragile.
- **Searchlight helicopter.** An enemy helicopter sweeps a spotlight over the streets each turn. Anyone in the light is spotted. It can be shot down with a rocket, and the wreck lands as a burning vehicle.
- **Patrol van.** A vehicle that drives the roads with headlights, unloads troops when the alarm goes off, and is itself a target for C4.
- **Engineers** who spot and disarm traps, and lay their own on the routes to the landing zone.
- **Riot shields.** Full cover from the front, so you have to flank, use explosives or use Ghost's laser.

## Missions

- **Hot LZ.** If the alarm has been up too long, the pilot calls off the first landing zone and the squad has to move to a second one.
- **Gunship support.** Once a mission, the pilot strafes a line of tiles. The pilot is already a voice character.
- **Side objectives.** Collect an intel case, rescue a captured agent, or get a VIP out who can't fight.
- **Campaign.** A run of cities where injuries carry over, downed agents may not come back, and survivors earn perks.
- **Daily seed.** Everyone gets the same city each day, with a score for time, stealth and survivors.

## Feel and presentation

- **Explosion kill cam.** Slow motion and a close camera on chain reactions.
- **Trap view.** Show where traps are and what their trigger areas cover, like the enemy vision cones.
- **Undo last move.** Allowed only if the move revealed nothing new, so it forgives a mis-tap without letting you scout for free.
- **New voice lines** for planting, detonating and traps going off. Add them to `tools/audio-manifest.mjs` and run `npm run audio`.
