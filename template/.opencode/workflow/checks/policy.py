"""Ordered native wildcard rules, resolved against the actual checkout."""
import functools
import json
import os
from pathlib import Path
import re
import sys

from hooklib import is_absolute, path_exists, path_is_dir

PROTECTION_PATH = '.opencode/workflow/protection.json'
PROTECTION_REASON = '保护配置只允许读取；修改或修复 protection.json 需由用户在 OpenCode 之外完成。'


def policy_root(path):
    here = Path(os.path.abspath(path))
    for folder in [here, *here.parents]:
        if path_exists(folder / '.git'):
            return folder
    return None


def load_policy(root: str) -> dict:
    policy = json.loads((Path(root) / '.opencode/workflow/protection.json').read_text(encoding='utf-8'))
    if not isinstance(policy, dict) or policy.get('version') != 1 or not isinstance(policy.get('rules'), list) or not policy['rules']:
        raise ValueError('保护配置无效')
    seen = set()
    for rule in policy['rules']:
        if (not isinstance(rule, dict) or not re.fullmatch(r'[a-z][a-z0-9-]*', rule.get('id', ''))
                or rule['id'] in seen or rule.get('effect') not in ['allow', 'deny']
                or not isinstance(rule.get('reason'), str) or not rule['reason'].strip()
                or not isinstance(rule.get('actions'), list) or not rule['actions']
                or any(a not in ['read', 'edit'] for a in rule['actions'])
                or not isinstance(rule.get('paths'), list) or not rule['paths']
                or any(not isinstance(p, str) or not p or p.startswith('/') or '..' in p.replace('\\', '/').split('/') or '\0' in p for p in rule['paths'])):
            raise ValueError('保护规则无效')
        for pattern in rule['paths']:
            if '{' in pattern or '}' in pattern:
                raise ValueError(f'不支持花括号，请拆成多条：{pattern}')
        seen.add(rule['id'])
    return policy


def matches(path, pattern):
    expression = ''.join('.*' if c == '*' else '.' if c == '?' else re.escape(c) for c in pattern)
    return re.fullmatch(expression, path, flags=re.DOTALL) is not None


@functools.lru_cache(maxsize=None)
def _resolved_root(root: str) -> Path:
    return Path(root).resolve()


def check_path(root: str, path: str, action: str, policy: dict, real: Path | None = None,
               descendants: bool = False) -> str | None:
    """按字面路径和真实路径各匹配一次。调用方已知真实路径时传入 real，省去解析（Windows 上逐个解析很慢）。"""
    base = _resolved_root(root)
    absolute = Path(os.path.abspath(Path(root) / path))
    protected = base / PROTECTION_PATH
    for candidate in dict.fromkeys([absolute, real if real is not None else absolute.resolve()]):
        if action == 'edit' and (any(candidate == locked or candidate in locked.parents
                                     for locked in (protected, protected.resolve()))
                                 or (path_exists(candidate) and protected.exists() and candidate.samefile(protected))):
            return PROTECTION_REASON
        try:
            name = os.path.relpath(candidate, base).replace(os.sep, '/')
        except ValueError:
            # Windows 上与检出不在同一盘符时没有相对路径；按绝对路径匹配，与检出外路径的处理一致。
            name = Path(candidate).as_posix()
        reason, effect = None, None
        for rule in policy['rules']:
            if action in rule['actions'] and any(matches(name, pattern) for pattern in rule['paths']):
                effect = rule['effect']
                reason = rule['reason'] if rule['effect'] == 'deny' else None
        if reason:
            return reason
        # 明确允许的普通文件（含尚未创建的示例文件）不能因虚构子项推翻例外。
        # 真实目录仍检查子项；字面路径和真实路径各自判定，允许例外不能豁免链接目标。
        if descendants and not (effect == 'allow' and not path_is_dir(candidate)):
            for rule in policy['rules']:
                if action in rule['actions'] and any(matches(name.rstrip('/') + '/_', pattern) for pattern in rule['paths']):
                    reason = rule['reason'] if rule['effect'] == 'deny' else None
            if reason:
                return reason
    return None


def main():
    from protocol import utf8_stdio
    utf8_stdio()
    try:
        request = json.load(sys.stdin)
        if (not isinstance(request, dict) or not isinstance(request.get('root'), str)
                or not is_absolute(request['root']) or request.get('action') not in ['read', 'edit']
                or not isinstance(request.get('paths'), list)
                or any(not isinstance(path, str) or not path or is_absolute(path) or '\0' in path
                       or '..' in path.replace('\\', '/').split('/') for path in request['paths'])):
            raise ValueError('策略检查输入无效')
        root = request['root']
        policy = load_policy(root)
        denied = [path for path in request['paths'] if check_path(root, path, request['action'], policy)]
        print(json.dumps({'denied': denied}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, TypeError, KeyError) as error:
        print(json.dumps({'error': str(error)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
