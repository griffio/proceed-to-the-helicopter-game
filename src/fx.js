import { MW } from './defs.js';
import { lin } from './util.js';

const rnd = (a, b) => a + Math.random() * (b - a);

export class FX {
  constructor() {
    this.parts = [];
    this.beams = [];
    this.debris = [];
    this.lights = [];
    this.projectiles = [];
    this.emitAcc = 0;
    this.shake = 0;
  }

  spawn(p) {
    if (this.parts.length > 2500) return;
    this.parts.push({ vx: 0, vy: 0, vz: 0, drag: 0, grav: 0, rot: rnd(0, 6.28), vr: 0, size1: p.size, life: p.max, add: false, shape: 0, noFog: 0, seed: Math.random(), ...p });
  }
  flash(x, y, z, r, col, intensity, dur) { this.lights.push({ x, y, z, r, col, i: intensity, life: dur, max: dur }); }
  beam(a, b, width, col, dur, glow = 1) { this.beams.push({ a, b, w: width, col, life: dur, max: dur, glow }); }

  muzzle(x, y, z, dirX, dirZ, col = [1, 0.8, 0.4]) {
    for (let k = 0; k < 4; k++)
      this.spawn({ x: x + dirX * 0.2 * k, y, z: z + dirZ * 0.2 * k, size: 0.35 - k * 0.05, size1: 0.1, col: [...col, 1], max: 0.08, add: true, shape: 1 });
    this.spawn({ x, y, z, vx: dirX, vy: 0.5, vz: dirZ, size: 0.2, size1: 0.6, col: [0.6, 0.6, 0.6, 0.25], max: 0.8, shape: 2 });
    this.flash(x, y + 0.3, z, 5, col, 3, 0.09);
  }

  tracer(a, b, col, width = 0.05, dur = 0.12) { this.beam(a, b, width, [...col, 1], dur, 2); }

  laser(a, b) {
    this.beam(a, b, 0.22, [1, 0.1, 0.2, 1], 0.35, 4);
    this.beam(a, b, 0.06, [1, 0.8, 0.85, 1], 0.35, 6);
    this.flash(b[0], b[1], b[2], 4, [1, 0.1, 0.2], 4, 0.3);
    this.flash(a[0], a[1], a[2], 3, [1, 0.1, 0.2], 3, 0.2);
    for (let k = 0; k < 10; k++) this.spawn({ x: b[0], y: b[1], z: b[2], vx: rnd(-2, 2), vy: rnd(0, 3), vz: rnd(-2, 2), grav: 6, size: 0.06, col: [1, 0.3, 0.4, 1], max: rnd(0.3, 0.6), add: true, shape: 3 });
  }

  impact(x, y, z, kind = 'concrete') {
    const col = kind === 'metal' ? [1, 0.9, 0.6, 1] : kind === 'blood' ? [0.5, 0.02, 0.02, 1] : [0.8, 0.75, 0.65, 1];
    for (let k = 0; k < (kind === 'blood' ? 10 : 7); k++)
      this.spawn({ x, y, z, vx: rnd(-2.5, 2.5), vy: rnd(0.5, 3.5), vz: rnd(-2.5, 2.5), grav: 9, drag: 1, size: kind === 'blood' ? 0.07 : 0.05, col, max: rnd(0.2, 0.5), add: kind === 'metal', shape: 3 });
    if (kind !== 'blood') this.spawn({ x, y, z, vy: 0.4, size: 0.15, size1: 0.5, col: [0.6, 0.58, 0.55, 0.35], max: 0.8, shape: 2 });
    if (kind === 'metal') this.flash(x, y, z, 2, [1, 0.8, 0.5], 1.5, 0.06);
  }

  explosion(x, z, r, y = 0.4) {
    this.flash(x, y + 1.5, z, r * 5, [1, 0.55, 0.2], 9, 0.7);
    for (let k = 0; k < 26; k++) {
      const a = rnd(0, 6.28), s = rnd(0.5, 1) * r * 2.4;
      this.spawn({ x, y: y + rnd(0, 0.8), z, vx: Math.cos(a) * s, vy: rnd(1, 4), vz: Math.sin(a) * s, drag: 3.2, size: rnd(0.5, 0.9) * r * 0.5, size1: r * 0.6, col: [1, rnd(0.45, 0.75), 0.18, 1], max: rnd(0.35, 0.7), add: true, shape: 1 });
    }
    for (let k = 0; k < 18; k++) {
      const a = rnd(0, 6.28), s = rnd(0.3, 1) * r * 1.4;
      this.spawn({ x, y: y + 0.5, z, vx: Math.cos(a) * s, vy: rnd(1.5, 4), vz: Math.sin(a) * s, drag: 1.6, grav: -0.3, size: r * 0.35, size1: r * 0.95, col: [0.16, 0.15, 0.14, 0.7], max: rnd(1.8, 3.2), shape: 2 });
    }
    for (let k = 0; k < 30; k++) {
      const a = rnd(0, 6.28), s = rnd(3, 10);
      this.spawn({ x, y: y + 0.4, z, vx: Math.cos(a) * s, vy: rnd(2, 9), vz: Math.sin(a) * s, grav: 14, size: 0.05, col: [1, 0.7, 0.3, 1], max: rnd(0.4, 1.1), add: true, shape: 3 });
    }
    this.spawn({ x, y: y + 1, z, size: r * 1.6, size1: r * 0.4, col: [1, 0.95, 0.8, 1], max: 0.16, add: true, shape: 1 });
    this.ring = this.ring || [];
    this.ring.push({ x, z, r, life: 0.5, max: 0.5 });
    this.shake = Math.max(this.shake, Math.min(1.2, 0.25 + r * 0.18));
  }

  chunks(x, y, z, col, n = 8, power = 4) {
    const c = typeof col === 'string' ? lin(col) : col;
    for (let k = 0; k < n; k++) {
      if (this.debris.length > 260) this.debris.shift();
      this.debris.push({ x: x + rnd(-0.3, 0.3), y: y + rnd(0, 0.5), z: z + rnd(-0.3, 0.3), vx: rnd(-1, 1) * power, vy: rnd(0.5, 1.6) * power, vz: rnd(-1, 1) * power,
        rx: rnd(0, 6), ry: rnd(0, 6), rz: rnd(0, 6), vrx: rnd(-8, 8), vry: rnd(-8, 8), vrz: rnd(-8, 8), s: rnd(0.08, 0.28), col: c, life: rnd(4, 9), rest: false });
    }
  }

  // Projectile helper: resolves when it lands.
  projectile(kind, from, to, dur, arc) {
    return new Promise((resolve) => this.projectiles.push({ kind, from, to, t: 0, dur, arc, resolve, trail: 0 }));
  }

  update(dt, map, time) {
    // continuous emitters from map state
    this.emitAcc += dt;
    if (this.emitAcc > 0.06) {
      const steps = this.emitAcc; this.emitAcc = 0;
      for (let i = 0; i < map.n; i++) {
        if (map.fire[i] && Math.random() < steps * 9) {
          const x = (i % MW) + rnd(0.15, 0.85), z = ((i / MW) | 0) + rnd(0.15, 0.85);
          this.spawn({ x, y: 0.3, z, vy: rnd(1.2, 2.4), size: rnd(0.2, 0.38), size1: 0.05, col: [1, rnd(0.35, 0.6), 0.1, 0.9], max: rnd(0.4, 0.8), add: true, shape: 1 });
          if (Math.random() < 0.35) this.spawn({ x, y: 1.4, z, vy: rnd(1, 2), vx: 0.3, size: 0.3, size1: 1.2, col: [0.08, 0.07, 0.07, 0.55], max: rnd(1.8, 3), shape: 2, grav: -0.2 });
          if (Math.random() < 0.2) this.spawn({ x, y: 0.5, z, vx: rnd(-0.5, 0.5), vy: rnd(2, 4), vz: rnd(-0.5, 0.5), size: 0.035, col: [1, 0.6, 0.2, 1], max: rnd(0.6, 1.4), add: true, shape: 3 });
        }
        if (map.smoke[i] && Math.random() < steps * 3.2) {
          const x = (i % MW) + rnd(0, 1), z = ((i / MW) | 0) + rnd(0, 1);
          const mist = map.mist[i];
          this.spawn({ x, y: rnd(0.3, 1.4), z, vx: rnd(-0.2, 0.2), vy: rnd(0.05, 0.25), vz: rnd(-0.2, 0.2), size: rnd(0.7, 1.0), size1: rnd(1.1, 1.5),
            col: mist ? [0.65, 0.75, 0.85, 0.32] : [0.52, 0.54, 0.57, 0.5], max: rnd(2.2, 3.2), shape: 2 });
        }
      }
    }
    // particles
    const P = this.parts;
    for (let k = P.length - 1; k >= 0; k--) {
      const p = P[k];
      p.life -= dt;
      if (p.life <= 0) { P[k] = P[P.length - 1]; P.pop(); continue; }
      const dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vz *= dr; p.vy = p.vy * dr - p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.02 && p.grav > 0) { p.y = 0.02; p.vy *= -0.3; p.vx *= 0.6; p.vz *= 0.6; }
      p.rot += p.vr * dt;
    }
    for (let k = this.beams.length - 1; k >= 0; k--) { const b = this.beams[k]; b.life -= dt; if (b.life <= 0) this.beams.splice(k, 1); }
    for (let k = this.lights.length - 1; k >= 0; k--) { const l = this.lights[k]; l.life -= dt; if (l.life <= 0) this.lights.splice(k, 1); }
    if (this.ring) for (let k = this.ring.length - 1; k >= 0; k--) { this.ring[k].life -= dt; if (this.ring[k].life <= 0) this.ring.splice(k, 1); }
    for (const d of this.debris) {
      d.life -= dt;
      if (d.rest) continue;
      d.vy -= 16 * dt;
      d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
      d.rx += d.vrx * dt; d.ry += d.vry * dt; d.rz += d.vrz * dt;
      if (d.y < 0.05) {
        d.y = 0.05; d.vy *= -0.35; d.vx *= 0.5; d.vz *= 0.5; d.vrx *= 0.5; d.vry *= 0.5; d.vrz *= 0.5;
        if (Math.abs(d.vy) < 0.6) { d.rest = true; d.rx = Math.round(d.rx / 1.57) * 1.57; d.rz = Math.round(d.rz / 1.57) * 1.57; }
      }
    }
    this.debris = this.debris.filter((d) => d.life > 0);
    // projectiles
    for (let k = this.projectiles.length - 1; k >= 0; k--) {
      const p = this.projectiles[k];
      p.t += dt / p.dur;
      const t = Math.min(1, p.t);
      p.x = p.from[0] + (p.to[0] - p.from[0]) * t;
      p.z = p.from[2] + (p.to[2] - p.from[2]) * t;
      p.y = p.from[1] + (p.to[1] - p.from[1]) * t + p.arc * 4 * t * (1 - t);
      p.trail += dt;
      if (p.kind === 'rocket') {
        while (p.trail > 0.012) {
          p.trail -= 0.012;
          this.spawn({ x: p.x, y: p.y, z: p.z, vx: rnd(-0.3, 0.3), vy: rnd(0, 0.4), vz: rnd(-0.3, 0.3), size: 0.18, size1: 0.7, col: [0.55, 0.55, 0.56, 0.45], max: rnd(1, 1.6), shape: 2 });
          this.spawn({ x: p.x, y: p.y, z: p.z, size: 0.22, size1: 0.02, col: [1, 0.6, 0.2, 1], max: 0.12, add: true, shape: 1 });
        }
      } else if (p.trail > 0.05) {
        p.trail = 0;
        this.spawn({ x: p.x, y: p.y, z: p.z, size: 0.05, size1: 0.01, col: [1, 0.9, 0.5, 0.6], max: 0.25, add: true, shape: 3 });
      }
      if (p.t >= 1) { this.projectiles.splice(k, 1); p.resolve(); }
    }
    this.shake = Math.max(0, this.shake - dt * 1.8);
  }

  write(out, dyn, time, camX, camZ) {
    const { pa, pd, beams, decals } = out;
    for (const p of this.parts) {
      const t = 1 - p.life / p.max;
      const s = p.size + (p.size1 - p.size) * t;
      const fade = p.add ? 1 - t : Math.min(1, (1 - t) * 1.6) * Math.min(1, t * 6 + 0.2);
      (p.add ? pd : pa).push(p.x, p.y, p.z, s, p.col[0], p.col[1], p.col[2], p.col[3] * fade, p.rot, p.shape, p.noFog, p.seed);
    }
    for (const b of this.beams) {
      const k = b.life / b.max;
      beams.push(b.a[0], b.a[1], b.a[2], b.w * (0.5 + 0.5 * k), b.b[0], b.b[1], b.b[2], b.glow, b.col[0], b.col[1], b.col[2], b.col[3] * k);
    }
    if (this.ring) for (const r of this.ring) {
      const t = 1 - r.life / r.max;
      decals.push(r.x, 0.15, r.z, 0, r.r * 2.6 * (0.3 + t), r.r * 2.6 * (0.3 + t), 1, 0, 1, 0.7, 0.4, 0.8 * (1 - t), 0.08, 0, 0, 0);
    }
    for (const d of this.debris) {
      const fade = Math.min(1, d.life);
      dyn.box.add(d.x, d.y - d.s / 2, d.z, d.s * fade, d.s * fade, d.s * fade, d.ry, d.col, 0, 0, d.rx, d.rz);
    }
    for (const p of this.projectiles) {
      if (p.kind === 'rocket') {
        const yaw = Math.atan2(p.to[2] - p.from[2], p.to[0] - p.from[0]);
        dyn.box.add(p.x, p.y - 0.06, p.z, 0.5, 0.12, 0.12, yaw, [0.25, 0.27, 0.22]);
      } else {
        dyn.sph.add(p.x, p.y - 0.1, p.z, 0.2, 0.2, 0.2, 0, p.kind === 'smoke' ? [0.3, 0.4, 0.3] : [0.15, 0.2, 0.1]);
      }
    }
    // rain streaks around the camera
    for (let k = 0; k < 260; k++) {
      const hx = ((k * 0.6180339) % 1), hz = ((k * 0.7548776) % 1), hy = ((k * 0.5698403) % 1);
      const x = camX - 26 + hx * 52, z = camZ - 20 + hz * 40;
      const y = 14 - ((time * 22 + hy * 14) % 14);
      beams.push(x, y, z, 0.012, x - 0.08, y + 0.7, z - 0.04, 0, 0.55, 0.62, 0.75, 0.32);
    }
  }

  dynLights() {
    return this.lights.map((l) => {
      const k = l.life / l.max;
      return [l.x, l.y, l.z, l.r, l.col[0], l.col[1], l.col[2], l.i * k];
    });
  }
}
