"""Run report-only checks after a commit with bounded process lifetimes."""

import sys
sys.dont_write_bytecode = True

import os
from pathlib import Path
import shlex
import signal
import subprocess
from quality_lib import git_bytes, load_config, repo_root, utf8_stdio


CHECKS = (('注释审核', 'review-comments.py'), ('跳过测试检查', 'check-skips.py'))
FAILURE = '质量检查执行失败；提交已完成，请手动重跑。'


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
            timeout = load_config(here)['timeoutSeconds']
        except Exception:
            timeout = 30
        short = git_bytes(root, 'rev-parse', '--short', 'HEAD').decode('ascii').strip()
        env = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONIOENCODING': 'utf-8'}
        for name, filename in CHECKS:
            script = here / filename
            relative = script.relative_to(root).as_posix()
            if not script.is_file():
                print(f'{name}未执行：缺少 {relative}。')
                continue
            interpreter = 'py -3' if os_name == 'nt' else 'python3'
            rerun = f'{interpreter} {shlex.quote(relative)} --commit {short}'
            options = {'creationflags': 0x08000000} if os_name == 'nt' else {'start_new_session': True}
            process = subprocess.Popen([sys.executable, str(script), '--commit', 'HEAD'], cwd=root, env=env,
                                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **options)
            timed_out = False
            try:
                output, _ = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                try:
                    if os_name == 'nt':
                        subprocess.run(['taskkill', '/F', '/T', '/PID', str(process.pid)],
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=5)
                    else:
                        os.killpg(process.pid, signal.SIGKILL)
                except (OSError, subprocess.SubprocessError):
                    try:
                        process.kill()
                    except OSError:
                        pass
                try:
                    output, _ = process.communicate(timeout=5)
                except subprocess.TimeoutExpired as error:
                    output = error.output or b''
                    # Windows 的后台读取线程可能仍持有管道锁，不能在这里等待关闭。
                    if os_name != 'nt' and process.stdout:
                        process.stdout.close()
            sys.stdout.write(output.decode('utf-8', 'replace'))
            if timed_out:
                print(f'{name}超时（{timeout} 秒）未完成，请手动重跑：{rerun}')
            elif process.returncode == 2:
                print(f'{name}未完成，请手动重跑：{rerun}')
            elif process.returncode not in (0, 1):
                print(f'{name}执行失败（退出码 {process.returncode}），请手动重跑：{rerun}')
    except Exception:
        print(FAILURE)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
