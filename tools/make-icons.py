"""生成扩展图标（16/32/48/128）。

纯标准库：zlib + struct 手写 PNG，不引任何图像库 —— 项目是零依赖的，
为了四个图标装 Pillow 不值当。改图标就改下面的数字，然后

    python tools/make-icons.py

图案：圆角方块铺页面自己那层兜底渐变（蓝紫），上面一轮白色朝阳压着地平线。
对应「朝暮」：一天开始的地方，也正好是这页打开时看到的东西。
16px 下只剩「一个圆 + 一条线」，所以两者都比常规比例粗一号、留白给足。
"""

import math
import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "src" / "icons"

# 形状参数，都是相对边长的比例
CORNER = 0.235          # 圆角半径
SUN = (0.5, 0.455, 0.185)   # 圆心 x, y, 半径
LINE_Y = 0.632          # 地平线顶边
LINE_H = 0.058          # 地平线厚度
LINE_X = (0.235, 0.765)  # 地平线左右端点

# 底色：和 style.css 里 body 那层兜底渐变同一套色（蓝 → 紫 → 深藏青）
BASE = (0x1A, 0x21, 0x33)
GLOWS = [
    # (中心 x, 中心 y, 半径 x, 半径 y, 颜色, 强度)
    (0.16, 0.06, 0.95, 0.72, (0x3D, 0x4D, 0x75), 1.0),
    (0.88, 0.90, 0.85, 0.68, (0x57, 0x3F, 0x66), 1.0),
    (0.62, 0.45, 0.70, 0.60, (0x2B, 0x36, 0x54), 0.9),
]


def background(x, y, n):
    """页面兜底渐变：深色底 + 几个径向光斑。图标整体提亮一点，不然 16px 会糊成一块。"""
    r, g, b = BASE
    for gx, gy, rx, ry, color, strength in GLOWS:
        dx = (x - gx * n) / (rx * n)
        dy = (y - gy * n) / (ry * n)
        d = math.hypot(dx, dy)
        if d >= 1:
            continue
        # 和 CSS 的 radial-gradient 一样：中心满色，到边缘线性淡出
        t = (1 - d) * strength * 1.35
        t = min(1.0, t)
        r += (color[0] - r) * t
        g += (color[1] - g) * t
        b += (color[2] - b) * t
    return min(255.0, r), min(255.0, g), min(255.0, b)


def inside_round_rect(x, y, n):
    radius = CORNER * n
    cx = min(max(x, radius), n - radius)
    cy = min(max(y, radius), n - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def inside_sun(x, y, n):
    sx, sy, sr = SUN
    return (x - sx * n) ** 2 + (y - sy * n) ** 2 <= (sr * n) ** 2


def inside_line(x, y, n):
    top = LINE_Y * n
    bottom = (LINE_Y + LINE_H) * n
    half = LINE_H * n / 2
    left = LINE_X[0] * n
    right = LINE_X[1] * n
    mid = (top + bottom) / 2

    if left <= x <= right and top <= y <= bottom:
        return True
    # 两端的圆头
    for cx in (left, right):
        if (x - cx) ** 2 + (y - mid) ** 2 <= half * half:
            return True
    return False


def render(size, ss=4):
    """超采样 ss 倍再盒式降采样 —— 圆和圆角的抗锯齿全靠这个。"""
    n = size * ss
    acc = [[0.0, 0.0, 0.0, 0.0] for _ in range(size * size)]

    for py in range(n):
        y = py + 0.5
        for px in range(n):
            x = px + 0.5
            if not inside_round_rect(x, y, n):
                continue

            r, g, b = background(x, y, n)
            if inside_sun(x, y, n) or inside_line(x, y, n):
                r = g = b = 255.0

            cell = acc[(py // ss) * size + (px // ss)]
            cell[0] += r
            cell[1] += g
            cell[2] += b
            cell[3] += 1.0

    scale = ss * ss
    raw = bytearray()
    for row in range(size):
        raw.append(0)                       # 每行的过滤器字节
        for col in range(size):
            r, g, b, cover = acc[row * size + col]
            if cover <= 0:
                raw += b"\x00\x00\x00\x00"
                continue
            alpha = cover / scale
            raw += bytes((
                round(r / cover), round(g / cover), round(b / cover),
                round(alpha * 255),
            ))
    return bytes(raw)


def write_png(path, size, raw):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)   # 8 位 RGBA
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", header)
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 48, 128):
        target = OUT_DIR / f"icon{size}.png"
        write_png(target, size, render(size))
        print(f"  {target.relative_to(OUT_DIR.parent.parent)}  "
              f"{target.stat().st_size} 字节")


if __name__ == "__main__":
    main()
