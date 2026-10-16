import { Renderer } from './renderer.js';
import { Audio } from './audio.js';
import { UI } from './ui.js';
import { Input } from './input.js';
import { Game } from './game.js';

const $ = (s) => document.querySelector(s);
const canvas = $('#gpu');
const renderer = new Renderer();
const audio = new Audio();
let ui, game = null, attract = true;

async function boot() {
  try {
    await renderer.init(canvas);
  } catch (err) {
    $('#nogpu').classList.add('show');
    $('#nogpu .why').textContent = err.message;
    $('#loading').classList.remove('show');
    return;
  }
  renderer.onLost = () => $('#lost').classList.add('show');
  $('#reload').addEventListener('click', () => location.reload());
  ui = new UI();
  new Input(canvas, () => game);
  game = new Game({ audio, ui, seed: newSeed(), difficulty: 'veteran' });
  ui.attach(game);
  game.camera.tx = 30; game.camera.tz = 30; game.camera.dist = 44;
  // reveal the whole city faintly behind the title screen
  game.explored.fill(1);
  $('#loading').classList.remove('show');
  ui.showStart(async (diff) => {
    $('#loading').classList.add('show');
    $('#loading .msg').textContent = 'Loading radio chatter…';
    if (!audio.ctx) await audio.init(); else audio.resume();
    $('#loading').classList.remove('show');
    startGame(diff, game.seed);
  });
  requestAnimationFrame(loop);
}

function newSeed() { return (Math.random() * 1e9) | 0; }

function startGame(diff, seed) {
  attract = false;
  game = new Game({ audio, ui, seed, difficulty: diff });
  ui.attach(game);
  window.game = game; // handy for debugging from the console
  $('#hud').classList.add('show');
  game.start();
  lastDiff = diff;
}
let lastDiff = 'veteran';

$('#again').addEventListener('click', () => {
  $('#end').classList.remove('show');
  for (const id of [...audio.loops.keys()]) audio.stopLoop(id);
  startGame(lastDiff, newSeed());
});
$('#mute').addEventListener('click', () => {
  audio.setMuted(!audio.muted);
  $('#mute').textContent = audio.muted ? '🔇' : '🔊';
});
$('#help').addEventListener('click', () => $('#howto').classList.toggle('show'));
$('#howto').addEventListener('click', () => $('#howto').classList.remove('show'));
document.addEventListener('visibilitychange', () => {
  if (!audio.ctx) return;
  if (document.hidden) audio.ctx.suspend(); else audio.ctx.resume();
});

let last = performance.now(), ema = 1 / 60, slow = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  // adaptive resolution: drop render scale if we can't hold ~40fps
  ema += (dt - ema) * 0.05;
  slow = ema > 1 / 40 ? slow + dt : 0;
  if (slow > 2.5 && (renderer.scale ?? 1) > 0.55) { renderer.scale = (renderer.scale ?? 1) - 0.15; slow = 0; }
  renderer.resize();
  if (game) {
    if (attract) { game.camera.tx += dt * 1.2; if (game.camera.tx > 85) game.camera.tx = 15; game.fogCur.fill(0.55); }
    game.update(dt);
    if (attract) { game.fogCur.fill(0.55); }
    const w = canvas.clientWidth, h = canvas.clientHeight;
    game.frame(renderer, w, h);
    if (!attract) ui.frame(dt, w, h);
  }
  requestAnimationFrame(loop);
}

boot();
