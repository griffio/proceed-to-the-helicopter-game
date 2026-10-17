#!/usr/bin/env python3
"""Build-time texture generation with Gemini's image model ("Nano Banana 2").

    python3 tools/generate-textures.py              # generate anything missing, then process
    python3 tools/generate-textures.py brick roof   # regenerate just these
    python3 tools/generate-textures.py --process    # reprocess cached images, no API calls

The key comes from GEMINI_API_KEY / GOOGLE_API_KEY or the project's .env file, and is only
used here, never shipped. Raw API output is cached in .texture-cache/ (gitignored) so
reprocessing is free; every call's cost is logged there and the run stops before it would
pass the spending cap (--cap, default $4.50).

Needs Python 3 with Pillow and NumPy.
"""
import base64, io, json, os, sys, time, urllib.request, urllib.error
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = json.loads((ROOT / 'tools/texture-manifest.json').read_text())
CACHE = ROOT / '.texture-cache'
OUT = ROOT / 'assets/textures'
MODEL = 'gemini-3.1-flash-image'
URL = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent'
SIZE = 1024      # working resolution
SHIP = 512       # shipped resolution: plenty for the camera distance, light on iPad memory
# USD per token for gemini-3.1-flash-image (ai.google.dev/gemini-api/docs/pricing, Oct 2026)
PRICE_IN, PRICE_TEXT_OUT, PRICE_IMAGE_OUT = 0.50e-6, 3e-6, 60e-6
EST_CALL = 0.07  # worst-case cost of one 1K image call, checked against the cap before calling

args = [a for a in sys.argv[1:] if not a.startswith('--')]
flags = {a.split('=')[0]: (a.split('=') + [''])[1] for a in sys.argv[1:] if a.startswith('--')}
CAP = float(flags.get('--cap') or 4.50)
PROCESS_ONLY = '--process' in flags


def api_key():
    for name in ('GEMINI_API_KEY', 'GOOGLE_API_KEY'):
        if os.environ.get(name): return os.environ[name]
    env = ROOT / '.env'
    if env.exists():
        for line in env.read_text().splitlines():
            k, _, v = line.partition('=')
            if k.strip() in ('GEMINI_API_KEY', 'GOOGLE_API_KEY') and v.strip(): return v.strip().strip('"\'')
    sys.exit('Set GEMINI_API_KEY (or put it in .env)')


LEDGER = CACHE / 'ledger.json'
def ledger():
    return json.loads(LEDGER.read_text()) if LEDGER.exists() else {'spent': 0.0, 'calls': []}


def call(parts, label):
    led = ledger()
    if led['spent'] + EST_CALL > CAP:
        sys.exit(f'Stopping: ${led["spent"]:.3f} spent, another call could pass the ${CAP:.2f} cap')
    body = json.dumps({
        'contents': [{'parts': parts}],
        'generationConfig': {'responseModalities': ['IMAGE'], 'imageConfig': {'aspectRatio': '1:1', 'imageSize': '1K'}},
    }).encode()
    for attempt in range(5):
        req = urllib.request.Request(URL, data=body, method='POST', headers={'Content-Type': 'application/json', 'x-goog-api-key': api_key()})
        try:
            with urllib.request.urlopen(req, timeout=180) as r: res = json.loads(r.read())
            break
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:400]
            if e.code in (429, 500, 502, 503, 504) and attempt < 4:
                print(f'  {e.code}, retrying'); time.sleep(5 * (attempt + 1)); continue
            sys.exit(f'{label}: HTTP {e.code} {msg}')
    u = res.get('usageMetadata', {})
    img_tokens = sum(d.get('tokenCount', 0) for d in u.get('candidatesTokensDetails', []) if d.get('modality') == 'IMAGE')
    text_tokens = u.get('candidatesTokenCount', 0) - img_tokens + u.get('thoughtsTokenCount', 0)
    cost = u.get('promptTokenCount', 0) * PRICE_IN + img_tokens * PRICE_IMAGE_OUT + text_tokens * PRICE_TEXT_OUT
    led['spent'] += cost
    led['calls'].append({'label': label, 'cost': round(cost, 5), 'usage': u, 'at': time.strftime('%Y-%m-%d %H:%M:%S')})
    LEDGER.write_text(json.dumps(led, indent=1))
    print(f'  {label}: ${cost:.4f}  (total ${led["spent"]:.3f} of ${CAP:.2f})')
    for c in res.get('candidates', []):
        for p in c.get('content', {}).get('parts', []):
            data = p.get('inlineData') or p.get('inline_data')
            if data and not p.get('thought'):
                return Image.open(io.BytesIO(base64.b64decode(data['data']))).convert('RGB')
    sys.exit(f'{label}: no image in response: {json.dumps(res)[:400]}')


def png_part(img):
    buf = io.BytesIO(); img.save(buf, 'PNG')
    return {'inlineData': {'mimeType': 'image/png', 'data': base64.b64encode(buf.getvalue()).decode()}}


def arr(img): return np.asarray(img, dtype=np.float32) / 255
def img(a): return Image.fromarray(np.clip(a * 255 + 0.5, 0, 255).astype(np.uint8))
def roll(a): return np.roll(a, (a.shape[0] // 2, a.shape[1] // 2), axis=(0, 1))


def seam_score(a):
    """How visible the wrap-around seams are, relative to ordinary pixel-to-pixel variation."""
    inner = np.abs(np.diff(a, axis=1)).mean() + np.abs(np.diff(a, axis=0)).mean()
    wrap = np.abs(a[:, 0] - a[:, -1]).mean() + np.abs(a[0] - a[-1]).mean()
    return wrap / max(inner, 1e-6)


def cross_mask(n, inner=0.06, outer=0.16):
    """1 on a cross through the centre, fading to 0; the seams of a half-offset image lie on it."""
    d = np.abs(np.arange(n) / n - 0.5)
    band = np.clip((outer - d) / (outer - inner), 0, 1)
    band = band * band * (3 - 2 * band)
    return np.maximum(band[None, :], band[:, None])[..., None]


def periodic_crop(a):
    """Crop to the window [s, e) along each axis where column e looks most like column s, so
    wrapping around continues the image the way it naturally continues. Grids, planks and bricks
    then repeat exactly instead of being cut mid-slab."""
    def best(a2, n):  # a2: (n, rows, ch) slices along the axis being cropped, at 1/4 res
        m = a2.shape[0]
        win = np.concatenate([a2, np.roll(a2, -1, 0)], axis=1)  # compare 2-slice windows
        flat = win.reshape(m, -1)
        lo = int(m * 0.72)
        best_c, best_se = 1e9, (0, m)
        for s in range(0, m - lo):
            e = np.arange(s + lo, m)
            if not len(e): continue
            d = np.abs(flat[e] - flat[s]).mean(axis=1)
            k = int(d.argmin())
            if d[k] < best_c: best_c, best_se = d[k], (s, int(e[k]))
        return best_se[0] * n // m, best_se[1] * n // m
    n = a.shape[0]
    small = np.asarray(img(a).resize((n // 4, n // 4), Image.BOX), dtype=np.float32) / 255
    x0, x1 = best(np.transpose(small, (1, 0, 2)), n)
    y0, y1 = best(small, n)
    return arr(img(a[y0:y1, x0:x1]).resize((n, n), Image.LANCZOS))


def make_tileable(t, raw):
    """Offset by half so the seams form a cross in the middle, then repaint that cross: with
    Gemini for structured textures (bricks, slabs) or by blending in the un-offset original for
    noisy ones. The outer edges stay the offset image's, which wrap perfectly."""
    a = arr(raw)
    if seam_score(a) < 1.5: return a  # the model already made it seamless
    if t.get('crop'):
        a = periodic_crop(a)
        print(f'  {t["id"]}: periodic crop, seam score now {seam_score(a):.2f}')
        if seam_score(a) < 2.0: return a  # grids score higher even when perfect: joints sit at the wrap
    o = roll(a)
    fixed = CACHE / f'{t["id"]}.fix.png'
    if t.get('fix'):
        if not fixed.exists():
            if PROCESS_ONLY: print(f'  {t["id"]}: no cached seam fix, blending instead'); return o * (1 - cross_mask(o.shape[0])) + a * cross_mask(o.shape[0])
            g = call([{'text': 'This square texture tile has a visible seam forming a cross through its exact centre: one vertical line and one horizontal line where the pattern does not line up. '
                               'Repaint only a narrow band along that cross so the texture continues naturally and seamlessly across it, matching the pattern, scale, alignment, colour and lighting around it. '
                               'Keep everything else, especially all four outer edges, exactly as it is. Same framing, same size, no borders.'}, png_part(img(o))], f'{t["id"]} seam fix')
            g.save(fixed)
        g = arr(Image.open(fixed).convert('RGB').resize(o.shape[1::-1], Image.LANCZOS))
        w = cross_mask(o.shape[0], 0.1, 0.22)
        return o * (1 - w) + g * w
    w = cross_mask(o.shape[0])
    return o * (1 - w) + a * w


def make_decal(raw, soften=0):
    """Dark mark on white -> colour + alpha, by un-compositing from the white background.
    soften blurs the alpha (in pixels) and fades it radially, for marks that read too graphic."""
    a = arr(raw)
    alpha = np.clip((1 - a).max(axis=2) * 1.15 - 0.04, 0, 1)
    n = a.shape[0]
    yy, xx = np.mgrid[0:n, 0:n] / n - 0.5
    if soften:
        from PIL import ImageFilter
        alpha = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(soften)), dtype=np.float32) / 255
        r = np.hypot(xx, yy)
        disc = 1 - np.clip((r - 0.08) / 0.3, 0, 1) ** 2  # soft sooty base under the streaks
        alpha = np.clip(0.55 * disc + 0.6 * alpha, 0, 1) * np.clip(1 - r / 0.47, 0, 1) ** 0.7
        return np.dstack([np.clip(a * 0.12, 0, 0.06), alpha])  # char black, keeping a little grain
    alpha *= np.clip((0.5 - np.maximum(np.abs(xx), np.abs(yy))) / 0.06, 0, 1)  # never a hard edge at the border
    rgb = np.clip(1 - (1 - a) / np.maximum(alpha[..., None], 1e-3), 0, 1)
    return np.dstack([rgb, alpha])


def main():
    CACHE.mkdir(exist_ok=True); OUT.mkdir(parents=True, exist_ok=True)
    todo = [t for t in MANIFEST['textures'] if not args or t['id'] in args]
    for t in todo:
        raw_path = CACHE / f'{t["id"]}.png'
        if not raw_path.exists() or (args and not PROCESS_ONLY):
            if PROCESS_ONLY: print(f'  {t["id"]}: not generated yet'); continue
            prompt = t['prompt'] if t.get('decal') else f'{t["prompt"]} {MANIFEST["style"]}'
            call([{'text': prompt}], t['id']).save(raw_path)
            (CACHE / f'{t["id"]}.fix.png').unlink(missing_ok=True)
        raw = Image.open(raw_path).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
        if t.get('decal'):
            out = make_decal(raw, t.get('soften', 0))
            Image.fromarray((out * 255 + 0.5).astype(np.uint8)).resize((SHIP, SHIP), Image.LANCZOS).save(OUT / f'{t["id"]}.webp', quality=88)
            print(f'{t["id"]}: decal')
            continue
        before = seam_score(arr(raw))
        tiled = make_tileable(t, raw)
        img(tiled).resize((SHIP, SHIP), Image.LANCZOS).save(OUT / f'{t["id"]}.webp', quality=88)
        # 2x2 preview for eyeballing the tiling
        prev = np.tile(tiled, (2, 2, 1))
        img(prev).resize((1024, 1024), Image.LANCZOS).save(CACHE / f'{t["id"]}.preview.jpg', quality=85)
        print(f'{t["id"]}: seam score {before:.2f} -> {seam_score(tiled):.2f}')
    print(f'Spent so far: ${ledger()["spent"]:.3f}')


main()
