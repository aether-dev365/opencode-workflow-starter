"""Run report-only checks after a commit with bounded process lifetimes."""

import sys
sys.dont_write_bytecode = True

import os
from pathlib import Path
import shlex
import signal
import subprocess
import time
from quality_lib import git_bytes, load_config, repo_root, utf8_stdio
from quality_process import close_process, kill_tree, start_process, tree_active


CHECKS = (('注释审核', 'review-comments.py'), ('跳过测试检查', 'check-skips.py'),
          ('链接检查', 'check-links.py'), ('格式检查', 'check-format.py'), ('关联检查', 'check-sync.py'))
FAILURE = '质量检查执行失败；提交已完成，请手动重跑。'


def timeout_for(filename: str, config: dict | None) -> int:
    if config is None:
        return 30
    if filename == 'check-format.py':
        return 10 + sum(entry['timeoutSeconds'] for entry in config['formats'] if entry['hook'])
    return config['timeoutSeconds']


def main(argv: list[str], *, os_name=None) -> int:
    utf8_stdio()
    os_name = os_name or os.name
    try:
        root = repo_root(Path.cwd())
        for state in ('rebase-merge', 'rebase-apply'):
            path = Path(git_bytes(root, 'rev-parse', '--git-path', state).decode('utf-8', 'surrogateescape').strip())
            if (root / path).is_dir():
                return 0
        print('质量检查（提交已完成，以下只是报告）：', flush=True)
        here = Path(__file__).resolve().parent
        try:
            config = load_config(here, root=root)
        except Exception:
            config = None
        short = git_bytes(root, 'rev-parse', '--short', 'HEAD').decode('ascii').strip()
        env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8'}
        for name, filename in CHECKS:
            timeout = timeout_for(filename, config)
            script = here / filename
            relative = script.relative_to(root).as_posix()
            if not script.is_file():
                print(f'{name}未执行：缺少 {relative}。')
                continue
            interpreter = 'py -3' if os_name == 'nt' else 'python3'
            format_check = filename == 'check-format.py'
            flags = ['--hook'] if format_check else []
            rerun = f'{interpreter} {shlex.quote(relative)} --commit {short}' + (' --hook' if format_check else '')
            try:
                process = start_process([sys.executable, str(script), '--commit', 'HEAD', *flags],
                                        cwd=root, env=env, os_name=os_name)
            except (OSError, ValueError) as error:
                print(f'{name}未执行：{str(error) or type(error).__name__}，请手动重跑：{rerun}')
                continue
            timed_out = False
            cleanup_failed = False
            deadline = time.monotonic() + timeout
            try:
                output, _ = process.communicate(timeout=timeout)
                while tree_active(process):
                    if time.monotonic() >= deadline:
                        raise subprocess.TimeoutExpired(process.args, timeout, output=output)
                    time.sleep(.01)
            except subprocess.TimeoutExpired:
                timed_out = True
                cooperative = False
                if format_check and os_name != 'nt':
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                        cooperative = True
                    except OSError:
                        pass
                if not cooperative:
                    cleanup_failed = not kill_tree(process, os_name=os_name)
                try:
                    output, _ = process.communicate(timeout=5)
                except subprocess.TimeoutExpired as error:
                    if cooperative:
                        cleanup_failed = not kill_tree(process, os_name=os_name)
                        try:
                            output, _ = process.communicate(timeout=5)
                        except subprocess.TimeoutExpired as final:
                            output = final.output or b''
                            if process.stdout:
                                process.stdout.close()
                    else:
                        output = error.output or b''
                        # Windows 的后台读取线程可能仍持有管道锁，不能在这里等待关闭。
                        if os_name != 'nt' and process.stdout:
                            process.stdout.close()
            except OSError:
                output = b''
                cleanup_failed = True
                kill_tree(process, os_name=os_name)
            finally:
                cleanup_failed |= not close_process(process)
            sys.stdout.write(output.decode('utf-8', 'replace'))
            if cleanup_failed:
                print(f'{name}未完成：进程树清理失败，请手动重跑：{rerun}')
            if timed_out:
                print(f'{name}超时（{timeout} 秒）未完成，请手动重跑：{rerun}')
            elif process.returncode == 2:
                print(f'{name}未完成，请手动重跑：{rerun}')
            elif process.returncode not in (0, 1):
                print(f'{name}执行失败（退出码 {process.returncode}），请手动重跑：{rerun}')
            if format_check and (timed_out or process.returncode not in (0, 1)):
                print('固定提交只能固定候选文件范围；格式工具仍读取当前工作区，不能恢复历史版本的格式内容。')
    except Exception:
        print(FAILURE)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
