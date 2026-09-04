# -*- coding: utf-8 -*-
"""把 icon.png 转成 Windows 多尺寸 icon.ico。

用法（用自包含运行时跑，不需要额外装 Pillow）：
    tools/runtime/python/python.exe scripts/make-icon.py

为什么手写 ICO 容器：运行时里只有 cv2/numpy，没有 Pillow。ICO 结构简单，手写即可。

为什么每一档都用 DIB 而不是内嵌 PNG：ICO 文件本身两种都允许，但这个 .ico 最终会被
@electron/packager 写进 exe 的 RT_ICON 资源，而 RT_ICON 的原生格式是 DIB。
PNG 压缩条目在部分 Windows 代码路径（资源管理器图标渲染、旧版本系统）上解码不稳定，
表现就是 exe 显示不出图标。DIB 是从 Win95 起一直支持的格式，多占几百 KB 但确定能显示。

多尺寸是必须的——任务栏用 32、桌面大图标用 256，只塞一个尺寸会被系统硬缩放，小图标会糊。
"""
import struct
import sys
from pathlib import Path

import cv2
import numpy as np

# 256 是资源管理器超大图标，16 是标题栏/任务栏小图标，中间几档覆盖常见 DPI 缩放。
SIZES = [16, 24, 32, 48, 64, 128, 256]

root = Path(__file__).resolve().parent.parent
src = root / "icon.png"
dst = root / "icon.ico"

# IMREAD_UNCHANGED 保留 alpha：图标是圆角的，丢了透明通道四个角会变黑块。
source = cv2.imdecode(np.fromfile(str(src), dtype=np.uint8), cv2.IMREAD_UNCHANGED)
if source is None:
    raise SystemExit(f"读不到 {src}")
if source.ndim == 3 and source.shape[2] == 3:
    source = cv2.cvtColor(source, cv2.COLOR_BGR2BGRA)

def to_dib(bgra):
    """把 BGRA 图编码成 ICO 里的 DIB 条目：BITMAPINFOHEADER + XOR 位图 + AND 掩码。"""
    height, width = bgra.shape[:2]

    # biHeight 要写两倍高度，因为 DIB 里 XOR 位图和 AND 掩码是上下拼在一起的。
    # biCompression=0 (BI_RGB)，biSizeImage=0 让系统自己算。
    header = struct.pack("<IiiHHIIiiII", 40, width, height * 2, 1, 32, 0, 0, 0, 0, 0, 0)

    # DIB 是自下而上存储的，所以整幅图先上下翻转。
    xor = np.flipud(bgra).tobytes()

    # 32 位图标靠 alpha 通道做透明，AND 掩码理论上可以全 0；但部分绘制路径仍会读它，
    # 所以按 alpha 老老实实生成：1 = 透明。每行按 4 字节对齐。
    alpha = np.flipud(bgra[:, :, 3])
    row_bytes = ((width + 31) // 32) * 4
    mask = bytearray()
    for row in alpha:
        bits = np.packbits((row == 0).astype(np.uint8))
        padded = bytes(bits) + b"\x00" * (row_bytes - len(bits))
        mask += padded[:row_bytes]

    return header + xor + bytes(mask)


images = []
for size in SIZES:
    # INTER_AREA 是缩小场景画质最好的插值，避免小尺寸下线条断裂。
    resized = cv2.resize(source, (size, size), interpolation=cv2.INTER_AREA)
    images.append((size, to_dib(resized)))

# ICONDIR: reserved=0, type=1(icon), count
header = struct.pack("<HHH", 0, 1, len(images))
offset = len(header) + 16 * len(images)

entries = []
for size, data in images:
    # 宽高字段只有 1 字节，256 用 0 表示。planes=1, bitCount=32。
    entries.append(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(data), offset))
    offset += len(data)

dst.write_bytes(header + b"".join(entries) + b"".join(data for _, data in images))
print(f"写入 {dst.name}：{', '.join(str(size) for size, _ in images)} px，共 {dst.stat().st_size // 1024} KB")
