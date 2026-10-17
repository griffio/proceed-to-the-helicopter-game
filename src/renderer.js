import { mat4 } from './util.js';
import { TEXTURES, T } from './textures.js';

export const MAX_LIGHTS = 32;
const SHADOW_SIZE = 2048;
const SAMPLES = 4;
const BLOOM_LEVELS = 5;   // half resolution down to 1/32
const BLOOM_THRESHOLD = 0.62, BLOOM_KNEE = 0.3, BLOOM_STRENGTH = 0.65;

// Bloom: threshold the resolved frame into a half-res target, blur it down a mip chain and back
// up (dual filtering), then add it over the frame on the way to the screen.
const POST_WGSL = /* wgsl */ `
struct U { px: vec2f, a: f32, b: f32 };
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> u: U;
@group(0) @binding(3) var scene: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vsFull(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, smp, uv, 0.0).rgb; }
fn down(uv: vec2f) -> vec3f {
  let d = u.px;
  return (tap(uv) * 4.0 + tap(uv - d) + tap(uv + d) + tap(uv + vec2f(d.x, -d.y)) + tap(uv - vec2f(d.x, -d.y))) / 8.0;
}
@fragment fn fsPrefilter(v: VO) -> @location(0) vec4f {
  let c = pow(down(v.uv), vec3f(2.2));            // the frame is display-encoded; work in linear
  let l = max(c.r, max(c.g, c.b));
  return vec4f(c * smoothstep(u.a, u.a + u.b, l), 1.0);
}
@fragment fn fsDown(v: VO) -> @location(0) vec4f { return vec4f(down(v.uv), 1.0); }
@fragment fn fsUp(v: VO) -> @location(0) vec4f {
  let d = u.px;
  var c = tap(v.uv + vec2f(-2.0 * d.x, 0.0)) + tap(v.uv + vec2f(2.0 * d.x, 0.0)) + tap(v.uv + vec2f(0.0, -2.0 * d.y)) + tap(v.uv + vec2f(0.0, 2.0 * d.y));
  c += (tap(v.uv + d) + tap(v.uv - d) + tap(v.uv + vec2f(d.x, -d.y)) + tap(v.uv - vec2f(d.x, -d.y))) * 2.0;
  return vec4f(c / 12.0, 1.0);
}
@fragment fn fsComposite(v: VO) -> @location(0) vec4f {
  let c = pow(textureSampleLevel(scene, smp, v.uv, 0.0).rgb, vec3f(2.2)) + tap(v.uv) * u.a;
  return vec4f(pow(min(c, vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}
`;

const WGSL = /* wgsl */ `
struct Light { pos: vec4f, col: vec4f };
struct Scene {
  viewProj: mat4x4f,
  lightVP: mat4x4f,
  camPos: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  info: vec4f,      // mapW, mapH, time, nLights
  moonDir: vec4f,
  moonCol: vec4f,
  ambient: vec4f,
  lights: array<Light, ${MAX_LIGHTS}>,
};
@group(0) @binding(0) var<uniform> S: Scene;
@group(0) @binding(1) var fogTex: texture_2d<f32>;
@group(0) @binding(2) var linSamp: sampler;
@group(0) @binding(3) var shadowTex: texture_depth_2d;
@group(0) @binding(4) var shadowSamp: sampler_comparison;
// one texel per map tile: bit i is set if light i can reach that tile
@group(0) @binding(5) var lightMask: texture_2d<u32>;
@group(0) @binding(6) var texArr: texture_2d_array<f32>;
@group(0) @binding(7) var texSamp: sampler;
// per layer: average linear colour (x < 0 = not loaded), world units per repeat
@group(0) @binding(8) var<uniform> TI: array<vec4f, 16>;
// per layer: tangent-space normal (rgb) and cavity (a: high in grooves, where rain collects)
@group(0) @binding(9) var normArr: texture_2d_array<f32>;
// detail() also leaves the surface's bumped normal and cavity here for the lighting
var<private> gN: vec3f;
var<private> gCav: f32;

// World-space projection for axis-aligned boxes: tops use xz, sides use their own plane.
fn texProj(p: vec3f, N: vec3f) -> vec2f {
  if (abs(N.y) > 0.5) { return p.xz; }
  if (abs(N.x) > abs(N.z)) { return vec2f(p.z, -p.y); }
  return vec2f(p.x, -p.y);
}
// Texture as a detail map: divided by its own average, so the instance colour sets the overall
// tone and the texture only adds pattern. k blends from flat (0) to full detail (1).
fn detail(layer: i32, wp: vec3f, N: vec3f, dx: vec3f, dy: vec3f, k: f32) -> vec3f {
  var l = layer;
  if (l >= ${T.brick} && l <= ${T.posters} && N.y > 0.5) { l = ${T.concrete}; } // wall tops
  if (l < 0) { return vec3f(1.0); }
  let t = TI[l];
  if (t.x < 0.0) { return vec3f(1.0); }
  let s = 1.0 / t.w;
  let uv = texProj(wp, N) * s; let gx = texProj(dx, N) * s; let gy = texProj(dy, N) * s;
  let c = textureSampleGrad(texArr, texSamp, uv, l, gx, gy).rgb;
  let nm = textureSampleGrad(normArr, texSamp, uv, l, gx, gy);
  // tangent frame of texProj: T and B are the world directions of +u and +v
  var T = vec3f(1.0, 0.0, 0.0); var B = vec3f(0.0, -1.0, 0.0);
  if (abs(N.y) > 0.5) { B = vec3f(0.0, 0.0, 1.0); } else if (abs(N.x) > abs(N.z)) { T = vec3f(0.0, 0.0, 1.0); }
  let tn = nm.xyz * 2.0 - 1.0;
  gN = normalize(T * tn.x + B * tn.y + N * tn.z);
  gCav = nm.w;
  return mix(vec3f(1.0), min(c / t.rgb, vec3f(2.5)), k);
}

fn h2(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn h3(p: vec3f) -> f32 { return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453); }
fn noise2(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h2(i), h2(i + vec2f(1.0, 0.0)), u.x), mix(h2(i + vec2f(0.0, 1.0)), h2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fogAt(xz: vec2f) -> vec2f { return textureSampleLevel(fogTex, linSamp, xz / S.info.xy, 0.0).rg; }
fn applyFog(c: vec3f, f: vec2f) -> vec3f {
  let lum = dot(c, vec3f(0.3, 0.5, 0.2));
  let mem = vec3f(lum) * vec3f(0.5, 0.62, 0.95) * 0.5 + vec3f(0.004, 0.006, 0.012);
  let unseen = vec3f(0.004, 0.005, 0.009);
  return mix(mix(unseen, mem, f.y), c, f.x);
}
fn aoAt(xz: vec2f) -> f32 { return textureSampleLevel(fogTex, linSamp, xz / S.info.xy, 0.0).b; }
fn tonemap(c: vec3f) -> vec3f {
  let t = vec3f(1.0) - exp(-c * 1.5);
  return pow(t, vec3f(1.0 / 2.2));
}
fn rotm(yaw: f32, pitch: f32, roll: f32) -> mat3x3f {
  let cy = cos(yaw); let sy = sin(yaw);
  let cp = cos(pitch); let sp = sin(pitch);
  let cr = cos(roll); let sr = sin(roll);
  let ry = mat3x3f(vec3f(cy, 0.0, sy), vec3f(0.0, 1.0, 0.0), vec3f(-sy, 0.0, cy));
  let rz = mat3x3f(vec3f(cp, sp, 0.0), vec3f(-sp, cp, 0.0), vec3f(0.0, 0.0, 1.0));
  let rx = mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, cr, sr), vec3f(0.0, -sr, cr));
  return ry * rz * rx;
}

struct VIn {
  @location(0) pos: vec3f, @location(1) nrm: vec3f,
  @location(2) a: vec4f, @location(3) b: vec4f, @location(4) c: vec4f, @location(5) d: vec4f,
};
struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) wpos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) col: vec3f,
  @location(3) @interpolate(flat) m: vec4f,
};

fn worldOf(v: VIn) -> array<vec3f, 2> {
  let R = rotm(v.a.w, v.b.w, v.c.w);
  let wp = R * (v.pos * v.b.xyz) + v.a.xyz;
  let n = normalize(R * (v.nrm / v.b.xyz));
  return array<vec3f, 2>(wp, n);
}

@vertex fn vsMesh(v: VIn) -> VOut {
  let w = worldOf(v);
  var o: VOut;
  o.clip = S.viewProj * vec4f(w[0], 1.0);
  o.wpos = w[0]; o.nrm = w[1]; o.col = v.c.xyz; o.m = v.d;
  return o;
}

@vertex fn vsShadow(v: VIn) -> @builtin(position) vec4f {
  let w = worldOf(v);
  return S.lightVP * vec4f(w[0], 1.0);
}

fn shade(wp: vec3f, N: vec3f, base: vec3f, spec: f32, gloss: f32) -> vec3f {
  let V = normalize(S.camPos.xyz - wp);
  let lp = S.lightVP * vec4f(wp, 1.0);
  let suv = vec2f(lp.x * 0.5 + 0.5, -lp.y * 0.5 + 0.5);
  let dz = lp.z - 0.002;
  let ts = 1.5 / ${SHADOW_SIZE}.0;
  var sh = 0.0;
  sh += textureSampleCompareLevel(shadowTex, shadowSamp, suv + vec2f(-ts, -ts), dz);
  sh += textureSampleCompareLevel(shadowTex, shadowSamp, suv + vec2f(ts, -ts), dz);
  sh += textureSampleCompareLevel(shadowTex, shadowSamp, suv + vec2f(-ts, ts), dz);
  sh += textureSampleCompareLevel(shadowTex, shadowSamp, suv + vec2f(ts, ts), dz);
  sh *= 0.25;
  let Ld = normalize(S.moonDir.xyz);
  var diff = S.ambient.rgb * (0.55 + 0.45 * N.y);
  diff += S.moonCol.rgb * max(dot(N, Ld), 0.0) * sh;
  var sp = S.moonCol.rgb * pow(max(dot(N, normalize(Ld + V)), 0.0), gloss) * spec * sh;
  let cell = clamp(vec2i(floor(wp.xz)), vec2i(0), vec2i(S.info.xy) - 1);
  var mask = textureLoad(lightMask, cell, 0).r;
  loop {
    if (mask == 0u) { break; }
    let L = S.lights[firstTrailingBit(mask)];
    mask &= mask - 1u;
    let d = L.pos.xyz - wp;
    let dist = length(d);
    let att = clamp(1.0 - dist / L.pos.w, 0.0, 1.0);
    if (att <= 0.0) { continue; }
    let l = d / max(dist, 0.001);
    let c = L.col.rgb * (L.col.w * att * att);
    diff += c * max(dot(N, l) * 0.8 + 0.2, 0.0);
    sp += c * pow(max(dot(N, normalize(l + V)), 0.0), gloss) * spec;
  }
  return base * diff + sp;
}

@fragment fn fsMesh(i: VOut) -> @location(0) vec4f {
  // derivatives up front, while control flow is still uniform
  let dx = dpdx(i.wpos); let dy = dpdy(i.wpos);
  var fog = vec2f(1.0);
  if (i.m.z < 0.5) {
    fog = fogAt(i.wpos.xz);
    if (fog.x + fog.y < 0.004) { return vec4f(tonemap(applyFog(vec3f(0.0), fog)), 1.0); }
  }
  let mat = i32(i.m.y + 0.5) & 15;
  let tl = (i32(i.m.y + 0.5) >> 4) - 1;
  var base = i.col;
  let N = normalize(i.nrm);
  var spec = 0.06;
  var gloss = 12.0;
  var emis = vec3f(0.0);
  let wp = i.wpos;
  gN = N; gCav = 0.0;
  if (mat == 1) {
    let pud = smoothstep(0.5, 0.8, noise2(wp.xz * 0.45 + vec2f(3.1, 7.7)));
    var grit = vec3f(0.85 + 0.3 * h2(floor(wp.xz * 6.0)));
    if (tl >= 0) { grit = detail(tl, wp, N, dx, dy, 0.9); }
    base = base * mix(grit, vec3f(0.55), pud);
    let wet = max(pud, gCav * 0.6);
    spec = mix(0.5, 1.6, wet);
    gloss = mix(28.0, 120.0, wet);
    gN = normalize(mix(gN, N, pud)); // standing water is flat
  } else if (mat == 2) {
    if (abs(N.y) < 0.5) {
      let u = select(wp.x, wp.z, abs(N.x) > 0.5);
      let gu = u * 1.5;
      let gv = wp.y * 1.05;
      let fu = fract(gu); let fv = fract(gv);
      let win = step(0.2, fu) * step(fu, 0.8) * step(0.3, fv) * step(fv, 0.82) * step(0.9, wp.y);
      if (win > 0.5) {
        let h = h3(vec3f(floor(gu), floor(gv), i.m.w * 91.0));
        base = vec3f(0.015, 0.018, 0.026);
        spec = 1.2; gloss = 90.0;
        if (h > 0.76) {
          emis = select(vec3f(1.0, 0.6, 0.28), vec3f(0.45, 0.7, 1.0), h > 0.93) * (0.35 + 0.3 * h2(vec2f(h, 1.0)));
        }
      } else if (tl >= 0) {
        base = base * detail(tl, wp, N, dx, dy, 0.85);
      } else {
        base = base * (0.85 + 0.15 * h2(floor(vec2f(gu, gv * 3.0))));
      }
    } else if (tl >= 0) {
      base = base * 0.5 * detail(${T.roof}, wp, N, dx, dy, 0.9);
      spec = 0.2;
    } else {
      base = base * 0.5 * (0.85 + 0.3 * noise2(wp.xz * 2.0));
      spec = 0.2;
    }
  } else if (mat == 3) {
    spec = 1.4; gloss = 100.0;
  } else if (mat == 5) {
    if (tl >= 0) { base = base * detail(tl, wp, N, dx, dy, 0.9); }
    else { base = base * (0.75 + 0.5 * noise2(wp.xz * 3.0)); }
  } else if (mat == 6) {
    spec = 0.35; gloss = 26.0;
    if (tl >= 0) {
      base = base * detail(tl, wp, N, dx, dy, 0.85);
    } else {
      base = base * (0.88 + 0.24 * h2(floor(wp.xz * 2.0)));
      let seam = step(0.94, fract(wp.x)) + step(0.94, fract(wp.z));
      base = base * (1.0 - 0.25 * min(seam, 1.0));
    }
    // rain lingers in the joints of paving
    if (N.y > 0.5) { spec = mix(spec, 1.2, gCav * 0.7); gloss = mix(gloss, 90.0, gCav * 0.7); }
  } else if (tl >= 0) {
    base = base * detail(tl, wp, N, dx, dy, 0.85);
  }
  // contact shadow: darken toward occupied neighbouring tiles, fading out with height
  let occ = smoothstep(0.0, 0.6, aoAt(wp.xz)) * clamp(1.0 - wp.y / 1.1, 0.0, 1.0);
  base = base * (1.0 - 0.6 * occ);
  var col = shade(wp, gN, base, spec, gloss) + emis + i.col * i.m.x;
  if (mat == 4) { col = i.col * i.m.x; }
  if (i.m.z < 0.5) { col = applyFog(col, fog); }
  return vec4f(tonemap(col), 1.0);
}

// ---------- ground decals ----------
struct DOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec4f,
  @location(2) @interpolate(flat) p: vec4f,
  @location(3) wp: vec3f,
  @location(4) @interpolate(flat) sz: vec4f,
};
@vertex fn vsDecal(@location(0) corner: vec2f, @location(1) a: vec4f, @location(2) b: vec4f, @location(3) c: vec4f, @location(4) d: vec4f) -> DOut {
  let cr = cos(a.w); let sr = sin(a.w);
  let lx = corner.x * b.x; let lz = corner.y * b.y;
  let wp = vec3f(a.x + lx * cr - lz * sr, a.y, a.z + lx * sr + lz * cr);
  var o: DOut;
  o.clip = S.viewProj * vec4f(wp, 1.0);
  o.uv = corner * 2.0; o.col = c; o.p = d; o.wp = wp; o.sz = b;
  return o;
}
@fragment fn fsDecal(v: DOut) -> @location(0) vec4f {
  let duvx = dpdx(v.uv) * 0.5; let duvy = dpdy(v.uv) * 0.5;
  let shape = i32(v.sz.z + 0.5);
  var tcol = vec3f(1.0);
  let uv = v.uv;
  let r = length(uv);
  let e = max(abs(uv.x), abs(uv.y));
  var a = 0.0;
  let t = S.info.z;
  if (shape == 0) { a = 1.0 - smoothstep(1.0 - v.p.x, 1.0, e); }
  else if (shape == 1) { let w = v.p.x; a = 1.0 - smoothstep(0.0, w, abs(r - (1.0 - w))); }
  else if (shape == 2) { a = 1.0 - smoothstep(1.0 - v.p.x, 1.0, r); }
  else if (shape == 3) { let w = v.p.x; a = smoothstep(1.0 - w - 0.06, 1.0 - w, e) * (1.0 - smoothstep(0.96, 1.0, e)); }
  else if (shape == 4) {
    let ang = atan2(uv.y, uv.x);
    let rr = r / (0.62 + 0.38 * noise2(vec2f(ang * 1.7 + v.p.y * 10.0, v.p.y * 7.0)));
    a = (1.0 - smoothstep(0.55, 1.0, rr)) * (0.7 + 0.3 * noise2(uv * 4.0 + v.p.y));
  }
  else if (shape == 5) {
    let ring = 1.0 - smoothstep(0.0, 0.08, abs(r - 0.8));
    let ticks = step(abs(uv.x), 0.05) * step(0.55, abs(uv.y)) + step(abs(uv.y), 0.05) * step(0.55, abs(uv.x));
    a = max(ring, min(ticks, 1.0)) * step(r, 1.05);
  }
  else if (shape == 6) {
    // chevron pointing +x
    let x = uv.x; let y = abs(uv.y);
    a = step(abs(x + y * 0.9 - 0.2), 0.28) * step(y, 0.85) * step(-0.9, x);
  }
  else if (shape == 7) {
    // helipad H
    let bar1 = step(abs(uv.x + 0.45), 0.13) * step(abs(uv.y), 0.65);
    let bar2 = step(abs(uv.x - 0.45), 0.13) * step(abs(uv.y), 0.65);
    let mid = step(abs(uv.y), 0.11) * step(abs(uv.x), 0.45);
    a = min(bar1 + bar2 + mid, 1.0);
  }
  else if (shape == 8) {
    // pulsing filled disc
    a = (1.0 - smoothstep(0.6, 1.0, r)) * (0.6 + 0.4 * sin(t * 4.0 + v.p.y));
  }
  else if (shape == 9) {
    // dashed ring (rotating)
    let ang = atan2(uv.y, uv.x) + t * 0.6;
    a = (1.0 - smoothstep(0.0, v.p.x, abs(r - (1.0 - v.p.x)))) * step(0.0, sin(ang * 12.0));
  }
  else if (shape == 10) {
    // texture-array decal (scorch, blood); layer in p.x. Decals output display-space colour.
    let tc = textureSampleGrad(texArr, texSamp, v.uv * 0.5 + 0.5, i32(v.p.x + 0.5), duvx, duvy);
    a = tc.a; tcol = pow(tc.rgb, vec3f(1.0 / 2.2));
  }
  if (a <= 0.004) { discard; }
  var col = v.col.rgb * tcol;
  var fa = 1.0;
  if (v.p.z < 0.5) {
    let f = fogAt(v.wp.xz);
    col = col * mix(0.35, 1.0, f.x);
    fa = mix(0.45 * f.y, 1.0, f.x);
  }
  return vec4f(col, v.col.a * a * fa);
}

// ---------- billboard particles ----------
struct POut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) col: vec4f,
  @location(2) @interpolate(flat) e: vec4f,
  @location(3) wp: vec3f,
};
@vertex fn vsPart(@location(0) corner: vec2f, @location(1) p: vec4f, @location(2) c: vec4f, @location(3) e: vec4f) -> POut {
  let cr = cos(e.x); let sr = sin(e.x);
  let q = vec2f(corner.x * cr - corner.y * sr, corner.x * sr + corner.y * cr) * 2.0;
  let wp = p.xyz + (S.camRight.xyz * q.x + S.camUp.xyz * q.y) * p.w;
  var o: POut;
  o.clip = S.viewProj * vec4f(wp, 1.0);
  o.uv = corner * 2.0; o.col = c; o.e = e; o.wp = p.xyz;
  return o;
}
@fragment fn fsPart(v: POut) -> @location(0) vec4f {
  let r = length(v.uv);
  let shape = i32(v.e.y + 0.5);
  var a = 0.0;
  if (shape == 0) { a = 1.0 - smoothstep(0.0, 1.0, r); a = a * a; }
  else if (shape == 1) { a = pow(max(1.0 - r, 0.0), 0.7); }
  else if (shape == 2) {
    let n = noise2(v.uv * 2.2 + vec2f(v.e.w * 13.0, v.e.w * 7.0));
    a = (1.0 - smoothstep(0.25, 1.0, r)) * (0.55 + 0.45 * n);
  }
  else { a = step(r, 1.0) * (1.0 - r * r); }
  if (a <= 0.003) { discard; }
  var f = 1.0;
  if (v.e.z < 0.5) { let fg = fogAt(v.wp.xz); f = mix(0.3 * fg.y, 1.0, fg.x); }
  return vec4f(v.col.rgb * f, v.col.a * a);
}

// ---------- beams (tracers, lasers, rain) ----------
struct BOut {
  @builtin(position) clip: vec4f,
  @location(0) side: f32,
  @location(1) col: vec4f,
  @location(2) glow: f32,
};
@vertex fn vsBeam(@location(0) corner: vec2f, @location(1) p0: vec4f, @location(2) p1: vec4f, @location(3) c: vec4f) -> BOut {
  let a = p0.xyz; let b = p1.xyz;
  let mid = mix(a, b, corner.x);
  let dir = normalize(b - a + vec3f(0.00001, 0.0, 0.0));
  let view = normalize(S.camPos.xyz - mid);
  var side = cross(dir, view);
  let sl = length(side);
  side = select(vec3f(1.0, 0.0, 0.0), side / sl, sl > 0.0001);
  let wp = mid + side * corner.y * p0.w;
  var o: BOut;
  o.clip = S.viewProj * vec4f(wp, 1.0);
  o.side = corner.y; o.col = c; o.glow = p1.w;
  return o;
}
@fragment fn fsBeam(v: BOut) -> @location(0) vec4f {
  let k = 1.0 - abs(v.side);
  let a = pow(k, 2.0) * 0.6 + pow(k, 10.0) * v.glow;
  return vec4f(v.col.rgb * a * v.col.a, 1.0);
}
`;

function boxMesh() {
  const v = [];
  const face = (n, u, w) => {
    // n normal, u & w tangents; emit two triangles
    const c = (su, sw) => [0.5 * n[0] + 0.5 * su * u[0] + 0.5 * sw * w[0], 0.5 * n[1] + 0.5 * su * u[1] + 0.5 * sw * w[1], 0.5 * n[2] + 0.5 * su * u[2] + 0.5 * sw * w[2]];
    const p = [c(-1, -1), c(1, -1), c(1, 1), c(-1, -1), c(1, 1), c(-1, 1)];
    for (const q of p) v.push(q[0], q[1] + 0.5, q[2], ...n);
  };
  face([1, 0, 0], [0, 1, 0], [0, 0, 1]); face([-1, 0, 0], [0, 0, 1], [0, 1, 0]);
  face([0, 1, 0], [0, 0, 1], [1, 0, 0]); face([0, -1, 0], [1, 0, 0], [0, 0, 1]);
  face([0, 0, 1], [1, 0, 0], [0, 1, 0]); face([0, 0, -1], [0, 1, 0], [1, 0, 0]);
  return new Float32Array(v);
}
function cylMesh(seg = 14) {
  const v = [];
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2, a1 = ((k + 1) / seg) * Math.PI * 2;
    const x0 = Math.cos(a0) * 0.5, z0 = Math.sin(a0) * 0.5, x1 = Math.cos(a1) * 0.5, z1 = Math.sin(a1) * 0.5;
    const n0 = [Math.cos(a0), 0, Math.sin(a0)], n1 = [Math.cos(a1), 0, Math.sin(a1)];
    v.push(x0, 0, z0, ...n0, x1, 0, z1, ...n1, x1, 1, z1, ...n1);
    v.push(x0, 0, z0, ...n0, x1, 1, z1, ...n1, x0, 1, z0, ...n0);
    v.push(0, 1, 0, 0, 1, 0, x1, 1, z1, 0, 1, 0, x0, 1, z0, 0, 1, 0);
    v.push(0, 0, 0, 0, -1, 0, x0, 0, z0, 0, -1, 0, x1, 0, z1, 0, -1, 0);
  }
  return new Float32Array(v);
}
function sphereMesh(seg = 12, rings = 8) {
  const v = [];
  const pt = (r, s) => {
    const th = (r / rings) * Math.PI, ph = (s / seg) * Math.PI * 2;
    const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    return [n[0] * 0.5, n[1] * 0.5 + 0.5, n[2] * 0.5, ...n];
  };
  for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
    const a = pt(r, s), b = pt(r + 1, s), c = pt(r + 1, s + 1), d = pt(r, s + 1);
    v.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return new Float32Array(v);
}

// CPU-side growable instance list: 16 floats per mesh instance.
export class Instances {
  constructor(cap = 1024) { this.f = new Float32Array(cap * 16); this.n = 0; }
  clear() { this.n = 0; }
  grow() { const f = new Float32Array(this.f.length * 2); f.set(this.f); this.f = f; }
  // x,y,z = base position; sx,sy,sz = size; col = linear rgb
  add(x, y, z, sx, sy, sz, yaw, col, mat = 0, emis = 0, pitch = 0, roll = 0, noFog = 0, seed = 0) {
    if ((this.n + 1) * 16 > this.f.length) this.grow();
    const f = this.f, o = this.n++ * 16;
    f[o] = x; f[o + 1] = y; f[o + 2] = z; f[o + 3] = yaw;
    f[o + 4] = sx; f[o + 5] = sy; f[o + 6] = sz; f[o + 7] = pitch;
    f[o + 8] = col[0]; f[o + 9] = col[1]; f[o + 10] = col[2]; f[o + 11] = roll;
    f[o + 12] = emis; f[o + 13] = mat; f[o + 14] = noFog; f[o + 15] = seed;
  }
}
export class FlatList {
  constructor(stride, cap = 512) { this.s = stride; this.f = new Float32Array(cap * stride); this.n = 0; }
  clear() { this.n = 0; }
  // reads `arguments` rather than a rest array, so the hundreds of pushes per frame allocate nothing
  push() {
    const s = this.s;
    if ((this.n + 1) * s > this.f.length) { const f = new Float32Array(this.f.length * 2); f.set(this.f); this.f = f; }
    const f = this.f, o = this.n++ * s;
    for (let k = 0; k < s; k++) f[o + k] = arguments[k];
  }
}
export const MESHES = ['box', 'cyl', 'sph'];

export class Renderer {
  async init(canvas) {
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter found.');
    const device = (this.device = await adapter.requestDevice());
    device.lost.then((info) => { console.error('WebGPU device lost', info.message); this.onLost?.(info); });
    this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device, format: this.format, alphaMode: 'opaque' });

    const mod = device.createShaderModule({ code: WGSL });
    mod.getCompilationInfo?.().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error('WGSL', m.lineNum, m.message); });

    this.meshes = {};
    for (const [name, data] of [['box', boxMesh()], ['cyl', cylMesh()], ['sph', sphereMesh()]]) {
      const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, data);
      this.meshes[name] = { buf, count: data.length / 6 };
    }
    const quad = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
    this.quadBuf = device.createBuffer({ size: quad.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.quadBuf, 0, quad);
    const beamQ = new Float32Array([0, -1, 1, -1, 1, 1, 0, -1, 1, 1, 0, 1]);
    this.beamBuf = device.createBuffer({ size: beamQ.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.beamBuf, 0, beamQ);

    this.uniformSize = 64 * 2 + 16 * 7 + MAX_LIGHTS * 32;
    this.uniformData = new Float32Array(this.uniformSize / 4);
    this.ubuf = device.createBuffer({ size: this.uniformSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const shadowDesc = { size: [SHADOW_SIZE, SHADOW_SIZE], format: 'depth32float' };
    this.shadowTex = device.createTexture({ ...shadowDesc, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.staticShadowTex = device.createTexture({ ...shadowDesc, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.shadowView = this.shadowTex.createView();
    this.staticShadowView = this.staticShadowTex.createView();
    this.linSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.cmpSamp = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });

    const mainBGL = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'uint' } },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
    ] });
    const shadowBGL = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ] });
    this.mainBGL = mainBGL;
    this.shadowBG = device.createBindGroup({ layout: shadowBGL, entries: [{ binding: 0, resource: { buffer: this.ubuf } }] });
    const mainLayout = device.createPipelineLayout({ bindGroupLayouts: [mainBGL] });
    const shadowLayout = device.createPipelineLayout({ bindGroupLayouts: [shadowBGL] });

    const meshBuffers = [
      { arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] },
      { arrayStride: 64, stepMode: 'instance', attributes: [0, 1, 2, 3].map((k) => ({ shaderLocation: 2 + k, offset: k * 16, format: 'float32x4' })) },
    ];
    const ds = (write) => ({ format: 'depth24plus', depthWriteEnabled: write, depthCompare: 'less-equal' });
    const ms = { count: SAMPLES };
    const alphaBlend = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };
    const addBlend = { color: { srcFactor: 'src-alpha', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };
    const oneBlend = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'zero', dstFactor: 'one' } };

    this.meshPipe = device.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mod, entryPoint: 'vsMesh', buffers: meshBuffers },
      fragment: { module: mod, entryPoint: 'fsMesh', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: ds(true), multisample: ms,
    });
    this.shadowPipe = device.createRenderPipeline({
      layout: shadowLayout,
      vertex: { module: mod, entryPoint: 'vsShadow', buffers: meshBuffers },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 },
    });
    const quadBuffers = (stride, n) => [
      { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] },
      { arrayStride: stride, stepMode: 'instance', attributes: Array.from({ length: n }, (_, k) => ({ shaderLocation: 1 + k, offset: k * 16, format: 'float32x4' })) },
    ];
    this.decalPipe = device.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mod, entryPoint: 'vsDecal', buffers: quadBuffers(64, 4) },
      fragment: { module: mod, entryPoint: 'fsDecal', targets: [{ format: this.format, blend: alphaBlend }] },
      primitive: { topology: 'triangle-list' }, depthStencil: ds(false), multisample: ms,
    });
    const partDesc = (blend) => ({
      layout: mainLayout,
      vertex: { module: mod, entryPoint: 'vsPart', buffers: quadBuffers(48, 3) },
      fragment: { module: mod, entryPoint: 'fsPart', targets: [{ format: this.format, blend }] },
      primitive: { topology: 'triangle-list' }, depthStencil: ds(false), multisample: ms,
    });
    this.partAlphaPipe = device.createRenderPipeline(partDesc(alphaBlend));
    this.partAddPipe = device.createRenderPipeline(partDesc(addBlend));
    this.beamPipe = device.createRenderPipeline({
      layout: mainLayout,
      vertex: { module: mod, entryPoint: 'vsBeam', buffers: quadBuffers(48, 3) },
      fragment: { module: mod, entryPoint: 'fsBeam', targets: [{ format: this.format, blend: oneBlend }] },
      primitive: { topology: 'triangle-list' }, depthStencil: ds(false), multisample: ms,
    });

    const post = device.createShaderModule({ code: POST_WGSL });
    post.getCompilationInfo?.().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error('WGSL post', m.lineNum, m.message); });
    this.postBGL = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ] });
    const postLayout = device.createPipelineLayout({ bindGroupLayouts: [this.postBGL] });
    const postPipe = (entry, format, blend) => device.createRenderPipeline({
      layout: postLayout, vertex: { module: post, entryPoint: 'vsFull' },
      fragment: { module: post, entryPoint: entry, targets: [{ format, blend }] }, primitive: { topology: 'triangle-list' },
    });
    this.bloomPipes = {
      prefilter: postPipe('fsPrefilter', 'rgba16float'),
      down: postPipe('fsDown', 'rgba16float'),
      up: postPipe('fsUp', 'rgba16float', oneBlend),
      composite: postPipe('fsComposite', this.format),
    };

    this.gpuBufs = {};
    this.fogTex = null;
    this.resize();
    await this.loadTextures();
  }

  // Loads the surface textures into one texture array with mipmaps. A texture that fails to load
  // is flagged in texInfo and the shader falls back to the untextured look for it.
  async loadTextures() {
    const d = this.device, S = 512, levels = 10;
    this.texArr = d.createTexture({ size: [S, S, TEXTURES.length], format: 'rgba8unorm-srgb', mipLevelCount: levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    this.texSamp = d.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 8 });
    this.normArr = d.createTexture({ size: [S, S, TEXTURES.length], format: 'rgba8unorm', mipLevelCount: levels, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const info = new Float32Array(16 * 4);
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const canvas = (n) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(n, n) : Object.assign(document.createElement('canvas'), { width: n, height: n }));
    await Promise.all(TEXTURES.map(async ([id, scale, bump], k) => {
      info.set([-1, -1, -1, scale], k * 4);
      let flat = true;
      try {
        const res = await fetch(`assets/textures/${id}.webp`);
        if (!res.ok) throw new Error(res.status);
        let src = await createImageBitmap(await res.blob());
        for (let l = 0, n = S; l < levels; l++, n >>= 1) {
          const c = canvas(n), g = c.getContext('2d');
          g.drawImage(src, 0, 0, n, n);
          if (l === 0 && bump) { this.writeNormals(k, g.getImageData(0, 0, n, n).data, n, bump, levels); flat = false; }
          d.queue.copyExternalImageToTexture({ source: c }, { texture: this.texArr, origin: [0, 0, k], mipLevel: l }, [n, n]);
          if (n === 8) {
            const px = g.getImageData(0, 0, 8, 8).data, avg = [0, 0, 0];
            for (let p = 0; p < px.length; p += 4) for (let ch = 0; ch < 3; ch++) avg[ch] += lin(px[p + ch]) / 64;
            info.set(avg, k * 4);
          }
          src = c;
        }
      } catch (err) { console.warn(`texture ${id} not loaded`, err); }
      if (flat) this.writeNormals(k, null, S, 0, levels);
    }));
    this.texInfo = d.createBuffer({ size: info.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    d.queue.writeBuffer(this.texInfo, 0, info);
  }

  // Grow-on-demand GPU buffer keyed by name.
  upload(name, data, bytes) {
    let b = this.gpuBufs[name];
    if (!b || b.size < bytes) {
      b?.destroy();
      b = this.gpuBufs[name] = this.device.createBuffer({ size: Math.max(bytes, 1024) * 1.5 & ~3, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    }
    if (bytes) this.device.queue.writeBuffer(b, 0, data.buffer, data.byteOffset, bytes);
    return b;
  }

  setFog(w, h, data) {
    if (!this.fogTex) {
      this.fogTex = this.device.createTexture({ size: [w, h], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.fogW = w; this.fogH = h;
      this.maskTex = this.device.createTexture({ size: [w, h], format: 'r32uint', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      this.mask = new Uint32Array(w * h);
      this.mainBG = this.device.createBindGroup({ layout: this.mainBGL, entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: this.fogTex.createView() },
        { binding: 2, resource: this.linSamp },
        { binding: 3, resource: this.shadowView },
        { binding: 4, resource: this.cmpSamp },
        { binding: 5, resource: this.maskTex.createView() },
        { binding: 6, resource: this.texArr.createView({ dimension: '2d-array' }) },
        { binding: 7, resource: this.texSamp },
        { binding: 8, resource: { buffer: this.texInfo } },
        { binding: 9, resource: this.normArr.createView({ dimension: '2d-array' }) },
      ] });
    }
    this.device.queue.writeTexture({ texture: this.fogTex }, data, { bytesPerRow: w * 4 }, [w, h]);
  }

  // Normal map from a texture's brightness: high-passed so broad stains don't read as dents,
  // scaled by its own contrast so `bump` means the same for every texture. Alpha holds cavity.
  // Mips are box-filtered here rather than through a canvas, which would premultiply the alpha.
  writeNormals(layer, px, n, bump, levels) {
    let out = new Uint8Array(n * n * 4);
    if (!px) {
      for (let p = 0; p < n * n; p++) out.set([128, 128, 255, 0], p * 4);
    } else {
      const N = n * n, lum = new Float32Array(N), tmp = new Float32Array(N), blur = new Float32Array(N), R = 8;
      for (let p = 0; p < N; p++) lum[p] = (0.3 * px[p * 4] + 0.59 * px[p * 4 + 1] + 0.11 * px[p * 4 + 2]) / 255;
      // wrapped box blur, rows then columns
      for (const [src, dst, row] of [[lum, tmp, true], [tmp, blur, false]]) {
        for (let a = 0; a < n; a++) {
          let sum = 0;
          const at = (b) => (row ? a * n + ((b + n) % n) : ((b + n) % n) * n + a);
          for (let b = -R; b <= R; b++) sum += src[at(b)];
          for (let b = 0; b < n; b++) { dst[at(b)] = sum / (2 * R + 1); sum += src[at(b + R + 1)] - src[at(b - R)]; }
        }
      }
      let v2 = 0;
      for (let p = 0; p < N; p++) { lum[p] -= blur[p]; v2 += lum[p] * lum[p]; }
      const k = bump / Math.max(1e-4, Math.sqrt(v2 / N)) * 0.35;
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const h = (xx, yy) => lum[((yy + n) % n) * n + ((xx + n) % n)];
        const gx = -(h(x + 1, y) - h(x - 1, y)) * k, gy = -(h(x, y + 1) - h(x, y - 1)) * k;
        const il = 1 / Math.hypot(gx, gy, 1), p = (y * n + x) * 4;
        out[p] = (gx * il * 0.5 + 0.5) * 255; out[p + 1] = (gy * il * 0.5 + 0.5) * 255; out[p + 2] = (il * 0.5 + 0.5) * 255;
        out[p + 3] = Math.max(0, Math.min(1, -lum[y * n + x] * Math.sign(bump) * Math.abs(k) * 0.6)) * 255;
      }
    }
    for (let l = 0; l < levels; l++) {
      this.device.queue.writeTexture({ texture: this.normArr, origin: [0, 0, layer], mipLevel: l }, out, { bytesPerRow: n * 4 }, [n, n]);
      if (n === 1) break;
      const h = n >> 1, next = new Uint8Array(h * h * 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < h; x++) for (let c = 0; c < 4; c++) {
        const q = (yy, xx) => out[((y * 2 + yy) * n + x * 2 + xx) * 4 + c];
        next[(y * h + x) * 4 + c] = (q(0, 0) + q(0, 1) + q(1, 0) + q(1, 1) + 2) >> 2;
      }
      out = next; n = h;
    }
  }

  // Light culling: mark every tile each light's radius reaches, so a pixel only loops over the
  // handful of lights near it instead of all of them. Tested on the ground plane (xz), which is
  // conservative: the shader's attenuation still handles height.
  binLights(lights, nl) {
    const w = this.fogW, h = this.fogH, mask = this.mask;
    mask.fill(0);
    for (let k = 0; k < nl; k++) {
      const [lx, , lz, r] = lights[k], r2 = r * r, bit = 1 << k;
      const x0 = Math.max(0, Math.floor(lx - r)), x1 = Math.min(w - 1, Math.floor(lx + r));
      const z0 = Math.max(0, Math.floor(lz - r)), z1 = Math.min(h - 1, Math.floor(lz + r));
      for (let z = z0; z <= z1; z++) {
        const dz = lz < z ? z - lz : lz > z + 1 ? lz - z - 1 : 0;
        for (let x = x0; x <= x1; x++) {
          const dx = lx < x ? x - lx : lx > x + 1 ? lx - x - 1 : 0;
          if (dx * dx + dz * dz <= r2) mask[z * w + x] |= bit;
        }
      }
    }
    this.device.queue.writeTexture({ texture: this.maskTex }, mask, { bytesPerRow: w * 4 }, [w, h]);
  }

  resize() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    const maxPx = 3.6e6 * (this.scale ?? 1) ** 2;
    if (w * h > maxPx) { const k = Math.sqrt(maxPx / (w * h)); w = Math.round(w * k); h = Math.round(h * k); }
    if (c.width === w && c.height === h && this.msaa) return;
    c.width = w; c.height = h;
    this.msaa?.destroy(); this.depth?.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = this.device.createTexture({ size: [w, h], sampleCount: SAMPLES, format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.msaaView = this.msaa.createView();
    this.depthView = this.depth.createView();
    this.buildBloom(w, h);
  }

  // The frame resolves into sceneTex instead of the screen, so bloom can read it.
  buildBloom(w, h) {
    const d = this.device;
    for (const t of this.bloomTex || []) t.destroy();
    this.sceneTex?.destroy();
    for (const b of this.bloomBufs || []) b.destroy();
    this.sceneTex = d.createTexture({ size: [w, h], format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.sceneView = this.sceneTex.createView();
    this.bloomTex = []; this.bloomViews = []; this.bloomSize = [];
    for (let k = 0; k < BLOOM_LEVELS; k++) {
      const s = [Math.max(1, Math.ceil(w / 2 ** (k + 1))), Math.max(1, Math.ceil(h / 2 ** (k + 1)))];
      const t = d.createTexture({ size: s, format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      this.bloomTex.push(t); this.bloomViews.push(t.createView()); this.bloomSize.push(s);
    }
    // one bind group per pass: [source view, source size, uniform a, uniform b, target view, pipe, load]
    const V = this.bloomViews, Z = this.bloomSize;
    const steps = [['prefilter', this.sceneView, [w, h], BLOOM_THRESHOLD, BLOOM_KNEE, V[0]]];
    for (let k = 1; k < BLOOM_LEVELS; k++) steps.push(['down', V[k - 1], Z[k - 1], 0, 0, V[k]]);
    for (let k = BLOOM_LEVELS - 1; k > 0; k--) steps.push(['up', V[k], Z[k], 0, 0, V[k - 1]]);
    steps.push(['composite', V[0], Z[0], BLOOM_STRENGTH, 0, null]);
    this.bloomBufs = [];
    this.bloomSteps = steps.map(([pipe, src, [sw, sh], a, b, dst]) => {
      const buf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      d.queue.writeBuffer(buf, 0, new Float32Array([1 / sw, 1 / sh, a, b]));
      this.bloomBufs.push(buf);
      const bg = d.createBindGroup({ layout: this.postBGL, entries: [
        { binding: 0, resource: src }, { binding: 1, resource: this.linSamp },
        { binding: 2, resource: { buffer: buf } }, { binding: 3, resource: this.sceneView },
      ] });
      return { pipe: this.bloomPipes[pipe], bg, dst, load: pipe === 'up' };
    });
  }

  bloom(enc) {
    for (const st of this.bloomSteps) {
      const view = st.dst || this.ctx.getCurrentTexture().createView();
      const pass = enc.beginRenderPass({ colorAttachments: [{ view, loadOp: st.load ? 'load' : 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
      pass.setPipeline(st.pipe); pass.setBindGroup(0, st.bg); pass.draw(3);
      pass.end();
    }
  }

  drawRanges(pass, mesh, bufName, ranges) {
    if (!ranges.length) return;
    pass.setVertexBuffer(0, this.meshes[mesh].buf);
    pass.setVertexBuffer(1, this.gpuBufs[bufName]);
    for (const [start, n] of ranges) pass.draw(this.meshes[mesh].count, n, 0, start);
  }

  // frame: { viewProj, lightVP, camPos, camRight, camUp, mapW, mapH, time, moonDir, moonCol, ambient,
  //          lights:[[x,y,z,r, cr,cg,cb,intensity]], staticSets:{box,cyl,sph}, staticVersion, objCount:{box,cyl,sph},
  //          draws:{box,cyl,sph,ground: [[start,count]]}, marks, dynSets, decals, partsAlpha, partsAdd, beams }
  render(fr) {
    const d = this.device;
    if (!this.mainBG) return;
    const u = this.uniformData;
    u.set(fr.viewProj, 0); u.set(fr.lightVP, 16);
    u.set([...fr.camPos, 1], 32); u.set([...fr.camRight, 0], 36); u.set([...fr.camUp, 0], 40);
    const nl = Math.min(fr.lights.length, MAX_LIGHTS);
    u.set([fr.mapW, fr.mapH, fr.time, nl], 44);
    u.set([...fr.moonDir, 0], 48); u.set([...fr.moonCol, 0], 52); u.set([...fr.ambient, 0], 56);
    for (let k = 0; k < nl; k++) u.set(fr.lights[k], 60 + k * 8);
    d.queue.writeBuffer(this.ubuf, 0, u);
    this.binLights(fr.lights, nl);

    // static instances and road markings only change when the city does
    const staticChanged = fr.staticVersion !== this.staticVersion;
    if (staticChanged) {
      this.staticVersion = fr.staticVersion;
      for (const m of MESHES) this.upload('s_' + m, fr.staticSets[m].f, fr.staticSets[m].n * 64);
      this.upload('marks', fr.marks.f, fr.marks.n * 64);
    }
    for (const m of MESHES) { const s = fr.dynSets[m]; this.upload('d_' + m, s.f, s.n * 64); }
    const dec = fr.decals, pa = fr.partsAlpha, pd = fr.partsAdd, bm = fr.beams;
    this.upload('decal', dec.f, dec.n * 64);
    this.upload('pa', pa.f, pa.n * 48);
    this.upload('pd', pd.f, pd.n * 48);
    this.upload('beam', bm.f, bm.n * 48);

    const enc = d.createCommandEncoder();
    const S = SHADOW_SIZE;
    // static shadows are rendered once per city change into a cache...
    if (staticChanged) {
      const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.staticShadowView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      pass.setPipeline(this.shadowPipe);
      pass.setBindGroup(0, this.shadowBG);
      for (const m of MESHES) if (fr.objCount[m]) this.drawRanges(pass, m, 's_' + m, [[0, fr.objCount[m]]]);
      pass.end();
    }
    // ...then copied each frame, with only moving things drawn on top
    enc.copyTextureToTexture({ texture: this.staticShadowTex }, { texture: this.shadowTex }, [S, S]);
    {
      const pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.shadowView, depthLoadOp: 'load', depthStoreOp: 'store' } });
      pass.setPipeline(this.shadowPipe);
      pass.setBindGroup(0, this.shadowBG);
      for (const m of MESHES) if (fr.dynSets[m].n) this.drawRanges(pass, m, 'd_' + m, [[0, fr.dynSets[m].n]]);
      pass.end();
    }
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaaView, resolveTarget: this.sceneView, clearValue: { r: 0.004, g: 0.006, b: 0.01, a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.depthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setBindGroup(0, this.mainBG);
    pass.setPipeline(this.meshPipe);
    // tall things first, ground last: early depth testing then skips the hidden floor
    for (const m of MESHES) {
      this.drawRanges(pass, m, 's_' + m, fr.draws[m]);
      if (fr.dynSets[m].n) this.drawRanges(pass, m, 'd_' + m, [[0, fr.dynSets[m].n]]);
    }
    this.drawRanges(pass, 'box', 's_box', fr.draws.ground);
    pass.setPipeline(this.decalPipe);
    pass.setVertexBuffer(0, this.quadBuf);
    if (fr.marks.n) { pass.setVertexBuffer(1, this.gpuBufs.marks); pass.draw(6, fr.marks.n); }
    if (dec.n) { pass.setVertexBuffer(1, this.gpuBufs.decal); pass.draw(6, dec.n); }
    if (pa.n) { pass.setPipeline(this.partAlphaPipe); pass.setVertexBuffer(0, this.quadBuf); pass.setVertexBuffer(1, this.gpuBufs.pa); pass.draw(6, pa.n); }
    if (pd.n) { pass.setPipeline(this.partAddPipe); pass.setVertexBuffer(0, this.quadBuf); pass.setVertexBuffer(1, this.gpuBufs.pd); pass.draw(6, pd.n); }
    if (bm.n) { pass.setPipeline(this.beamPipe); pass.setVertexBuffer(0, this.beamBuf); pass.setVertexBuffer(1, this.gpuBufs.beam); pass.draw(6, bm.n); }
    pass.end();
    this.bloom(enc);
    d.queue.submit([enc.finish()]);
  }
}

// Camera: orbits the target at a fixed pitch. yaw 0 looks north from the south;
// increasing yaw turns the world clockwise on screen.
export class Camera {
  constructor() {
    this.tx = 10; this.tz = 30; this.dist = 30; this.pitch = 1.02; this.fov = 0.78;
    this.yaw = 0; this.yawGoal = null;
    this.goal = null; this.shake = 0; this.aspect = 1;
  }
  // Ground-plane directions of screen-right and screen-up.
  axes() {
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    return { right: [c, -s], fwd: [-s, -c] };
  }
  // Move the target so the map follows a finger drag of (dx, dy) css pixels.
  pan(dx, dy, worldPerPx) {
    const { right, fwd } = this.axes();
    const a = -dx * worldPerPx, b = (dy * worldPerPx) / Math.sin(this.pitch);
    this.tx += right[0] * a + fwd[0] * b;
    this.tz += right[1] * a + fwd[1] * b;
    this.goal = null;
  }
  // Turn by a quarter step, snapping to the nearest compass direction.
  turn(dir) {
    const q = Math.PI / 2;
    this.yawGoal = Math.round((this.yawGoal ?? this.yaw) / q) * q + dir * q;
  }
  faceNorth() { this.yawGoal = Math.round(this.yaw / (Math.PI * 2)) * Math.PI * 2; }
  matrices(w, h) {
    this.aspect = w / h;
    const sx = (Math.random() - 0.5) * this.shake, sz = (Math.random() - 0.5) * this.shake;
    const c = Math.cos(this.pitch) * this.dist;
    const eye = [this.tx + sx + Math.sin(this.yaw) * c, Math.sin(this.pitch) * this.dist, this.tz + sz + Math.cos(this.yaw) * c];
    this._eye = eye;
    const view = mat4.lookAt(eye, [this.tx + sx, 0, this.tz + sz], [0, 1, 0]);
    const proj = mat4.perspective(this.fov, this.aspect, 1, 400);
    this.vp = mat4.mul(proj, view);
    const f = norm([this.tx + sx - eye[0], -eye[1], this.tz + sz - eye[2]]);
    const r = norm(cross(f, [0, 1, 0]));
    const u = cross(r, f);
    this.basis = { f, r, u };
    return { vp: this.vp, eye, right: r, up: u };
  }
  // screen (css px) -> ray
  ray(px, py, w, h) {
    const { f, r, u } = this.basis;
    const ny = Math.tan(this.fov / 2), nx = ny * this.aspect;
    const sx = (px / w) * 2 - 1, sy = 1 - (py / h) * 2;
    const d = norm([f[0] + r[0] * sx * nx + u[0] * sy * ny, f[1] + r[1] * sx * nx + u[1] * sy * ny, f[2] + r[2] * sx * nx + u[2] * sy * ny]);
    return { o: this._eye, d };
  }
  project(x, y, z, w, h) {
    const c = mat4.xform(this.vp, x, y, z);
    if (c[3] <= 0) return null;
    return [((c[0] / c[3]) * 0.5 + 0.5) * w, (0.5 - (c[1] / c[3]) * 0.5) * h];
  }
}
const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
