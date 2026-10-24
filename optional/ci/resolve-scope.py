"""将 GitHub 事件解析为已验证的候选提交范围。"""
import sys
sys.dont_write_bytecode = True

from dataclasses import asdict, dataclass
import json
import os
from pathlib import Path
import re
import subprocess


@dataclass(frozen=True)
class Scope:
    mode: str
    base: str
    head: str


def git(root, *args, input=None, codes=(0,)):
    result = subprocess.run(['git', *args], cwd=root, input=input, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=10)
    if result.returncode not in codes:
        raise ValueError('Git 查询失败')
    return result.returncode, result.stdout.decode('utf-8', 'strict').rstrip('\n')


def oid(value, size):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{' + str(size) + '}', value):
        raise ValueError('提交标识无效')
    return value.lower()


def commit_exists(root, value):
    _, result = git(root, 'cat-file', '--batch-check', input=(value + '\n').encode('ascii'))
    if result == value + ' missing':
        return False
    fields = result.split(' ')
    if len(fields) != 3 or fields[0] != value or fields[1] != 'commit' or not fields[2].isdigit():
        raise ValueError('对象不是有效的 commit')
    _, resolved = git(root, 'rev-parse', '--verify', value + '^{commit}')
    if resolved != value:
        raise ValueError('提交解析结果不一致')
    return True


def resolve_scope(root: Path, event_name: str, event: dict, github_sha: str, ref: str) -> Scope:
    if not isinstance(event, dict):
        raise ValueError('事件必须是对象')
    _, top = git(root, 'rev-parse', '--show-toplevel')
    if Path(top).resolve() != root.resolve() or Path.cwd().resolve() != root.resolve():
        raise ValueError('必须在当前检出根执行')
    _, shallow = git(root, 'rev-parse', '--git-path', 'shallow')
    shallow = root / shallow
    if shallow.exists() and shallow.read_bytes().strip():
        raise ValueError('浅历史不能用于完整检查')
    _, actual = git(root, 'rev-parse', '--verify', 'HEAD^{commit}')
    if not re.fullmatch(r'(?:[0-9a-f]{40}|[0-9a-f]{64})', actual):
        raise ValueError('HEAD 无效')
    if event_name == 'pull_request':
        head = event['pull_request']['head']['sha']
        base = event['pull_request']['base']['sha']
    elif event_name == 'push':
        branch = event['repository']['default_branch']
        if not isinstance(branch, str) or not branch or event.get('deleted') is not False or ref != 'refs/heads/' + branch:
            raise ValueError('不是默认分支的有效 push')
        git(root, 'check-ref-format', ref)
        head, base = event['after'], event['before']
    elif event_name == 'workflow_dispatch':
        head, base = github_sha, None
    else:
        raise ValueError('不支持的事件')
    head = oid(head, len(actual))
    if head != actual or not commit_exists(root, head):
        raise ValueError('候选提交与检出 HEAD 不一致')
    if event_name == 'workflow_dispatch':
        print('手动执行：全量质量检查。', file=sys.stderr)
        return Scope('all', '', head)
    base = oid(base, len(actual))
    if event_name == 'push' and base == '0' * len(actual):
        print('首次推送：全量质量检查。', file=sys.stderr)
        return Scope('all', '', head)
    exists = commit_exists(root, base)
    if event_name == 'pull_request':
        if not exists:
            raise ValueError('PR 基线不可用')
        _, ancestor = git(root, 'merge-base', base, head)
        if not commit_exists(root, oid(ancestor, len(actual))):
            raise ValueError('没有有效的合并基点')
    elif not exists or git(root, 'merge-base', '--is-ancestor', base, head, codes=(0, 1))[0] == 1:
        print('旧 tip 不可用或不是候选祖先：全量质量检查。', file=sys.stderr)
        return Scope('all', '', head)
    return Scope('range', base, head)


def main(argv: list[str]) -> int:
    try:
        if argv:
            raise ValueError('此入口仅接受 GitHub 事件环境')
        root = Path(__file__).resolve().parents[2]
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text(encoding='utf-8'))
        scope = resolve_scope(root, os.environ['GITHUB_EVENT_NAME'], event,
                              os.environ.get('GITHUB_SHA', ''), os.environ.get('GITHUB_REF', ''))
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8', newline='\n') as output:
                output.write(f'mode={scope.mode}\nbase={scope.base}\nhead={scope.head}\n')
        print(json.dumps(asdict(scope)))
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print('范围解析未完成：事件、检出或 Git 查询无效。', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
