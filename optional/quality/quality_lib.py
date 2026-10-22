"""Shared configuration, file selection and command-line support."""

import json
import argparse
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Callable
from quality_lexer import family


COMMENT_RULE_IDS = ('document', 'tracking', 'process', 'generator')
SKIP_CATEGORIES = ('skip', 'focus', 'expected-failure')
EXCLUDED = set(('node_modules vendor third_party dist build out target coverage __pycache__ '
                '.venv venv .next .nuxt generated').split())


class ConfigError(Exception):
    pass


def default_config() -> dict:
    return {'version': 1, 'include': ['*'], 'exclude': [], 'timeoutSeconds': 30,
            'comments': {'disable': [], 'extraRules': []}, 'skips': {'disable': [], 'extraMarkers': []}}


def _object(value, allowed, field):
    if not isinstance(value, dict):
        raise ConfigError(field or 'quality.json')
    for key in value:
        if key not in allowed:
            raise ConfigError(f'{field}.{key}' if field else key)


def _strings(value, field, allowed=None):
    if not isinstance(value, list):
        raise ConfigError(field)
    for n, item in enumerate(value):
        if not isinstance(item, str) or not item or (allowed is not None and item not in allowed):
            raise ConfigError(f'{field}[{n}]')
    return value


def load_config(directory: Path) -> dict:
    file = directory / 'quality.json'
    config = default_config()
    if not file.exists():
        return config
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except (ValueError, UnicodeError):
        raise ConfigError('quality.json') from None
    _object(data, config, '')
    if type(data.get('version')) is not int or data['version'] != 1:
        raise ConfigError('version')
    for key in ('include', 'exclude'):
        if key in data:
            config[key] = _strings(data[key], key)
    timeout = data.get('timeoutSeconds', 30)
    if type(timeout) is not int or not 1 <= timeout <= 600:
        raise ConfigError('timeoutSeconds')
    config['timeoutSeconds'] = timeout
    used = set(COMMENT_RULE_IDS + SKIP_CATEGORIES)
    for section, extra, ids in [('comments', 'extraRules', COMMENT_RULE_IDS), ('skips', 'extraMarkers', SKIP_CATEGORIES)]:
        if section not in data:
            continue
        value = data[section]
        _object(value, ('disable', extra), section)
        config[section]['disable'] = _strings(value.get('disable', []), section + '.disable', ids)
        entries = value.get(extra, [])
        if not isinstance(entries, list):
            raise ConfigError(section + '.' + extra)
        for n, entry in enumerate(entries):
            field = f'{section}.{extra}[{n}]'
            _object(entry, ('id', 'pattern', 'message') if section == 'comments' else ('id', 'pattern', 'paths', 'category'), field)
            ident = entry.get('id')
            if not isinstance(ident, str) or not re.fullmatch('[a-z][a-z0-9-]*', ident) or ident in used:
                raise ConfigError(field + '.id')
            used.add(ident)
            pattern = entry.get('pattern')
            if not isinstance(pattern, str):
                raise ConfigError(field + '.pattern')
            try:
                regex = re.compile(pattern)
            except re.error:
                raise ConfigError(field + '.pattern') from None
            result = {**entry, 'regex': regex}
            if section == 'comments':
                if not isinstance(entry.get('message'), str) or not entry['message']:
                    raise ConfigError(field + '.message')
            else:
                result['paths'] = _strings(entry.get('paths', ['*']), field + '.paths')
                result['category'] = entry.get('category', 'skip')
                if result['category'] not in SKIP_CATEGORIES:
                    raise ConfigError(field + '.category')
            config[section][extra].append(result)
    return config


def glob_match(pattern: str, path: str) -> bool:
    regex = ''.join('.*' if ch == '*' else '.' if ch == '?' else re.escape(ch) for ch in pattern)
    return re.fullmatch(regex, path, re.DOTALL) is not None


def selected(path: str, config: dict) -> bool:
    file = PurePosixPath(path)
    return (family(path) is not None and not EXCLUDED.intersection(file.parts)
            and not file.name.lower().endswith(('.min.js', '.min.css', '.bundle.js'))
            and any(glob_match(p, path) for p in config['include'])
            and not any(glob_match(p, path) for p in config['exclude']))


def utf8_stdio() -> None:
    for stream, errors in ((sys.stdin, 'strict'), (sys.stdout, 'replace'), (sys.stderr, 'backslashreplace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure:
            reconfigure(encoding='utf-8', errors=errors)


class Incomplete(Exception):
    pass


@dataclass(frozen=True)
class Target:
    path: str
    read: Callable[[], bytes]
    added: frozenset[int] | None


@dataclass(frozen=True)
class Changes:
    targets: list[Target]
    merge: bool = False


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    rule: str
    message: str


Mode = tuple[str, str | None]
CheckFn = Callable[[str, str, frozenset[int] | None, dict], list[Finding]]


def parse_mode(argv: list[str]) -> Mode:
    parser = argparse.ArgumentParser(description='检查新增或改动的行')
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--commit', metavar='REV')
    modes.add_argument('--staged', action='store_true')
    modes.add_argument('--range', metavar='BASE..HEAD')
    modes.add_argument('--all', action='store_true')
    args = parser.parse_args(argv)
    if args.staged:
        return 'staged', None
    if args.all:
        return 'all', None
    if args.range is not None:
        return 'range', args.range
    return 'commit', args.commit if args.commit is not None else 'HEAD'


def git_bytes(root: Path, *args: str, reason='git 命令失败') -> bytes:
    result = subprocess.run(['git', '-c', 'core.quotepath=off', '--literal-pathspecs', *args],
                            cwd=root, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise Incomplete(reason)
    return result.stdout


def repo_root(cwd: Path) -> Path:
    return Path(git_bytes(cwd, 'rev-parse', '--show-toplevel', reason='不在 git 仓库中').decode('utf-8', 'surrogateescape').strip()).resolve()


def _revision(root, rev):
    return git_bytes(root, 'rev-parse', '--verify', '--end-of-options', rev + '^{commit}', reason='修订号无效').decode('ascii').strip()


def collect(root: Path, mode: Mode) -> Changes:
    kind, rev = mode
    if kind == 'all':
        paths = git_bytes(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0')
        targets = []
        for raw in sorted(set(paths) - {b''}):
            path = raw.decode('utf-8', 'surrogateescape')
            file = root / path
            if file.is_file() and not file.is_symlink():
                targets.append(Target(path, file.read_bytes, None))
        return Changes(targets)
    if kind == 'commit':
        sha = _revision(root, rev)
        parents = git_bytes(root, 'rev-list', '--parents', '-n', '1', sha).split()
        if len(parents) > 2:
            return Changes([], True)
        command = ['diff-tree', '-r', '--root', '--no-commit-id', sha]
        source = sha
    elif kind == 'staged':
        command = ['diff', '--cached']
        source = ''
    elif kind == 'range':
        parts = rev.split('..')
        if len(parts) != 2 or not all(parts) or '...' in rev:
            raise Incomplete('修订号无效')
        left, right = (_revision(root, p) for p in parts)
        command = ['diff', left + '...' + right]
        source = right
    else:
        raise Incomplete('修订号无效')
    common = ['-M', '--no-color', '--no-ext-diff', '--no-textconv']
    records = git_bytes(root, *command, *common, '--raw', '-z').split(b'\0')
    targets = []
    i = 0
    while i < len(records) and records[i]:
        header = records[i].split()
        old = records[i + 1].decode('utf-8', 'surrogateescape')
        status = header[4][:1]
        new = records[i + 2].decode('utf-8', 'surrogateescape') if status in {b'R', b'C'} else old
        i += 3 if status in {b'R', b'C'} else 2
        if status not in {b'A', b'M', b'R', b'C', b'T'} or header[1] not in {b'100644', b'100755'}:
            continue
        patch = git_bytes(root, *command, *common, '-p', '-U0', '--', *dict.fromkeys([old, new]))
        lines = set()
        for match in re.finditer(rb'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', patch, re.M):
            start = int(match[1])
            count = int(match[2]) if match[2] is not None else 1
            lines.update(range(start, start + count))
        if lines:
            target = source + ':' + new
            targets.append(Target(new, lambda target=target: git_bytes(root, 'cat-file', 'blob', target), frozenset(lines)))
    return Changes(targets)


def main(name: str, unit: str, check: CheckFn, argv: list[str], here: Path, cwd: Path | None = None) -> int:
    utf8_stdio()
    try:
        mode = parse_mode(argv)
        root = repo_root(cwd or Path.cwd())
        config = load_config(here)
        changes = collect(root, mode)
        if changes.merge:
            print(f'{name}：合并提交不检查。')
            return 0
        findings = {}
        checked = skipped = 0
        for target in changes.targets:
            if not selected(target.path, config):
                continue
            raw = target.read()
            if b'\0' in raw[:8000]:
                continue
            if len(raw) > 1024 * 1024:
                skipped += 1
                continue
            try:
                text = raw.decode('utf-8')
            except UnicodeDecodeError:
                skipped += 1
                continue
            if re.search(r'@generated|DO NOT EDIT|Code generated|auto-generated', '\n'.join(text.splitlines()[:5]), re.I):
                continue
            for finding in check(target.path, text, target.added, config):
                findings[(finding.path, finding.line, finding.rule)] = finding
            checked += 1
        for key in sorted(findings):
            f = findings[key]
            print(f'{f.path}:{f.line}: [{f.rule}] {f.message}')
        suffix = f'（跳过 {skipped} 个非 UTF-8 或过大的文件）' if skipped else ''
        print(f'{name}：检查了 {checked} 个文件，{len(findings)} 处{unit}{suffix}。')
        return 1 if findings else 0
    except ConfigError as error:
        reason = '配置无效：' + error.args[0]
    except Incomplete as error:
        reason = error.args[0]
    except Exception as error:
        reason = type(error).__name__
    print(f'{name}未完成：{reason}', file=sys.stderr)
    return 2
