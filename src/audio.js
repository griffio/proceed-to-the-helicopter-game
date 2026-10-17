// WebAudio playback of the pre-generated ElevenLabs assets.
export class Audio {
  constructor() {
    this.buffers = new Map();
    this.ready = false;
    this.voiceBusyUntil = 0;
    this.loops = new Map();
    this.listener = { x: 0, z: 0, zoom: 30 };
    this.muted = false;
  }

  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = 0.9; this.master.connect(c.destination);
    this.sfxBus = c.createGain(); this.sfxBus.gain.value = 0.8; this.sfxBus.connect(this.master);
    this.musicBus = c.createGain(); this.musicBus.gain.value = 0.5; this.musicBus.connect(this.master);
    // radio chain: band-pass + light saturation
    this.radio = c.createGain(); this.radio.gain.value = 1.5;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 380;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3600;
    const shaper = c.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = (i / 1023) * 2 - 1; curve[i] = Math.tanh(x * 2.2) / Math.tanh(2.2); }
    shaper.curve = curve;
    this.radio.connect(hp); hp.connect(lp); lp.connect(shaper); shaper.connect(this.master);
    // world voice (enemy shouts): direct
    this.voiceBus = c.createGain(); this.voiceBus.gain.value = 1.1; this.voiceBus.connect(this.master);

    let list = [];
    try { list = await (await fetch('assets/audio/manifest.json')).json(); } catch { list = []; }
    await Promise.all(list.map(async (id) => {
      try {
        const res = await fetch(`assets/audio/${id}.mp3`);
        const ab = await res.arrayBuffer();
        this.buffers.set(id, await c.decodeAudioData(ab));
      } catch { /* missing sound is non-fatal */ }
    }));
    this.ready = true;
  }

  resume() { if (this.ctx?.state !== 'running') this.ctx?.resume(); }

  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : 0.9; }

  // pos: [x, z] world position for distance attenuation / pan
  play(id, { vol = 1, pos = null, rate = 1, bus = null, delay = 0 } = {}) {
    const b = this.buffers.get(id);
    if (!b || !this.ctx) return null;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = b;
    src.playbackRate.value = rate * (1 + (Math.random() - 0.5) * 0.06);
    const g = c.createGain();
    let v = vol;
    let out = g;
    if (pos) {
      const dx = pos[0] - this.listener.x, dz = pos[1] - this.listener.z;
      const d = Math.hypot(dx, dz);
      const near = this.listener.zoom * 0.6;
      v *= d < near ? 1 : Math.max(0.12, near / d);
      if (c.createStereoPanner) {
        const p = c.createStereoPanner();
        p.pan.value = Math.max(-0.8, Math.min(0.8, dx / 25));
        g.connect(p); out = p;
      }
    }
    g.gain.value = v;
    src.connect(g);
    out.connect(bus || this.sfxBus);
    src.start(c.currentTime + delay);
    return src;
  }

  pickVariant(prefix) {
    const opts = [];
    for (let k = 1; k <= 4; k++) if (this.buffers.has(`${prefix}_${k}`)) opts.push(`${prefix}_${k}`);
    return opts.length ? opts[Math.floor(Math.random() * opts.length)] : null;
  }

  hasVoice(who, event) { return !!this.pickVariant(`vo_${who}_${event}`); }

  // Radio voice line. priority lines interrupt the queue gate.
  voice(who, event, { priority = false, world = null } = {}) {
    if (!this.ctx) return 0;
    const id = this.pickVariant(`vo_${who}_${event}`);
    if (!id) return 0;
    const now = this.ctx.currentTime;
    if (!priority && now < this.voiceBusyUntil) return 0;
    const b = this.buffers.get(id);
    if (world) {
      this.play(id, { vol: 1, pos: world, bus: this.voiceBus });
    } else {
      this.play(id, { vol: 1, bus: this.radio });
    }
    this.voiceBusyUntil = now + b.duration + 0.25;
    return b.duration;
  }

  loop(id, vol = 0.5, bus = null) {
    if (this.loops.has(id)) { this.loops.get(id).g.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.4); return; }
    const b = this.buffers.get(id);
    if (!b || !this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = b; src.loop = true;
    const g = this.ctx.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.6);
    src.connect(g); g.connect(bus || this.musicBus);
    src.start();
    this.loops.set(id, { src, g });
  }
  loopVolume(id, vol) { const l = this.loops.get(id); if (l) l.g.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.3); }
  stopLoop(id) {
    const l = this.loops.get(id);
    if (!l) return;
    l.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    setTimeout(() => { try { l.src.stop(); } catch { } }, 1500);
    this.loops.delete(id);
  }
}
