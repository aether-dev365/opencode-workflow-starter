"""Shared configuration, file selection and command-line support."""

import json
import argparse
import functools
import os
import ntpath
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Callable
from quality_lexer import family
from quality_process import program


COMMENT_RULE_IDS = ('document', 'tracking', 'process', 'generator')
SKIP_CATEGORIES = ('skip', 'focus', 'expected-failure')
SYNC_EVENTS = ('add', 'modify', 'delete')
EXCLUDED = set(('node_modules vendor third_party dist build out target coverage __pycache__ '
                '.venv venv .next .nuxt generated').split())


class ConfigError(Exception):
    pass


def default_config() -> dict:
    return {'version': 1, 'include': ['*'], 'exclude': [], 'timeoutSeconds': 30,
            'comments': {'disable': [], 'extraRules': []}, 'skips': {'disable': [], 'extraMarkers': []},
            'formats': [], 'links': {'exclude': [], 'ignoreTargets': []}, 'sync': []}


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


def _argv(value, field):
    result = _strings(value, field)
    if not result:
        raise ConfigError(field)
    for n, arg in enumerate(result):
        if '\0' in arg:
            raise ConfigError(f'{field}[{n}]')
    if (result[0] == '{files}' or result.count('{files}') > 1
            or any('{files}' in arg and arg != '{files}' for arg in result)):
        raise ConfigError(field)
    return result


def load_config(directory: Path, *, root: Path | None = None) -> dict:
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
    if 'links' in data:
        _object(data['links'], ('exclude', 'ignoreTargets'), 'links')
        for key in ('exclude', 'ignoreTargets'):
            config['links'][key] = _strings(data['links'].get(key, []), 'links.' + key)
    formats = data.get('formats', [])
    if not isinstance(formats, list):
        raise ConfigError('formats')
    format_ids = set()
    for n, entry in enumerate(formats):
        field = f'formats[{n}]'
        _object(entry, ('id', 'paths', 'check', 'fix', 'cwd', 'hook', 'timeoutSeconds'), field)
        ident = entry.get('id')
        if not isinstance(ident, str) or not re.fullmatch('[a-z][a-z0-9-]*', ident) or ident in format_ids:
            raise ConfigError(field + '.id')
        format_ids.add(ident)
        paths = _strings(entry.get('paths'), field + '.paths')
        if not paths:
            raise ConfigError(field + '.paths')
        result = {**entry, 'check': _argv(entry.get('check'), field + '.check')}
        if 'fix' in entry:
            result['fix'] = _argv(entry['fix'], field + '.fix')
        cwd = entry.get('cwd', '.')
        # 不用 ntpath.isabs：Python 3.13 起它不把 /tmp、\tmp 这类无盘符的根路径算作绝对路径。
        if (not isinstance(cwd, str) or not cwd or '\0' in cwd or cwd.startswith(('/', '\\')) or ntpath.splitdrive(cwd)[0]
                or ntpath.normpath(cwd).replace('\\', '/').split('/')[0] == '..'):
            raise ConfigError(field + '.cwd')
        if root is not None:
            try:
                if not (root / cwd).resolve().is_relative_to(root.resolve()):
                    raise ConfigError(field + '.cwd')
            except (OSError, RuntimeError):
                raise ConfigError(field + '.cwd') from None
        hook, timeout = entry.get('hook', True), entry.get('timeoutSeconds', 60)
        if type(hook) is not bool:
            raise ConfigError(field + '.hook')
        if type(timeout) is not int or not 1 <= timeout <= 600:
            raise ConfigError(field + '.timeoutSeconds')
        config['formats'].append({**result, 'cwd': cwd, 'hook': hook, 'timeoutSeconds': timeout})
    sync = data.get('sync', [])
    if not isinstance(sync, list):
        raise ConfigError('sync')
    sync_ids = set()
    for n, entry in enumerate(sync):
        field = f'sync[{n}]'
        _object(entry, ('id', 'paths', 'exclude', 'related', 'message', 'on'), field)
        ident = entry.get('id')
        if not isinstance(ident, str) or not re.fullmatch('[a-z][a-z0-9-]*', ident) or ident in sync_ids:
            raise ConfigError(field + '.id')
        sync_ids.add(ident)
        result = {'id': ident}
        for key in ('paths', 'exclude', 'related'):
            result[key] = _strings(entry.get(key, [] if key == 'exclude' else None), f'{field}.{key}')
            if key != 'exclude' and not result[key]:
                raise ConfigError(f'{field}.{key}')
        if not isinstance(entry.get('message'), str) or not entry['message']:
            raise ConfigError(field + '.message')
        result['message'] = entry['message']
        result['on'] = _strings(entry.get('on', list(SYNC_EVENTS)), field + '.on', SYNC_EVENTS)
        if not result['on']:
            raise ConfigError(field + '.on')
        config['sync'].append(result)
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


@functools.lru_cache(maxsize=None)
def glob_regex(pattern: str) -> re.Pattern[str]:
    return re.compile(''.join('.*' if ch == '*' else '.' if ch == '?' else re.escape(ch) for ch in pattern), re.DOTALL)


def glob_match(pattern: str, path: str) -> bool:
    return glob_regex(pattern).fullmatch(path) is not None


def path_selected(path: str, config: dict) -> bool:
    file = PurePosixPath(path)
    return (not EXCLUDED.intersection(file.parts)
            and not file.name.lower().endswith(('.min.js', '.min.css', '.bundle.js'))
            and any(glob_match(p, path) for p in config['include'])
            and not any(glob_match(p, path) for p in config['exclude']))


def selected(path: str, config: dict) -> bool:
    return family(path) is not None and path_selected(path, config)


def utf8_stdio() -> None:
    for stream, errors in ((sys.stdin, 'strict'), (sys.stdout, 'replace'), (sys.stderr, 'backslashreplace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure:
            options = {} if stream is sys.stdin else {'newline': '\n'}
            reconfigure(encoding='utf-8', errors=errors, **options)


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


def _mode_parser(description='检查新增或改动的行'):
    parser = argparse.ArgumentParser(description=description)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--commit', metavar='REV')
    modes.add_argument('--staged', action='store_true')
    modes.add_argument('--range', metavar='BASE..HEAD')
    modes.add_argument('--all', action='store_true')
    return parser


def _mode(args) -> Mode:
    if args.staged:
        return 'staged', None
    if args.all:
        return 'all', None
    if args.range is not None:
        return 'range', args.range
    return 'commit', args.commit if args.commit is not None else 'HEAD'


def parse_mode(argv: list[str], *, description='检查新增或改动的行') -> Mode:
    return _mode(_mode_parser(description).parse_args(argv))


def parse_line_options(argv: list[str], *, description='检查新增或改动的行',
                       incomplete_help='候选文本未能分析时退出 2') -> tuple[Mode, bool]:
    parser = _mode_parser(description)
    parser.add_argument('--fail-on-incomplete', action='store_true', help=incomplete_help)
    args = parser.parse_args(argv)
    return _mode(args), args.fail_on_incomplete


def git_command() -> str:
    git = program('git')
    if git is None:
        raise Incomplete('找不到 git 命令；安装 Git 并确认它在 PATH 中')
    return git


def git_bytes(root: Path, *args: str, reason='git 命令失败', input=None) -> bytes:
    env = {key: value for key, value in os.environ.items() if key not in {'GIT_DIFF_OPTS', 'GIT_EXTERNAL_DIFF'}}
    result = subprocess.run([git_command(), '-c', 'core.quotepath=off', '--literal-pathspecs', *args],
                            cwd=root, env=env, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode:
        raise Incomplete(reason)
    return result.stdout


def repo_root(cwd: Path) -> Path:
    return Path(git_bytes(cwd, 'rev-parse', '--show-toplevel', reason='不在 git 仓库中').decode('utf-8', 'surrogateescape').strip()).resolve()


def _revision(root, rev):
    if not isinstance(rev, str) or not rev or rev.startswith('-'):
        raise Incomplete('修订号无效')
    return git_bytes(root, 'rev-parse', '--verify', rev + '^{commit}', reason='修订号无效').decode('ascii').strip()


def raw_entries(raw: bytes):
    records = raw.split(b'\0')
    i = 0
    while i < len(records) and records[i]:
        header = records[i].split()
        renamed = header[4][:1] in {b'R', b'C'}
        path = records[i + (2 if renamed else 1)].decode('utf-8', 'surrogateescape')
        yield header, path
        i += 3 if renamed else 2


def added_lines(patch: bytes) -> frozenset[int]:
    lines = set()
    for match in re.finditer(rb'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', patch, re.M):
        start = int(match[1])
        count = int(match[2]) if match[2] is not None else 1
        lines.update(range(start, start + count))
    return frozenset(lines)


def path_batches(paths):
    batch, size = [], 0
    for path in paths:
        length = len(path.encode('utf-8', 'surrogateescape')) + 1
        if batch and size + length > 12000:
            yield batch
            batch, size = [], 0
        batch.append(path)
        size += length
    if batch:
        yield batch


def collect(root: Path, mode: Mode, select=lambda path: True) -> Changes:
    kind, rev = mode
    if kind == 'all':
        paths = git_bytes(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split(b'\0')
        targets = []
        for raw in sorted(set(paths) - {b''}):
            path = raw.decode('utf-8', 'surrogateescape')
            if not select(path):
                continue
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
    elif kind == 'staged':
        command = ['diff', '--cached']
    elif kind == 'range':
        parts = rev.split('..')
        if len(parts) != 2 or not all(parts) or '...' in rev:
            raise Incomplete('修订号无效')
        left, right = (_revision(root, p) for p in parts)
        command = ['diff', left + '...' + right]
    else:
        raise Incomplete('修订号无效')
    common = ['-M', '--no-color', '--no-ext-diff', '--no-textconv', '--inter-hunk-context=0']
    records = git_bytes(root, *command, *common, '--raw', '--no-abbrev', '-z')
    entries = [(header, path) for header, path in raw_entries(records)
               if header[4][:1] in {b'A', b'M', b'R', b'C', b'T'}
               and header[1] in {b'100644', b'100755'} and select(path)]
    changed, ordinary = [], []
    for header, path in entries:
        status = header[4][:1]
        if status in {b'R', b'C'}:
            # 直接比较已识别改名的两个 blob，避免旧路径现在是目录时混入其他文件。
            patch = git_bytes(root, 'diff', *common, '-p', '-U0', header[2].decode('ascii'), header[3].decode('ascii'))
            changed.append((path, header[3], added_lines(patch)))
        elif status == b'T':
            # 从符号链接或子模块变成普通文件时，新文件的所有行都是新增行。
            changed.append((path, header[3], None))
        else:
            ordinary.append(path)
    wanted = set(ordinary)
    for batch in path_batches(ordinary):
        output = git_bytes(root, *command, *common, '--no-renames', '--raw', '--no-abbrev', '-z', '-p', '-U0', '--', *batch)
        if not output:
            continue
        raw, patches = output.split(b'\0\0', 1)
        sections = re.split(rb'^diff --git ', patches, flags=re.M)[1:]
        batch_entries = list(raw_entries(raw))
        if len(batch_entries) != len(sections):
            raise Incomplete('git 差异输出无效')
        for (header, path), patch in zip(batch_entries, sections):
            if path in wanted:
                changed.append((path, header[3], added_lines(patch)))
    changed = [(path, oid, lines) for path, oid, lines in changed if lines or lines is None]
    targets = []
    if changed:
        output = git_bytes(root, 'cat-file', '--batch', input=b''.join(oid + b'\n' for _, oid, _ in changed))
        offset = 0
        for path, oid, lines in changed:
            end = output.index(b'\n', offset)
            header = output[offset:end].split()
            if len(header) != 3 or header[0] != oid or header[1] != b'blob':
                raise Incomplete('git 文件输出无效')
            size = int(header[2])
            content = output[end + 1:end + 1 + size]
            offset = end + size + 2
            if lines is None:
                count = content.count(b'\n') + int(bool(content) and not content.endswith(b'\n'))
                lines = frozenset(range(1, count + 1))
            if lines:
                targets.append(Target(path, lambda content=content: content, lines))
    return Changes(targets)


def _generated_header(raw: bytes) -> bool:
    # 生成内容可超出文本分析上限或不是 UTF-8，头部标记本身是 ASCII。
    end = 0
    for _ in range(5):
        newline = raw.find(b'\n', end)
        if newline < 0:
            end = len(raw)
            break
        end = newline + 1
    pattern = re.compile(rb'@generated|DO NOT EDIT|Code generated|auto-generated', re.I)
    return pattern.search(raw, 0, end) is not None


def main(name: str, unit: str, check: CheckFn, argv: list[str], here: Path, cwd: Path | None = None) -> int:
    utf8_stdio()
    try:
        mode, strict = parse_line_options(argv)
        root = repo_root(cwd or Path.cwd())
        config = load_config(here, root=root)
        directory = here.resolve()
        changes = collect(root, mode, lambda path: selected(path, config) and not (root / path).is_relative_to(directory))
        if changes.merge:
            print(f'{name}：合并提交不检查。')
            return 0
        findings = {}
        checked = skipped = unanalyzable = 0
        for target in changes.targets:
            if not selected(target.path, config):
                continue
            raw = target.read()
            if b'\0' in raw[:8000]:
                continue
            if strict and _generated_header(raw):
                continue
            if len(raw) > 1024 * 1024:
                skipped += 1
                continue
            try:
                text = raw.decode('utf-8-sig')
            except UnicodeDecodeError:
                skipped += 1
                continue
            if re.search(r'@generated|DO NOT EDIT|Code generated|auto-generated', '\n'.join(text.split('\n')[:5]), re.I):
                continue
            try:
                results = check(target.path, text, target.added, config)
            except Exception:
                unanalyzable += 1
                continue
            for finding in results:
                findings[(finding.path, finding.line, finding.rule)] = finding
            checked += 1
        for key in sorted(findings):
            f = findings[key]
            print(f'{f.path}:{f.line}: [{f.rule}] {f.message}')
        counts = []
        if skipped:
            counts.append(f'{skipped} 个非 UTF-8 或过大的文件')
        if unanalyzable:
            counts.append(f'{unanalyzable} 个无法分析的文件')
        suffix = '（跳过 ' + '，'.join(counts) + '）' if counts else ''
        print(f'{name}：检查了 {checked} 个文件，{len(findings)} 处{unit}{suffix}。')
        if strict and (skipped or unanalyzable):
            return 2
        return 1 if findings else 0
    except ConfigError as error:
        reason = '配置无效：' + error.args[0]
    except Incomplete as error:
        reason = error.args[0]
    except Exception as error:
        reason = type(error).__name__
    print(f'{name}未完成：{reason}', file=sys.stderr)
    return 2
