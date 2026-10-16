import { MW, MH, F, O, AGENTS, WEAPONS, DIFFICULTY } from './defs.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export class UI {
  constructor() {
    this.game = null;
    this.floats = [];
    this.bars = new Map();
    this.overlay = $('#overlay');
    this.mini = $('#minimap');
    this.miniCtx = this.mini.getContext('2d');
    this.miniT = 0;
    this.bind();
  }

  attach(game) {
    this.game = game;
    for (const b of this.bars.values()) b.remove();
    this.bars.clear();
    for (const f of this.floats) f.el.remove();
    this.floats = [];
    this.refresh();
  }

  bind() {
    $('#actions').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]');
      if (!b || !this.game) return;
      const a = this.acts[+b.dataset.i];
      this.game.startAction(a);
    });
    $('#squad').addEventListener('click', (e) => {
      const c = e.target.closest('[data-id]');
      if (!c || !this.game) return;
      const u = this.game.units.find((x) => x.id === +c.dataset.id);
      if (u && this.game.phase === 'player' && !this.game.busy) this.game.select(u);
      else if (u) this.game.focus(u.rx, u.rz, true);
    });
    $('#endturn').addEventListener('click', () => this.game?.endTurn());
    $('#rotl').addEventListener('click', () => this.game?.camera.turn(-1));
    $('#rotr').addEventListener('click', () => this.game?.camera.turn(1));
    $('#compass').addEventListener('click', () => this.game?.camera.faceNorth());
    this.needle = $('#needle');
    $('#fire').addEventListener('click', () => this.game?.confirm());
    $('#cancel').addEventListener('click', () => this.game?.cancelAction());
    $('#chips').addEventListener('click', (e) => {
      const c = e.target.closest('[data-id]');
      if (!c || !this.game) return;
      const g = this.game;
      const t = g.targets.find((x) => x.id === +c.dataset.id);
      if (t) { g.target = t; g.focusTarget(); g.audio.play('ui_select', { vol: 0.3 }); this.refresh(); }
    });
    $('#movego').addEventListener('click', () => {
      const g = this.game;
      if (g?.preview) g.tap(g.preview.tile, null);
    });
    this.mini.addEventListener('pointerdown', (e) => {
      if (!this.game) return;
      const r = this.mini.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * MW, z = ((e.clientY - r.top) / r.height) * MH;
      this.game.camera.goal = [x, z];
      e.stopPropagation();
    });
  }

  toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
  }
  warn(msg) {
    const w = $('#warn');
    w.textContent = msg;
    w.classList.remove('show'); void w.offsetWidth; w.classList.add('show');
    clearTimeout(this._warnT);
    this._warnT = setTimeout(() => w.classList.remove('show'), 5200);
  }
  banner(title, sub) {
    const b = $('#banner');
    b.innerHTML = `<div class="bt">${esc(title)}</div>${sub ? `<div class="bs">${esc(sub)}</div>` : ''}`;
    b.classList.remove('show'); void b.offsetWidth; b.classList.add('show');
  }

  float(u, text, cls) { this.floats.push(this.makeFloat(text, cls, { u })); }
  floatAt(x, y, text, cls) { this.floats.push(this.makeFloat(text, cls, { x: x + 0.5, z: y + 0.5 })); }
  makeFloat(text, cls, anchor) {
    const el = document.createElement('div');
    el.className = `float ${cls || ''}`;
    el.textContent = text;
    this.overlay.appendChild(el);
    const stack = this.floats.filter((f) => f.anchor.u && f.anchor.u === anchor.u).length;
    return { el, anchor, t: 0, stack };
  }

  refresh() {
    const g = this.game;
    if (!g) return;
    // top bar
    const alive = g.agents.filter((a) => g.alive(a)).length;
    $('#turn').textContent = `TURN ${g.turn}`;
    const st = $('#status');
    if (g.alarm) { st.textContent = `ALARM · reinforcements in ${g.reinforceIn}`; st.className = 'alarm'; }
    else if (g.enemies.some((e) => !e.dead && e.state === 'alerted')) { st.textContent = 'SPOTTED · silence them'; st.className = 'spotted'; }
    else { st.textContent = 'UNDETECTED'; st.className = 'stealth'; }
    $('#objective').textContent = `Extracted ${g.stats.extracted}/5 · Active ${alive} · Kills ${g.stats.kills}`;
    const playerTurn = g.phase === 'player' && !g.busy;
    $('#endturn').disabled = !playerTurn;
    $('#hud').classList.toggle('enemy-turn', g.phase === 'enemy');

    // squad
    $('#squad').innerHTML = g.agents.map((a) => {
      const marked = g.enemies.some((e) => !e.dead && e.mark === a.id);
      const status = a.dead ? 'KIA' : a.extracted ? 'EXTRACTED' : a.downed ? `DOWN ${a.bleed}` : a.overwatch ? 'OVERWATCH' : a.hunker ? 'HUNKERED' : a.shadow > 0 ? 'SHADOW' : '';
      const pips = a.dead || a.extracted ? '' : `<span class="ap">${'<i class="on"></i>'.repeat(Math.max(0, a.ap))}${'<i></i>'.repeat(Math.max(0, 2 - a.ap))}</span>`;
      const hp = Array.from({ length: a.maxHp }, (_, k) => `<i class="${k < a.hp ? 'on' : ''}"></i>`).join('');
      return `<div class="card ${g.selected === a ? 'sel' : ''} ${a.dead ? 'dead' : ''} ${a.extracted ? 'out' : ''} ${a.downed ? 'downed' : ''} ${marked ? 'marked' : ''}" data-id="${a.id}" style="--c:${a.color}">
        <div class="nm">${a.name}${pips}</div><div class="rl">${a.role}</div>
        <div class="hp">${hp}</div>${status ? `<div class="stt">${status}</div>` : ''}${marked ? '<div class="laser">SNIPER LASER</div>' : ''}</div>`;
    }).join('');

    // actions
    const u = g.selected;
    const acts = (this.acts = playerTurn && u ? g.actionsFor(u) : []);
    $('#actions').innerHTML = acts.map((a, i) => `<button data-i="${i}" class="${a.disabled ? 'dis' : ''} ${g.action && g.action.id === a.id && (a.id !== 'fire' || g.action.wk === a.wk) ? 'act' : ''} ${a.hot ? 'hot' : ''}" title="${esc(a.disabled || a.hint || '')}">
      <span class="ic">${a.icon}</span><span class="lb">${esc(a.label)}</span>${a.count !== undefined ? `<span class="ct">${a.count}</span>` : ''}</button>`).join('');
    $('#actions').classList.toggle('show', acts.length > 0);

    // confirm panel
    const cp = $('#confirmPanel');
    const info = g.mode === 'target' ? g.targetInfo() : null;
    const aoe = g.mode === 'aoe' && g.aoe;
    if (playerTurn && (g.mode === 'target' || g.mode === 'aoe')) {
      cp.classList.add('show');
      let html = '';
      if (g.mode === 'target') {
        const t = g.target;
        const tname = !t ? 'No target' : t.side ? `${t.name}${t.side === 'enemy' ? ` · ${t.hp}/${t.maxHp} HP` : ''}` : g.map ? `Object` : '';
        html += `<div class="ttl">${esc(g.action.label)} <span>${esc(tname)}</span></div>`;
        if (info) {
          html += `<div class="pct ${info.chance >= 66 ? 'good' : info.chance >= 40 ? 'mid' : 'bad'}">${info.chance}%<small>${g.action.id === 'fire' ? `HIT · ${info.crit}% CRIT` : ''}</small></div>`;
          if (g.action.id === 'fire') {
            const W = WEAPONS[g.action.wk];
            html += `<div class="dmg">Damage ${W.dmg[0]}–${W.dmg[1]}${W.pierce ? ' · burns cover' : ''}${W.shred ? ' · shreds cover' : ''}</div>`;
          }
          html += `<ul class="mods">${info.mods.map(([l, v]) => `<li><span>${esc(l)}</span><b class="${v > 0 ? 'p' : v < 0 ? 'n' : ''}">${v > 0 ? '+' : ''}${v || ''}</b></li>`).join('')}</ul>`;
        } else if (t && !t.side) {
          html += `<div class="dmg">Tap again or press FIRE</div>`;
        }
      } else {
        const I = { frag: 'Frag Grenade', smoke: 'Smoke Grenade', rocket: 'Rocket', drone: 'Recon Drone' }[g.action.id];
        html += `<div class="ttl">${I}</div>`;
        if (aoe) {
          const hit = g.aoeAffected();
          const foes = hit.filter((x) => x.side === 'enemy').length, friends = hit.filter((x) => x.side === 'agent').length;
          if (g.action.id === 'smoke') html += `<div class="dmg">Smoke: −25% to hit anyone inside, blocks sight lines. Lasts 2 turns.</div>`;
          else if (g.action.id === 'drone') html += `<div class="dmg">Drone hovers for 2 turns, sees over cars and walls in a ${7}-tile radius.</div>`;
          else {
            html += `<div class="dmg">Ignores cover · destroys cover, walls and vehicles</div><ul class="mods"><li><span>Enemies hit</span><b class="p">${foes}</b></li><li><span>Agents hit</span><b class="${friends ? 'n' : ''}">${friends}</b></li>${aoe.impact?.blocked ? '<li><span>Blocked — detonates early</span><b class="n">!</b></li>' : ''}</ul>`;
          }
          html += `<div class="dmg">Tap the same spot again or press CONFIRM</div>`;
        } else html += `<div class="dmg">Tap a target area within range</div>`;
      }
      cp.querySelector('.body').innerHTML = html;
      const can = g.mode === 'target' ? !!g.target : !!aoe;
      $('#fire').disabled = !can;
      $('#fire').textContent = g.mode === 'target' ? (g.action.id === 'fire' ? 'FIRE' : 'CONFIRM') : 'CONFIRM';
      $('#chips').innerHTML = g.mode === 'target' ? g.targets.map((t) => {
        const inf = g.action.id === 'fire' ? g.shotInfo(u, t, g.action.wk) : null;
        return `<button data-id="${t.id}" class="${t === g.target ? 'on' : ''}">${esc(t.name)}${inf ? ` <b>${inf.chance}%</b>` : ''}</button>`;
      }).join('') : '';
    } else cp.classList.remove('show');

    // move preview hint
    const mh = $('#movehint');
    if (playerTurn && g.mode === 'move' && g.preview) {
      const p = g.preview;
      const cover = Math.max(...p.cover);
      mh.innerHTML = `<span class="${p.ap === 1 ? 'b' : 'y'}">${p.ap === 1 ? 'MOVE' : 'DASH'} · ${p.ap} AP</span>
        <span class="${cover === 2 ? 'b' : cover === 1 ? 'y' : 'r'}">${cover === 2 ? 'FULL COVER' : cover === 1 ? 'HALF COVER' : 'NO COVER'}</span>
        <span class="${p.lit ? 'y' : 'b'}">${p.lit ? 'LIT — easier to spot' : 'DARK — harder to spot'}</span>
        ${p.danger ? '<span class="r">IN ENEMY VIEW</span>' : ''}`;
      mh.classList.add('show');
    } else mh.classList.remove('show');
    $('#movego').classList.toggle('show', !!(playerTurn && g.mode === 'move' && g.preview));
  }

  // per-frame: HP bars, floating text, minimap
  frame(dt, w, h) {
    const g = this.game;
    if (!g) return;
    const cam = g.camera;
    const seenIds = new Set();
    for (const u of g.units) {
      const show = !u.dead && !u.extracted && (u.side === 'agent' || u.seen);
      if (!show) continue;
      const p = cam.project(u.rx, u.ry + 1.45, u.rz, w, h);
      if (!p || p[0] < -40 || p[0] > w + 40 || p[1] < -40 || p[1] > h + 40) continue;
      seenIds.add(u.id);
      let el = this.bars.get(u.id);
      if (!el) {
        el = document.createElement('div');
        el.className = `bar ${u.side}`;
        this.overlay.appendChild(el);
        this.bars.set(u.id, el);
      }
      const key = `${u.hp}/${u.maxHp}/${u.state}/${u.overwatch}/${u.downed}`;
      if (el._k !== key) {
        el._k = key;
        const icon = u.side === 'enemy' ? (u.state === 'alerted' ? '<em class="al">!</em>' : u.state === 'suspicious' ? '<em class="su">?</em>' : '') : '';
        el.innerHTML = `${icon}${Array.from({ length: u.maxHp }, (_, k) => `<i class="${k < u.hp ? 'on' : ''}"></i>`).join('')}`;
      }
      el.style.transform = `translate(${p[0]}px, ${p[1]}px)`;
    }
    for (const [id, el] of this.bars) if (!seenIds.has(id)) { el.style.transform = 'translate(-999px,-999px)'; }

    for (let k = this.floats.length - 1; k >= 0; k--) {
      const f = this.floats[k];
      f.t += dt;
      const a = f.anchor;
      const x = a.u ? a.u.rx : a.x, z = a.u ? a.u.rz : a.z, y = a.u ? a.u.ry + 1.9 : 1.6;
      const p = cam.project(x, y, z, w, h);
      if (p) f.el.style.transform = `translate(${p[0]}px, ${p[1] - f.t * 28 - f.stack * 22}px)`;
      f.el.style.opacity = String(Math.min(1, (2.2 - f.t) * 2));
      if (f.t > 2.2) { f.el.remove(); this.floats.splice(k, 1); }
    }

    // compass needle points to map north on screen
    this.needle.style.transform = `rotate(${cam.yaw}rad)`;
    this.miniT -= dt;
    if (this.miniT <= 0) { this.miniT = 0.25; this.drawMini(); }
  }

  drawMini() {
    const g = this.game, m = g.map, c = this.miniCtx;
    const cw = this.mini.width, ch = this.mini.height;
    if (!this.miniImg || this.miniImg.width !== MW) this.miniImg = c.createImageData(MW, MH);
    const d = this.miniImg.data;
    for (let i = 0; i < m.n; i++) {
      let r = 6, gg = 8, b = 12;
      if (g.explored[i]) {
        const o = m.obj[i];
        if (o === O.BUILDING) { const h = m.bh[i]; r = gg = b = 60 + Math.min(80, h * 6); if (m.roof[i]) { r = 90; gg = 95; b = 110; } }
        else if (o === O.WALL || o === O.WINDOW) { r = 120; gg = 115; b = 105; }
        else if (o !== O.NONE && o !== O.DOOR && o !== O.RUBBLE) { r = 85; gg = 80; b = 70; }
        else {
          const f = m.floor[i];
          [r, gg, b] = f === F.ROAD ? [28, 30, 34] : f === F.GRASS ? [26, 52, 28] : f === F.INTERIOR ? [70, 56, 44] : [48, 48, 50];
        }
        if (!g.visible[i]) { r *= 0.55; gg *= 0.6; b *= 0.75; }
      }
      if (m.lzTiles.has(i)) { r = 40; gg = 200; b = 90; }
      d[i * 4] = r; d[i * 4 + 1] = gg; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
    }
    c.imageSmoothingEnabled = false;
    if (!this.miniBuf) { this.miniBuf = document.createElement('canvas'); this.miniBuf.width = MW; this.miniBuf.height = MH; }
    this.miniBuf.getContext('2d').putImageData(this.miniImg, 0, 0);
    c.drawImage(this.miniBuf, 0, 0, cw, ch);
    const sx = cw / MW, sy = ch / MH;
    for (const e of g.enemies) if (!e.dead && e.seen) { c.fillStyle = e.state === 'alerted' ? '#ff3b30' : '#ffb020'; c.fillRect(e.x * sx - 1.5, e.y * sy - 1.5, 4, 4); }
    for (const a of g.agents) if (g.alive(a)) { c.fillStyle = a.color; c.beginPath(); c.arc((a.x + 0.5) * sx, (a.y + 0.5) * sy, 3.2, 0, 7); c.fill(); }
    // what the camera currently sees (rotates with the view); the brighter edge is the top of the screen
    const fp = g.footprint;
    if (fp) {
      c.strokeStyle = 'rgba(255,255,255,0.45)'; c.lineWidth = 1;
      c.beginPath();
      fp.forEach(([x, z], k) => (k ? c.lineTo(x * sx, z * sy) : c.moveTo(x * sx, z * sy)));
      c.closePath(); c.stroke();
      c.strokeStyle = 'rgba(79,216,255,0.9)'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(fp[0][0] * sx, fp[0][1] * sy); c.lineTo(fp[1][0] * sx, fp[1][1] * sy); c.stroke();
    }
  }

  showStart(onStart) {
    const s = $('#start');
    s.classList.add('show');
    $('#roster').innerHTML = AGENTS.map((a) => `<div class="ra" style="--c:${a.color}"><b>${a.name}</b><span>${a.role}</span><p>${esc(a.blurb)}</p></div>`).join('');
    let diff = 'veteran';
    $('#diff').innerHTML = Object.entries(DIFFICULTY).map(([k, d]) => `<button data-k="${k}" class="${k === diff ? 'on' : ''}">${d.label}<small>${d.enemies} hostiles</small></button>`).join('');
    $('#diff').onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      diff = b.dataset.k;
      for (const x of $('#diff').children) x.classList.toggle('on', x === b);
    };
    $('#deploy').onclick = () => { s.classList.remove('show'); onStart(diff); };
  }

  showEnd(win, stats, turns) {
    const e = $('#end');
    const rank = !win ? 'MISSION FAILED' : stats.extracted === 5 ? 'FLAWLESS EXTRACTION' : stats.extracted >= 3 ? 'MISSION ACCOMPLISHED' : 'PYRRHIC ESCAPE';
    e.querySelector('.res').innerHTML = `<h1 class="${win ? 'win' : 'lose'}">${rank}</h1>
      <div class="stats"><div><b>${stats.extracted}/5</b><span>Extracted</span></div><div><b>${stats.kills}</b><span>Kills</span></div>
      <div><b>${turns}</b><span>Turns</span></div><div><b>${stats.shots ? Math.round((stats.hits / stats.shots) * 100) : 0}%</b><span>Accuracy</span></div>
      <div><b>${stats.destroyed}</b><span>Things destroyed</span></div><div><b>${stats.lost}</b><span>Agents lost</span></div></div>`;
    e.classList.add('show');
  }
}
