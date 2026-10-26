"""Install and remove only the report-only hook owned by this extension."""

import sys
sys.dont_write_bytecode = True

import argparse
import os
from pathlib import Path
import re
import shlex
import subprocess
from quality_lib import Incomplete, git_bytes, repo_root, utf8_stdio
from quality_process import program


MARKER = '# workflow-quality-hook'


def dispatcher(relative_dir: str) -> str:
    return '''#!/bin/sh
# workflow-quality-hook
# 只报告：任何情况下都以 0 退出，不影响已经完成的提交。
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
quality_dir={dir}
runner="$repo_root/$quality_dir/run-hook.py"
if [ ! -f "$runner" ]; then
  echo "质量检查未执行：当前检出缺少 $quality_dir/run-hook.py。" >&2
  exit 0
fi
usable() {
  "$@" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}
set --
if [ -n "${WORKFLOW_PYTHON:-}" ] && usable "$WORKFLOW_PYTHON"; then
  set -- "$WORKFLOW_PYTHON"
fi
if [ "$#" -eq 0 ]; then
  case "$(uname -s 2>/dev/null)" in
    MINGW*|MSYS*|CYGWIN*) if usable py -3; then set -- py -3; fi ;;
  esac
fi
if [ "$#" -eq 0 ]; then
  for candidate in python3 python; do
    if usable "$candidate"; then set -- "$candidate"; break; fi
  done
fi
if [ "$#" -eq 0 ]; then
  echo '质量检查未执行：找不到 Python 3.10+。' >&2
  exit 0
fi
"$@" "$runner" post-commit || echo '质量检查执行失败；提交已完成，请手动重跑。' >&2
exit 0
'''.replace('{dir}', "'" + relative_dir.replace("'", "'\\''") + "'")


def manual_line(relative_dir: str) -> str:
    interpreter = 'py -3' if os.name == 'nt' else 'python3'
    escaped = re.sub(r'([$`"\\])', r'\\\1', relative_dir)
    return f'{interpreter} "$(git rev-parse --show-toplevel)/{escaped}/run-hook.py" post-commit || true'


def unsupported_directory(relative_dir: str) -> bool:
    """分发器逐行写入目录；换行和回车会拆开那一行，其余字符都由 sh 单引号转义。"""
    return any(ch in relative_dir for ch in '\n\r\0')


def owned_hook(hook: Path) -> bool:
    if hook.is_symlink() or not hook.is_file():
        return False
    content = hook.read_bytes()
    lines = content.split(b'\n')
    if len(lines) < 2 or lines[1] != MARKER.encode('utf-8'):
        return False
    found = re.search(rb'^quality_dir=(.*)$', content, re.M)
    try:
        words = shlex.split(found[1].decode('utf-8')) if found else []
    except (ValueError, UnicodeDecodeError):
        return False
    return len(words) == 1 and content == dispatcher(words[0]).encode('utf-8')


def main(argv: list[str]) -> int:
    utf8_stdio()
    parser = argparse.ArgumentParser(description='安装或卸载只报告的质量检查 hook')
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args(argv)
    try:
        root = repo_root(Path.cwd())
        try:
            relative = Path(__file__).resolve().parent.relative_to(root).as_posix()
        except ValueError:
            print('脚本不在当前检出内，未安装。')
            return 2
        if unsupported_directory(relative):
            print('脚本目录的路径含有换行等控制字符，未安装。')
            return 2
        git = program('git')
        if git is None:
            print('找不到 git 命令，未安装。')
            return 2
        configured = subprocess.run([git, 'config', '--get', 'core.hooksPath'], cwd=root,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if configured.returncode == 0 and not args.uninstall:
            value = configured.stdout.decode('utf-8', 'replace').strip()
            print(f'已配置 core.hooksPath（{value}），未安装。请在该目录的 post-commit 中加入下面这行：')
            print(manual_line(relative))
            return 2
        if configured.returncode not in (0, 1):
            raise RuntimeError()
        hooks = Path(git_bytes(root, 'rev-parse', '--git-path', 'hooks').decode('utf-8', 'surrogateescape').strip())
        hooks = root / hooks
        if not args.uninstall and hooks.is_symlink():
            print(f'hooks 目录是符号链接（{hooks}），未安装。请在实际使用的 post-commit 中加入下面这行：')
            print(manual_line(relative))
            return 2
        hook = hooks / 'post-commit'
        exists = hook.exists() or hook.is_symlink()
        owned = owned_hook(hook)
        if args.uninstall:
            if not exists:
                print('未安装质量检查 hook，无需卸载。')
            elif owned:
                hook.unlink()
                print('已卸载质量检查 hook。')
            else:
                print('post-commit 不是本扩展安装的，未改动。')
                return 2
            return 0
        if exists and not owned:
            print(f'已有其他 post-commit（{hook}），未安装。请在其中加入下面这行：')
            print(manual_line(relative))
            return 2
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_bytes(dispatcher(relative).encode('utf-8'))
        hook.chmod(hook.stat().st_mode | 0o111)
        print(f'已更新质量检查 hook：{hook}' if exists else f'已安装质量检查 hook：{hook}')
        return 0
    except Exception as error:
        reason = '不在 git 仓库中' if isinstance(error, Incomplete) and error.args == ('不在 git 仓库中',) else type(error).__name__
        print(f'安装失败：{reason}')
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
