"""运行 CI 质量检查，保留分项状态和未完成结果。"""
import sys
sys.dont_write_bytecode = True

import argparse
from pathlib import Path
import re
import secrets
import subprocess
from typing import Callable
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/quality'))
try:
    from quality_process import ProcessResult, run_process, termination_flag
    from quality_lib import utf8_stdio
    IMPORTED = True
except ImportError:
    IMPORTED = False

CHECKS = (('comments', 'review-comments.py'), ('skips', 'check-skips.py'),
          ('links', 'check-links.py'), ('format', 'check-format.py'))
LABELS = {'pass': '通过', 'warn': '提醒', 'fail': '未通过', 'incomplete': '未完成'}
OID = r'(?:[0-9a-f]{40}|[0-9a-f]{64})'


def classify(check_id: str, result) -> str:
    if not result.started or result.error or result.timed_out or result.cancelled:
        return 'incomplete'
    if result.returncode == 0:
        return 'pass'
    if result.returncode == 1:
        return 'warn' if check_id == 'comments' else 'fail'
    return 'incomplete'


def emit_output(check_id, result):
    if not result.output:
        return
    token = secrets.token_hex(32)
    print(f'::stop-commands::{token}', flush=True)
    truncated = result.truncated
    try:
        prefix = f'[{check_id}] '
        for line in result.output.split('\n')[:40]:
            safe = ''.join(ch.encode('unicode_escape').decode('ascii') if unicodedata.category(ch) in ('Cc', 'Cf', 'Zl', 'Zp') else ch for ch in line)
            limit = 4096 - len(prefix)
            truncated |= len(safe) > limit
            print(prefix + safe[:limit])
        if truncated:
            print(f'[{check_id}] 输出已截断。')
    finally:
        print(f'::{token}::', flush=True)


def run_quality(root: Path, mode: tuple[str, str | None], *, timeout: float = 300,
                cancelled: Callable[[], bool] | None = None) -> int:
    try:
        if not IMPORTED:
            raise ValueError('质量扩展缺失')
        utf8_stdio()
        def git(*args):
            result = subprocess.run(['git', *args], cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            if result.returncode:
                raise ValueError('Git 查询失败')
            return result.stdout.decode('utf-8', 'strict').rstrip('\n')
        if Path(git('rev-parse', '--show-toplevel')).resolve() != root.resolve() or Path.cwd().resolve() != root.resolve():
            raise ValueError('不是检出根')
        head = git('rev-parse', '--verify', 'HEAD^{commit}')
        if not re.fullmatch(OID, head):
            raise ValueError('HEAD 无效')
        if mode[0] == 'all' and mode[1] is None:
            args = ['--all']
        elif mode[0] == 'range' and isinstance(mode[1], str) and re.fullmatch(OID + r'\.\.' + OID, mode[1]):
            base, right = mode[1].split('..')
            if right != head or git('cat-file', '-t', base) != 'commit':
                raise ValueError('候选范围不匹配')
            git('merge-base', base, right)
            args = ['--range', mode[1]]
        else:
            raise ValueError('范围无效')
        states = []
        with termination_flag() as stopped:
            def is_cancelled():
                return stopped() or bool(cancelled and cancelled())
            for check_id, filename in CHECKS:
                script = root / 'scripts/quality' / filename
                if is_cancelled():
                    result = ProcessResult(False, None, '', False, False, True, '已取消')
                elif not script.is_file() or script.is_symlink():
                    result = ProcessResult(False, None, '', False, False, False, '缺少普通检查入口')
                else:
                    flags = ['--fail-on-incomplete'] if check_id in ('comments', 'skips') else []
                    result = run_process([sys.executable, str(script), *args, *flags], cwd=root,
                                         timeout=timeout, cancelled=is_cancelled, cooperative=check_id == 'format')
                state = classify(check_id, result)
                states.append((check_id, state, result.started))
                emit_output(check_id, result)
                if result.timed_out:
                    print(f'{check_id}：超时未完成。')
                elif result.cancelled:
                    print(f'{check_id}：已取消，未完成。')
                elif result.error:
                    print(f'{check_id}：启动或清理未完成。')
        print('质量检查汇总：')
        for check_id, state, started in states:
            print(f'{check_id}：{LABELS[state]}；' + ('已启动' if started else '未启动'))
        return 2 if any(s == 'incomplete' for _, s, _ in states) else 1 if any(s == 'fail' for _, s, _ in states) else 0
    except (OSError, ValueError, TypeError, subprocess.SubprocessError):
        print('质量检查未完成：范围、检出或质量扩展无效。', file=sys.stderr)
        return 2


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='CI 分层质量检查')
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--all', action='store_true')
    modes.add_argument('--range', metavar='BASE..HEAD')
    args = parser.parse_args(argv)
    return run_quality(ROOT, ('all', None) if args.all else ('range', args.range))


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
