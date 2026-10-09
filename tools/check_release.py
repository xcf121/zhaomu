"""发布自检：确认「仓库 → 打包 → tag → Release」四处对得上。

发布这件事有三个各自独立、又都不会报错的失手方式，1.2.0 一次中了俩：

  1. 提交没推        本地一切正常，远端少两个提交
  2. tag 挪了没推    本地 tag 移到了含 .gitattributes 的新提交上，远端还指着旧的。
                     `git push` 默认不带 tag，「挪过」这件事本身不会报任何错
  3. 包重打了没重传  dist/ 里是新包，Release 上还是旧包。1.2.0 就这么中过一次：
                     重建在 23:16、资产上传在 22:38，差的是 12 个文本文件的换行符，
                     一共 298 字节。装上去功能一模一样 —— 失效的是「同样的源码打出来的包
                     逐字节一致」这句话，而回退和验包时唯一的依据就是它

这个脚本一次把这几处比一遍，任何一处对不上就非 0 退出：

    python tools/check_release.py

前四项只用 git；第五项要下载 Release 上的资产来比字节，靠 `gh`（仓库是私有的），
没装 gh 没登录就跳过它、其余照查。零依赖，与项目其余部分一致。
"""

import hashlib
import io
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import package  # noqa: E402  —— 复用它的打包逻辑，别在这里再抄一份

ROOT = Path(__file__).resolve().parent.parent

OK, BAD, SKIP = 'ok', '失败', '跳过'


def run(*args):
    return subprocess.run(args, cwd=ROOT, capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


def git(*args):
    return run('git', *args)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {i.filename: (i.CRC, i.file_size) for i in z.infolist()}


def crlf_entries(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {i.filename for i in z.infolist() if b'\r\n' in z.read(i.filename)}


def describe_diff(want, got):
    """两个 zip 对不上时，指出差在哪 —— 1.2.0 那次就是靠这个一眼看出是换行符。"""
    try:
        a, b = entries(want), entries(got)
    except zipfile.BadZipFile:
        return '有一边根本不是 zip'
    only_want = sorted(set(a) - set(b))
    only_got = sorted(set(b) - set(a))
    diff = sorted(k for k in set(a) & set(b) if a[k] != b[k])
    bits = []
    if only_want:
        bits.append('只有重建的包里有：' + ', '.join(only_want[:5]))
    if only_got:
        bits.append('只有那边有：' + ', '.join(only_got[:5]))
    if diff:
        bits.append(f'{len(diff)} 个文件内容不同：' + ', '.join(diff[:5]))
        # 换行符是这对包里最阴的差异：文件逐行一样，字节数却不同
        try:
            if crlf_entries(got) - crlf_entries(want):
                bits.append('那边多出来的 CRLF 就在这些文件里 —— 多半是检出时的换行符没归一')
        except zipfile.BadZipFile:
            pass
    return '；'.join(bits) or '大小不同，但逐条目看又都一样'


def check_worktree():
    r = git('status', '--porcelain')
    if r.returncode != 0:
        return BAD, f'git status 跑不了：{r.stderr.strip()}'
    if r.stdout.strip():
        dirty = r.stdout.strip().replace('\n', '\n        ')
        return BAD, f'工作区不干净，先把改动提交掉：\n        {dirty}'
    return OK, '工作区干净'


def check_synced(branch):
    ahead = git('rev-list', '--count', f'origin/{branch}..HEAD')
    behind = git('rev-list', '--count', f'HEAD..origin/{branch}')
    if ahead.returncode or behind.returncode:
        return SKIP, f'本机没有 origin/{branch}，跳过'
    a, b = int(ahead.stdout.strip() or 0), int(behind.stdout.strip() or 0)
    if a or b:
        return BAD, (f'与 origin/{branch} 不同步：本地领先 {a} 个提交、落后 {b} 个。\n'
                     f'        git push origin {branch}')
    return OK, f'与 origin/{branch} 一致'


def check_tag(tag):
    local = git('rev-parse', tag)
    if local.returncode != 0:
        return BAD, f'本地没有 tag {tag}（打了没？：git tag -a {tag} -m "…"）'
    remote = git('ls-remote', 'origin', f'refs/tags/{tag}')
    if remote.returncode != 0:
        return SKIP, f'git ls-remote 跑不了，{tag} 没比'
    if not remote.stdout.strip():
        return BAD, f'远端没有 tag {tag} —— git push origin {tag}'
    local_sha = local.stdout.strip()
    remote_sha = remote.stdout.strip().split()[0]
    if local_sha != remote_sha:
        return BAD, (f'本地和远端的 {tag} 指的不是一个东西：\n'
                     f'        本地 {local_sha[:12]}　远端 {remote_sha[:12]}\n'
                     f'        tag 挪过就得强推：git push --force origin {tag}')
    return OK, f'{tag} 本地与远端一致（{local_sha[:12]}）'


def check_dist(want):
    version = package.read_manifest()['version']
    path = package.OUT_DIR / f'zhaomu-v{version}.zip'
    if not path.exists():
        return BAD, f'dist/{path.name} 还没有 —— 先跑 python tools/package.py'
    got = path.read_bytes()
    if sha(got) != sha(want):
        return BAD, f'dist/{path.name} 与现场重建的对不上（{describe_diff(want, got)}）'
    return OK, f'dist/{path.name} 与现场重建一致（{sha(want)[:12]}）'


def check_release(tag, dist_name, want):
    if not shutil.which('gh'):
        return SKIP, '没装 gh —— Release 上的资产没跟重建的比过'
    with tempfile.TemporaryDirectory() as tmp:
        r = run('gh', 'release', 'download', tag, '--dir', tmp, '--pattern', '*.zip', '--clobber')
        if r.returncode != 0:
            return BAD, f'从 Release {tag} 下载资产失败：{r.stderr.strip()[:200]}'
        zips = sorted(Path(tmp).glob('*.zip'))
        if len(zips) != 1:
            return BAD, f'Release {tag} 上的 zip 不是恰好一个：{[p.name for p in zips]}'
        got, name = zips[0].read_bytes(), zips[0].name
    if sha(got) != sha(want):
        return BAD, (f'Release {tag} 上的 {name} 与现场重建的对不上'
                     f'（{describe_diff(want, got)}）\n'
                     f'        重传：gh release upload {tag} dist/{dist_name} --clobber')
    return OK, f'Release {tag} 上的 {name} 与现场重建一致'


def main():
    branch = git('symbolic-ref', '--short', 'HEAD').stdout.strip() or 'main'
    manifest = package.read_manifest()
    version, tag = manifest['version'], f"v{package.read_manifest()['version']}"
    dist_name = f'zhaomu-v{version}.zip'

    print(f"发布自检 —— {manifest['name']} {tag}\n")

    # 比远端之前先 fetch：不然比的是本机缓存的旧状态，正好漏掉「没推」这一类
    fetched = git('fetch', 'origin', '--quiet').returncode == 0

    want = package.build_bytes()

    results = [
        ('工作区', check_worktree()),
        ('提交', check_synced(branch) if fetched else (SKIP, 'git fetch 失败（断网？），没比远端的提交')),
        ('tag', check_tag(tag)),
        ('打包', check_dist(want)),
        ('Release', check_release(tag, dist_name, want)),
    ]

    for label, (status, detail) in results:
        print(f'  [{status}] {label}：{detail}')

    failed = [label for label, (status, _) in results if status == BAD]
    skipped = [label for label, (status, _) in results if status == SKIP]
    print()
    if failed:
        print(f'对不上的地方：{"、".join(failed)}')
    if skipped:
        print(f'没查成：{"、".join(skipped)}')
    if not failed:
        print('四处都对得上，可以发了。' if not skipped else '查过的都对得上。')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
