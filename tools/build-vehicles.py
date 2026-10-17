#!/usr/bin/env python3
"""Convert Kenney's Car Kit (CC0, https://kenney.nl/assets/car-kit) into the game's vehicle meshes.

    python3 tools/build-vehicles.py "/path/to/kenney_car-kit/Models/GLB format"

Writes assets/vehicles/vehicles.json, with the mesh data inline as base64 (one file that any
static host serves, including Claude artifacts, which don't serve .bin). Each model is flattened to one indexed
mesh, turned to face +x like the game's boxes, and normalised to a unit box (x and z in
[-0.5, 0.5], y in [0, 1]); the game scales it to the vehicle's footprint. The kit colours
everything through one palette texture, which is baked into vertex colours here, with each
vertex tagged by role so the game can repaint bodies, darken glass and light the lamps.
Faces the top-down camera never sees are dropped (undersides), and the detailed wheels are
swapped for simple tyres, which cuts each model to about a third of its triangles.

Vertex (16 bytes): position unorm16x4 (x and z offset by 0.5), normal snorm8x4, colour unorm8x4
(rgb linear, a = role * 40).
Needs Python 3 with Pillow and NumPy.
"""
import base64, json, math, struct, sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'assets/vehicles'

# role ids, matched in the vehicle shader
FIXED, PAINT, GLASS, HEAD, TAIL, SIREN = range(6)
# palette cells (column of 16, row of 4) with a fixed role in every model
CELL_ROLES = {(1, 3): GLASS, (3, 3): HEAD, (5, 3): TAIL, (7, 3): SIREN}

# name -> (class, paint cell or None to keep the kit's livery)
MODELS = {
    'sedan': ('car', (13, 1)),
    'sedan-sports': ('car', (13, 1)),
    'hatchback-sports': ('car', (7, 1)),
    'suv': ('car', (7, 1)),
    'suv-luxury': ('car', (9, 1)),
    'van': ('car', (15, 1)),
    'truck': ('car', (7, 1)),         # a pickup: fits a car's footprint
    'taxi': ('car', None),
    'police': ('car', None),
    'delivery': ('truck', (7, 1)),
    'garbage-truck': ('truck', None),
    'ambulance': ('truck', None),
    'firetruck': ('truck', None),
}


def srgb_to_linear(c):
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def quat_matrix(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def node_matrix(node):
    m = np.eye(4)
    if 'matrix' in node: return np.array(node['matrix']).reshape(4, 4).T
    r = quat_matrix(node.get('rotation', [0, 0, 0, 1])) * np.array(node.get('scale', [1, 1, 1]))
    m[:3, :3] = r
    m[:3, 3] = node.get('translation', [0, 0, 0])
    return m


def load_glb(path):
    b = path.read_bytes()
    n = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + n])
    binoff = 20 + n + 8

    def acc(i):
        a = j['accessors'][i]
        bv = j['bufferViews'][a['bufferView']]
        comp = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
        dt = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[a['componentType']]
        stride = bv.get('byteStride')
        start = binoff + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        if stride and stride != comp * np.dtype(dt).itemsize:
            raise ValueError('interleaved buffers not supported')
        r = np.frombuffer(b, dt, a['count'] * comp, start)
        return r.reshape(-1, comp) if comp > 1 else r
    return j, acc


def tyre(pos, palette_lin, segs=10):
    """Low-poly stand-in for a wheel: tread plus the outer face. The axle is the wheel's thinnest
    horizontal axis (x for road wheels in the kit, z for a spare on a tailgate)."""
    swap = np.ptp(pos[:, 2]) < np.ptp(pos[:, 0])
    if swap: pos = pos[:, [2, 1, 0]]
    lo, hi = pos.min(0), pos.max(0)
    c = (lo + hi) / 2
    r, hw = (hi[1] - lo[1]) / 2, (hi[0] - lo[0]) / 2
    out = 1 if c[0] > 0 else -1  # the side facing away from the car
    tire = srgb_to_linear(np.array([62.0, 62, 68])); hub = srgb_to_linear(np.array([150.0, 152, 168]))
    P, N, C, I = [], [], [], []
    for k in range(segs):
        a = 2 * math.pi * k / segs
        y, z, ny, nz = math.cos(a) * r, math.sin(a) * r, math.cos(a), math.sin(a)
        for sx in (-1, 1):  # tread ring
            P.append(c + [sx * hw, y, z]); N.append([0, ny, nz]); C.append(tire)
    for k in range(segs):
        a0, a1 = 2 * k, 2 * ((k + 1) % segs)
        I += [a0, a0 + 1, a1 + 1, a0, a1 + 1, a1]
    base = len(P)
    for k in range(segs):  # outer face: tyre rim around a hub
        a = 2 * math.pi * k / segs
        P.append(c + [out * hw, math.cos(a) * r, math.sin(a) * r]); N.append([out, 0, 0]); C.append(tire)
    P.append(c + [out * hw * 1.02, 0, 0]); N.append([out, 0, 0]); C.append(hub)
    for k in range(segs): I += [base + k, base + (k + 1) % segs, base + segs]
    P, N = np.array(P), np.array(N)
    if swap: P, N = P[:, [2, 1, 0]], N[:, [2, 1, 0]]
    return P, N, np.array(C), np.array(I, np.uint32)


def convert(path, paint_cell, palette, palette_lin):
    j, acc = load_glb(path)
    P, N, C, I = [], [], [], []
    base = 0

    def walk(ni, parent):
        nonlocal base
        node = j['nodes'][ni]
        m = parent @ node_matrix(node)
        if 'mesh' in node:
            for p in j['meshes'][node['mesh']]['primitives']:
                pos = acc(p['attributes']['POSITION']).astype(np.float64)
                nrm = acc(p['attributes']['NORMAL']).astype(np.float64)
                uv = acc(p['attributes']['TEXCOORD_0'])
                idx = acc(p['indices']).astype(np.uint32) if 'indices' in p else np.arange(len(pos), dtype=np.uint32)
                pos = pos @ m[:3, :3].T + m[:3, 3]
                nm = np.linalg.inv(m[:3, :3]).T
                nrm = nrm @ nm.T
                nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
                if node.get('name', '').startswith('wheel'):
                    tp, tn, tc, ti = tyre(pos[np.unique(idx)], palette_lin)
                    P.append(tp); N.append(tn); C.append(np.column_stack([tc, np.zeros(len(tp))])); I.append(ti + base)
                    base += len(tp)
                    continue
                # drop faces pointing down: the camera only ever looks from above
                tri = idx.reshape(-1, 3)
                idx = tri[nrm[tri].mean(1)[:, 1] > -0.3].reshape(-1)
                h, w = palette.shape[:2]
                px = np.clip((uv[:, 0] * w).astype(int), 0, w - 1)
                py = np.clip((uv[:, 1] * h).astype(int), 0, h - 1)
                cols = palette_lin[py, px]
                cells = list(zip((uv[:, 0] * 16).astype(int), (uv[:, 1] * 4).astype(int)))
                role = np.array([CELL_ROLES.get(c, PAINT if c == paint_cell else FIXED) for c in cells])
                if paint_cell is not None:
                    # paint keeps only the kit's shading, relative to the swatch's average, halved to fit 8 bits
                    cx, cy = paint_cell
                    avg = palette_lin[cy * h // 4:(cy + 1) * h // 4, cx * w // 16:(cx + 1) * w // 16].reshape(-1, 3).mean(0)
                    rel = (cols @ [0.3, 0.59, 0.11]) / max(1e-4, avg @ [0.3, 0.59, 0.11])
                    cols = np.where((role == PAINT)[:, None], np.clip(rel * 0.5, 0, 1)[:, None].repeat(3, 1), cols)
                P.append(pos); N.append(nrm); C.append(np.column_stack([cols, role * 40 / 255])); I.append(idx + base)
                base += len(pos)
        for c in node.get('children', []): walk(c, m)

    for root in j['scenes'][j.get('scene', 0)]['nodes']: walk(root, np.eye(4))
    pos, nrm, col, idx = np.vstack(P), np.vstack(N), np.vstack(C), np.concatenate(I)
    # face +x (the kit faces +z): rotate 90 degrees about y
    rot = np.array([[0, 0, 1], [0, 1, 0], [-1, 0, 0]], dtype=np.float64)
    pos, nrm = pos @ rot.T, nrm @ rot.T
    lo, hi = pos.min(0), pos.max(0)
    size = hi - lo
    pos = (pos - [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]) / size
    return pos.astype(np.float32), nrm.astype(np.float32), col, idx, size


def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    src = Path(sys.argv[1])
    palette = np.asarray(Image.open(src / 'Textures/colormap.png').convert('RGB'))
    palette_lin = srgb_to_linear(palette.astype(np.float64))
    OUT.mkdir(parents=True, exist_ok=True)
    blob = bytearray()
    index = {}
    for name, (cls, paint) in MODELS.items():
        pos, nrm, col, idx, size = convert(src / f'{name}.glb', paint, palette, palette_lin)
        if len(pos) > 65535: sys.exit(f'{name}: too many vertices for 16-bit indices')
        v = np.zeros((len(pos), 16), np.uint8)
        p16 = np.clip((pos + [0.5, 0, 0.5]) * 65535 + 0.5, 0, 65535).astype('<u2')
        v[:, 0:6] = p16.view(np.uint8).reshape(-1, 6)
        v[:, 8:11] = np.clip(np.round(nrm * 127), -127, 127).astype(np.int8).view(np.uint8)
        v[:, 12:16] = np.clip(col * 255 + 0.5, 0, 255).astype(np.uint8)
        v_off = len(blob); blob += v.tobytes()
        while len(blob) % 4: blob += b'\0'
        i_off = len(blob); blob += idx.astype(np.uint16).tobytes()
        while len(blob) % 4: blob += b'\0'
        index[name] = {'class': cls, 'livery': paint is None, 'vertexOffset': v_off, 'vertices': len(pos),
                       'indexOffset': i_off, 'indices': len(idx), 'size': [round(float(s), 4) for s in size]}
        print(f'{name:18} {cls:5} {len(idx) // 3:5} tris  size {np.round(size, 2)}')
    (OUT / 'vehicles.bin').unlink(missing_ok=True)
    (OUT / 'vehicles.json').write_text(json.dumps({'stride': 16, 'models': index, 'data': base64.b64encode(bytes(blob)).decode()}))
    lic = src.parent.parent / 'License.txt'
    if lic.exists(): (OUT / 'LICENSE-kenney-car-kit.txt').write_text(lic.read_text())
    print(f'{len(blob) / 1024:.0f} KB')


main()
