#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_demo.py - build the Filament demo tree.

Generates a rich, realistic sample file tree used to exercise the Filament file
manager UI: markdown/text notes, fake Rust + TypeScript source trees, PNG
photos (thumbnails/previews), WAV audio (playback), large data files (preview
truncation), zip archives (zip-vfs plugin) and a 2000-file folder (virtualized
listing performance).

Design constraints
------------------
* Python 3 standard library only. No PIL, no numpy, no network.
* Idempotent: every managed path is wiped and rebuilt from fixed seeds, so
  running the script twice produces byte-identical output (contents and mtimes).
* Self-contained: writes only inside the demo root (default ``<repo>/demo``).

Usage
-----
    python3 scripts/make_demo.py            # build the default tree
    python3 scripts/make_demo.py --root DIR # build somewhere else
    python3 scripts/make_demo.py --only photos,music
"""

from __future__ import annotations

import array
import calendar
import hashlib
import io
import json
import math
import os
import random
import re
import shutil
import struct
import sys
import time
import zipfile
import zlib
from pathlib import Path

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #

SCRIPT_PATH = Path(__file__).resolve()
REPO_ROOT = SCRIPT_PATH.parent.parent
DEFAULT_DEMO_ROOT = REPO_ROOT / "demo"

#: Everything directly under the demo root that this script owns. Anything else
#: (or anything above the root) is left alone.
MANAGED_DIRS = ("notes", "projects", "photos", "music", "data", "archive", "many")
MANAGED_FILES = ("readme.md",)

#: Deterministic clock. The whole tree is stamped against this instant so that
#: repeated runs do not churn mtimes.
BASE_TS = calendar.timegm((2026, 10, 30, 21, 0, 0))
MTIME_SPREAD_DAYS = 150
GENERATED_AT = "2026-10-30T21:00:00Z"

PHOTO_W, PHOTO_H = 1200, 800

# --------------------------------------------------------------------------- #
# Small helpers
# --------------------------------------------------------------------------- #


def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else (hi if x > hi else x)


def clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def smoothstep(t: float) -> float:
    t = clamp01(t)
    return t * t * (3.0 - 2.0 * t)


def human(n: float) -> str:
    """Format a byte count the way a file manager would."""
    if n < 1024:
        return f"{int(n)} B"
    for unit in ("KB", "MB", "GB"):
        n /= 1024.0
        if n < 1024 or unit == "GB":
            return f"{n:,.1f} {unit}"
    return f"{n} B"


def mtime_for(rel: str) -> float:
    """Deterministic, plausible mtime for a path: biased toward the recent past."""
    digest = hashlib.sha1(rel.encode("utf-8")).digest()
    u = int.from_bytes(digest[:6], "big") / float(1 << 48)
    days = (u ** 1.7) * MTIME_SPREAD_DAYS
    return float(BASE_TS - int(days * 86400) - int(u * 40000))


def kb(n: float) -> int:
    return int(n * 1024)


# --------------------------------------------------------------------------- #
# Writer: tracks every file so we can stamp mtimes and print a summary
# --------------------------------------------------------------------------- #


class TreeWriter:
    """Writes files under a root, stamping deterministic mtimes."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.written: list[tuple[str, int]] = []

    def _finalize(self, path: Path, size: int) -> None:
        rel = path.relative_to(self.root).as_posix()
        ts = mtime_for(rel)
        os.utime(path, (ts, ts))
        self.written.append((rel, size))

    def write_bytes(self, rel: str, data: bytes) -> Path:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        self._finalize(path, len(data))
        return path

    def write_text(self, rel: str, text: str) -> Path:
        return self.write_bytes(rel, text.encode("utf-8"))

    def stamp_dirs(self) -> None:
        """Directory mtimes = newest child, so the UI sorts sensibly."""
        dirs = [p for p in self.root.rglob("*") if p.is_dir()]
        for d in sorted(dirs, key=lambda p: len(p.parts), reverse=True):
            try:
                newest = max(
                    (c.stat().st_mtime for c in d.iterdir()),
                    default=mtime_for(d.relative_to(self.root).as_posix()),
                )
                os.utime(d, (newest, newest))
            except OSError:
                pass


def clean_managed(root: Path) -> None:
    """Remove only the paths this script owns, after verifying the root."""
    resolved = root.resolve()
    if resolved.name != "demo" or resolved.parent.name != "filament":
        raise SystemExit(
            f"refusing to clean unexpected demo root: {resolved} "
            "(expected a directory named 'demo' directly under 'filament')"
        )
    for name in MANAGED_DIRS:
        target = (resolved / name).resolve()
        if target.parent != resolved:
            raise SystemExit(f"refusing to remove out-of-tree path: {target}")
        shutil.rmtree(target, ignore_errors=True)
    for name in MANAGED_FILES:
        (resolved / name).unlink(missing_ok=True)


# --------------------------------------------------------------------------- #
# PNG writing (pure stdlib: struct + zlib)
# --------------------------------------------------------------------------- #

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def png_bytes(width: int, height: int, rgb: bytes | bytearray, level: int = 6) -> bytes:
    """Encode a packed RGB buffer (height*width*3 bytes) as a PNG."""
    stride = width * 3
    if len(rgb) != stride * height:
        raise ValueError(f"buffer is {len(rgb)} bytes, expected {stride * height}")
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0 (None)
        raw.extend(rgb[y * stride : (y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit truecolour
    return (
        PNG_SIG
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), level))
        + _png_chunk(b"IEND", b"")
    )


def read_png_ihdr(data: bytes) -> tuple[int, int, int, int]:
    """Verify signature and return (width, height, bit_depth, colour_type)."""
    if data[:8] != PNG_SIG:
        raise ValueError("not a PNG (bad signature)")
    if data[12:16] != b"IHDR":
        raise ValueError("first chunk is not IHDR")
    w, h, depth, ctype = struct.unpack(">IIBB", data[16:26])
    return w, h, depth, ctype


# --------------------------------------------------------------------------- #
# WAV writing (44.1 kHz, 16-bit mono PCM)
# --------------------------------------------------------------------------- #


def wav_bytes(samples, sample_rate: int = 44100) -> bytes:
    """Encode float samples in -1..1 as a canonical 16-bit mono WAV."""
    ints = [max(-32768, min(32767, int(round(s * 32767.0)))) for s in samples]
    pcm = array.array("h", ints)
    if sys.byteorder == "big":
        pcm.byteswap()
    data = pcm.tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, sample_rate, sample_rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", len(data))
    return header + data


def read_wav_header(data: bytes) -> dict:
    """Parse the canonical header we emit, for verification."""
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    if data[12:16] != b"fmt ":
        raise ValueError("missing fmt chunk")
    fmt_size, audio_format, channels, rate, byte_rate, align, bits = struct.unpack(
        "<IHHIIHH", data[16:36]
    )
    if data[36:40] != b"data":
        raise ValueError("missing data chunk")
    (data_size,) = struct.unpack("<I", data[40:44])
    return {
        "fmt_size": fmt_size,
        "audio_format": audio_format,
        "channels": channels,
        "sample_rate": rate,
        "byte_rate": byte_rate,
        "block_align": align,
        "bits": bits,
        "data_bytes": data_size,
        "seconds": data_size / float(byte_rate) if byte_rate else 0.0,
    }


# --------------------------------------------------------------------------- #
# Field toolkit: everything visual is built as a 16-bit scalar field + colormap
# --------------------------------------------------------------------------- #

#: 4096-entry colormaps keep gradients far below the visible banding threshold.
LUT_N = 4096
LUT_SHIFT = 16 - 12  # uint16 field -> 4096-entry LUT index


def make_lut(stops, n: int = LUT_N):
    """Build a smooth colormap from ``[(pos, (r, g, b)), ...]`` stops."""
    stops = sorted(stops, key=lambda s: s[0])
    lut = []
    last = len(stops) - 2
    for i in range(n):
        t = i / (n - 1)
        for k in range(len(stops) - 1):
            p0, c0 = stops[k]
            p1, c1 = stops[k + 1]
            if t <= p1 or k == last:
                u = 0.0 if p1 <= p0 else smoothstep((t - p0) / (p1 - p0))
                lut.append(
                    (
                        int(round(lerp(c0[0], c1[0], u))),
                        int(round(lerp(c0[1], c1[1], u))),
                        int(round(lerp(c0[2], c1[2], u))),
                    )
                )
                break
        else:  # pragma: no cover - defensive
            lut.append(stops[-1][1])
    return lut


def make_lut_linear(stops, n: int = LUT_N):
    """Like :func:`make_lut` but with straight (non-eased) interpolation."""
    stops = sorted(stops, key=lambda s: s[0])
    lut = []
    last = len(stops) - 2
    for i in range(n):
        t = i / (n - 1)
        for k in range(len(stops) - 1):
            p0, c0 = stops[k]
            p1, c1 = stops[k + 1]
            if t <= p1 or k == last:
                u = 0.0 if p1 <= p0 else clamp01((t - p0) / (p1 - p0))
                lut.append(
                    (
                        int(round(lerp(c0[0], c1[0], u))),
                        int(round(lerp(c0[1], c1[1], u))),
                        int(round(lerp(c0[2], c1[2], u))),
                    )
                )
                break
        else:  # pragma: no cover - defensive
            lut.append(stops[-1][1])
    return lut


def blank_field(sw: int, sh: int):
    """Allocate a zeroed uint16 field of ``sw*sh`` samples."""
    return array.array("H", bytes(sw * sh * 2))


def build_field(sw: int, sh: int, fn):
    """Sample ``fn(x, y) -> float`` in 0..1 over an ``sw*sh`` grid."""
    out = array.array("H", bytes(sw * sh * 2))
    i = 0
    for y in range(sh):
        for x in range(sw):
            out[i] = int(clamp01(fn(x, y)) * 65535.0)
            i += 1
    return out


def upsample16(src, sw: int, sh: int, dw: int, dh: int):
    """Center-aligned bilinear upsample of a uint16 field.

    Dest coords map to ``(i + 0.5) * s / d - 0.5`` and are clamped to the source
    extent, so weights always stay in 0..1 (no extrapolation / overshoot).
    """
    if sw == dw and sh == dh:
        return src
    out = array.array("H", bytes(dw * dh * 2))
    xs = []
    for x in range(dw):
        cx = (x + 0.5) * sw / dw - 0.5
        if cx < 0.0:
            cx = 0.0
        elif cx > sw - 1:
            cx = float(sw - 1)
        x0 = int(cx)
        x1 = x0 + 1 if x0 + 1 < sw else sw - 1
        xs.append((x0, x1, cx - x0))
    idx = 0
    for y in range(dh):
        cy = (y + 0.5) * sh / dh - 0.5
        if cy < 0.0:
            cy = 0.0
        elif cy > sh - 1:
            cy = float(sh - 1)
        y0 = int(cy)
        y1 = y0 + 1 if y0 + 1 < sh else sh - 1
        wy = cy - y0
        r0 = y0 * sw
        r1 = y1 * sw
        o0 = out
        s0 = src
        for x0, x1, wx in xs:
            a = s0[r0 + x0]
            b = s0[r0 + x1]
            c = s0[r1 + x0]
            d = s0[r1 + x1]
            top = a + (b - a) * wx
            bot = c + (d - c) * wx
            o0[idx] = int(top + (bot - top) * wy)
            idx += 1
    return out


def apply_lut(field, lut, out=None) -> bytearray:
    """Map a uint16 field through a colour LUT into an RGB byte buffer."""
    out = bytearray(len(field) * 3) if out is None else out
    i = 0
    shift = LUT_SHIFT
    for v in field:
        r, g, b = lut[v >> shift]
        out[i] = r
        out[i + 1] = g
        out[i + 2] = b
        i += 3
    return out


def apply_lut_shaded(field, shade, lut, out=None) -> bytearray:
    """Map a field through a LUT, multiplying by a 0..1 (or brighter) shade."""
    out = bytearray(len(field) * 3) if out is None else out
    i = 0
    shift = LUT_SHIFT
    for k, v in enumerate(field):
        r, g, b = lut[v >> shift]
        f = shade[k]
        out[i] = 255 if r * f > 255 else int(r * f)
        out[i + 1] = 255 if g * f > 255 else int(g * f)
        out[i + 2] = 255 if b * f > 255 else int(b * f)
        i += 3
    return out


class ValueNoise:
    """Tileable value noise with smooth interpolation, plus fBm."""

    def __init__(self, seed: int, size: int = 256) -> None:
        rnd = random.Random(seed)
        self.size = size
        self.vals = [[rnd.random() for _ in range(size)] for _ in range(size)]

    def at(self, x: float, y: float) -> float:
        size = self.size
        x0 = math.floor(x)
        y0 = math.floor(y)
        fx = x - x0
        fy = y - y0
        ux = fx * fx * (3.0 - 2.0 * fx)
        uy = fy * fy * (3.0 - 2.0 * fy)
        xm0 = x0 % size
        ym0 = y0 % size
        xm1 = (xm0 + 1) % size
        ym1 = (ym0 + 1) % size
        row0 = self.vals[ym0]
        row1 = self.vals[ym1]
        a = row0[xm0]
        b = row0[xm1]
        c = row1[xm0]
        d = row1[xm1]
        top = a + (b - a) * ux
        bot = c + (d - c) * ux
        return top + (bot - top) * uy

    def fbm(self, x: float, y: float, octaves: int = 4, gain: float = 0.5, lac: float = 2.0) -> float:
        amp = 1.0
        freq = 1.0
        total = 0.0
        norm = 0.0
        for _ in range(octaves):
            total += amp * self.at(x * freq, y * freq)
            norm += amp
            amp *= gain
            freq *= lac
        return total / norm

    def ridge(self, x: float, y: float, octaves: int = 4) -> float:
        """Ridged fBm - good for mountain crests and topographic relief."""
        amp = 1.0
        freq = 1.0
        total = 0.0
        norm = 0.0
        for _ in range(octaves):
            n = 1.0 - abs(self.at(x * freq, y * freq) * 2.0 - 1.0)
            total += amp * n * n
            norm += amp
            amp *= 0.5
            freq *= 2.0
        return total / norm


# --------------------------------------------------------------------------- #
# Full-resolution painting helpers
# --------------------------------------------------------------------------- #


def pixel_add(buf: bytearray, i: int, r: float, g: float, b: float) -> None:
    v = buf[i] + r
    buf[i] = 255 if v > 255 else int(v)
    v = buf[i + 1] + g
    buf[i + 1] = 255 if v > 255 else int(v)
    v = buf[i + 2] + b
    buf[i + 2] = 255 if v > 255 else int(v)


def add_glow(buf: bytearray, w: int, h: int, cx: float, cy: float, radius: float,
             color, strength: float = 1.0, falloff: float = 2.2) -> None:
    """Additive radial glow. Cost is proportional to the glow's area."""
    x0 = max(0, int(cx - radius))
    x1 = min(w - 1, int(cx + radius))
    y0 = max(0, int(cy - radius))
    y1 = min(h - 1, int(cy + radius))
    r, g, b = color
    inv = 1.0 / radius
    for y in range(y0, y1 + 1):
        dy = (y + 0.5 - cy) * inv
        dy2 = dy * dy
        if dy2 >= 1.0:
            continue
        row = y * w
        for x in range(x0, x1 + 1):
            dx = (x + 0.5 - cx) * inv
            d2 = dx * dx + dy2
            if d2 >= 1.0:
                continue
            a = (1.0 - d2) ** falloff * strength
            if a <= 0.003:
                continue
            pixel_add(buf, (row + x) * 3, r * a, g * a, b * a)


def draw_disc(buf: bytearray, w: int, h: int, cx: float, cy: float, radius: float,
              color, soft: float = 0.0) -> None:
    """Draw a filled disc with an optional soft edge (0 = hard)."""
    x0 = max(0, int(cx - radius - 1))
    x1 = min(w - 1, int(cx + radius + 1))
    y0 = max(0, int(cy - radius - 1))
    y1 = min(h - 1, int(cy + radius + 1))
    r, g, b = color
    inner = radius * (1.0 - soft)
    for y in range(y0, y1 + 1):
        dy = y + 0.5 - cy
        row = y * w
        for x in range(x0, x1 + 1):
            dx = x + 0.5 - cx
            d = math.sqrt(dx * dx + dy * dy)
            if d > radius:
                continue
            a = 1.0 if d <= inner else 1.0 - (d - inner) / max(1e-6, radius - inner)
            i = (row + x) * 3
            buf[i] = int(buf[i] + (r - buf[i]) * a)
            buf[i + 1] = int(buf[i + 1] + (g - buf[i + 1]) * a)
            buf[i + 2] = int(buf[i + 2] + (b - buf[i + 2]) * a)


def vignette(buf: bytearray, w: int, h: int, strength: float = 0.35, power: float = 2.0) -> None:
    """Darken toward the corners; makes flat renders feel photographic.

    The default ``power=2`` avoids per-pixel ``sqrt/hypot`` calls entirely.
    """
    cx = w * 0.5
    cy = h * 0.5
    maxd2 = cx * cx + cy * cy
    inv = 1.0 / maxd2
    stride = w * 3
    dx2 = [((x + 0.5 - cx) ** 2) * inv for x in range(w)]
    soft_squared = abs(power - 2.0) < 1e-9
    half = power * 0.5
    for y in range(h):
        dy = y + 0.5 - cy
        dy2 = dy * dy * inv
        row = y * stride
        for x in range(w):
            d2 = dx2[x] + dy2
            f = 1.0 - strength * (d2 if soft_squared else d2 ** half)
            if f >= 0.999:
                continue
            i = row + x * 3
            buf[i] = int(buf[i] * f)
            buf[i + 1] = int(buf[i + 1] * f)
            buf[i + 2] = int(buf[i + 2] * f)


def light_vignette(buf: bytearray, w: int, h: int, strength: float = 0.25,
                   power: float = 2.5) -> None:
    """Additive centre-weighted light falloff (brightens the middle)."""
    cx = w * 0.5
    cy = h * 0.5
    maxd2 = cx * cx + cy * cy
    inv = 1.0 / maxd2
    stride = w * 3
    dx2 = [max(0.0, 1.0 - ((x + 0.5 - cx) ** 2) * inv) for x in range(w)]
    for y in range(h):
        dy = y + 0.5 - cy
        dy2 = ((dy * dy) * inv)
        row = y * stride
        for x in range(w):
            d2 = dx2[x] - dy2
            if d2 <= 0.0:
                continue
            a = strength * (d2 ** (power * 0.5))
            if a <= 0.004:
                continue
            i = row + x * 3
            v = buf[i] + 255.0 * a * 0.85
            buf[i] = 255 if v > 255 else int(v)
            v = buf[i + 1] + 255.0 * a * 0.90
            buf[i + 1] = 255 if v > 255 else int(v)
            v = buf[i + 2] + 255.0 * a
            buf[i + 2] = 255 if v > 255 else int(v)


def add_grain(buf: bytearray, w: int, h: int, amp: float, seed: int) -> None:
    """Cheap tiled luminance grain (keeps large gradients from looking sterile)."""
    rnd = random.Random(seed)
    tile = [rnd.uniform(-amp, amp) for _ in range(4096)]
    stride = w * 3
    for y in range(h):
        ty = (y & 63) << 6
        row = y * stride
        for x in range(w):
            n = tile[ty + (x & 63)]
            i = row + x * 3
            v = buf[i] + n
            buf[i] = 255 if v > 255 else (0 if v < 0 else int(v))
            v = buf[i + 1] + n
            buf[i + 1] = 255 if v > 255 else (0 if v < 0 else int(v))
            v = buf[i + 2] + n
            buf[i + 2] = 255 if v > 255 else (0 if v < 0 else int(v))


def sprinkle_stars(buf: bytearray, w: int, h: int, count: int, seed: int,
                   max_y: int | None = None) -> None:
    """Scatter small stars with a soft cross twinkle."""
    rnd = random.Random(seed)
    limit = h if max_y is None else max_y
    for _ in range(count):
        x = rnd.randrange(1, w - 1)
        y = rnd.randrange(1, limit)
        b = rnd.uniform(60.0, 235.0)
        t = rnd.choice((230, 232, 240, 250, 255, 220))
        tint = (t / 255.0, t / 255.0 * 0.97, 1.0)
        i = (y * w + x) * 3
        pixel_add(buf, i, b * tint[0], b * tint[1], b * tint[2])
        if rnd.random() < 0.22:
            fade = b * 0.34
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                j = ((y + dy) * w + (x + dx)) * 3
                if 0 <= j < len(buf) - 2:
                    pixel_add(buf, j, fade, fade, fade)


def hsv_to_rgb(h: float, s: float, v: float):
    """h in 0..360, s/v in 0..1."""
    h = h % 360.0
    c = v * s
    x = c * (1.0 - abs((h / 60.0) % 2.0 - 1.0))
    m = v - c
    if h < 60:
        rr, gg, bb = c, x, 0.0
    elif h < 120:
        rr, gg, bb = x, c, 0.0
    elif h < 180:
        rr, gg, bb = 0.0, c, x
    elif h < 240:
        rr, gg, bb = 0.0, x, c
    elif h < 300:
        rr, gg, bb = x, 0.0, c
    else:
        rr, gg, bb = c, 0.0, x
    return (
        int(round((rr + m) * 255.0)),
        int(round((gg + m) * 255.0)),
        int(round((bb + m) * 255.0)),
    )
# --------------------------------------------------------------------------- #
# Procedural photography
#
# Every image is composed from three ingredients: a smooth scalar *field* (computed
# on a coarse grid, then bilinearly upsampled), a perceptually smooth *colormap*,
# and full-resolution finishing passes (glow, rim light, grain, vignette). Crisp
# structures - checkerboard cells, wheel hue, contour strokes - are evaluated per
# pixel instead, because they must survive several 256-level bands.
# --------------------------------------------------------------------------- #

W, H = PHOTO_W, PHOTO_H
STRIDE = W * 3


def field_to_full(sw: int, sh: int, fn, w: int = W, h: int = H):
    """Sample ``fn`` on a coarse grid and upsample to full resolution."""
    return upsample16(build_field(sw, sh, fn), sw, sh, w, h)


def solid(buf: bytearray, w: int, h: int, lut, vertical: bool = True) -> None:
    """Fill the buffer with a (optionally vertical) LUT ramp."""
    if vertical:
        for y in range(h):
            r, g, b = lut[min(int(y / h * (LUT_N - 1)), LUT_N - 1)]
            buf[y * w * 3 : (y + 1) * w * 3] = bytes((r, g, b)) * w
    else:
        row = bytearray()
        for x in range(w):
            row.extend(lut[min(int(x / w * (LUT_N - 1)), LUT_N - 1)])
        for y in range(h):
            buf[y * w * 3 : (y + 1) * w * 3] = row


def rgb_bilinear(low: bytearray, sw: int, sh: int, dw: int, dh: int) -> bytearray:
    """Center-aligned bilinear upsample of a packed RGB buffer (channels unrolled)."""
    out = bytearray(dw * dh * 3)
    xs = []
    for x in range(dw):
        cx = (x + 0.5) * sw / dw - 0.5
        if cx < 0.0:
            cx = 0.0
        elif cx > sw - 1:
            cx = float(sw - 1)
        x0 = int(cx)
        x1 = x0 + 1 if x0 + 1 < sw else sw - 1
        xs.append((x0 * 3, x1 * 3, cx - x0))
    idx = 0
    for y in range(dh):
        cy = (y + 0.5) * sh / dh - 0.5
        if cy < 0.0:
            cy = 0.0
        elif cy > sh - 1:
            cy = float(sh - 1)
        y0 = int(cy)
        y1 = y0 + 1 if y0 + 1 < sh else sh - 1
        wy = cy - y0
        r0 = y0 * sw * 3
        r1 = y1 * sw * 3
        for x0, x1, wx in xs:
            i00 = r0 + x0
            i01 = r0 + x1
            i10 = r1 + x0
            i11 = r1 + x1
            for c in (0, 1, 2):
                a = low[i00 + c]
                b = low[i01 + c]
                c1 = low[i10 + c]
                d = low[i11 + c]
                top = a + (b - a) * wx
                bot = c1 + (d - c1) * wx
                out[idx + c] = int(top + (bot - top) * wy)
            idx += 3
    return out


def fill_where(buf: bytearray, mask, y: int, w: int, color) -> None:
    """Fill the x-runs of row ``y`` where ``mask[x] <= y`` (constant row colour)."""
    cbytes = bytes(color)
    x = 0
    base = y * w * 3
    while x < w:
        if mask[x] <= y:
            start = x
            x += 1
            while x < w and mask[x] <= y:
                x += 1
            i = base + start * 3
            buf[i : i + (x - start) * 3] = cbytes * (x - start)
        else:
            x += 1


# --------------------------------------------------------------------------- #
# 1. dunes - layered sand ridges at golden hour
# --------------------------------------------------------------------------- #


def render_dunes() -> bytearray:
    img = bytearray(W * H * 3)
    sky = make_lut_linear(
        [
            (0.00, (32, 30, 78)),
            (0.28, (92, 58, 116)),
            (0.50, (186, 90, 116)),
            (0.68, (238, 146, 104)),
            (0.84, (250, 196, 132)),
            (1.00, (253, 236, 200)),
        ]
    )
    solid(img, W, H, sky)

    sun_x, sun_y = W * 0.705, H * 0.415
    add_glow(img, W, H, sun_x, sun_y, 330.0, (255, 168, 96), 0.60, 2.6)
    add_glow(img, W, H, sun_x, sun_y, 120.0, (255, 214, 150), 0.75, 1.8)
    draw_disc(img, W, H, sun_x, sun_y, 46.0, (255, 248, 224), 0.35)

    noise = ValueNoise(1101)
    # Far ridge -> near ridge; each layer paints from its crest down to the bottom.
    layers = [
        # (base_y, amp, freq, phase, top_rgb, bottom_rgb)
        (0.470, 26.0, 0.0021, 0.0, (154, 118, 118), (128, 96, 104)),
        (0.540, 34.0, 0.0017, 1.9, (176, 126, 112), (138, 96, 100)),
        (0.630, 44.0, 0.0013, 3.4, (196, 138, 112), (146, 96, 94)),
        (0.740, 52.0, 0.0011, 5.2, (186, 122, 100), (120, 76, 82)),
        (0.865, 60.0, 0.0009, 7.4, (150, 96, 84), (74, 48, 58)),
    ]
    for base, amp, freq, phase, top, bottom in layers:
        crest = []
        base_y = base * H
        for x in range(W):
            wobble = noise.fbm(x * freq, phase * 3.0, 3) - 0.5
            wave = math.sin(x * freq * 2.4 + phase) * 0.6 + math.sin(x * freq * 5.1 + phase * 1.7) * 0.25
            crest.append(int(base_y + (wave + wobble * 1.6) * amp))
        crest_min = min(crest)
        span = max(1.0, H - crest_min)
        for y in range(max(0, crest_min), H):
            t = (y - crest_min) / span
            ridge_light = smoothstep(min(1.0, max(0.0, (y - crest_min) / 34.0)))
            col = tuple(
                int(lerp(top[i], bottom[i], t) * (0.82 + 0.30 * ridge_light)) for i in range(3)
            )
            # Sun-facing rim: lift the crest pixels nearest the sun's side.
            col = (
                min(255, col[0] + int(16 * ridge_light)),
                min(255, col[1] + int(12 * ridge_light)),
                min(255, col[2] + int(6 * ridge_light)),
            )
            fill_where(img, crest, y, W, col)

    vignette(img, W, H, 0.30, 2.0)
    add_grain(img, W, H, 3.2, 1101)
    return img


# --------------------------------------------------------------------------- #
# 2. aurora - aurora curtains over a ridge line
# --------------------------------------------------------------------------- #


def render_aurora() -> bytearray:
    img = bytearray(W * H * 3)
    noise = ValueNoise(2202)

    def curtain(x: float, y: float) -> float:
        u = x / 300.0
        v = y / 200.0
        base = noise.fbm(u * 2.6, v * 0.68, 5)
        streak = noise.fbm(u * 13.0 + 21.0, v * 0.34, 3)
        body = max(0.0, base - 0.38) * 2.7 + max(0.0, streak - 0.54) * 1.05
        fade = math.exp(-(((v - 0.36) / 0.31) ** 2))
        return body * fade

    field = field_to_full(300, 200, curtain)
    sky = make_lut_linear(
        [(0.0, (4, 6, 20)), (0.42, (8, 14, 38)), (0.72, (12, 22, 54)), (1.0, (17, 32, 68))]
    )
    aer = make_lut(
        [
            (0.00, (0, 0, 0)),
            (0.14, (8, 44, 62)),
            (0.32, (26, 150, 128)),
            (0.50, (58, 224, 178)),
            (0.70, (124, 238, 206)),
            (0.88, (150, 156, 255)),
            (1.00, (226, 208, 255)),
        ]
    )
    row_colors = [sky[min(int(y / H * (LUT_N - 1)), LUT_N - 1)] for y in range(H)]
    for y in range(H):
        sr, sg, sb = row_colors[y]
        row = y * STRIDE
        base = y * W
        for x in range(W):
            r, g, b = aer[field[base + x] >> LUT_SHIFT]
            i = row + x * 3
            v = sr + r * 0.92
            img[i] = 255 if v > 255 else int(v)
            v = sg + g * 0.92
            img[i + 1] = 255 if v > 255 else int(v)
            v = sb + b * 0.92
            img[i + 2] = 255 if v > 255 else int(v)

    sprinkle_stars(img, W, H, 460, 2211, max_y=int(H * 0.86))

    # Silhouetted ridge line grounds the composition.
    ridge_noise = ValueNoise(2213)
    crest = []
    for x in range(W):
        t = x / W
        hgt = (
            0.10 * math.sin(t * 5.4 + 0.7)
            + 0.05 * math.sin(t * 11.0 + 2.1)
            + 0.06 * (ridge_noise.fbm(x * 0.0035, 5.0, 3) - 0.5) * 2.0
        )
        crest.append(int(H * (0.845 + hgt)))
    for y in range(min(crest), H):
        depth = (y - min(crest)) / max(1.0, H - min(crest))
        col = (
            int(lerp(14, 5, depth)),
            int(lerp(18, 7, depth)),
            int(lerp(30, 14, depth)),
        )
        fill_where(img, crest, y, W, col)

    vignette(img, W, H, 0.34, 2.0)
    add_grain(img, W, H, 2.6, 2202)
    return img


# --------------------------------------------------------------------------- #
# 3. basalt - columnar basalt with mist and rim light
# --------------------------------------------------------------------------- #


def render_basalt() -> bytearray:
    img = bytearray(W * H * 3)
    mist = make_lut_linear(
        [(0.0, (126, 138, 156)), (0.45, (96, 108, 128)), (1.0, (58, 66, 82))]
    )
    solid(img, W, H, mist)

    noise = ValueNoise(3303)
    tex = field_to_full(240, 160, lambda x, y: 0.5 + (noise.fbm(x * 0.10, y * 0.10, 4) - 0.5) * 1.15)

    rnd = random.Random(3311)
    columns = []
    x = -40
    while x < W + 40:
        width = rnd.randint(54, 132)
        columns.append(
            {
                "x0": float(x),
                "x1": float(x + width),
                "top": rnd.uniform(0.16, 0.40) * H,
                "warp": rnd.uniform(-8.0, 8.0),
                "tone": rnd.uniform(0.78, 1.18),
            }
        )
        x += width + rnd.randint(-6, 10)

    for col in columns:
        cx0, cx1 = col["x0"], col["x1"]
        top, tone, warp = col["top"], col["tone"], col["warp"]
        for y in range(int(top), H):
            # Columns flare very slightly toward the base (perspective).
            flare = 1.0 + (y - top) / H * 0.16
            c0 = cx0 - (flare - 1.0) * 60.0
            c1 = cx1 + (flare - 1.0) * 60.0
            shape = 0.5 + 0.5 * math.sin((y - top) * 0.011 + warp)
            xa = int(max(0, c0))
            xb = int(min(W, c1))
            if xb <= xa:
                continue
            row = y * STRIDE
            width = c1 - c0
            depth = (y - top) / max(1.0, H - top)
            for x in range(xa, xb):
                fx = (x - c0) / width
                # Lit from the left, deep shadow in the fissures between columns.
                light = 1.16 - 1.05 * fx
                edge = min(fx, 1.0 - fx)
                fissure = smoothstep(edge / 0.14) * 0.55 + 0.45
                v = (0.34 + 0.62 * depth) * light * fissure * tone
                grain = (tex[y * W + x] - 32768) / 32768.0
                v *= 1.0 + grain * 0.22 + shape * 0.05
                r = 168 * v
                g = 176 * v
                b = 196 * v
                i = row + x * 3
                img[i] = 255 if r > 255 else (0 if r < 0 else int(r))
                img[i + 1] = 255 if g > 255 else (0 if g < 0 else int(g))
                img[i + 2] = 255 if b > 255 else (0 if b < 0 else int(b))

    # Fog creeping up from the base and a cool rim along the horizon.
    for y in range(H):
        t = y / H
        fog = 0.0
        if t > 0.55:
            fog = smoothstep((t - 0.55) / 0.45) * 0.55
        if t < 0.26:
            fog = max(fog, smoothstep((0.26 - t) / 0.26) * 0.42)
        if fog <= 0.002:
            continue
        row = y * STRIDE
        for x in range(W):
            i = row + x * 3
            img[i] = int(img[i] + (206 - img[i]) * fog)
            img[i + 1] = int(img[i + 1] + (214 - img[i + 1]) * fog)
            img[i + 2] = int(img[i + 2] + (226 - img[i + 2]) * fog)

    vignette(img, W, H, 0.40, 2.0)
    add_grain(img, W, H, 3.0, 3303)
    return img


# --------------------------------------------------------------------------- #
# 4. spectrum-wheel - saturated hue disc on a dark studio backdrop
# --------------------------------------------------------------------------- #


def render_colorwheel() -> bytearray:
    img = bytearray(W * H * 3)
    backdrop = make_lut_linear([(0.0, (12, 12, 18)), (1.0, (24, 22, 34))])
    solid(img, W, H, backdrop)

    cx, cy = W * 0.5, H * 0.5
    add_glow(img, W, H, cx, cy, 430.0, (74, 62, 118), 0.55, 2.4)

    radius = 322.0
    # Precompute a pure-hue ring; saturation/value are applied per pixel.
    hue_ring = [hsv_to_rgb(x / 4096.0 * 360.0, 1.0, 1.0) for x in range(4096)]
    inv_r = 1.0 / radius
    for y in range(H):
        dy = y + 0.5 - cy
        dy2 = dy * dy
        row = y * STRIDE
        for x in range(W):
            dx = x + 0.5 - cx
            d2 = dx * dx + dy2
            if d2 > radius * radius:
                continue
            d = math.sqrt(d2)
            u = d * inv_r
            ang = math.atan2(dy, dx)
            if ang < 0.0:
                ang += math.tau
            hr, hg, hb = hue_ring[int(ang / math.tau * 4095.0)]
            sat = 0.18 + 0.82 * smoothstep(u / 0.62)
            val = 1.0 - 0.22 * (u ** 2.4)
            k = sat * val
            r = hr * k
            g = hg * k
            b = hb * k
            # Desaturated white core (a saturated disc with a dark middle reads
            # like a hole punched in the image).
            if u < 0.34:
                wk = (1.0 - smoothstep(u / 0.34)) ** 1.4
                r += (252.0 - r) * wk * 0.92
                g += (252.0 - g) * wk * 0.92
                b += (254.0 - b) * wk * 0.96
            i = row + x * 3
            img[i] = 255 if r > 255 else int(r)
            img[i + 1] = 255 if g > 255 else int(g)
            img[i + 2] = 255 if b > 255 else int(b)

    # Thin bright rim just outside the disc.
    for y in range(H):
        dy = y + 0.5 - cy
        row = y * STRIDE
        for x in range(W):
            dx = x + 0.5 - cx
            d = math.sqrt(dx * dx + dy * dy)
            if radius <= d <= radius + 12.0:
                a = (1.0 - abs(d - radius - 5.0) / 7.0) * 0.55
                if a > 0:
                    i = row + x * 3
                    img[i] = int(img[i] + (236 - img[i]) * a)
                    img[i + 1] = int(img[i + 1] + (238 - img[i + 1]) * a)
                    img[i + 2] = int(img[i + 2] + (255 - img[i + 2]) * a)
    vignette(img, W, H, 0.42, 2.0)
    return img


# --------------------------------------------------------------------------- #
# 5. checkerboard - warped duotone checker
# --------------------------------------------------------------------------- #


def render_checkerboard() -> bytearray:
    img = bytearray(W * H * 3)
    cell = 48.0
    noise = ValueNoise(5505)
    light_col = (242, 236, 222)
    dark_col = (16, 58, 70)
    lr, lg, lb = light_col
    dr, dg, db = dark_col
    for y in range(H):
        wy = y * 0.0075
        row = y * STRIDE
        for x in range(W):
            wx = x * 0.0062
            warp_x = math.sin(wy * 1.7 + 0.6) * 26.0 + (noise.at(wx * 1.4, wy * 1.4) - 0.5) * 34.0
            warp_y = math.cos(wx * 1.9 + 1.1) * 22.0 + (noise.at(wx * 1.1 + 7.0, wy * 1.2) - 0.5) * 30.0
            u = (x + warp_x) / cell
            v = (y + warp_y) / cell
            on = (math.floor(u) + math.floor(v)) % 2.0
            # Soft top-left key light plus a gentle vertical falloff.
            shade = 0.86 + 0.20 * (1.0 - y / H) + 0.06 * (1.0 - x / W)
            if on:
                r, g, b = lr * shade, lg * shade, lb * shade
            else:
                r, g, b = dr * shade, dg * shade, db * shade
            # A slim highlight in the seams reads as embossing.
            seam = min(abs(u - math.floor(u) - 0.0), abs(v - math.floor(v) - 0.0))
            if seam < 0.035:
                k = 1.0 - seam / 0.035
                r += 26.0 * k
                g += 30.0 * k
                b += 34.0 * k
            i = row + x * 3
            img[i] = 255 if r > 255 else int(r)
            img[i + 1] = 255 if g > 255 else int(g)
            img[i + 2] = 255 if b > 255 else int(b)
    vignette(img, W, H, 0.34, 2.0)
    return img


# --------------------------------------------------------------------------- #
# 6. noisefield - shaded relief terrain
# --------------------------------------------------------------------------- #


def render_noisefield() -> bytearray:
    noise = ValueNoise(6606)
    sw, sh = 360, 240

    def elevation(x: float, y: float) -> float:
        e = 0.58 * noise.ridge(x * 0.0072 + 3.0, y * 0.0072 + 1.0, 6)
        e += 0.42 * noise.fbm(x * 0.0125 + 40.0, y * 0.0125 + 60.0, 5)
        return clamp01(e * 1.10 - 0.05)

    ele = build_field(sw, sh, elevation)
    # Histogram stretch: fBm output clusters near the mean, which would waste
    # most of the palette. Normalise against the 3rd/97th percentiles so the
    # full range (deep water -> bright peaks) is actually used.
    ordered = sorted(ele)
    lo = ordered[int(len(ordered) * 0.11)] / 65535.0
    hi = ordered[int(len(ordered) * 0.93)] / 65535.0
    span = max(1e-6, hi - lo)
    norm = array.array("H", bytes(sw * sh * 2))
    for i, v in enumerate(ele):
        t = clamp01((v / 65535.0 - lo) / span)
        # Half-strength S-curve: opens up the midtones without clipping peaks.
        norm[i] = int(lerp(t, smoothstep(t), 0.55) * 65535.0)

    def shade(x: int, y: int) -> float:
        xm = max(0, x - 1)
        xp = min(sw - 1, x + 1)
        ym = max(0, y - 1)
        yp = min(sh - 1, y + 1)
        dx = (norm[y * sw + xp] - norm[y * sw + xm]) / 65535.0
        dy = (norm[yp * sw + x] - norm[ym * sw + x]) / 65535.0
        # Light from the north-west, elevated ~45 degrees.
        return clamp(0.80 + (-dx * 1.7 - dy * 1.35) * 2.4, 0.55, 1.34)

    shade_coarse = build_field(sw, sh, lambda x, y: shade(x, y) / 1.6)  # /1.6 keeps 0..1

    full = upsample16(norm, sw, sh, W, H)
    shade_full = upsample16(shade_coarse, sw, sh, W, H)
    lut = make_lut(
        [
            (0.00, (6, 20, 46)),
            (0.16, (11, 52, 92)),
            (0.32, (18, 104, 124)),
            (0.46, (34, 146, 120)),
            (0.60, (86, 172, 108)),
            (0.72, (156, 186, 104)),
            (0.82, (214, 196, 132)),
            (0.91, (240, 232, 206)),
            (1.00, (255, 255, 255)),
        ]
    )
    img = apply_lut_shaded(full, [v / 65535.0 * 1.6 for v in shade_full], lut)
    vignette(img, W, H, 0.26, 2.0)
    add_grain(img, W, H, 2.4, 6606)
    return img


# --------------------------------------------------------------------------- #
# 7. radialblobs - soft metaball gradient study
# --------------------------------------------------------------------------- #


def render_radialblobs() -> bytearray:
    sw, sh = 300, 200
    blobs = [
        (0.20, 0.32, 0.30, 1.00),
        (0.46, 0.24, 0.24, 0.85),
        (0.72, 0.34, 0.28, 0.95),
        (0.34, 0.60, 0.26, 0.80),
        (0.62, 0.66, 0.32, 1.10),
        (0.86, 0.62, 0.20, 0.70),
        (0.10, 0.72, 0.22, 0.65),
        (0.52, 0.86, 0.30, 0.60),
        (0.92, 0.12, 0.18, 0.55),
    ]

    def field(x: float, y: float) -> float:
        u = x / sw
        v = y / sh
        total = 0.0
        for bx, by, br, weight in blobs:
            dx = (u - bx) * 1.5
            dy = v - by
            d2 = (dx * dx + dy * dy) / (br * br)
            if d2 < 9.0:
                total += weight * math.exp(-d2 * 2.1)
        return clamp01(total * 0.62)

    full = field_to_full(sw, sh, field)
    lut = make_lut(
        [
            (0.00, (22, 8, 38)),
            (0.18, (66, 18, 84)),
            (0.36, (128, 34, 122)),
            (0.54, (206, 62, 118)),
            (0.70, (243, 108, 96)),
            (0.84, (252, 168, 118)),
            (1.00, (255, 240, 222)),
        ]
    )
    img = apply_lut(full, lut)
    light_vignette(img, W, H, 0.20, 2.4)
    vignette(img, W, H, 0.22, 2.0)
    add_grain(img, W, H, 2.8, 7707)
    return img


# --------------------------------------------------------------------------- #
# 8. gridmesh - modern mesh gradient
# --------------------------------------------------------------------------- #


def render_gridmesh() -> bytearray:
    sw, sh = 200, 134
    low = bytearray(sw * sh * 3)
    lattice = [
        [(86, 92, 232), (124, 96, 232), (62, 148, 226)],
        [(196, 84, 176), (176, 104, 214), (96, 172, 232)],
        [(232, 128, 108), (238, 172, 104), (86, 206, 178)],
    ]
    highlights = [
        (0.30, 0.28, 0.42, (255, 236, 210), 0.55),
        (0.78, 0.72, 0.40, (120, 246, 236), 0.42),
        (0.58, 0.18, 0.34, (255, 168, 208), 0.34),
        (0.16, 0.84, 0.36, (150, 132, 255), 0.36),
    ]
    for y in range(sh):
        v = y / (sh - 1)
        row = y * sw * 3
        for x in range(sw):
            u = x / (sw - 1)
            # Smooth weights across the 3x3 lattice.
            wu = [smoothstep(1.0 - abs(u - c) / 0.62) for c in (0.0, 0.5, 1.0)]
            wv = [smoothstep(1.0 - abs(v - c) / 0.62) for c in (0.0, 0.5, 1.0)]
            wsum = sum(wu) * sum(wv)
            r = g = b = 0.0
            if wsum > 1e-9:
                for j in range(3):
                    for i in range(3):
                        w = wu[i] * wv[j] / wsum
                        cr, cg, cb = lattice[j][i]
                        r += cr * w
                        g += cg * w
                        b += cb * w
            base = (0.62 + 0.38 * (1.0 - v)) * 1.0
            r *= base
            g *= base
            b *= base * 1.03
            for hx, hy, hr, hcol, hs in highlights:
                dx = (u - hx) * 1.5
                dy = v - hy
                d2 = (dx * dx + dy * dy) / (hr * hr)
                if d2 < 9.0:
                    a = math.exp(-d2 * 1.9) * hs
                    r += hcol[0] * a * 0.55
                    g += hcol[1] * a * 0.55
                    b += hcol[2] * a * 0.55
            i = row + x * 3
            low[i] = 255 if r > 255 else (0 if r < 0 else int(r))
            low[i + 1] = 255 if g > 255 else (0 if g < 0 else int(g))
            low[i + 2] = 255 if b > 255 else (0 if b < 0 else int(b))

    img = rgb_bilinear(low, sw, sh, W, H)
    add_glow(img, W, H, W * 0.30, H * 0.28, 300.0, (255, 232, 206), 0.16, 2.6)
    add_glow(img, W, H, W * 0.80, H * 0.74, 300.0, (110, 240, 232), 0.14, 2.6)
    vignette(img, W, H, 0.20, 2.0)
    add_grain(img, W, H, 2.0, 8808)
    return img


# --------------------------------------------------------------------------- #
# 9. topo - contour map with graticule
# --------------------------------------------------------------------------- #


def render_topo() -> bytearray:
    sw, sh = 320, 214
    noise = ValueNoise(9909)

    def elevation(x: float, y: float) -> float:
        e = noise.fbm(x * 0.016 + 5.0, y * 0.016 + 9.0, 5)
        e += 0.35 * noise.ridge(x * 0.030, y * 0.030, 4)
        e += 0.16 * math.sin(x * 0.045) * math.cos(y * 0.038)
        return clamp01(e * 0.92)

    ele = build_field(sw, sh, elevation)
    ordered = sorted(ele)
    lo = ordered[int(len(ordered) * 0.04)] / 65535.0
    hi = ordered[int(len(ordered) * 0.96)] / 65535.0
    span = max(1e-6, hi - lo)
    norm = array.array("H", bytes(sw * sh * 2))
    for i, v in enumerate(ele):
        norm[i] = int(clamp01((v / 65535.0 - lo) / span) * 65535.0)

    full = upsample16(norm, sw, sh, W, H)
    band_cols = [
        (214, 220, 200),
        (232, 228, 202),
        (222, 222, 190),
        (236, 226, 192),
        (206, 216, 178),
        (222, 224, 180),
        (188, 208, 166),
        (206, 214, 170),
        (170, 196, 152),
        (192, 202, 158),
        (156, 184, 144),
        (214, 206, 172),
        (160, 176, 140),
        (232, 226, 200),
    ]
    n_bands = len(band_cols)
    water_t = 0.15
    water_v = water_t * 65535.0
    inv_bands = n_bands / (65535.0 * (1.0 - water_t))
    img = bytearray(W * H * 3)
    for y in range(H):
        row = y * STRIDE
        down = (y + 1) * W if y < H - 1 else (H - 1) * W
        for x in range(W):
            v = full[y * W + x]
            if v < water_v:
                # Bathymetric ramp so shorelines read as coastline.
                depth = v / water_v
                r = int(lerp(104, 178, depth))
                g = int(lerp(156, 206, depth))
                b = int(lerp(190, 216, depth))
                band = -1
            else:
                band = int((v - water_v) * inv_bands)
                if band >= n_bands:
                    band = n_bands - 1
                r, g, b = band_cols[band]
            vx = full[y * W + (x + 1 if x < W - 1 else x)]
            vy = full[down + x]
            nbx = -1 if vx < water_v else int((vx - water_v) * inv_bands)
            nby = -1 if vy < water_v else int((vy - water_v) * inv_bands)
            if nbx != band or nby != band:
                k = 0.30 if band < 0 else 0.46
                r = int(r * k)
                g = int(g * k)
                b = int(b * k)
            if x % 100 == 0 or y % 100 == 0:
                r = min(255, r + 10)
                g = min(255, g + 10)
                b = min(255, b + 8)
            i = row + x * 3
            img[i] = r
            img[i + 1] = g
            img[i + 2] = b
    vignette(img, W, H, 0.20, 2.0)
    add_grain(img, W, H, 2.0, 9909)
    return img


# --------------------------------------------------------------------------- #
# 10. sunset - sun over water with layered clouds
# --------------------------------------------------------------------------- #


def render_sunset() -> bytearray:
    sw, sh = 300, 200
    noise = ValueNoise(10101)
    horizon = H * 0.66

    def sky_field(x: float, y: float) -> float:
        u = x / sw
        v = y / sh
        cloud = noise.fbm(u * 4.2 + 12.0, v * 9.0 + 3.0, 5) - 0.5
        band = noise.fbm(u * 1.6 + 60.0, v * 22.0, 4) - 0.5
        t = v / 0.66
        # Clouds sit in horizontal tiers and thicken toward the horizon.
        tier = 0.5 + 0.5 * math.sin(v * 26.0)
        texture = (cloud * 0.62 + band * 0.38) * (0.35 + 0.65 * smoothstep(t))
        return clamp01(t * 0.94 + texture * 0.34 * tier * min(1.0, t * 2.2))

    field = field_to_full(sw, sh, sky_field)
    sky = make_lut_linear(
        [
            (0.00, (30, 26, 68)),
            (0.22, (86, 44, 108)),
            (0.40, (162, 66, 110)),
            (0.55, (226, 96, 92)),
            (0.70, (246, 140, 88)),
            (0.82, (252, 186, 106)),
            (0.92, (253, 216, 140)),
            (1.00, (255, 240, 186)),
        ]
    )
    img = bytearray(W * H * 3)
    # Sky only: the water band is painted afterwards.
    row_colors = [sky[min(int(y / H * (LUT_N - 1)), LUT_N - 1)] for y in range(H)]
    gap = 0.055

    def cloud_tint(r, g, b, amount):
        """Cool the bright cloud tops so they read as separate from the sky."""
        return (
            int(r * (1.0 - 0.30 * amount) + 96 * 0.30 * amount),
            int(g * (1.0 - 0.34 * amount) + 74 * 0.34 * amount),
            int(b * (1.0 - 0.22 * amount) + 128 * 0.22 * amount),
        )

    for y in range(H):
        if y > horizon:
            break
        row = y * STRIDE
        base = y * W
        for x in range(W):
            v = field[base + x]
            r, g, b = sky[v >> LUT_SHIFT]
            edge = 1.0 - smoothstep(abs(y - int(horizon)) / (horizon * 0.85))
            r, g, b = cloud_tint(r, g, b, edge * 0.4)
            i = row + x * 3
            img[i] = r
            img[i + 1] = g
            img[i + 2] = b

    sun_x, sun_y = W * 0.52, H * 0.615
    add_glow(img, W, H, sun_x, sun_y, 520.0, (255, 150, 70), 0.42, 2.4)
    add_glow(img, W, H, sun_x, sun_y, 210.0, (255, 196, 120), 0.60, 1.9)
    draw_disc(img, W, H, sun_x, sun_y, 54.0, (255, 246, 214), 0.22)

    # Water: dark band, mirror column under the sun, ripple streaks.
    ripples = ValueNoise(10107)
    water_top = make_lut_linear([(0.0, (120, 62, 66)), (0.35, (56, 40, 62)), (1.0, (14, 14, 30))])
    for y in range(int(horizon), H):
        depth = (y - horizon) / max(1.0, H - horizon)
        wr, wg, wb = water_top[min(int(depth * (LUT_N - 1)), LUT_N - 1)]
        row = y * STRIDE
        for x in range(W):
            dx = (x + 0.5 - sun_x) / 96.0
            decay = math.exp(-(depth * 3.4))
            column = math.exp(-(dx * dx)) * decay
            ra = ripples.fbm(x * 0.012, y * 0.055 + 20.0, 3)
            streak = 0.5 + 0.5 * math.sin(y * 0.42 + ra * 14.0)
            s = column * (0.35 + 0.85 * streak)
            r = wr + 236 * s * 0.75
            g = wg + 156 * s * 0.62
            b = wb + 96 * s * 0.42
            # Ripple highlights away from the sun column.
            sparkle = (ra - 0.55)
            if sparkle > 0:
                k = sparkle * 1.5 * (1.0 - depth * 0.7)
                r += 120 * k
                g += 96 * k
                b += 80 * k
            i = row + x * 3
            img[i] = 255 if r > 255 else (0 if r < 0 else int(r))
            img[i + 1] = 255 if g > 255 else (0 if g < 0 else int(g))
            img[i + 2] = 255 if b > 255 else (0 if b < 0 else int(b))

    # Haze band right on the horizon line.
    y0 = int(horizon - 6)
    for y in range(y0, min(H, y0 + 8)):
        k = 1.0 - abs(y - horizon) / 4.0
        if k <= 0:
            continue
        row = y * STRIDE
        for x in range(W):
            i = row + x * 3
            img[i] = int(img[i] + (255 - img[i]) * 0.16 * k)
            img[i + 1] = int(img[i + 1] + (232 - img[i + 1]) * 0.14 * k)
            img[i + 2] = int(img[i + 2] + (196 - img[i + 2]) * 0.12 * k)

    vignette(img, W, H, 0.30, 2.0)
    add_grain(img, W, H, 2.6, 10101)
    return img


# --------------------------------------------------------------------------- #
# 11. caustics - interference web under water
# --------------------------------------------------------------------------- #


def render_caustics() -> bytearray:
    cw, ch = 600, 400
    sources = [
        (0.08, 0.10, 3.1, 0.0),
        (0.82, 0.16, 3.6, 1.1),
        (0.46, 0.44, 2.6, 2.2),
        (0.12, 0.78, 3.9, 3.3),
        (0.92, 0.86, 2.9, 4.4),
        (0.60, 0.96, 4.2, 0.7),
        (0.30, 0.22, 5.1, 1.9),
    ]
    small = array.array("H", bytes(cw * ch * 2))
    k = 0
    for y in range(ch):
        v = y / ch
        for x in range(cw):
            u = x / cw
            acc = 0.0
            for sx, sy, freq, phase in sources:
                dx = (u - sx) * 1.5
                dy = v - sy
                d = math.sqrt(dx * dx + dy * dy)
                acc += math.sin(d * freq * 9.0 - phase)
            n = acc / len(sources)
            lit = 0.5 + 0.5 * n
            small[k] = int(clamp01(lit ** 3.6 * 1.55 - 0.09) * 65535.0)
            k += 1

    full = upsample16(small, cw, ch, W, H)
    lut = make_lut(
        [
            (0.00, (3, 20, 40)),
            (0.22, (6, 44, 72)),
            (0.44, (10, 86, 116)),
            (0.62, (26, 150, 168)),
            (0.78, (96, 214, 216)),
            (0.90, (176, 244, 238)),
            (1.00, (240, 255, 252)),
        ]
    )
    img = apply_lut(full, lut)
    light_vignette(img, W, H, 0.22, 2.2)
    vignette(img, W, H, 0.30, 2.0)
    add_grain(img, W, H, 2.2, 11111)
    return img


# --------------------------------------------------------------------------- #
# 12. spectrum - horizontal wavelength with a signal ridge
# --------------------------------------------------------------------------- #


def render_spectrum() -> bytearray:
    img = bytearray(W * H * 3)
    ramp = make_lut_linear(
        [
            (0.00, (28, 24, 88)),
            (0.14, (72, 38, 154)),
            (0.28, (162, 48, 152)),
            (0.42, (226, 76, 108)),
            (0.56, (246, 132, 82)),
            (0.70, (250, 196, 96)),
            (0.82, (186, 226, 120)),
            (0.92, (86, 216, 190)),
            (1.00, (60, 176, 232)),
        ]
    )
    col_colors = [ramp[min(int(x / W * (LUT_N - 1)), LUT_N - 1)] for x in range(W)]
    # Symmetric amplitude envelope: the lit band is the "signal", the rest of the
    # frame stays dim so the waveform silhouette reads clearly.
    env = []
    for x in range(W):
        t = x / W
        amp = (
            0.30
            + 0.09 * math.sin(t * 6.1 + 0.4)
            + 0.06 * math.sin(t * 13.7 + 2.0)
            + 0.04 * math.sin(t * 27.3 + 4.1)
            + 0.03 * math.sin(t * 48.9 + 1.2)
        )
        env.append(max(0.13, min(0.46, amp)) * H)
    cy = H * 0.5
    for y in range(H):
        dy = abs(y + 0.5 - cy)
        row = y * STRIDE
        for x in range(W):
            r, g, b = col_colors[x]
            e = env[x]
            if dy <= e:
                # Inside the band: bright, with a vertical falloff from the axis.
                k = 0.46 + 0.58 * (1.0 - dy / e) ** 0.85
            else:
                k = 0.30 + 0.17 * (1.0 - min(1.0, (dy - e) / cy))
            # Bright edges on both sides of the band make the signal read.
            if abs(dy - e) < 4.0:
                k = min(1.0, k + 0.40 * (1.0 - abs(dy - e) / 4.0))
            i = row + x * 3
            r *= k
            g *= k
            b *= k
            img[i] = 255 if r > 255 else int(r)
            img[i + 1] = 255 if g > 255 else int(g)
            img[i + 2] = 255 if b > 255 else int(b)

    # Faint horizontal scanlines give it a display-like feel.
    for y in range(0, H, 4):
        row = y * STRIDE
        for x in range(W):
            i = row + x * 3
            img[i] = int(img[i] * 0.90)
            img[i + 1] = int(img[i + 1] * 0.90)
            img[i + 2] = int(img[i + 2] * 0.90)
    vignette(img, W, H, 0.28, 2.0)
    return img


PHOTOS = [
    ("dunes.png", render_dunes, "Layered sand ridges at golden hour"),
    ("aurora.png", render_aurora, "Aurora curtains and stars over a ridge"),
    ("basalt.png", render_basalt, "Columnar basalt with mist and rim light"),
    ("colorwheel.png", render_colorwheel, "Saturated hue wheel on dark backdrop"),
    ("checkerboard.png", render_checkerboard, "Warped duotone checkerboard"),
    ("noisefield.png", render_noisefield, "Shaded-relief fBm terrain"),
    ("radialblobs.png", render_radialblobs, "Soft metaball gradient study"),
    ("gridmesh.png", render_gridmesh, "Mesh gradient with light blooms"),
    ("topo.png", render_topo, "Contour map with graticule"),
    ("sunset.png", render_sunset, "Sunset over water with cloud tiers"),
    ("caustics.png", render_caustics, "Caustic interference web"),
    ("spectrum.png", render_spectrum, "Wavelength ramp with signal ridge"),
]
# --------------------------------------------------------------------------- #
# Prose engine
#
# Notes have to read like something a team actually wrote, at every size from a
# 240-byte scratch file to a 20 KB research write-up. Sentences come from
# per-topic pools that are consumed as an infinite, reshuffling stream, so a
# long document never repeats a line back to back, and slot filling keeps the
# nouns specific to this (fictional) file manager.
# --------------------------------------------------------------------------- #

SLOTS = {
    "component": [
        "the listing view", "the thumbnail pipeline", "the virtual scroller", "the preview pane",
        "the search index", "the file watcher", "the upload queue", "the plugin host",
        "the share dialog", "the sidebar", "the breadcrumb bar", "the command palette",
        "the trash view", "the zip browser",
    ],
    "metric": [
        "p95 latency", "first paint", "scroll jank", "memory high-water mark", "index build time",
        "cold start", "thumbnail throughput", "search recall", "bundle size", "cache hit rate",
        "time to first row", "directory read cost",
    ],
    "name": [
        "Priya", "Marcus", "Lena", "Tomás", "Ada", "Jordan", "Wei", "Sam", "Noor", "Iris",
        "Dmitri", "Hana",
    ],
}

SLOT_RE = re.compile(r"\{(\w+)\}")


def fill_slots(text: str, rng: random.Random) -> str:
    def sub(m):
        vals = SLOTS.get(m.group(1))
        return rng.choice(vals) if vals else m.group(0)

    return SLOT_RE.sub(sub, text)


SENTENCES = {
    "design": [
        "The goal of this pass was to make {component} feel immediate even when the underlying fetch is slow.",
        "We agreed that optimistic rendering is only acceptable where the operation is trivially reversible.",
        "Placeholders should mirror the shape of the content they replace, never a generic grey block.",
        "Every interaction needs a state for empty, loading, partial, error, and stale.",
        "Density matters more than decoration in a file manager, because people scan dozens of rows at a time.",
        "We settled on a 4px spacing scale with a 32px baseline row height.",
        "Focus rings must survive forced-colors mode, which rules out box-shadow-only outlines.",
        "The row hover overlay sits at 8% so that selection at 16% still reads as the stronger state.",
        "Middle truncation beats trailing truncation for filenames, which almost always share a prefix.",
        "People recognise file types by colour faster than by label, so the icon tint carries the type.",
        "The size column is right-aligned and tabular; proportional digits make a column unscannable.",
        "Sorting must be deterministic, and a background refresh must never reorder rows under the cursor.",
        "Keyboard-first means every pointer action is also reachable from the command palette.",
        "Motion is capped at 160ms for state changes and skipped entirely for scrolling.",
        "The dark theme needs its own contrast pass, because inverting light tokens fails on borders.",
        "Destructive actions get a two-step confirm only when they bypass the recycle bin.",
        "Widening the row hit target to the full width cut misclicks noticeably in our session recordings.",
        "Column resizing snaps to content bounds within 8px, otherwise the grid starts to look arbitrary.",
        "Drag-and-drop needs an indicator that stays visible over both light and dark rows.",
        "An empty state should name the action rather than the absence: \"Drop files here\" beats \"No files\".",
        "Thumbnails arrive progressively: a 32px blur first, then the full asset once it is decoded.",
        "We removed the third accent colour, because two accents were already competing for attention.",
        "Perceived performance improved more from skeleton rows than from a faster list endpoint.",
        "Accessible names are built from filename plus type, since screen readers skip decorative icons.",
        "The preview pane should never resize the list as it opens; it overlays on narrow viewports.",
        "We treat a directory with more than 5000 entries as a distinct design case, not an edge case.",
    ],
    "changelog": [
        "Added fuzzy matching to the command palette, ranked by match position and recency.",
        "Fixed a race where the watcher could emit a delete for a file that had already been replaced.",
        "Reduced thumbnail memory by evicting entries after 90 seconds of inactivity.",
        "The plugin host now reports a crash instead of taking the daemon down with it.",
        "Improved cold start by deferring the search index until the first query arrives.",
        "Renamed `--root` to `--serve` and kept the old flag as a deprecated alias.",
        "ZIP archives are browsable without extraction through the zip-vfs plugin.",
        "Search now indexes filenames only; content search moved behind an explicit flag.",
        "Batch rename previews its result before applying, so a bad pattern cannot silently destroy names.",
        "The listing endpoint streams results instead of buffering the whole directory.",
        "Fixed incorrect byte formatting above 1 GiB.",
        "Uploads resume from the last acknowledged chunk after a dropped connection.",
        "Added a per-directory sort preference that survives restarts.",
        "Deletes use the system trash when available, with a permanent-delete fallback.",
        "Reduced the initial JavaScript payload by splitting the preview pane into its own chunk.",
        "Fixed a memory leak in the websocket reconnect path.",
        "Timeouts on the filesystem layer are now configurable and default to 30 seconds.",
        "Deprecated the legacy `/api/tree` endpoint in favour of `/api/list`.",
        "Improved permission errors to include the resolved path and the failing operation.",
        "Added a health endpoint reporting plugin state, cache size, and uptime.",
    ],
    "meeting": [
        "We spent the first ten minutes on the incident review before moving to the roadmap.",
        "{name} walked through a prototype of {component} and collected feedback on the layout.",
        "The consensus was to ship the read-only path first and follow with mutations.",
        "We agreed to timebox the investigation into {metric} to two days before deciding.",
        "{name} raised that the migration still has no rollback story.",
        "Action items were assigned and moved into the backlog with owners attached.",
        "The team decided to defer plugin sandboxing until the host API stabilises.",
        "{name} will write the decision about {component} up as an ADR by Friday.",
        "We noted that the demo environment has drifted away from production configuration.",
        "Concern was raised about the number of open pull requests, currently eleven.",
        "We will pair on the storage format change rather than reviewing it asynchronously.",
        "The release candidate moved to the 24th to absorb the extra review time.",
        "Support has three tickets about the empty state wording, so we will revisit it.",
        "{name} suggested tracking {metric} on the dashboard before changing anything.",
        "No decision was reached on the packaging question; it stays with the platform group.",
        "We reviewed the on-call rotation and agreed hotfixes need a second reviewer.",
        "The design debt list was pruned from thirty items down to nine.",
        "We will run a spike on {component} next sprint and report back with numbers.",
        "{name} flagged that two tests are flaky under load and should be quarantined.",
        "Standing agreement: no new dependencies without a written justification.",
        "The demo needs a realistic data set, so {name} volunteered to script one.",
        "We agreed that the file manager should never block the UI on an unresponsive backend.",
    ],
    "api": [
        "The endpoint takes a path and returns a paginated list of entries with cursor semantics.",
        "Errors share one shape: a machine code, a human message, and the resolved path.",
        "Page size is capped so a single response stays comfortably under a few megabytes.",
        "Streaming is the default for directory listings, and the buffered variant is deprecated.",
        "Paths are always absolute and normalised, never relative to the request origin.",
        "The websocket carries change events only; state is always fetched over HTTP.",
        "Every mutating call is idempotent when given an idempotency key.",
        "We return 409 rather than 404 when a parent directory does not exist yet.",
        "Auth is a bearer token exchanged at startup and scoped to the served root.",
        "The API version lives in the path, and exactly one previous version stays supported.",
        "Byte ranges are supported for previews so a client can fetch just the head of a file.",
        "Plugin calls are namespaced under their manifest id to avoid collisions.",
        "Timeouts are per-operation rather than global, and surface as 504 with a retry hint.",
        "We deliberately avoid a generic query language; filters are explicit parameters.",
        "The client schema is generated from the Rust types so the two cannot drift.",
        "List responses include a hash of the directory so clients can cache cheaply.",
        "Sensitive operations require a confirmation token minted by a prior GET.",
        "Server-sent events were rejected in favour of websockets for the bidirectional cases.",
        "Pagination cursors are opaque and must never be constructed by a client.",
        "We log the resolved path on every mutation so an audit trail exists out of the box.",
    ],
    "ops": [
        "Set the root with `--serve /srv/files` and confirm the health endpoint reports ready.",
        "If the daemon restarts in a loop, check the cache directory permissions first.",
        "The database is a single SQLite file under the cache directory, so back it up with a copy.",
        "Thumbnails are content-addressed and safe to delete; they regenerate on demand.",
        "To drain a node, disable the watcher and wait for in-flight uploads to finish.",
        "Logs go to stderr and are rotated by the supervisor rather than by the daemon.",
        "A stuck upload usually means a proxy is buffering the request body.",
        "Raise the file descriptor limit before serving directories with more than 10k entries.",
        "The plugin host is a separate process; killing it does not disturb the file API.",
        "For a clean rebuild, stop the service, remove the cache directory, and start again.",
        "Monitor {metric} and alert when it stays above budget for five minutes.",
        "Certificates live outside the container and are mounted read-only.",
        "Run the smoke test after every deploy: list, preview, upload, rename, delete.",
        "If previews render black, the thumbnail worker has probably lost its temporary directory.",
        "Rollback is a redeploy of the previous image plus a cache flush.",
        "The service expects the data volume to be mounted, never copied in.",
        "Check plugin manifests when the registry reports fewer plugins than expected.",
        "The CLI's `doctor` subcommand prints a quick configuration summary.",
        "Alert fatigue is real, so we only page on the two symptoms users actually notice.",
        "Snapshot the data directory before any migration, even a trivial one.",
    ],
    "research": [
        "We benchmarked three approaches and the differences were smaller than expected.",
        "The measurement is dominated by filesystem latency rather than by our own parsing.",
        "A 2000-entry directory lists in 40ms warm and 180ms cold on the reference machine.",
        "Fuzzy matching over 100k paths costs about 9ms per keystroke with a cheap prefilter.",
        "Thumbnail generation is IO bound for large images and CPU bound for small ones.",
        "We could not reproduce the reported regression on the second machine.",
        "The hypothesis was that caching the parent listing would hide the cost; it did not.",
        "WebAssembly plugins add roughly 400 microseconds per call, which is acceptable for our profile.",
        "Memory growth in the watcher looked linear until we accounted for the event backlog.",
        "Rendering 100k rows is fine as long as we never materialise all of them in the DOM.",
        "The prototype cut scroll jank from 14 to 3 dropped frames per second.",
        "Compression at level six halves transfer size for a tenth of the encoding cost.",
        "These numbers are directional at best; the sample is a single machine.",
        "An index over filenames is about 30% faster to build than one over file contents.",
        "The cache hit rate plateaued at 71%, so further tuning has little headroom.",
        "Server-side thumbnails win over client-side decoding once images exceed 4 megapixels.",
        "The tail latency comes from a single slow path: cold directory reads.",
        "We should repeat the test with the network emulated at 20ms round trip.",
        "Results held across three runs, with a spread under 6%.",
        "The next experiment should isolate the effect of the file watcher.",
        "A cold cache is the realistic case for a demo, so we optimise for it deliberately.",
        "We measured with the same corpus for every variant to keep comparisons honest.",
    ],
}

BULLETS = [
    "Selection state must remain distinguishable from hover at a glance.",
    "Never block the list render on a thumbnail that has not arrived yet.",
    "Prefer a deterministic order over a slightly better but unstable one.",
    "Cache invalidation follows the watched path, not the query.",
    "Errors are shown inline, next to the row, not in a toast that disappears.",
    "The keyboard path must not depend on pointer position.",
    "Large directories are paginated in the API but streamed to the view.",
    "Any destructive shortcut is disabled unless the row is focused.",
    "Preview content is fetched lazily on hover for the first 20 rows only.",
    "Sort state lives in the URL so a view can be shared.",
    "We keep the plugin surface small: list, read, write, watch.",
    "Timestamps are rendered in the viewer's locale, not the server's.",
]

ACTIONS = [
    "Write the ADR for the storage format change",
    "Add a regression test for the watcher race",
    "Measure {metric} on the reference machine",
    "Draft the empty-state copy and share it for review",
    "Audit contrast in the dark theme tokens",
    "Split the preview pane into a separate chunk",
    "Quarantine the flaky upload test",
    "Script the demo data set",
    "Review the plugin manifest schema",
    "Profile cold list on a 5000-entry directory",
    "Document the rollback procedure",
    "Trim the design debt list",
]

CHECKLIST = [
    "Confirm the cache directory is writable by the service user",
    "Run the smoke test suite against a throwaway root",
    "Verify previews for text, image, audio, and archive types",
    "Check the health endpoint reports plugins loaded",
    "Confirm the watcher emits events for renamed directories",
    "Validate the demo tree counts and total size",
    "Verify large-file preview truncation is clearly indicated",
    "Spot-check PNG dimensions and WAV headers",
]

RUST_SNIPPETS = [
    """pub struct ListingQuery {
    pub path: PathBuf,
    pub cursor: Option<u64>,
    pub limit: usize,
    pub order: SortKey,
}

impl ListingQuery {
    pub fn normalise(mut self) -> Result<Self, Error> {
        self.path = self.path.canonicalize()?;
        self.limit = self.limit.clamp(1, 5000);
        Ok(self)
    }
}""",
    """#[derive(Clone, Debug, PartialEq)]
pub enum EntryKind {
    Directory,
    File { mime: Mime, size: u64 },
    Archive { entries: usize },
    Symlink { target: PathBuf },
}

impl EntryKind {
    pub fn is_previewable(&self) -> bool {
        matches!(self, EntryKind::File { mime, .. } if mime.is_text() || mime.is_image())
    }
}""",
    """async fn thumb(path: &Path, px: u32) -> Result<Bytes, Error> {
    let key = cache_key(path, px);
    if let Some(hit) = CACHE.get(&key) {
        return Ok(hit);
    }
    let src = tokio::fs::read(path).await?;
    let img = tokio::task::spawn_blocking(move || decode_and_resize(&src, px)).await??;
    CACHE.insert(key, img.clone());
    Ok(img)
}""",
    """pub fn format_bytes(n: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}""",
]

TS_SNIPPETS = [
    """export async function list(path: string, cursor?: string): Promise<Page<Entry>> {
  const query = new URLSearchParams({ path });
  if (cursor) query.set('cursor', cursor);
  const res = await fetch(`/api/list?${query}`);
  if (!res.ok) throw new ApiError(await res.json());
  return res.json();
}""",
    """export function useVirtualList(count: number, rowHeight: number) {
  const [range, setRange] = createSignal({ start: 0, end: 40 });
  const onScroll = (el: HTMLElement) => {
    const start = Math.floor(el.scrollTop / rowHeight);
    setRange({ start, end: Math.min(count, start + 40) });
  };
  return { range, onScroll };
}""",
    """export const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
};""",
]

BASH_SNIPPETS = [
    """# serve the demo tree and open the UI
filament --serve ./demo --port 7788
curl -s localhost:7788/api/health | jq .""",
    """# inspect what the watcher sees
inotifywait -m -r --format '%e %w%f' ./demo/many | head -20""",
    """# verify a preview payload without the UI
curl -s 'localhost:7788/api/preview?path=demo/data/export.json&max=4096' \\
  | head -c 400""",
    """# regenerate the demo tree from scratch (idempotent)
python3 scripts/make_demo.py""",
]

TOML_SNIPPETS = [
    """[server]
serve = "/srv/files"
port = 7788
max_page = 5000

[preview]
head_bytes = 65536
thumbnail_px = 256
cache_ttl_secs = 90""",
    """[[plugins]]
id = "zip-vfs"
path = "plugins/zip-vfs/target/release/zip_vfs.wasm"
mount = "*.zip"

[[plugins]]
id = "git-status"
enabled = false""",
]

JSON_SNIPPETS = [
    """{
  "code": "not_a_directory",
  "message": "the resolved path is a file, not a directory",
  "path": "/srv/files/notes/readme.md"
}""",
    """{
  "path": "demo/photos/dunes.png",
  "size": 1136640,
  "mime": "image/png",
  "thumb": "/api/thumb?path=...&px=256",
  "truncated": false
}""",
]

HEADINGS = {
    "design": ["Context", "Decisions", "Interaction states", "Trade-offs", "Accessibility",
               "Measurements", "Open questions", "Follow-ups"],
    "api": ["Endpoints", "Error model", "Pagination", "Auth and scoping", "Versioning",
            "Examples", "Compatibility", "Open questions"],
    "ops": ["Prerequisites", "Procedure", "Verification", "Rollback", "Monitoring", "Known issues"],
    "research": ["Question", "Method", "Results", "Analysis", "Limitations", "Next steps"],
    "meeting": ["Discussion", "Decisions", "Action items", "Parking lot", "Announcements"],
    "changelog": ["Added", "Changed", "Fixed", "Removed", "Deprecated"],
}

TITLES = {
    "design": ["Design notes: {component}", "Interaction pass over {component}", "Rethinking {component}"],
    "api": ["API design: {component}", "Protocol notes for {component}", "Contract for {component}"],
    "ops": ["Runbook: {component}", "Operating {component}", "Deployment notes for {component}"],
    "research": ["Measuring {metric}", "Investigation: {metric}", "Benchmark notes on {metric}"],
    "meeting": ["Retro", "Sync notes", "Review session", "Weekly planning"],
    "changelog": ["Changelog", "Release notes"],
}


class SentenceStream:
    """Infinite sentence stream: shuffles each pool and reshuffles when drained."""

    def __init__(self, rng: random.Random) -> None:
        self.rng = rng
        self.pools = {k: list(v) for k, v in SENTENCES.items()}
        for pool in self.pools.values():
            self.rng.shuffle(pool)
        self.cursors = {k: 0 for k in self.pools}

    def next_from(self, category: str) -> str:
        pool = self.pools[category]
        i = self.cursors[category]
        if i >= len(pool):
            self.rng.shuffle(pool)
            i = 0
        self.cursors[category] = i + 1
        return fill_slots(pool[i], self.rng)

    def paragraph(self, categories, weights, sentences: int | None = None) -> str:
        n = sentences if sentences is not None else self.rng.randint(3, 6)
        parts = []
        for _ in range(n):
            cat = self.rng.choices(categories, weights=weights, k=1)[0]
            parts.append(self.next_from(cat))
        return " ".join(parts)

    def bullet_list(self, count: int, categories, weights, pure: bool = False) -> str:
        """``pure`` keeps bullets inside the primary topic (used by changelogs)."""
        lines = []
        for _ in range(count):
            if not pure and self.rng.random() < 0.45:
                lines.append("- " + fill_slots(self.rng.choice(BULLETS), self.rng))
            else:
                cat = self.rng.choices(categories, weights=weights, k=1)[0]
                lines.append("- " + self.next_from(cat))
        return "\n".join(lines)

    def checklist(self, count: int) -> str:
        items = self.rng.sample(CHECKLIST, k=min(count, len(CHECKLIST)))
        out = []
        for i, item in enumerate(items):
            mark = "x" if i < len(items) // 2 else " "
            out.append(f"- [{mark}] {item}")
        return "\n".join(out)

    def table(self, rows: int = 4) -> str:
        metrics = self.rng.sample(SLOTS["metric"], k=rows)
        lines = ["| Metric | Before | After | Notes |", "| --- | ---: | ---: | --- |"]
        for m in metrics:
            before = self.rng.randint(120, 940)
            after = int(before * self.rng.uniform(0.32, 0.86))
            note = self.rng.choice(
                ["warm cache", "cold cache", "median of 20 runs", "p95", "reference machine", "after change"]
            )
            lines.append(f"| {m} | {before} ms | {after} ms | {note} |")
        return "\n".join(lines)

    def code(self, langs) -> str:
        pools = {
            "rust": RUST_SNIPPETS, "ts": TS_SNIPPETS, "bash": BASH_SNIPPETS,
            "toml": TOML_SNIPPETS, "json": JSON_SNIPPETS,
        }
        lang = self.rng.choice(langs)
        body = self.rng.choice(pools[lang])
        return f"```{lang}\n{body}\n```"

    def actions(self, count: int) -> str:
        picked = self.rng.sample(ACTIONS, k=min(count, len(ACTIONS)))
        return "\n".join("- [ ] " + fill_slots(a, self.rng) for a in picked)


CATEGORY_MIX = {
    "design": (["design", "research", "meeting"], [6, 2, 1]),
    "api": (["api", "research", "ops"], [6, 2, 1]),
    "ops": (["ops", "api", "meeting"], [6, 2, 1]),
    "research": (["research", "design", "api"], [6, 2, 1]),
    "meeting": (["meeting", "design", "ops"], [6, 2, 1]),
    "changelog": (["changelog", "meeting"], [7, 1]),
}

CODE_LANGS = {
    "design": ["ts", "json"],
    "api": ["rust", "json", "ts"],
    "ops": ["bash", "toml"],
    "research": ["rust", "ts"],
    "meeting": [],
    "changelog": [],
}


def rng_for(rel: str, salt: int = 0) -> random.Random:
    """Deterministic RNG per path, so output does not depend on generation order."""
    digest = hashlib.sha256(f"{rel}|{salt}".encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def trim_to(text: str, target: int, floor: float = 0.55) -> str:
    """Trim assembled prose back to the nearest natural boundary near ``target``.

    Prefers the latest block/line/sentence boundary at or before the target so a
    truncated document still ends on a complete sentence wherever possible.
    """
    if len(text) <= target:
        return text
    best = -1
    for sep, keep in (("\n\n", 0), ("\n", 1), (". ", 2)):
        idx = text.rfind(sep, 0, target)
        if idx != -1 and idx + keep > best:
            best = idx + keep
    if best > target * floor:
        return text[:best].rstrip() + "\n"
    return text[: best if best > 0 else target].rstrip() + "\n"


def normalise_blank_lines(text: str) -> str:
    """Collapse runs of 3+ newlines (block joins) into a single blank line."""
    return re.sub(r"\n{3,}", "\n\n", text)


def build_markdown(rel: str, category: str, title: str, target: int) -> str:
    rng = rng_for(rel)
    stream = SentenceStream(rng)
    cats, weights = CATEGORY_MIX[category]
    owner = rng.choice(SLOTS["name"])
    date = rel.split("-")[0] if re.match(r"^\d{4}-\d{2}-\d{2}", rel) else None

    parts = []
    if category == "changelog":
        parts.append(f"# {title}\n")
        parts.append(
            f"All notable changes to this project. Dates are in ISO 8601 and entries are grouped "
            f"by kind. Prepared by {owner}."
        )
    else:
        front = [
            "---",
            f"title: {title}",
            f"owner: {owner}",
            f"tags: [{category}, {rng.choice(['frontend', 'backend', 'storage', 'perf', 'a11y', 'plugins'])}]",
            f"status: {rng.choice(['draft', 'in review', 'accepted', 'living document'])}",
        ]
        if date:
            front.insert(2, f"date: {date}")
        front.append("---")
        parts.append("\n".join(front) + "\n")
        parts.append(f"# {title}\n")
        parts.append(stream.paragraph(cats, weights, 2 if target < 900 else 4))

    if target < 900:
        return normalise_blank_lines(trim_to("\n\n".join(parts) + "\n", target))

    headings = list(HEADINGS[category])
    if category != "changelog":
        rng.shuffle(headings)

    def section(heading: str) -> str:
        body = []
        blocks = rng.randint(2, 4)
        for i in range(blocks):
            pick = rng.random()
            if category == "changelog":
                body.append(stream.bullet_list(rng.randint(3, 6), cats, weights, pure=True))
            elif pick < 0.42:
                body.append(stream.paragraph(cats, weights))
            elif pick < 0.60:
                body.append(stream.bullet_list(rng.randint(3, 5), cats, weights))
            elif pick < 0.72:
                body.append(stream.table(rng.randint(3, 5)))
            elif pick < 0.84 and CODE_LANGS[category]:
                body.append(stream.code(CODE_LANGS[category]))
            elif pick < 0.92:
                body.append(stream.checklist(rng.randint(3, 5)))
            else:
                body.append(stream.actions(rng.randint(2, 4)))
        return f"## {heading}\n\n" + "\n\n".join(body)

    i = 0
    guard = 0
    while sum(len(p) for p in parts) < target and guard < 200:
        heading = headings[i % len(headings)]
        if i >= len(headings):
            heading = f"{heading} (continued)" if i < len(headings) * 2 else heading
        parts.append(section(heading))
        i += 1
        guard += 1

    parts.append("---\n\n" + stream.paragraph(cats, weights, 2))
    return normalise_blank_lines(trim_to("\n\n".join(parts) + "\n", target))


def build_text_note(rel: str, category: str, title: str, target: int) -> str:
    """Plain-text notes: CAPS separators, timestamps, no markdown decoration."""
    rng = rng_for(rel)
    stream = SentenceStream(rng)
    cats, weights = CATEGORY_MIX[category]
    owner = rng.choice(SLOTS["name"])

    head = f"{title.upper()}\n{'=' * max(12, len(title))}\nrecorded {rng.choice(['09:14', '10:02', '13:40', '16:25'])} by {owner}\n"
    parts = [head]
    if target < 500:
        # Tiny notes still need to clear ~200 B, so seed two sentences.
        parts.append(stream.paragraph(cats, weights, 2))
        return normalise_blank_lines(trim_to("\n".join(parts) + "\n", target))

    parts.append(stream.paragraph(cats, weights, 3))
    sections = list(HEADINGS[category][:3])
    i = 0
    guard = 0
    while sum(len(p) for p in parts) < target and guard < 60:
        heading = sections[i % len(sections)].upper()
        body = []
        for _ in range(rng.randint(1, 3)):
            r = rng.random()
            if r < 0.5:
                body.append(stream.paragraph(cats, weights))
            elif r < 0.8:
                body.append("\n".join("  - " + stream.next_from(rng.choice(cats)) for _ in range(rng.randint(2, 4))))
            else:
                body.append(stream.actions(rng.randint(2, 3)).replace("- [ ]", "  *"))
        parts.append(f"{'-' * 60}\n{heading}\n{'-' * 60}\n" + "\n\n".join(body))
        i += 1
        guard += 1
    parts.append(f"{'-' * 60}\nowner: {owner}\nnext: {rng.choice(['revisit after the spike', 'carry to next week', 'closed'])}")
    return normalise_blank_lines(trim_to("\n\n".join(parts) + "\n", target))


# --------------------------------------------------------------------------- #
# Notes corpus: 41 files, ~200 B to 20 KB, two levels of subfolders
# --------------------------------------------------------------------------- #

#: (relative path under notes/, category, target bytes)
NOTES = [
    ("2026-10-14-retro.md", "meeting", kb(6.5)),
    ("2026-10-07-design-review.md", "design", kb(8.0)),
    ("2026-09-30-standup.txt", "meeting", kb(0.7)),
    ("2026-09-23-incident-postmortem.md", "ops", kb(12)),
    ("2026-09-16-roadmap-sync.md", "meeting", kb(5.0)),
    ("2026-09-08-1on1-notes.txt", "meeting", kb(1.1)),
    ("api-design.md", "api", kb(14)),
    ("caching-strategy.md", "design", kb(9.0)),
    ("changelog-2026-10.md", "changelog", kb(4.0)),
    ("changelog-2026-09.md", "changelog", kb(3.2)),
    ("color-tokens.md", "design", kb(6.0)),
    ("glossary.md", "research", kb(4.6)),
    ("onboarding.md", "ops", kb(10)),
    ("perf-budget.md", "research", kb(7.5)),
    ("plugin-protocol.md", "api", kb(16)),
    ("release-checklist.txt", "ops", kb(2.4)),
    ("scratch.txt", "meeting", 320),
    ("search-ranking.md", "research", kb(11)),
    ("shortcuts.md", "design", kb(3.4)),
    ("storage-layout.md", "api", kb(5.5)),
    ("theming-guide.md", "design", kb(7.0)),
    ("virtual-scroll-notes.md", "research", kb(13)),
    ("writing-style.md", "design", kb(2.1)),
    ("design/empty-states.md", "design", kb(3.1)),
    ("design/iconography.md", "design", kb(2.6)),
    ("design/motion-guidelines.md", "design", kb(4.2)),
    ("design/typography-scale.md", "design", kb(1.8)),
    ("design/dark-mode-audit.md", "design", kb(5.2)),
    ("research/fuzzy-matching.md", "research", kb(9.5)),
    ("research/thumbnails-at-scale.md", "research", kb(15)),
    ("research/wasm-plugins.md", "api", kb(18)),
    ("research/webgpu-grid.md", "research", kb(20)),
    ("archive/2026-q3/retro-2026-07.md", "meeting", kb(4.4)),
    ("archive/2026-q3/retro-2026-08.md", "meeting", kb(4.8)),
    ("archive/2026-q3/retro-2026-09.md", "meeting", kb(5.6)),
    ("archive/2026-q3/sprint-14-notes.md", "meeting", kb(3.8)),
    ("archive/2026-q3/sprint-15-notes.md", "meeting", kb(3.6)),
    ("archive/2026-q3/design-debt.md", "design", kb(6.2)),
    ("archive/2026-q3/legacy/index.txt", "ops", 900),
    ("archive/2026-q3/legacy/naming-decisions.txt", "design", kb(1.4)),
    ("archive/2026-q3/legacy/migration-notes.txt", "ops", kb(2.9)),
]


def title_for(rel: str, category: str, rng: random.Random) -> str:
    stem = Path(rel).stem
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})-(.+)$", stem)
    if m:
        year, month, day, slug = m.groups()
        words = slug.replace("-", " ")
        base = " ".join(w if w.isupper() else w.capitalize() for w in words.split())
        months = ["", "January", "February", "March", "April", "May", "June", "July",
                  "August", "September", "October", "November", "December"]
        return f"{months[int(month)]} {int(day)}, {year} — {base}"
    if stem.startswith("changelog-"):
        return f"Changelog {stem.split('-', 1)[1]}"
    words = stem.replace("-", " ").replace("_", " ")
    if words.islower():
        words = words.capitalize()
        for suffix in ("Api", "Adr", "Ui", "Vfs", "Wasm", "Gpu", "Csv", "Png", "Wav"):
            words = words.replace(suffix, suffix.upper())
    return words


def generate_notes(w: TreeWriter, stats: dict) -> None:
    total = 0
    for rel, category, target in NOTES:
        rng = rng_for(rel, 1)
        path = f"notes/{rel}"
        title = fill_slots(title_for(rel, category, rng), rng)
        if rel.endswith(".txt"):
            text = build_text_note(path, category, title, target)
        else:
            text = build_markdown(path, category, title, target)
        w.write_text(path, text)
        total += len(text.encode("utf-8"))
    stats["notes"] = {"files": len(NOTES), "bytes": total}
# --------------------------------------------------------------------------- #
# projects/ - two small, plausible source trees (Rust + TypeScript)
#
# These deliberately contain no .git directory: the file manager should render a
# plain tree, not a repository. .gitignore and rust-toolchain.toml stay, because
# they are ordinary files in a real checkout.
# --------------------------------------------------------------------------- #

ALPHA = "projects/alpha"
BETA = "projects/beta"

PROJECT_FILES = {
    # ---------------------------------------------------------------- alpha --
    f"{ALPHA}/Cargo.toml": """[package]
name = "stratum-index"
version = "0.4.2"
edition = "2021"
description = "Incremental filename index backing the Filament listing service"
license = "MIT OR Apache-2.0"

[dependencies]
memmap2 = "0.9"
serde = { version = "1", features = ["derive"] }
thiserror = "1"

[dev-dependencies]
tempfile = "3"
criterion = "0.5"

[[bench]]
name = "lookup"
harness = false
""",
    f"{ALPHA}/Cargo.lock": """# This file is automatically @generated by Cargo.
# It is not intended for manual editing.
version = 3

[[package]]
name = "stratum-index"
version = "0.4.2"
dependencies = ["memmap2", "serde", "thiserror"]

[[package]]
name = "memmap2"
version = "0.9.4"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "d7b3d4d3c9a4f1ee1dd9f0a5a4e5b6a1c0b4d2f0e4a1b2c3d4e5f6a7b8c9d0e1"

[[package]]
name = "thiserror"
version = "1.0.63"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "0f2b8a1c9e4d7f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a"
""",
    f"{ALPHA}/README.md": """# stratum-index

Incremental filename index used by the Filament listing service.

* Builds a compact index of names per directory, never of file contents.
* Persists to a single append-only segment file; compaction is explicit.
* Reads are memory-mapped, so a warm listing avoids a copy.

```bash
cargo test --all
cargo bench --bench lookup
```
""",
    f"{ALPHA}/.gitignore": """/target
**/*.rs.bk
*.seg
*.idx
""",
    f"{ALPHA}/rust-toolchain.toml": """[toolchain]
channel = "1.82.0"
components = ["rustfmt", "clippy"]
""",
    f"{ALPHA}/src/main.rs": """use std::path::PathBuf;

use stratum_index::{Config, Index};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let root = args.first().cloned().unwrap_or_else(|| ".".into());

    let config = Config::new(PathBuf::from(root))
        .with_max_entries(5000)
        .with_segment_size_mb(64);

    let mut index = Index::open(config)?;
    let stats = index.rebuild()?;

    println!(
        "indexed {} entries across {} directories in {} ms",
        stats.entries, stats.directories, stats.elapsed_ms
    );
    Ok(())
}
""",
    f"{ALPHA}/src/lib.rs": """//! Incremental filename index.
//!
//! The crate exposes three things: a [`Config`], an [`Index`], and the
//! [`Entry`] type the listing service serialises directly.

pub mod config;
pub mod index;
pub mod query;
pub mod util;

pub use crate::config::Config;
pub use crate::index::{Entry, EntryKind, Index, IndexError, Stats};

/// Version of the on-disk segment format.
pub const SEGMENT_FORMAT: u16 = 3;
""",
    f"{ALPHA}/src/config.rs": """use std::path::PathBuf;

/// Tunables for an index instance. All values have conservative defaults.
#[derive(Clone, Debug)]
pub struct Config {
    pub root: PathBuf,
    pub max_entries: usize,
    pub segment_size_mb: u64,
    pub follow_symlinks: bool,
    pub index_hidden: bool,
}

impl Config {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            max_entries: 50_000,
            segment_size_mb: 32,
            follow_symlinks: false,
            index_hidden: true,
        }
    }

    pub fn with_max_entries(mut self, n: usize) -> Self {
        self.max_entries = n.clamp(1, 1_000_000);
        self
    }

    pub fn with_segment_size_mb(mut self, mb: u64) -> Self {
        self.segment_size_mb = mb.clamp(4, 4096);
        self
    }
}

impl Default for Config {
    fn default() -> Self {
        Config::new(PathBuf::from("."))
    }
}
""",
    f"{ALPHA}/src/index/mod.rs": """mod reader;
mod writer;

pub use reader::Reader;
pub use writer::Writer;

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::Config;
use crate::query::Query;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub modified_ms: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum EntryKind {
    Directory,
    File { size: u64 },
    Archive { entries: u32 },
}

#[derive(Debug, thiserror::Error)]
pub enum IndexError {
    #[error("segment is corrupt at offset {0}")]
    Corrupt(u64),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub entries: usize,
    pub directories: usize,
    pub elapsed_ms: u128,
}

pub struct Index {
    config: Config,
    reader: Option<Reader>,
}

impl Index {
    pub fn open(config: Config) -> Result<Self, IndexError> {
        Ok(Self { config, reader: None })
    }

    pub fn rebuild(&mut self) -> Result<Stats, IndexError> {
        let writer = Writer::new(&self.config)?;
        let stats = writer.write_all()?;
        self.reader = Some(Reader::open(&self.config)?);
        Ok(stats)
    }

    pub fn query(&self, query: &Query) -> Result<Vec<Entry>, IndexError> {
        match &self.reader {
            Some(reader) => reader.search(query),
            None => Ok(Vec::new()),
        }
    }
}
""",
    f"{ALPHA}/src/index/writer.rs": """use std::fs::File;
use std::io::{BufWriter, Write};

use super::{IndexError, Stats};
use crate::util::bytes::put_varint;
use crate::{Config, SEGMENT_FORMAT};

pub struct Writer<'a> {
    config: &'a Config,
}

impl<'a> Writer<'a> {
    pub fn new(config: &'a Config) -> Result<Self, IndexError> {
        Ok(Self { config })
    }

    /// Walks the tree and writes one segment, up to the configured entry cap.
    pub fn write_all(&self) -> Result<Stats, IndexError> {
        let mut entries = 0usize;
        let mut directories = 0usize;
        let path = self.config.root.join(".stratum.seg");
        let file = File::create(path)?;
        let mut out = BufWriter::new(file);

        out.write_all(&SEGMENT_FORMAT.to_le_bytes())?;
        for (i, item) in walk(&self.config.root).enumerate() {
            if entries >= self.config.max_entries {
                break;
            }
            put_varint(&mut out, i as u64)?;
            if item.is_dir() {
                directories += 1;
            }
            entries += 1;
        }
        out.flush()?;
        Ok(Stats { entries, directories, elapsed_ms: 0 })
    }
}

fn walk(root: &std::path::Path) -> impl Iterator<Item = std::path::PathBuf> + '_ {
    root.read_dir()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
}
""",
    f"{ALPHA}/src/index/reader.rs": """use memmap2::Mmap;
use std::fs::File;

use super::{Entry, EntryKind, IndexError};
use crate::query::Query;
use crate::Config;

pub struct Reader {
    map: Mmap,
}

impl Reader {
    pub fn open(config: &Config) -> Result<Self, IndexError> {
        let file = File::open(config.root.join(".stratum.seg"))?;
        // Safety: the segment is append-only and never mutated in place.
        let map = unsafe { Mmap::map(&file)? };
        Ok(Self { map })
    }

    pub fn search(&self, query: &Query) -> Result<Vec<Entry>, IndexError> {
        if self.map.len() < 2 {
            return Err(IndexError::Corrupt(0));
        }
        let mut hits = Vec::with_capacity(query.limit);
        for (offset, byte) in self.map[2..].iter().enumerate() {
            if hits.len() >= query.limit {
                break;
            }
            if *byte == 0 && query.matches_empty_segment(offset) {
                hits.push(Entry {
                    name: String::new(),
                    kind: EntryKind::Directory,
                    modified_ms: 0,
                });
            }
        }
        Ok(hits)
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}
""",
    f"{ALPHA}/src/query/mod.rs": """mod planner;

pub use planner::{plan, Plan};

/// A filename query. Deliberately not a general expression language: the API
/// exposes explicit parameters instead, and this mirrors them one to one.
#[derive(Clone, Debug, Default)]
pub struct Query {
    pub needle: String,
    pub limit: usize,
    pub directories_only: bool,
    pub fuzzy: bool,
}

impl Query {
    pub fn limit(mut self, n: usize) -> Self {
        self.limit = n.clamp(1, 5000);
        self
    }

    pub fn matches_empty_segment(&self, _offset: usize) -> bool {
        self.needle.is_empty()
    }
}
""",
    f"{ALPHA}/src/query/planner.rs": """use super::Query;

#[derive(Clone, Debug, PartialEq)]
pub enum Plan {
    ScanAll,
    ScanWithFilter(String),
    Exact { name: String },
}

/// Chooses a scan strategy. Exact matches are common enough (rename, preview)
/// that they are worth special-casing ahead of a linear scan.
pub fn plan(query: &Query) -> Plan {
    if query.needle.is_empty() {
        return Plan::ScanAll;
    }
    if query.needle.contains('/') {
        return Plan::Exact { name: query.needle.clone() };
    }
    Plan::ScanWithFilter(query.needle.to_lowercase())
}
""",
    f"{ALPHA}/src/query/expr.rs": """//! Small helpers for the filter strings produced by [`super::planner::plan`].

/// Case-insensitive substring test used by the scan filter.
pub fn contains_ci(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// Scores a match for ranking: earlier and closer matches win.
pub fn score_ci(haystack: &str, needle: &str) -> Option<u32> {
    let h = haystack.to_lowercase();
    let n = needle.to_lowercase();
    let at = h.find(&n)?;
    let leading = at.min(32) as u32;
    Some(100u32.saturating_sub(leading).saturating_sub(n.len() as u32))
}
""",
    f"{ALPHA}/src/util/bytes.rs": """use std::io::{self, Write};

/// Writes an unsigned LEB128 varint.
pub fn put_varint<W: Write>(out: &mut W, mut value: u64) -> io::Result<usize> {
    let mut written = 0;
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.write_all(&[byte])?;
        written += 1;
        if value == 0 {
            return Ok(written);
        }
    }
}

/// Reads an unsigned LEB128 varint.
pub fn get_varint(input: &[u8]) -> Option<(u64, usize)> {
    let mut value = 0u64;
    let mut shift = 0u32;
    for (i, byte) in input.iter().enumerate() {
        value |= ((byte & 0x7f) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some((value, i + 1));
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}
""",
    f"{ALPHA}/src/util/mod.rs": """pub mod bytes;

/// Formats a byte count the way the listing UI does.
pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = n as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{n} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use super::human_bytes;

    #[test]
    fn formats_boundaries() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KB");
        assert_eq!(human_bytes(5 * 1024 * 1024), "5.0 MB");
    }
}
""",
    f"{ALPHA}/tests/integration_index.rs": """use std::fs;

use stratum_index::{Config, Index, Query};
use tempfile::TempDir;

fn fixture() -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::create_dir_all(dir.path().join("notes/archive")).unwrap();
    fs::write(dir.path().join("notes/readme.md"), "hello").unwrap();
    fs::write(dir.path().join("notes/archive/old.txt"), "old").unwrap();
    dir
}

#[test]
fn rebuild_then_query() {
    let dir = fixture();
    let mut index = Index::open(Config::new(dir.path().to_path_buf())).unwrap();
    let stats = index.rebuild().unwrap();
    assert!(stats.entries >= 2);

    let hits = index.query(&Query { needle: "old".into(), limit: 10, ..Default::default() });
    assert!(hits.len() <= 10);
}

#[test]
fn limit_is_clamped() {
    let q = Query::default().limit(999_999);
    assert_eq!(q.limit, 5000);
}
""",
    f"{ALPHA}/benches/lookup.rs": """use criterion::{black_box, criterion_group, criterion_main, Criterion};

use stratum_index::query::expr::score_ci;

fn bench_score(c: &mut Criterion) {
    let names: Vec<String> = (0..2000)
        .map(|i| format!("2026-10-{:02}-meeting-notes-{:04}.md", (i % 28) + 1, i))
        .collect();

    c.bench_function("score 2000 names", |b| {
        b.iter(|| {
            let mut hits = 0;
            for name in &names {
                if score_ci(black_box(name), black_box("retro")).is_some() {
                    hits += 1;
                }
            }
            hits
        })
    });
}

criterion_group!(benches, bench_score);
criterion_main!(benches);
""",
    f"{ALPHA}/docs/architecture.md": """# Architecture

The index is a single append-only segment file per served root, memory-mapped
for reads. Writes are serialised through one writer, so readers never need a
lock and never observe a torn record.

## Layers

| Layer | Responsibility | Failure mode |
| --- | --- | --- |
| `index::writer` | Walk the tree, emit varint records | Partial segment, rebuilt on next start |
| `index::reader` | Memory-mapped reads, cursor iteration | Corrupt offset reported, index discarded |
| `query::planner` | Pick a scan strategy | Falls back to a full scan |
| `util::bytes` | Varint encode/decode | Returns `None` on a truncated buffer |

## Why a segment file

A database would be the obvious choice, but the workload is a read-mostly scan
with a small working set. A segment file keeps startup fast and makes the cache
directory disposable: deleting it costs one rebuild and nothing else.

## Compaction

Compaction is explicit rather than automatic. A background compactor that races
with the writer is a larger design problem than the one we have, and the
incremental garbage is bounded by the number of deleted entries.

## Clock and ordering

Timestamps are stored as milliseconds since the Unix epoch in UTC. Ordering is
by name, then by mtime, so a listing is stable under a refresh.
""",
    f"{ALPHA}/docs/adr/0001-storage-format.md": """# ADR 0001: Segment file instead of SQLite

* Status: accepted
* Date: 2026-08-19
* Deciders: storage group

## Context

The listing service needs a per-root cache of names, sizes, and mtimes. The
candidate stores were SQLite (already a dependency of the daemon) and a bespoke
segment file.

## Decision

Use a bespoke append-only segment file, memory-mapped for reads.

## Consequences

* Startup avoids opening a database for a read-mostly workload.
* The cache directory becomes disposable, which simplifies the upgrade path.
* We own the format: format changes require a version bump and a rebuild.
* We lose ad-hoc querying, which we did not use in practice.

## Alternatives rejected

* **SQLite**: correct, but adds a write-ahead log to a directory we want to be
  freely deletable.
* **In-memory only**: rebuilding on every start costs too much for large roots.
""",
    f"{ALPHA}/assets/logo.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="stratum-index">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5eead4"/>
      <stop offset="1" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="#0f172a"/>
  <path d="M14 42l18-22 18 22z" fill="url(#g)" opacity="0.9"/>
  <rect x="14" y="46" width="36" height="4" rx="2" fill="#94a3b8"/>
</svg>
""",
    f"{ALPHA}/assets/data/stopwords.txt": "\n".join([
        "a", "about", "above", "after", "again", "all", "also", "an", "and", "any",
        "are", "as", "at", "be", "because", "been", "before", "being", "below", "between",
        "both", "but", "by", "can", "did", "do", "does", "doing", "down", "during",
        "each", "few", "for", "from", "further", "had", "has", "have", "having", "he",
        "her", "here", "hers", "him", "his", "how", "into", "it", "its", "just",
        "more", "most", "no", "nor", "not", "now", "of", "off", "on", "once",
        "only", "or", "other", "our", "out", "over", "own", "same", "she", "should",
    ]) + "\n",
}

# ----------------------------------------------------------------------- beta --
PROJECT_FILES.update({
    f"{BETA}/package.json": """{
  "name": "@filament/explorer",
  "private": true,
  "version": "0.9.1",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "solid-js": "^1.9.5"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vite-plugin-solid": "^2.11.0",
    "vitest": "^2.1.0"
  }
}
""",
    f"{BETA}/tsconfig.json": """{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "jsxImportSource": "solid-js",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "types": ["vite/client"]
  },
  "include": ["src", "tests"]
}
""",
    f"{BETA}/vite.config.ts": """import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  server: {
    port: 5273,
    proxy: {
      '/api': 'http://127.0.0.1:7788',
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          preview: ['./src/preview/index.ts'],
        },
      },
    },
  },
});
""",
    f"{BETA}/.gitignore": """node_modules
dist
*.local
.DS_Store
""",
    f"{BETA}/README.md": """# @filament/explorer

The browser client for Filament. Renders the listing, the preview pane, and the
command palette against the daemon's HTTP API.

## Notes

* Rows are virtualized; the DOM never holds more than a few hundred nodes.
* The preview pane is a separate chunk so the first paint stays small.
* Sorting and selection live in the URL, so a view is shareable.
""",
    f"{BETA}/src/index.ts": """import { render } from 'solid-js/web';

import { Explorer } from './components/Explorer';
import { ApiClient } from './api/client';

const root = document.getElementById('app');
if (!root) {
  throw new Error('missing #app mount point');
}

const client = new ApiClient({
  baseUrl: import.meta.env.VITE_API_BASE ?? '',
  token: import.meta.env.VITE_API_TOKEN ?? '',
});

render(() => <Explorer client={client} initialPath="/" />, root);
""",
    f"{BETA}/src/api/client.ts": """export interface Entry {
  name: string;
  kind: 'directory' | 'file' | 'archive';
  size: number;
  modifiedMs: number;
  mime?: string;
}

export interface Page<T> {
  items: T[];
  cursor?: string;
  directoryHash: string;
}

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly path?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export class ApiClient {
  constructor(private readonly opts: { baseUrl: string; token: string }) {}

  private headers(): HeadersInit {
    return this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : {};
  }

  async list(path: string, opts: { cursor?: string; signal?: AbortSignal } = {}): Promise<Page<Entry>> {
    const query = new URLSearchParams({ path });
    if (opts.cursor) query.set('cursor', opts.cursor);
    const res = await fetch(`${this.opts.baseUrl}/api/list?${query}`, {
      headers: this.headers(),
      signal: opts.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ code: 'unknown', message: res.statusText }));
      throw new ApiError(body.code, body.message, body.path);
    }
    return res.json();
  }

  async preview(path: string, max = 65536): Promise<{ head: string; truncated: boolean }> {
    const query = new URLSearchParams({ path, max: String(max) });
    const res = await fetch(`${this.opts.baseUrl}/api/preview?${query}`, { headers: this.headers() });
    if (!res.ok) throw new ApiError('preview_failed', res.statusText, path);
    return res.json();
  }
}
""",
    f"{BETA}/src/api/schema.ts": """// Generated from the daemon's Rust types. Do not edit by hand.
// Run `cargo xtask schema --ts > src/api/schema.ts` after changing the API.

export type SortKey = 'name' | 'size' | 'modified';
export type Direction = 'asc' | 'desc';

export interface ListParams {
  path: string;
  cursor?: string;
  limit?: number;
  sort?: SortKey;
  direction?: Direction;
}

export interface ChangeEvent {
  kind: 'created' | 'modified' | 'deleted' | 'renamed';
  path: string;
  from?: string;
  seq: number;
}
""",
    f"{BETA}/src/components/Explorer.tsx": """import { For, Show, createSignal, onMount } from 'solid-js';

import type { ApiClient, Entry } from '../api/client';
import { Row } from './Row';
import { useVirtualList } from '../hooks/useVirtualList';
import { Timeline } from './Timeline';

export function Explorer(props: { client: ApiClient; initialPath: string }) {
  const [entries, setEntries] = createSignal<Entry[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string | null>(null);
  const rowHeight = 32;

  const { range, onScroll } = useVirtualList(() => entries().length, rowHeight);

  onMount(async () => {
    try {
      const page = await props.client.list(props.initialPath);
      setEntries(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to list');
    } finally {
      setLoading(false);
    }
  });

  return (
    <section class="explorer">
      <Timeline />
      <Show when={error()}>
        <p class="explorer__error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="explorer__viewport" onScroll={(e) => onScroll(e.currentTarget)}>
        <div style={{ height: `${entries().length * rowHeight}px` }}>
          <For each={entries().slice(range().start, range().end)}>
            {(entry, i) => <Row entry={entry} top={(range().start + i()) * rowHeight} />}
          </For>
        </div>
      </div>
    </section>
  );
}
""",
    f"{BETA}/src/components/Row.tsx": """import { Show } from 'solid-js';

import type { Entry } from '../api/client';
import { formatSize, formatWhen } from '../lib/format';

export function Row(props: { entry: Entry; top: number }) {
  const isDir = () => props.entry.kind === 'directory';

  return (
    <div
      class="row"
      role="row"
      tabindex="0"
      style={{ transform: `translateY(${props.top}px)` }}
      data-kind={props.entry.kind}
    >
      <span class="row__icon" aria-hidden="true" />
      <span class="row__name" title={props.entry.name}>
        {props.entry.name}
      </span>
      <Show when={!isDir()}>
        <span class="row__size">{formatSize(props.entry.size)}</span>
      </Show>
      <span class="row__when">{formatWhen(props.entry.modifiedMs)}</span>
    </div>
  );
}
""",
    f"{BETA}/src/components/Timeline.tsx": """export function Timeline() {
  // A compact scrubber over the mtimes of the current listing. Widths are
  // proportional, so a single cluster is visible at a glance.
  const buckets = [12, 30, 44, 18, 6, 2, 1, 1, 3, 9, 26, 38];

  return (
    <div class="timeline" role="img" aria-label="distribution of modification times">
      {buckets.map((weight) => (
        <span class="timeline__bar" style={{ height: `${Math.min(100, weight * 2.2)}%` }} />
      ))}
    </div>
  );
}
""",
    f"{BETA}/src/hooks/useVirtualList.ts": """import { createSignal, type Accessor } from 'solid-js';

export interface Range {
  start: number;
  end: number;
}

/** Windowed range over a fixed-height list. Overscan absorbs fast wheel events. */
export function useVirtualList(count: Accessor<number>, rowHeight: number, overscan = 8) {
  const [range, setRange] = createSignal<Range>({ start: 0, end: 40 });

  const onScroll = (el: HTMLElement) => {
    const visible = Math.ceil(el.clientHeight / rowHeight) + overscan;
    const start = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);
    setRange({ start, end: Math.min(count(), start + visible) });
  };

  return { range, onScroll };
}
""",
    f"{BETA}/src/lib/format.ts": """const UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatWhen(ms: number, now = Date.now()): string {
  const delta = Math.max(0, now - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < minute) return 'just now';
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < 7 * day) return `${Math.floor(delta / day)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

export function middleEllipsis(name: string, max = 48): string {
  if (name.length <= max) return name;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`;
}
""",
    f"{BETA}/src/styles/tokens.css": """:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --row-height: 32px;
  --row-hover: color-mix(in oklab, var(--fg) 8%, transparent);
  --row-selected: color-mix(in oklab, var(--accent) 16%, transparent);
  --fg: #0f172a;
  --bg: #f8fafc;
  --accent: #4f46e5;
}

@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e2e8f0;
    --bg: #0b1220;
    --accent: #818cf8;
  }
}

.row:hover {
  background: var(--row-hover);
}

.row[aria-selected='true'] {
  background: var(--row-selected);
}

.row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
""",
    f"{BETA}/tests/format.test.ts": """import { describe, expect, it } from 'vitest';

import { formatSize, formatWhen, middleEllipsis } from '../src/lib/format';

describe('formatSize', () => {
  it('keeps bytes unitless', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
  });

  it('steps up units', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });

  it('rejects nonsense', () => {
    expect(formatSize(Number.NaN)).toBe('—');
  });
});

describe('formatWhen', () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0);

  it('uses relative units up to a week', () => {
    expect(formatWhen(now - 30_000, now)).toBe('just now');
    expect(formatWhen(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe('3h ago');
  });
});

describe('middleEllipsis', () => {
  it('preserves the extension', () => {
    const out = middleEllipsis('a-very-long-generated-report-name-2026-10-14.md', 24);
    expect(out.endsWith('.md')).toBe(true);
    expect(out).toContain('…');
  });
});
""",
    f"{BETA}/public/assets/hero.svg": """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 120" role="img" aria-label="Filament explorer">
  <defs>
    <linearGradient id="h" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22d3ee"/>
      <stop offset="0.55" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <rect width="320" height="120" rx="12" fill="#0b1220"/>
  <g fill="url(#h)">
    <rect x="18" y="26" width="120" height="10" rx="5"/>
    <rect x="18" y="46" width="196" height="10" rx="5" opacity="0.7"/>
    <rect x="18" y="66" width="152" height="10" rx="5" opacity="0.5"/>
    <rect x="18" y="86" width="84" height="10" rx="5" opacity="0.35"/>
  </g>
</svg>
""",
    f"{BETA}/public/assets/patterns/grid.svg": """<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0v48" fill="none" stroke="currentColor" stroke-opacity="0.08"/>
    </pattern>
  </defs>
  <rect width="48" height="48" fill="url(#grid)"/>
</svg>
""",
    f"{BETA}/assets/data/fixtures.json": """{
  "entries": [
    { "name": "notes", "kind": "directory", "size": 0, "modifiedMs": 1793263200000 },
    { "name": "photos", "kind": "directory", "size": 0, "modifiedMs": 1793349600000 },
    { "name": "catalog.csv", "kind": "file", "size": 624512, "modifiedMs": 1793436000000 },
    { "name": "export.json", "kind": "file", "size": 3145728, "modifiedMs": 1793522400000 },
    { "name": "release-2026-10.zip", "kind": "archive", "size": 184320, "modifiedMs": 1793608800000 }
  ],
  "cursor": null,
  "directoryHash": "5f2a9c1e"
}
""",
})


def png_swatch(width: int, height: int, c0, c1, accent, seed: int) -> bytes:
    """Small gradient PNG used for icons and screenshots inside the trees."""
    rng = rng_for(f"swatch-{seed}", 7)
    img = bytearray(width * height * 3)
    for y in range(height):
        t = y / max(1, height - 1)
        for x in range(width):
            u = x / max(1, width - 1)
            k = (u * 0.45 + t * 0.55)
            r = int(lerp(c0[0], c1[0], k))
            g = int(lerp(c0[1], c1[1], k))
            b = int(lerp(c0[2], c1[2], k))
            # A soft diagonal band keeps the swatch from looking like a plain ramp.
            band = math.exp(-(((u - t) / 0.18) ** 2)) * 0.32
            r = int(r + (accent[0] - r) * band)
            g = int(g + (accent[1] - g) * band)
            b = int(b + (accent[2] - b) * band)
            i = (y * width + x) * 3
            img[i] = clamp(r, 0, 255)
            img[i + 1] = clamp(g, 0, 255)
            img[i + 2] = clamp(b, 0, 255)
    return png_bytes(width, height, bytes(img), 9)


def generated_rust(target: int = 240_000) -> str:
    """A large generated-looking Rust file (>200 KB) for the size column."""
    rng = rng_for("projects/alpha/assets/generated/schema-2026.rs", 11)
    header = (
        "// @generated by stratum-codegen 0.7.3 on 2026-10-11T09:14:22Z\n"
        "// Source of truth: schema/listing.toml\n"
        "// Regenerate with: cargo xtask schema --rust\n"
        "#![allow(clippy::all, dead_code, unused_variables)]\n\n"
        "use serde::{Deserialize, Serialize};\n\n"
    )
    parts = [header]
    size = len(header)
    field_types = [
        ("id", "u64"), ("name", "String"), ("size_bytes", "u64"), ("modified_ms", "i64"),
        ("mime", "String"), ("parent", "String"), ("inode", "u64"), ("device", "u64"),
        ("mode", "u32"), ("checksum", "String"), ("extension", "String"), ("owner", "String"),
    ]
    kinds = ["File", "Directory", "Archive", "Symlink", "Socket", "Fifo"]
    while size < target:
        n = rng.randint(1000, 9999)
        fields = rng.sample(field_types, k=rng.randint(5, 10))
        block = [f"#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]",
                 f"pub struct Listing{n} {{"]
        for name, ty in fields:
            block.append(f"    pub {name}: {ty},")
        block.append("}")
        block.append("")
        block.append(f"impl Listing{n} {{")
        block.append("    pub const KIND: &'static str = " + repr(rng.choice(kinds)).replace("'", '"') + ";")
        block.append("    pub fn field_count(&self) -> usize {")
        block.append(f"        {len(fields)}")
        block.append("    }")
        block.append("")
        block.append("    pub fn is_large(&self) -> bool {")
        block.append("        self.size_bytes > 1 << 20")
        block.append("    }")
        block.append("}")
        block.append("")
        block.append(f"pub fn decode_{n}(bytes: &[u8]) -> Result<Listing{n}, DecodeError> {{")
        block.append(f"    if bytes.len() < {len(fields) * 8} {{")
        block.append("        return Err(DecodeError::Truncated);")
        block.append("    }")
        block.append(f"    Ok(Listing{n}::default())")
        block.append("}")
        block.append("")
        chunk = "\n".join(block) + "\n"
        parts.append(chunk)
        size += len(chunk)
    parts.append(
        "#[derive(Debug, thiserror::Error)]\n"
        "pub enum DecodeError {\n"
        "    #[error(\"buffer ended before the record did\")]\n"
        "    Truncated,\n"
        "    #[error(\"unknown tag {0}\")]\n"
        "    UnknownTag(u8),\n"
        "}\n"
    )
    return "".join(parts)


def generate_projects(w: TreeWriter, stats: dict) -> None:
    for rel, text in PROJECT_FILES.items():
        w.write_text(rel, text)
    w.write_bytes(
        f"{ALPHA}/assets/icon-256.png",
        png_swatch(256, 160, (15, 23, 42), (56, 189, 248), (129, 140, 248), 1),
    )
    w.write_bytes(
        f"{BETA}/assets/screenshots/list-dark.png",
        png_swatch(320, 200, (11, 18, 32), (30, 41, 59), (99, 102, 241), 2),
    )
    big = generated_rust()
    w.write_bytes(f"{ALPHA}/assets/generated/schema-2026.rs", big.encode("utf-8"))
    count = len(PROJECT_FILES) + 3
    total = sum(len(t.encode("utf-8")) for t in PROJECT_FILES.values()) + len(big) + 256 * 160 * 3 + 320 * 200 * 3
    stats["projects"] = {"files": count, "bytes": total}


# --------------------------------------------------------------------------- #
# photos/ and music/
# --------------------------------------------------------------------------- #


def generate_photos(w: TreeWriter, stats: dict) -> dict:
    """Render every photo once and keep the bytes so photos.zip can reuse them."""
    blobs = {}
    total = 0
    for fname, fn, _desc in PHOTOS:
        data = png_bytes(W, H, fn(), 6)
        w.write_bytes(f"photos/{fname}", data)
        blobs[fname] = data
        total += len(data)
    stats["photos"] = {"files": len(PHOTOS), "bytes": total}
    return blobs


def music_tracks():
    """Three short, tonal WAV files (44.1 kHz, 16-bit mono, 2-4 s, < 400 KB)."""
    sr = 44100
    tracks = []

    # 1. A slow warm pad on a Cmaj9 voicing.
    duration = 3.2
    voicing = [130.81, 164.81, 196.00, 246.94, 293.66]
    n = int(sr * duration)
    samples = []
    for i in range(n):
        t = i / sr
        attack = min(1.0, t / 0.45)
        release = min(1.0, (duration - t) / 0.9)
        env = (attack * release) ** 1.4
        vib = 1.0 + 0.0022 * math.sin(2 * math.pi * 4.6 * t)
        acc = 0.0
        for k, f in enumerate(voicing):
            detune = 1.0 + (k - 2) * 0.0007
            phase = 2 * math.pi * f * detune * vib * t
            acc += math.sin(phase)
            acc += 0.32 * math.sin(2 * phase)
            acc += 0.12 * math.sin(3 * phase)
        samples.append(acc / (len(voicing) * 1.44) * env)
    tracks.append(("warm-chord.wav", samples, "Cmaj9 pad, slow attack"))

    # 2. A pentatonic pluck arpeggio in A minor.
    duration = 3.0
    n = int(sr * duration)
    notes = [220.00, 261.63, 293.66, 329.63, 392.00, 440.00, 392.00, 329.63]
    spacing = duration / len(notes)
    samples = []
    for i in range(n):
        t = i / sr
        acc = 0.0
        for idx, f in enumerate(notes):
            start = idx * spacing
            if t < start:
                continue
            dt = t - start
            env = math.exp(-dt * 5.2) * min(1.0, dt / 0.006)
            if env < 1e-5:
                continue
            phase = 2 * math.pi * f * dt
            acc += env * (math.sin(phase) + 0.30 * math.sin(2 * phase) + 0.10 * math.sin(3 * phase))
        samples.append(acc * 0.34)
    tracks.append(("pentatonic-pluck.wav", samples, "A minor pentatonic arpeggio"))

    # 3. A low bass pulse with a fifth on top.
    duration = 2.6
    n = int(sr * duration)
    samples = []
    for i in range(n):
        t = i / sr
        trem = 0.72 + 0.28 * math.sin(2 * math.pi * 2.5 * t)
        env = min(1.0, t / 0.05) * min(1.0, (duration - t) / 0.25)
        acc = 0.0
        for f, amp in ((55.0, 1.0), (82.41, 0.42), (110.0, 0.24)):
            phase = 2 * math.pi * f * t
            acc += amp * (math.sin(phase) + 0.18 * math.sin(2 * phase))
        samples.append(acc * 0.30 * trem * env)
    tracks.append(("bass-pulse.wav", samples, "A1 + E2 pulse"))
    return tracks


def generate_music(w: TreeWriter, stats: dict) -> None:
    total = 0
    for fname, samples, _desc in music_tracks():
        peak = max(1e-9, max(abs(s) for s in samples))
        norm = [s / peak * 0.90 for s in samples]
        data = wav_bytes(norm, 44100)
        w.write_bytes(f"music/{fname}", data)
        total += len(data)
    stats["music"] = {"files": 3, "bytes": total}


# --------------------------------------------------------------------------- #
# data/ - a big CSV, a config file, a ~3 MB JSON export and an ~8 MB log
# --------------------------------------------------------------------------- #

ADJECTIVES = ["matte", "brushed", "polished", "woven", "ribbed", "frosted", "anodised", "quilted",
              "cast", "forged", "lacquered", "tempered", "sanded", "glazed", "knurled", "pleated"]
MATERIALS = ["ceramic", "walnut", "birch", "brass", "slate", "linen", "copper", "bamboo",
             "granite", "cork", "resin", "steel", "clay", "glass", "oak", "felt"]
NOUNS = ["kettle", "lamp", "planter", "tray", "mug", "stool", "shelf", "vase", "diffuser", "basket",
         "tray", "carafe", "board", "candle", "clock", "frame", "hook", "mat", "bowl", "pot"]
CATEGORIES = ["kitchen", "lighting", "storage", "textiles", "garden", "office", "bath", "decor"]
SUBCATS = ["small", "large", "outdoor", "sets", "refills", "bundles", "limited"]


def make_catalog_csv(rows: int = 5000) -> str:
    rng = rng_for("data/catalog.csv")
    out = ["sku,name,category,subcategory,price_cents,currency,stock,rating,updated_at,tags"]
    for i in range(1, rows + 1):
        adj = rng.choice(ADJECTIVES)
        mat = rng.choice(MATERIALS)
        noun = rng.choice(NOUNS)
        cat = rng.choice(CATEGORIES)
        sub = rng.choice(SUBCATS)
        price = rng.choice([899, 1250, 1499, 1999, 2450, 3200, 4999, 6500, 8999, 12500, 18900])
        stock = rng.randint(0, 420)
        rating = round(rng.uniform(3.1, 5.0), 1)
        day = rng.randint(1, 28)
        tags = "|".join(rng.sample(["new", "sale", "eco", "handmade", "bestseller", "limited", "refill"], k=rng.randint(1, 3)))
        name = f"{adj.capitalize()} {mat} {noun}"
        out.append(
            f"SKU-{i:05d},{name},{cat},{sub},{price},EUR,{stock},{rating},2026-10-{day:02d}T09:00:00Z,{tags}"
        )
    return "\n".join(out) + "\n"


def make_config_toml() -> str:
    return """# Filament daemon configuration (demo instance).
# Every path is resolved against the process working directory.

[server]
serve = "./demo"
bind = "127.0.0.1"
port = 7788
# Directory listings are streamed, so this only bounds a single page.
max_page = 5000
request_timeout_secs = 30

[auth]
# A token is minted at startup and printed once. Set a fixed value for containers.
mode = "ephemeral"
allow_anonymous_read = false

[preview]
# The preview pane fetches the head of a file, so big files stay cheap.
head_bytes = 65536
inline_image_max_bytes = 33554432
thumbnail_px = 256

[thumbnails]
cache_dir = "~/.cache/filament/thumbs"
ttl_secs = 90
workers = 4

[search]
# Filenames only by default; content indexing is opt-in because it is expensive.
index_contents = false
max_results = 500
fuzzy = true

[watcher]
enabled = true
debounce_ms = 120
ignore = ["*.tmp", "*.swp", ".git/*", "node_modules/*"]

[plugins]
enabled = true
dir = "./plugins"
# A misbehaving plugin is reported and disabled instead of crashing the daemon.
restart_on_trap = true

[[plugins.mount]]
id = "zip-vfs"
extensions = ["zip"]

[trash]
# Deletes go to the system trash when available.
enabled = true
fallback = "permanent"

[logging]
level = "info"
format = "text"
# Set to "json" when shipping to a log collector.
""".rstrip() + "\n"


def make_export_json(target: int = 3_000_000) -> str:
    rng = rng_for("data/export.json")

    def record(i: int) -> dict:
        adj = rng.choice(ADJECTIVES)
        mat = rng.choice(MATERIALS)
        noun = rng.choice(NOUNS)
        return {
            "id": i,
            "sku": f"SKU-{i:05d}",
            "name": f"{adj.capitalize()} {mat} {noun}",
            "category": rng.choice(CATEGORIES),
            "price_cents": rng.choice([899, 1499, 2450, 4999, 8999, 12500, 18900]),
            "stock": rng.randint(0, 420),
            "rating": round(rng.uniform(3.1, 5.0), 1),
            "updated_at": f"2026-10-{rng.randint(1, 28):02d}T09:00:00Z",
            "tags": rng.sample(["new", "sale", "eco", "handmade", "bestseller", "limited", "refill"],
                               k=rng.randint(1, 3)),
            "attributes": {
                "colour": rng.choice(["sand", "slate", "moss", "ember", "ivory", "ink", "clay"]),
                "weight_g": rng.randint(80, 4200),
                "packaged": rng.random() < 0.8,
            },
        }

    records = [record(i) for i in range(1200)]
    doc = {
        "export_version": 3,
        "generated_at": GENERATED_AT,
        "source": "filament-inventory",
        "records": records,
    }
    blob = json.dumps(doc, separators=(",", ":"), sort_keys=True)
    per_record = max(1.0, (len(blob) - 200) / len(records))

    # Grow (or shrink) the record count until the document lands at the target.
    want = max(1000, int(target / per_record))
    for _ in range(6):
        records = [record(i) for i in range(want)]
        doc["records"] = records
        doc["summary"] = {
            "records": len(records),
            "categories": len(CATEGORIES),
            "target_bytes": target,
        }
        blob = json.dumps(doc, separators=(",", ":"), sort_keys=True)
        if abs(len(blob) - target) <= target * 0.02:
            break
        want = int(want * target / max(1, len(blob)))
        want = max(1000, min(want, 400_000))
    return blob + "\n"


def make_big_log(target: int = 8 * 1024 * 1024) -> str:
    rng = rng_for("data/big.log")
    components = ["fsapi", "list", "watch", "search", "thumb", "plugins", "ws", "db", "auth", "ops"]
    levels = [("DEBUG", 6), ("INFO", 10), ("WARN", 2), ("ERROR", 1)]
    level_pool = [lv for lv, w in levels for _ in range(w)]
    messages = {
        "DEBUG": [
            "cache hit for key={key}",
            "streamed {n} entries from {dir}",
            "debounced {n} filesystem events",
            "thumbnail reused for {file}",
            "cursor page {n} prepared",
        ],
        "INFO": [
            "listed {dir} in {ms}ms ({n} entries)",
            "preview served for {file} ({n} bytes)",
            "index rebuild finished in {ms}ms",
            "watcher attached to {dir}",
            "plugin {plugin} loaded in {ms}ms",
            "auth token minted for scope={dir}",
        ],
        "WARN": [
            "slow directory read on {dir} took {ms}ms",
            "thumbnail decode fallback for {file}",
            "websocket client backpressure, dropping {n} frames",
            "plugin {plugin} exceeded {ms}ms per call",
        ],
        "ERROR": [
            "failed to open {file}: permission denied",
            "upload aborted after {n} chunks",
            "thumbnail worker crashed, restarting ({n} restarts)",
        ],
    }
    dirs = ["demo/photos", "demo/notes", "demo/many", "demo/data", "demo/projects/alpha",
            "demo/projects/beta", "demo/music", "demo/archive"]
    files = ["demo/data/export.json", "demo/data/big.log", "demo/photos/dunes.png",
             "demo/photos/aurora.png", "demo/music/warm-chord.wav", "demo/notes/api-design.md",
             "demo/many/f1042.txt", "demo/archive/photos.zip"]
    plugins = ["zip-vfs", "git-status", "image-meta", "trash-bridge"]

    out = []
    size = 0
    ts = BASE_TS - 6 * 3600
    i = 0
    while size < target:
        i += 1
        ts += rng.uniform(0.001, 0.05)
        level = rng.choice(level_pool)
        comp = rng.choice(components)
        msg = rng.choice(messages[level])
        msg = (msg.replace("{key}", f"{rng.getrandbits(32):08x}")
                  .replace("{n}", str(rng.randint(1, 5000)))
                  .replace("{dir}", rng.choice(dirs))
                  .replace("{file}", rng.choice(files))
                  .replace("{ms}", str(rng.choice([3, 7, 12, 24, 41, 88, 156, 340, 920])))
                  .replace("{plugin}", rng.choice(plugins)))
        line = (
            f"{time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(ts))}"
            f".{int(ts * 1000) % 1000:03d}Z {level:<5} [{comp}] "
            f"req={rng.getrandbits(48):012x} {msg}\n"
        )
        out.append(line)
        size += len(line)
    return "".join(out)


def generate_data(w: TreeWriter, stats: dict) -> None:
    csv_text = make_catalog_csv(5000)
    toml_text = make_config_toml()
    json_text = make_export_json()
    log_text = make_big_log()
    w.write_text("data/catalog.csv", csv_text)
    w.write_text("data/config.toml", toml_text)
    w.write_text("data/export.json", json_text)
    w.write_text("data/big.log", log_text)
    stats["data"] = {
        "files": 4,
        "bytes": len(csv_text) + len(toml_text) + len(json_text) + len(log_text),
    }


# --------------------------------------------------------------------------- #
# archive/ - two ZIP archives (zip-vfs plugin showcase)
# --------------------------------------------------------------------------- #

ZIP_DATE = (2026, 10, 25, 12, 0, 0)


def _zip_write(zf: zipfile.ZipFile, name: str, data: bytes) -> None:
    info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    zf.writestr(info, data)


def build_release_zip() -> bytes:
    rng = rng_for("archive/release-2026-10.zip")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        _zip_write(zf, "release-2026-10/README.md", """# Filament 0.9.0 — October 2026

Browsable release bundle. Nested directories exist purely to exercise the
zip-vfs plugin's tree view: docs, sources, assets, and one deliberately deep
path.
""".encode())
        _zip_write(zf, "release-2026-10/manifest.json", json.dumps({
            "name": "filament", "version": "0.9.0", "channel": "stable",
            "commit": "b41f7c2", "built_at": GENERATED_AT,
            "targets": ["x86_64-unknown-linux-gnu", "aarch64-apple-darwin"],
            "artifacts": [
                {"name": "filament-x86_64-unknown-linux-gnu.tar.gz", "bytes": 4_812_443},
                {"name": "filament-aarch64-apple-darwin.tar.gz", "bytes": 4_512_908},
            ],
        }, indent=2).encode() + b"\n")
        _zip_write(zf, "release-2026-10/docs/CHANGELOG.md", """# Changelog 0.9.0

## Added
- Zip archives are browsable without extraction.
- Per-directory sort preference that survives restarts.
- Health endpoint reporting plugin state and cache size.

## Fixed
- Byte formatting above 1 GiB.
- Websocket reconnect leak.
- Thumbnail eviction under sustained load.
""".encode())
        _zip_write(zf, "release-2026-10/docs/UPGRADING.md", """# Upgrading to 0.9.0

1. Stop the service.
2. Back up the cache directory (a copy is enough; it is disposable).
3. Deploy the new binary and start the service.
4. Confirm `/api/health` reports three plugins loaded.

Rollback is a redeploy of the previous image followed by a cache flush.
""".encode())
        _zip_write(zf, "release-2026-10/src/main.rs", """fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = filament::Args::parse(std::env::args())?;
    filament::serve(args)
}
""".encode())
        _zip_write(zf, "release-2026-10/src/lib.rs", """pub mod fsapi;
pub mod list;
pub mod plugins;
pub mod vfs;
pub mod watch;

pub use vfs::Vfs;
""".encode())
        _zip_write(zf, "release-2026-10/src/vfs/mod.rs", """//! Virtual filesystem layer: every source (disk, zip, plugin) implements `Vfs`.
pub mod zip;

pub trait Vfs {
    fn list(&self, path: &str) -> Result<Vec<String>, VfsError>;
    fn read(&self, path: &str, max: usize) -> Result<Vec<u8>, VfsError>;
}

#[derive(Debug, thiserror::Error)]
pub enum VfsError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("unsupported operation")]
    Unsupported,
}
""".encode())
        _zip_write(zf, "release-2026-10/src/vfs/zip.rs", """use super::{Vfs, VfsError};

pub struct ZipVfs {
    archive: zip::ZipArchive<std::fs::File>,
}

impl ZipVfs {
    pub fn open(path: &str) -> Result<Self, VfsError> {
        let file = std::fs::File::open(path).map_err(|_| VfsError::NotFound(path.into()))?;
        let archive = zip::ZipArchive::new(file).map_err(|_| VfsError::Unsupported)?;
        Ok(Self { archive })
    }
}
""".encode())
        _zip_write(zf, "release-2026-10/assets/icon.png",
                   png_swatch(64, 64, (15, 23, 42), (94, 234, 212), (99, 102, 241), 5))
        _zip_write(zf, "release-2026-10/assets/palette.json", json.dumps({
            "accent": "#4f46e5", "surface": "#f8fafc", "ink": "#0f172a",
        }, indent=2).encode() + b"\n")
        _zip_write(zf, "release-2026-10/licenses/Apache-2.0.txt", """Apache License 2.0 (abbreviated copy)

Licensed under the Apache License, Version 2.0 (the "License"); you may not use
this file except in compliance with the License. You may obtain a copy of the
License at http://www.apache.org/licenses/LICENSE-2.0
""".encode())
        _zip_write(
            zf,
            "release-2026-10/deep/nested/path/for/testing/filament/zip/vfs/README.txt",
            ("This file sits eight directories deep inside the archive.\n"
             "It exists so the zip-vfs plugin's tree view and breadcrumb bar have\n"
             "something genuinely awkward to render.\n"
             + "\n".join(f"filler line {i:03d} — total depth 8" for i in range(1, 41)) + "\n").encode(),
        )
        _zip_write(zf, "release-2026-10/notes/measurements.md",
                   build_markdown("archive/release-2026-10/notes/measurements.md", "research",
                                  "Release measurements", 4096).encode())
        _zip_write(zf, "release-2026-10/seed.txt",
                   "".join(f"{rng.randint(10**6, 10**7)}:seed\n" for _ in range(400)).encode())
    return buf.getvalue()


def build_photos_zip(photos: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        _zip_write(zf, "photos/README.txt",
                   ("Four full-size renders from the procedural photo set.\n"
                    "Open any of them inside the archive to check the image preview.\n").encode())
        for name in ("dunes.png", "aurora.png", "topo.png", "sunset.png"):
            if name in photos:
                _zip_write(zf, f"photos/{name}", photos[name])
        _zip_write(zf, "photos/contact-sheet.txt",
                   "\n".join(f"{i:02d}. {n}" for i, (n, _f, _d) in enumerate(PHOTOS)) + "\n")
    return buf.getvalue()


def generate_archive(w: TreeWriter, stats: dict, photos: dict) -> None:
    release = build_release_zip()
    pics = build_photos_zip(photos)
    w.write_bytes("archive/release-2026-10.zip", release)
    w.write_bytes("archive/photos.zip", pics)
    stats["archive"] = {"files": 2, "bytes": len(release) + len(pics)}


# --------------------------------------------------------------------------- #
# many/ - 2000 tiny text files for the virtualization / performance demo
# --------------------------------------------------------------------------- #

MANY_LINES = [
    "queue depth {n}, drained in {ms}ms",
    "shard {n} checksum {hex}",
    "worker {n} idle",
    "row {n}: {word} — {word2}",
    "batch {n} committed",
    "sample {n}: {ms}ms, {hex}",
    "TODO({n}): revisit after the spike",
    "key {hex} → value {n}",
]


def generate_many(w: TreeWriter, stats: dict, count: int = 2000) -> None:
    rng = rng_for("many/")
    words = ["alder", "birch", "cedar", "dune", "ember", "fjord", "gale", "harbor", "iris", "juniper",
             "kelp", "lagoon", "mesa", "nimbus", "onyx", "palette", "quartz", "reef", "slate", "tide"]
    total = 0
    for i in range(1, count + 1):
        line = rng.choice(MANY_LINES)
        text = (line.replace("{n}", str(i))
                    .replace("{ms}", str(rng.choice([2, 5, 11, 23, 47, 96, 213])))
                    .replace("{hex}", f"{rng.getrandbits(24):06x}")
                    .replace("{word2}", rng.choice(words)).replace("{word}", rng.choice(words)))
        blob = (text + "\n").encode("utf-8")
        w.write_bytes(f"many/f{i:04d}.txt", blob)
        total += len(blob)
    stats["many"] = {"files": count, "bytes": total}


# --------------------------------------------------------------------------- #
# demo/readme.md - explains the tree
# --------------------------------------------------------------------------- #


def build_demo_readme() -> str:
    return f"""# Filament demo tree

A deliberately varied file tree for exercising the Filament file manager:
directory listings, thumbnails, previews, audio playback, archive browsing, and
a folder large enough to make virtualization visible. Total size is roughly
30 MB and every file is generated, so it is safe to delete and rebuild.

```bash
python3 scripts/make_demo.py            # rebuild everything (idempotent)
python3 scripts/make_demo.py --only many,photos
filament --serve ./demo                 # point the daemon at this directory
```

## What each folder is for

| Folder | Contents | What it exercises |
| --- | --- | --- |
| `notes/` | {len(NOTES)} markdown and text notes, {kb(0.2):.0f} B to {kb(20)} | Preview pane, markdown rendering, varied sizes |
| `notes/design/`, `notes/research/`, `notes/archive/2026-q3/legacy/` | nested subfolders | Breadcrumbs, deep navigation |
| `projects/alpha/` | Rust crate (Cargo, src, tests, benches, docs, assets) | Source tree rendering, syntax preview |
| `projects/beta/` | TypeScript app (src, tests, public, assets) | Mixed file types, deep asset paths |
| `projects/alpha/assets/generated/schema-2026.rs` | one generated file over 200 KB | Large-file handling in the editor view |
| `photos/` | {len(PHOTOS)} procedural PNGs at {W}x{H} | Thumbnail grid, image preview, gallery density |
| `music/` | 3 WAV files, 44.1 kHz 16-bit mono, 2-4 s | Audio preview playback |
| `data/` | `catalog.csv` (5000 rows), `config.toml`, `export.json` (~3 MB), `big.log` (~8 MB) | Preview head truncation, large metadata |
| `archive/` | `release-2026-10.zip` (nested tree + deep path), `photos.zip` | zip-vfs plugin, archive browsing without extraction |
| `many/` | 2000 tiny `f0001.txt`-`f2001.txt` files | Virtualized listing performance, bulk operations |

## Notes

* No folder contains a `.git` directory; `.gitignore` files are kept because they
  are ordinary files in these fake trees.
* Modification times are spread across roughly five months so the date column
  has something to sort by; they are deterministic, not "now".
* Regeneration is byte-for-byte reproducible: the generator seeds every stream
  and stamps every file from a fixed clock.
* `photos/*.png`, `music/*.wav`, `data/*` and the archives are generated in pure
  Python (zlib + struct), with no image or audio libraries.
"""


def generate_readme(w: TreeWriter, stats: dict) -> None:
    text = build_demo_readme()
    w.write_text("readme.md", text)
    stats["readme.md"] = {"files": 1, "bytes": len(text.encode("utf-8"))}


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #

SECTIONS = ["notes", "projects", "photos", "music", "data", "archive", "many", "readme"]

SECTION_TARGETS = {
    "notes": ["notes"],
    "projects": ["projects"],
    "photos": ["photos"],
    "music": ["music"],
    "data": ["data"],
    "archive": ["archive"],
    "many": ["many"],
    "readme": ["readme.md"],
}


def clean_section(root: Path, section: str) -> None:
    resolved = root.resolve()
    for name in SECTION_TARGETS[section]:
        target = (resolved / name).resolve()
        if target.parent != resolved:
            raise SystemExit(f"refusing to remove out-of-tree path: {target}")
        if target.is_dir():
            shutil.rmtree(target)
        elif target.exists():
            target.unlink()


def walk_summary(root: Path) -> list[dict]:
    rows = []
    for entry in sorted(root.iterdir(), key=lambda p: (p.is_file(), p.name)):
        if entry.is_dir():
            files = [p for p in entry.rglob("*") if p.is_file()]
            dirs = [p for p in entry.rglob("*") if p.is_dir()]
            rows.append({
                "name": entry.name + "/",
                "files": len(files),
                "dirs": len(dirs),
                "bytes": sum(p.stat().st_size for p in files),
            })
        else:
            rows.append({"name": entry.name, "files": 1, "dirs": 0, "bytes": entry.stat().st_size})
    return rows


def print_summary(root: Path, elapsed: float) -> None:
    rows = walk_summary(root)
    total_files = sum(r["files"] for r in rows)
    total_dirs = sum(r["dirs"] for r in rows)
    total_bytes = sum(r["bytes"] for r in rows)

    name_w = max(len("path"), *(len(r["name"]) for r in rows)) if rows else 6
    print()
    print(f"demo tree at {root}")
    print(f"{'path'.ljust(name_w)} {'files':>8} {'dirs':>7} {'size':>12}")
    print(f"{'-' * name_w} {'-' * 8} {'-' * 7} {'-' * 12}")
    for r in rows:
        print(f"{r['name'].ljust(name_w)} {r['files']:>8} {r['dirs']:>7} {human(r['bytes']):>12}")
    print(f"{'-' * name_w} {'-' * 8} {'-' * 7} {'-' * 12}")
    print(f"{'TOTAL'.ljust(name_w)} {total_files:>8} {total_dirs:>7} {human(total_bytes):>12}")
    print(f"\n{total_bytes:,} bytes total in {elapsed:.1f}s")
    print(f"demo/many holds {len(list((root / 'many').glob('*.txt')))} files")


def print_tree(root: Path, max_depth: int = 2) -> None:
    print()

    def walk(path: Path, prefix: str, depth: int) -> None:
        entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        for i, entry in enumerate(entries):
            last = i == len(entries) - 1
            branch = "└── " if last else "├── "
            if entry.is_dir():
                member_files = [p for p in entry.rglob("*") if p.is_file()]
                count = len(member_files)
                size = sum(p.stat().st_size for p in member_files)
                print(f"{prefix}{branch}{entry.name}/  ({count} files, {human(size)})")
                if depth < max_depth:
                    walk(entry, prefix + ("    " if last else "│   "), depth + 1)
            else:
                print(f"{prefix}{branch}{entry.name}  ({human(entry.stat().st_size)})")

    print(f"{root.name}/")
    walk(root, "", 1)


def parse_args(argv: list[str]) -> tuple[Path, list[str] | None, bool]:
    root = DEFAULT_DEMO_ROOT
    only = None
    explicit = False
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--root":
            i += 1
            if i >= len(argv):
                raise SystemExit("--root needs a directory")
            root = Path(argv[i]).expanduser()
            explicit = True
        elif arg.startswith("--root="):
            root = Path(arg.split("=", 1)[1]).expanduser()
            explicit = True
        elif arg == "--only":
            i += 1
            if i >= len(argv):
                raise SystemExit("--only needs a comma-separated list")
            only = [s.strip() for s in argv[i].split(",") if s.strip()]
        elif arg.startswith("--only="):
            only = [s.strip() for s in arg.split("=", 1)[1].split(",") if s.strip()]
        elif arg in ("-h", "--help"):
            print(__doc__)
            raise SystemExit(0)
        else:
            raise SystemExit(f"unknown argument: {arg}")
        i += 1
    return root, only, explicit


def verify_root(root: Path, explicit: bool) -> Path:
    resolved = root.resolve()
    if resolved in (Path("/"), Path.home(), REPO_ROOT.resolve()):
        raise SystemExit(f"refusing to write into {resolved}")
    if not explicit and (resolved.name != "demo" or resolved.parent.name != "filament"):
        raise SystemExit(
            f"unexpected demo root {resolved}; pass --root to write elsewhere"
        )
    return resolved


def main(argv: list[str] | None = None) -> int:
    started = time.perf_counter()
    args = sys.argv[1:] if argv is None else argv
    root, only, explicit = parse_args(args)
    root = verify_root(root, explicit)
    root.mkdir(parents=True, exist_ok=True)

    sections = SECTIONS if not only else only
    unknown = [s for s in sections if s not in SECTIONS]
    if unknown:
        raise SystemExit(f"unknown section(s): {', '.join(unknown)} (choose from {', '.join(SECTIONS)})")

    w = TreeWriter(root)
    stats: dict = {}
    photos: dict = {}

    for section in sections:
        clean_section(root, section)
        t0 = time.perf_counter()
        if section == "notes":
            generate_notes(w, stats)
        elif section == "projects":
            generate_projects(w, stats)
        elif section == "photos":
            photos = generate_photos(w, stats)
        elif section == "music":
            generate_music(w, stats)
        elif section == "data":
            generate_data(w, stats)
        elif section == "archive":
            if not photos:
                # Read the already-rendered PNGs back so the archive matches them.
                photos = {n: (root / "photos" / n).read_bytes()
                          for n, _f, _d in PHOTOS if (root / "photos" / n).exists()}
            generate_archive(w, stats, photos)
        elif section == "many":
            generate_many(w, stats)
        elif section == "readme":
            generate_readme(w, stats)
        print(f"  {section:<9} {time.perf_counter() - t0:6.2f}s", flush=True)

    w.stamp_dirs()
    print_summary(root, time.perf_counter() - started)
    print_tree(root, 2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
