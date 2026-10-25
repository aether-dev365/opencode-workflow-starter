"""套件自身的关联检查：先校验 scripts/quality/quality.json 的登记，再报告上游分支到 HEAD 的同步提醒。"""

import sys
sys.dont_write_bytecode = True

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'optional/quality'))
from quality_lib import Incomplete, repo_root, utf8_stdio
from quality_sync import main as check


def git_status(root: Path, *args: str) -> tuple[int, str]:
    result = subprocess.run(['git', *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    return result.returncode, result.stdout.decode('utf-8', 'surrogateescape').strip()


def upstream(root: Path) -> str | None:
    # 当前分支的上游优先；分离 HEAD、没有配置上游或上游分支已删除时回退到 origin/main。CI 的 PR 检出两者都没有，push 检出的上游就是 HEAD。
    # 只有引用确实不存在才回退：引用存在却解析不到提交、Git 查询出错都报告未完成，不能当成没有上游。
    names = []
    code, branch = git_status(root, 'symbolic-ref', '--quiet', 'HEAD')
    if code == 0:
        code, name = git_status(root, 'for-each-ref', '--format=%(upstream)', branch)
        if code:
            raise Incomplete('读取上游配置失败')
        names += [name] if name else []
    elif code != 1:
        raise Incomplete('读取当前分支失败')
    for name in names + ['refs/remotes/origin/main']:
        code, _ = git_status(root, 'rev-parse', '--verify', '--quiet', name)
        if code == 1:
            continue
        if code == 0:
            code, sha = git_status(root, 'rev-parse', '--verify', '--quiet', name + '^{commit}')
        if code:
            raise Incomplete('上游引用无效：' + name)
        return sha
    return None


def run() -> int:
    utf8_stdio()
    try:
        cwd = Path.cwd()
    except OSError as error:
        print(f'关联检查未完成：无法读取当前目录（{type(error).__name__}）', file=sys.stderr)
        return 2
    try:
        root = repo_root(cwd)
        here = root / 'scripts/quality'
        if check(['--all', '--fail-on-incomplete'], here=here, cwd=root) == 2:
            return 2
        base = upstream(root)
    except Incomplete as error:
        print('关联检查未完成：' + error.args[0], file=sys.stderr)
        return 2
    # ValueError 来自参数无法传给 git，例如 Windows 上含非法字节的分支名。
    except (OSError, ValueError) as error:
        print(f'关联检查未完成：无法运行 git（{type(error).__name__}）', file=sys.stderr)
        return 2
    if base is None:
        print('没有上游分支，只校验了登记。')
        return 0
    # 提醒只报告：有提醒也退出 0，只有检查未完成才让验证失败。
    return 2 if check(['--range', f'{base}..HEAD'], here=here, cwd=root) == 2 else 0


if __name__ == '__main__':
    sys.exit(run())
