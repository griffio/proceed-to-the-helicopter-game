import { MW, MH, O } from './defs.js';
import { clamp } from './util.js';

// Touch-first camera + tap handling (pointer events cover iPad touch, Pencil and mouse).
export class Input {
  constructor(canvas, getGame) {
    this.c = canvas;
    this.getGame = getGame;
    this.ptrs = new Map();
    this.pinch = null;
    this.drag = false;
    const opts = { passive: false };
    canvas.addEventListener('pointerdown', (e) => this.down(e), opts);
    canvas.addEventListener('pointermove', (e) => this.move(e), opts);
    canvas.addEventListener('pointerup', (e) => this.up(e), opts);
    canvas.addEventListener('pointercancel', (e) => { this.ptrs.delete(e.pointerId); this.pinch = null; }, opts);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const g = this.getGame(); if (!g) return;
      g.camera.dist = clamp(g.camera.dist * Math.exp(e.deltaY * 0.0015), 10, 70);
    }, opts);
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), opts);
    document.addEventListener('touchmove', (e) => { if (e.target === canvas) e.preventDefault(); }, opts);
    window.addEventListener('keydown', (e) => this.key(e));
  }

  down(e) {
    e.preventDefault();
    this.c.setPointerCapture?.(e.pointerId);
    this.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    if (this.ptrs.size === 2) {
      const [a, b] = [...this.ptrs.values()];
      const g = this.getGame();
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: g?.camera.dist ?? 30, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      this.drag = true;
    } else if (this.ptrs.size === 1) this.drag = false;
  }

  worldPerPx() {
    const g = this.getGame();
    const cam = g.camera;
    return (2 * cam.dist * Math.tan(cam.fov / 2)) / this.c.clientHeight;
  }

  move(e) {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    e.preventDefault();
    const g = this.getGame();
    if (!g) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    const cam = g.camera;
    if (this.ptrs.size === 2 && this.pinch) {
      const [a, b] = [...this.ptrs.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      cam.dist = clamp(this.pinch.dist * (this.pinch.d / Math.max(20, d)), 10, 70);
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const k = this.worldPerPx();
      cam.tx -= (cx - this.pinch.cx) * k; cam.tz -= ((cy - this.pinch.cy) * k) / Math.sin(cam.pitch);
      this.pinch.cx = cx; this.pinch.cy = cy;
      cam.goal = null;
      return;
    }
    if (!this.drag && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 12) this.drag = true;
    if (this.drag) {
      const k = this.worldPerPx();
      cam.tx = clamp(cam.tx - dx * k, 0, MW);
      cam.tz = clamp(cam.tz - (dy * k) / Math.sin(cam.pitch), 0, MH);
      cam.goal = null;
    }
  }

  up(e) {
    const p = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);
    if (this.ptrs.size < 2) this.pinch = null;
    if (!p) return;
    const wasTap = !this.drag && performance.now() - p.t < 600 && this.ptrs.size === 0;
    if (this.ptrs.size === 0) this.drag = false;
    if (wasTap) this.pick(e.clientX, e.clientY);
  }

  pick(px, py) {
    const g = this.getGame();
    if (!g || g.phase !== 'player') return;
    const r = this.c.getBoundingClientRect();
    const x = px - r.left, y = py - r.top, w = r.width, h = r.height;
    // units first (generous touch radius)
    let unit = null, best = 40;
    for (const u of g.units) {
      if (u.dead || u.extracted || (u.side === 'enemy' && !u.seen)) continue;
      const p = g.camera.project(u.rx, u.ry + 0.6, u.rz, w, h);
      if (!p) continue;
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < best) { best = d; unit = u; }
    }
    const tile = this.rayTile(g, x, y, w, h, false);
    const ground = this.rayTile(g, x, y, w, h, true);
    g.tap(tile, unit, ground);
  }

  // groundOnly: see through vehicles and props to the floor (roofs still count)
  rayTile(g, x, y, w, h, groundOnly) {
    const m = g.map;
    const { o, d } = g.camera.ray(x, y, w, h);
    const heightAt = (i) => {
      const ob = m.obj[i];
      if (ob === O.BUILDING) return m.bh[i];
      if (groundOnly || ob === O.NONE || ob === O.DOOR || ob === O.LAMP) return m.standH(i);
      return Math.min(m.obstacleH(i), 2.7);
    };
    let t = 0;
    for (let k = 0; k < 900; k++) {
      t += 0.12;
      const px = o[0] + d[0] * t, py = o[1] + d[1] * t, pz = o[2] + d[2] * t;
      if (py < -0.5) break;
      const tx = Math.floor(px), tz = Math.floor(pz);
      if (tx < 0 || tz < 0 || tx >= MW || tz >= MH) { if (py < 0) break; continue; }
      const i = tz * MW + tx;
      if (py <= heightAt(i) + 0.02) return i;
    }
    return -1;
  }

  key(e) {
    const g = this.getGame();
    if (!g) return;
    const cam = g.camera;
    switch (e.key) {
      case 'Escape': g.cancelAction(); break;
      case 'Enter': g.confirm(); break;
      case ' ': e.preventDefault(); g.endTurn(); break;
      case 'Tab': {
        e.preventDefault();
        const list = g.agents.filter((a) => g.alive(a) && !a.downed);
        const i = list.indexOf(g.selected);
        if (list.length && g.phase === 'player' && !g.busy) g.select(list[(i + 1) % list.length]);
        break;
      }
      case 'ArrowLeft': case 'a': cam.tx -= 3; cam.goal = null; break;
      case 'ArrowRight': case 'd': cam.tx += 3; cam.goal = null; break;
      case 'ArrowUp': case 'w': cam.tz -= 3; cam.goal = null; break;
      case 'ArrowDown': case 's': cam.tz += 3; cam.goal = null; break;
    }
  }
}
