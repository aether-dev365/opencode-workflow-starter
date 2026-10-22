"""Install and remove only the report-only hook owned by this extension."""

import sys
sys.dont_write_bytecode = True

import argparse
import os
from pathlib import Path
import re
import subprocess
from quality_lib import git_bytes, repo_root, utf8_stdio


MARKER = '# workflow-quality-hook'


def dispatcher(relative_dir: str) -> str:
    return '''#!/bin/sh
# workflow-quality-hook
# 只报告：任何情况下都以 0 退出，不影响已经完成的提交。
repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
runner="$repo_root/{dir}/run-hook.py"
if [ ! -f "$runner" ]; then
  echo '质量检查未执行：当前检出缺少 {dir}/run-hook.py。' >&2
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
'''.replace('{dir}', relative_dir)


def manual_line(relative_dir: str) -> str:
    interpreter = 'py -3' if os.name == 'nt' else 'python3'
    return f'{interpreter} "$(git rev-parse --show-toplevel)/{relative_dir}/run-hook.py" post-commit || true'


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
        if not re.fullmatch(r'[A-Za-z0-9._/-]+', relative):
            print('脚本目录的路径只能包含字母、数字和 . _ / -，未安装。')
            return 2
        configured = subprocess.run(['git', 'config', '--get', 'core.hooksPath'], cwd=root,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if configured.returncode == 0:
            value = configured.stdout.decode('utf-8', 'replace').strip()
            print(f'已配置 core.hooksPath（{value}），未安装。请在该目录的 post-commit 中加入下面这行：')
            print(manual_line(relative))
            return 2
        if configured.returncode != 1:
            raise RuntimeError()
        hooks = Path(git_bytes(root, 'rev-parse', '--git-path', 'hooks').decode('utf-8', 'surrogateescape').strip())
        hook = (root / hooks).resolve() / 'post-commit'
        exists = hook.exists() or hook.is_symlink()
        owned = exists and not hook.is_symlink() and hook.is_file() and MARKER.encode('utf-8') in hook.read_bytes()
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
        print(f'安装失败：{type(error).__name__}')
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
