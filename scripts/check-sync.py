"""套件自身的关联检查：先校验 scripts/quality/quality.json 的登记，再报告上游分支到 HEAD 的同步提醒。"""

import sys
sys.dont_write_bytecode = True

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'optional/quality'))
from quality_lib import Incomplete, git_bytes, repo_root, utf8_stdio
from quality_sync import main as check


def upstream(root: Path) -> str | None:
    # 上游分支被删除时回退到 origin/main；CI 的浅检出两者都没有。
    for name in ('@{upstream}', 'refs/remotes/origin/main'):
        try:
            return git_bytes(root, 'rev-parse', '--verify', name + '^{commit}').decode('ascii').strip()
        except Incomplete:
            continue
    return None


def run() -> int:
    utf8_stdio()
    try:
        root = repo_root(Path.cwd())
    except Incomplete as error:
        print('关联检查未完成：' + error.args[0], file=sys.stderr)
        return 2
    here = root / 'scripts/quality'
    if check(['--all', '--fail-on-incomplete'], here=here, cwd=root) == 2:
        return 2
    base = upstream(root)
    if base is None:
        print('没有上游分支，只校验了登记。')
        return 0
    # 提醒只报告：有提醒也退出 0，只有检查未完成才让验证失败。
    return 2 if check(['--range', f'{base}..HEAD'], here=here, cwd=root) == 2 else 0


if __name__ == '__main__':
    sys.exit(run())
