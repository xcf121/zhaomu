"""打包发布用的 zip。

把 src/ 里的东西原样打进 dist/zhaomu-v<版本>.zip，**manifest.json 在压缩包根目录** ——
这样解压出来就是一个能直接「加载已解压的扩展程序」的目录，也是 Chrome 应用店认的布局。

版本号只从 src/manifest.json 读，别处不再写第二遍。
纯标准库（zipfile），项目零依赖。

    python tools/package.py

打包逻辑另开一个 build_bytes() 给 tools/check_release.py 用 —— 自检要拿「现场打的包」
去比 Release 上的资产，两边必须是同一份代码打出来的，各抄一份迟早走散。
"""

import io
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'src'
OUT_DIR = ROOT / 'dist'

# 打进包里没有任何意义的东西
SKIP_SUFFIX = {'.map'}
SKIP_NAME = {'.DS_Store', 'Thumbs.db'}


def read_manifest():
    return json.loads((SRC / 'manifest.json').read_text(encoding='utf-8'))


def collect_files():
    """要打进包里的文件，按路径排序 —— 顺序也得固定，包才谈得上可复现。"""
    return sorted(
        p for p in SRC.rglob('*')
        if p.is_file()
        and p.suffix not in SKIP_SUFFIX
        and p.name not in SKIP_NAME
    )


def build_bytes():
    """在内存里打出这个 zip，返回 bytes。跟写进 dist/ 的是同一条路径，逐字节一致。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for p in collect_files():
            # 固定时间戳：同样的源码打出来的包逐字节一致，方便比对
            info = zipfile.ZipInfo(p.relative_to(SRC).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, p.read_bytes())
    return buf.getvalue()


def main():
    manifest = read_manifest()
    version = manifest['version']

    files = collect_files()
    if (SRC / 'manifest.json') not in files:
        raise SystemExit('src/manifest.json 不见了，没法打包')

    OUT_DIR.mkdir(exist_ok=True)
    out = OUT_DIR / f'zhaomu-v{version}.zip'
    out.write_bytes(build_bytes())

    total = sum(p.stat().st_size for p in files)
    print(f"{manifest['name']} v{version}")
    print(f'  {len(files)} 个文件，原始 {total / 1024:.0f} KB')
    print(f'  → {out.relative_to(ROOT).as_posix()}（{out.stat().st_size / 1024:.0f} KB）')
    with zipfile.ZipFile(out) as z:
        print(f'  压缩包根目录：{", ".join(sorted(z.namelist())[:4])} …')


if __name__ == '__main__':
    main()
