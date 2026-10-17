// Every sound in the game. generate-audio.mjs turns this into assets/audio/*.mp3
// and writes assets/audio/manifest.json, which the game loads at runtime.

export const VOICES = {
  viper: 'pFZP5JQG7iQjIQuC4Bku',   // Lily - sniper
  bulldog: 'SOYHLrjzK2X1ezoPC6cr', // Harry - heavy
  ghost: 'N2lVS1w4EtoT3dr4eOWO',   // Callum - infiltrator
  sparks: 'IKne3meq5aSn9XLyUdCD',  // Charlie - demolitions
  doc: 'EXAVITQu4vr4xnSDxMaL',     // Sarah - medic / tech
  overlord: 'onwK4e9ZLuTAKqWW03F9', // Daniel - mission handler
  pilot: 'iP95p4xoKVk53GoZ742B',   // Chris - helicopter pilot
  enemyA: 'pNInz6obpgDQGcFmaJgB',  // Adam
  enemyB: 'nPczCjzI2devNBz1zQrb',  // Brian
};

const agentLines = {
  viper: {
    select: ['Viper. Eyes open.', 'Scope ready.'],
    move: ['Relocating.', 'Moving to a new perch.'],
    attack: ['Taking the shot.', 'Sending it.'],
    kill: ['Target down.', 'One shot. One kill.'],
    hurt: ['I am hit! Still in the fight.'],
    ability: ['Holding this angle. Nothing gets past.'],
    overwatch: ['Overwatch. I have the lane.'],
    spotted: ['Contact. I see them.'],
    extract: ['Viper aboard. Go, go!'],
    wounded: ['Viper. I am hit, but I can still shoot.', 'Bleeding... still on target.'],
    downed: ['Viper down... I cannot move. I need a medic.', 'I cannot feel my legs... do not leave me here.'],
  },
  bulldog: {
    select: ['Bulldog. Let us make some noise.', 'Big gun, ready.'],
    move: ['Moving up.', 'Heavy coming through.'],
    attack: ['Eat lead!', 'Light them up!'],
    kill: ['Scratch one!', 'He is done.'],
    hurt: ['Agh! Just a scratch!'],
    ability: ['Rocket out! Clear the area!'],
    overwatch: ['Covering. Come and get it.'],
    spotted: ['Hostiles! Right there!'],
    extract: ['Bulldog on the bird!'],
    wounded: ['Bulldog. Took a few. Still standing.', 'Hurts like hell. Just point me at them.'],
    downed: ['Bulldog is down! Get me up, get me up!', 'Agh... cannot lift the gun. Somebody!'],
  },
  ghost: {
    select: ['Ghost. Already here.', 'Quiet as a shadow.'],
    move: ['Slipping through.', 'On the move. Quietly.'],
    attack: ['Lights out.', 'Burn.'],
    kill: ['Silent kill.', 'He never saw me.'],
    hurt: ['Hnn. They found me.'],
    ability: ['Going dark.'],
    overwatch: ['Watching from the dark.'],
    spotted: ['Movement. Enemy close.'],
    extract: ['Ghost aboard.'],
    wounded: ['Ghost. Wounded. Still quiet.', 'They drew blood. My turn next.'],
    downed: ['Ghost... down. Losing a lot of blood.', 'Cannot move... find me before they do.'],
  },
  sparks: {
    select: ['Sparks here! What are we blowing up?', 'Ready to cause trouble!'],
    move: ['On my way!', 'Repositioning!'],
    attack: ['Have some of this!', 'Fire!'],
    kill: ['Boom! Got him!', 'That one is not getting up!'],
    hurt: ['Ow! That one stung!'],
    ability: ['Fire in the hole!', 'Smoke out! Use it!'],
    overwatch: ['Watching the street.'],
    spotted: ['Oi! Enemies!'],
    extract: ['Sparks is on the helicopter!'],
    wounded: ['Sparks here. Bit singed, still sparky!', 'Ow. Okay. Okay. I am fine. Mostly.'],
    downed: ['Sparks down! This is not how I go out!', 'Bleeding out here! Somebody get Doc!'],
  },
  doc: {
    select: ['Doc here. Who needs patching?', 'Doc, ready.'],
    move: ['Moving.', 'Right behind you.'],
    attack: ['Engaging.', 'Taking them down.'],
    kill: ['Hostile neutralized.', 'He is down.'],
    hurt: ['I am hit! Medic is hit!'],
    ability: ['Hold still. Patching you up.', 'Drone is up. Mapping the area.'],
    overwatch: ['Covering the team.'],
    spotted: ['Contact! Enemy spotted.'],
    extract: ['Doc aboard. Everyone in?'],
    wounded: ['Doc. I am hurt. I will patch myself later.', 'Medic is wounded. Keep me covered.'],
    downed: ['Doc is down... someone else has to patch me up.', 'Keep pressure on it... hurry.'],
  },
};

const radioLines = {
  overlord: {
    intro: ['Team, this is Overlord. The district is crawling with hostiles. Your extraction is on the far side of the city. Stay in cover, stay out of their sight, and proceed to the helicopter.'],
    agent_down: ['Agent down! I repeat, agent down!'],
    alarm: ['They have raised the alarm. Expect reinforcements. Move fast.'],
    reinforce: ['Enemy reinforcements inbound.'],
    victory: ['Extraction confirmed. Outstanding work, team.'],
    defeat: ['We have lost the team. Mission failed.'],
    halfway: ['You are halfway there. Keep pushing.'],
    sniper_warn: ['Careful. Sniper laser on your position.'],
  },
  pilot: {
    lz_near: ['Helicopter on station. Get to the L Z!'],
    boarded: ['Got one aboard!', 'Another one safe. Keep them coming!'],
    hurry: ['Hurry! I cannot hold this position forever!'],
  },
  enemyA: {
    contact: ['Contact! Over there!'],
    alert: ['What was that? Check it out.'],
    grenade: ['Grenade!'],
    mandown: ['Man down!'],
    flank: ['Flank them!'],
  },
  enemyB: {
    contact: ['Intruders! Open fire!'],
    alert: ['I heard something.'],
    grenade: ['Frag out!'],
    mandown: ['We lost one!'],
    flank: ['Move up! Surround them!'],
  },
};

export const SPEECH = [];
for (const [who, events] of Object.entries({ ...agentLines, ...radioLines })) {
  for (const [ev, lines] of Object.entries(events)) {
    lines.forEach((text, i) => SPEECH.push({ id: `vo_${who}_${ev}_${i + 1}`, voice: VOICES[who], text }));
  }
}

// [id, prompt, duration seconds or null, loop?, prompt influence]
export const SFX = [
  ['sniper_shot', 'Single powerful sniper rifle gunshot with long echoing tail in a city street at night', 2.5, false, 0.6],
  ['mg_burst', 'Machine gun firing a fast burst of about eight rounds, loud, close', 2, false, 0.6],
  ['smg_burst', 'Submachine gun short three round burst, tight and snappy', 1.2, false, 0.6],
  ['pistol_shot', 'Single handgun gunshot, crisp, urban echo', 1, false, 0.6],
  ['laser_pistol', 'Sci-fi laser pistol zap, high pitched energy beam discharge with electric crackle', 1, false, 0.7],
  ['laser_charge', 'Short rising energy weapon charge-up whine', 0.8, false, 0.7],
  ['rocket_launch', 'Rocket launcher firing, whoosh of rocket motor flying away', 2, false, 0.6],
  ['explosion_big', 'Huge explosion with deep boom, debris and car parts raining down, city echo', 4, false, 0.5],
  ['explosion_small', 'Hand grenade explosion, sharp blast with shrapnel', 2.5, false, 0.5],
  ['car_explode', 'Car exploding, fuel tank blast, metal crunching, glass shattering, fire whoosh', 4, false, 0.5],
  ['grenade_throw', 'Grenade pin pulled and metal grenade bouncing on asphalt', 1.2, false, 0.6],
  ['smoke_grenade', 'Smoke grenade canister hissing loudly as it releases smoke', 3, false, 0.6],
  ['impact_concrete', 'Bullet hitting concrete wall, chips flying', 0.6, false, 0.6],
  ['impact_metal', 'Bullet hitting car metal body, sharp ping', 0.6, false, 0.6],
  ['bullet_whiz', 'Bullet whizzing past close by, supersonic crack and whiz', 0.7, false, 0.6],
  ['glass_shatter', 'Window glass shattering and falling', 1.5, false, 0.6],
  ['wall_crumble', 'Concrete wall collapsing into rubble, heavy debris falling', 2.5, false, 0.5],
  ['car_alarm', 'Car alarm going off, classic whooping siren', 4, false, 0.6],
  ['body_hit', 'Bullet impact on body, dull thud with cloth', 0.5, false, 0.5],
  ['body_fall', 'Body collapsing to the ground with gear rattling', 1, false, 0.5],
  ['reload', 'Rifle magazine reload, mag out, mag in, bolt charging', 1.5, false, 0.6],
  ['footsteps', 'Tactical boots running a few steps on wet pavement', 1.5, false, 0.5],
  ['medkit', 'Medical kit unzipping and bandage tearing, quick', 1.5, false, 0.5],
  ['drone', 'Small quadcopter drone taking off and buzzing away', 2.5, false, 0.6],
  ['overwatch_trigger', 'Short sharp tactical alert beep, two tones', 0.5, false, 0.8],
  ['enemy_alert', 'Stealth game enemy alert sting, sudden dramatic orchestral hit with a metallic exclamation', 1.2, false, 0.6],
  ['ui_select', 'Soft futuristic UI click, short tick', 0.5, false, 0.8],
  ['ui_confirm', 'Futuristic UI confirm sound, two quick ascending blips', 0.5, false, 0.8],
  ['ui_error', 'Short low UI error buzz', 0.5, false, 0.8],
  ['turn_player', 'Tense cinematic stinger, low synth pulse building, signaling your turn', 2, false, 0.5],
  ['turn_enemy', 'Ominous dark cinematic stinger, deep brass and taiko drum hit', 2, false, 0.5],
  ['radio_click', 'Military radio push to talk click with short static burst', 0.5, false, 0.8],
  ['hunker', 'Soldier diving into cover, cloth rustle and gear thud', 0.8, false, 0.5],
  ['hydrant', 'Fire hydrant bursting, high pressure water spraying', 3, false, 0.6],
  ['victory', 'Triumphant cinematic military victory fanfare, short', 4, false, 0.5],
  ['defeat', 'Somber cinematic defeat sting, low strings, short', 4, false, 0.5],
  ['heli_loop', 'Helicopter rotor blades hovering steadily, constant thumping', 6, true, 0.6],
  ['ambient_loop', 'Night city ambience with light rain, distant traffic, far away sirens, steady', 20, true, 0.4],
  ['tension_loop', 'Dark tense ambient synth drone with slow pulsing heartbeat bass, cinematic stealth music bed', 20, true, 0.4],
  ['fire_loop', 'Car fire burning, crackling flames, steady', 5, true, 0.5],
  ['alarm_loop', 'Distant facility alarm siren wailing over the city', 6, true, 0.5],
];
