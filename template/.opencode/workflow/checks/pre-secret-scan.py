#!/usr/bin/env python3
"""Scan prospective commit additions with Gitleaks, without changing the real index.

This is a bounded command grammar, not a shell interpreter. Mutating compound
commands must be split so the scan observes the index that will be committed.
"""
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time

from hooklib import _command_lines, _lift_substitutions, split_segments, windows_path
from protocol import emit_result, read_event

TOTAL_TIMEOUT = 8
COMMIT_DIFF_LIMIT = 16 * 1024 * 1024
SNAPSHOT_DIFF_LIMIT = 128 * 1024 * 1024
PIN = Path(__file__).resolve().parents[2] / 'secret-scan'
UNSUPPORTED = ('已拦截：凭据扫描无法可靠确定这条提交命令的内容。'
               '请将暂存或其他操作与提交拆成独立工具调用；先独立执行 git add，再独立执行 '
               'git commit -m "说明"。可在提交前加 cd <目录> && 或 git -C <目录>；'
               '交互式选择请先独立运行 git add -p，路径清单请直接写在 -- 后。')
GIT_ENV = {'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
           'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
           'GIT_NAMESPACE'}


class Blocked(Exception):
    pass


def install_command(os_name=os.name):
    return ('py -3' if os_name == 'nt' else 'python3') + ' .opencode/secret-scan/install.py'


def kill_tree(proc, os_name=os.name, run=subprocess.run):
    """超时后终止扫描器及其子进程：POSIX 杀掉整个进程组，Windows 用 taskkill /T。"""
    if os_name == 'nt':
        run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], capture_output=True)
    else:
        os.killpg(proc.pid, signal.SIGKILL)


def words(command):
    parser = shlex.shlex(command, posix=True, punctuation_chars=';&|()< >')
    parser.whitespace_split = True
    parser.commenters = '#'
    return list(parser)


def contains_commit(command):
    """Locate literal commit invocations, including unsupported shell wrappers.

    Data heredocs and ordinary echo/read arguments are not commands. Aliases and
    arbitrary scripts are outside this command guard's documented boundary.
    """
    text = '\n'.join(_command_lines(command.split('\n')))
    inner = []
    outer, _ = _lift_substitutions(text, inner)
    if any(contains_commit(part) for part in inner):
        return True
    for segment in split_segments(outer):
        try:
            tokens = words(segment.lstrip('({! '))
        except ValueError:
            return bool(re.search(r'\bgit\b[^\n]*\bcommit\b', segment))
        while tokens and (tokens[0] in ('then', 'do', 'if')
                          or re.match(r'^[A-Za-z_][A-Za-z_0-9]*=', tokens[0])):
            tokens.pop(0)
        if not tokens:
            continue
        name = Path(tokens[0]).name
        if name in ('env', 'command', 'exec', 'time', 'timeout', 'nice'):
            tokens.pop(0)
            while tokens and (tokens[0].startswith('-') or re.match(r'^\w+=', tokens[0])):
                option = tokens.pop(0)
                if option in ('-u', '--unset', '-C', '--chdir', '-a', '-n', '--adjustment',
                              '-k', '--kill-after', '-s', '--signal') and tokens:
                    tokens.pop(0)
            if name == 'timeout' and tokens:
                tokens.pop(0)
            if contains_commit(shlex.join(tokens)):
                return True
        if name in ('bash', 'sh', 'zsh'):
            if any('c' in t and t.startswith('-') for t in tokens[1:3]):
                if any(contains_commit(t) for t in tokens[2:]):
                    return True
        if name == 'git':
            index = 1
            while index < len(tokens):
                token = tokens[index]
                if token in ('-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'):
                    index += 2
                elif token.startswith('-'):
                    index += 1
                else:
                    if token == 'commit':
                        return True
                    break
    # Backtick substitutions do not have a supported execution grammar.
    return any(contains_commit(part) for part in re.findall(r'`([^`]+)`', text))


def shell_directory(path):
    """Reject logical/physical cd ambiguity before resolving any symlinks."""
    path = Path(path)
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise Blocked('已拦截：cd 起点或目标经过符号链接，Bash 逻辑目录与物理路径可能不同。'
                      '请先独立运行 pwd -P 确认目标仓库，再在独立工具调用中使用 '
                      'git -C <真实绝对路径> commit -m "说明"，或 cd <真实绝对路径> && git commit。')
    return path.resolve()


def commit_command(command, cwd):
    if not contains_commit(command):
        return None
    # Expansions can run commands or select a different index/path. Even message
    # substitutions are rejected; use a literal message or a prepared -F file.
    text = '\n'.join(_command_lines(command.split('\n'))).replace('\\\n', ' ')
    if any(c in text for c in ('$','`')):
        raise Blocked(UNSUPPORTED)
    tokens = words(text)
    if len(tokens) > 1 and tokens[0] == 'cd' and not Path(windows_path(tokens[1])).is_absolute():
        cwd = shell_directory(cwd)
        # Bash preserves a valid inherited logical PWD even if the hook's cwd
        # was already canonicalized by the host. An absolute first cd resets it.
        inherited_pwd = os.environ.get('PWD')
        try:
            if inherited_pwd and os.path.samefile(inherited_pwd, cwd):
                shell_directory(inherited_pwd)
        except OSError:
            pass  # Bash discards a PWD that does not refer to its cwd.
    while tokens[:1] == ['cd']:
        if len(tokens) < 4 or tokens[2] != '&&' or tokens[1].startswith('-'):
            raise Blocked(UNSUPPORTED)
        if not Path(windows_path(tokens[1])).is_absolute() and os.environ.get('CDPATH'):
            raise Blocked('已拦截：非空 CDPATH 会改变相对 cd 的目标。请在独立工具调用中使用 '
                          'git -C <真实绝对路径> commit，或 cd <真实绝对路径> && git commit。')
        cwd = shell_directory(Path(cwd) / windows_path(tokens[1]))
        tokens = tokens[3:]
    if not tokens or tokens.pop(0) not in ('git', '/usr/bin/git', '/bin/git'):
        raise Blocked(UNSUPPORTED)
    while tokens and tokens[0] != 'commit':
        option = tokens.pop(0)
        if option == '--no-pager':
            continue
        if option == '-C' and tokens:
            target = tokens.pop(0)
        elif option.startswith('-C') and len(option) > 2:
            target = option[2:]
        else:
            raise Blocked(UNSUPPORTED)
        cwd = (Path(cwd) / windows_path(target)).resolve()
    if not tokens:
        raise Blocked(UNSUPPORTED)
    tokens.pop(0)
    if any(t in ('&&', '||', ';', '|', '&', '(', ')', '<', '>', '>>', '<<') for t in tokens):
        raise Blocked(UNSUPPORTED)
    if '\n' in text.strip() and len(split_segments(text)) > 1:
        raise Blocked(UNSUPPORTED)

    mode, amend, paths = 'staged', False, []
    no_value = {'--amend', '--no-edit', '--allow-empty', '--allow-empty-message', '--no-verify',
                '--no-gpg-sign', '--signoff', '--reset-author', '--quiet', '--verbose',
                '--edit', '--no-post-rewrite', '--dry-run', '--short', '--branch',
                '--porcelain', '--long', '--null', '--ahead-behind', '--no-ahead-behind'}
    with_value = {'--message', '--file', '--author', '--date', '--cleanup', '--reuse-message',
                  '--reedit-message', '--template', '--fixup', '--squash', '--trailer'}
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if token == '--':
            paths.extend(tokens[index:])
            break
        if token in ('--all', '--only', '--include'):
            new_mode = {'--all': 'all', '--only': 'only', '--include': 'include'}[token]
            if mode != 'staged' and mode != new_mode:
                raise Blocked(UNSUPPORTED)
            mode = new_mode
        elif token in no_value:
            amend |= token == '--amend'
        elif token.split('=', 1)[0] in with_value:
            if '=' not in token:
                if index == len(tokens):
                    raise Blocked(UNSUPPORTED)
                index += 1
        elif token in ('--gpg-sign', '--untracked-files') or token.startswith(('--gpg-sign=', '--untracked-files=')):
            pass
        elif token.startswith('--'):
            raise Blocked(UNSUPPORTED)
        elif token.startswith('-') and token != '-':
            short = token[1:]
            while short:
                flag, short = short[0], short[1:]
                if flag in 'aio':
                    new_mode = {'a': 'all', 'i': 'include', 'o': 'only'}[flag]
                    if mode != 'staged' and mode != new_mode:
                        raise Blocked(UNSUPPORTED)
                    mode = new_mode
                elif flag in 'mFCct':
                    if not short:
                        if index == len(tokens):
                            raise Blocked(UNSUPPORTED)
                        index += 1
                    break
                elif flag in 'Su':
                    break  # optional attached value only
                elif flag not in 'qvns ez'.replace(' ', ''):
                    raise Blocked(UNSUPPORTED)
        else:
            paths.append(token)
    if paths and mode == 'staged':
        mode = 'only'
    if (paths and mode == 'all') or (mode == 'include' and not paths) or (
            mode == 'only' and not paths and not amend):
        raise Blocked(UNSUPPORTED)
    # Unquoted globs/tilde are expanded by Bash before Git sees them; require the
    # literal pathspec to be quoted (shlex keeps it intact for Git).
    from hooklib import _mask_quotes
    if re.search(r'[*?\[\]{}~]', _mask_quotes(text)):
        raise Blocked(UNSUPPORTED)
    return Path(cwd), mode, amend, paths


class Runner:
    def __init__(self):
        self.deadline = time.monotonic() + TOTAL_TIMEOUT

    def run(self, args, *, env=None, cwd=None, data=b'', ok=(0,)):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise Blocked('已拦截：凭据扫描超时；请缩小单次提交并重新扫描，或排查 Git/Gitleaks 性能。')
        try:
            proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, env=env, cwd=cwd, start_new_session=True)
            try:
                stdout, _ = proc.communicate(data, timeout=remaining)
            except subprocess.TimeoutExpired:
                kill_tree(proc)
                proc.communicate()
                raise Blocked('已拦截：凭据扫描超时；请缩小单次提交并重新扫描，或排查 Git/Gitleaks 性能。')
        except OSError:
            raise Blocked('已拦截：Git/Gitleaks 无法启动，请检查安装和仓库路径后重试。') from None
        if proc.returncode not in ok:
            raise Blocked('已拦截：Git/Gitleaks 扫描失败，请检查暂存区、提交参数或扫描器安装后重试；原始输出未回显。')
        return proc.returncode, stdout


def scan_commit(parsed, runner, *, snapshot=None):
    cwd, mode, amend, paths = parsed
    if any(os.environ.get(name) for name in GIT_ENV):
        raise Blocked('已拦截：当前环境覆盖了 Git 仓库或 index；请清除 GIT_* 覆盖后用独立 git -C <目录> commit。')
    pin = json.loads((PIN / 'pinned.json').read_text(encoding='utf-8'))
    scanner = shutil.which('gitleaks')
    if not scanner:
        fallback = Path.home() / '.local/bin' / ('gitleaks.exe' if os.name == 'nt' else 'gitleaks')
        scanner = str(fallback) if fallback.is_file() else None
    if not scanner:
        raise Blocked(f'已拦截：缺少 Gitleaks；先运行 {install_command()}，再重新提交。'
                      'OpenCode 后台服务的 PATH 在服务启动时确定，安装扫描器或修改 PATH 后先执行 opencode service restart。')
    _, version = runner.run([scanner, 'version'])
    if version.strip().decode('ascii', 'replace') != pin['version']:
        raise Blocked(f'已拦截：Gitleaks 版本不匹配；运行 {install_command()} --check 检查固定版本。')
    env = {k: v for k, v in os.environ.items() if not k.startswith('GITLEAKS_')}
    env['GIT_OPTIONAL_LOCKS'] = '0'

    def git(*args, data=b'', ok=(0,), directory=None):
        return runner.run(['git', '-C', str(directory or cwd), *args], env=env, data=data, ok=ok)

    _, root_data = git('rev-parse', '--show-toplevel')
    root = Path(os.fsdecode(root_data.rstrip(b'\n')))
    _, index_data = git('rev-parse', '--path-format=absolute', '--git-path', 'index')
    original_index = Path(os.fsdecode(index_data.rstrip(b'\n')))
    _, objects_data = git('rev-parse', '--path-format=absolute', '--git-path', 'objects')
    objects = os.fsdecode(objects_data.rstrip(b'\n'))
    code, head = git('rev-parse', '--verify', '--quiet', 'HEAD', ok=(0, 1))
    has_head = code == 0

    with tempfile.TemporaryDirectory(prefix='workflow-secret-scan-') as temporary:
        temp = Path(temporary)
        index = temp / 'index'
        if original_index.exists():
            shutil.copyfile(original_index, index)
        (temp / 'objects').mkdir()
        # Prospective -a/path blobs go in the temporary object database too.
        env.update(GIT_INDEX_FILE=str(index), GIT_OBJECT_DIRECTORY=str(temp / 'objects'),
                   GIT_ALTERNATE_OBJECT_DIRECTORIES=objects)
        if not index.exists():
            git('read-tree', '--empty')
        if mode in ('only', 'include') and paths:
            # commit pathspecs may name a path already staged for deletion;
            # Git still considers the HEAD entry tracked for a --only commit.
            inherited = ['--with-tree=HEAD'] if has_head else []
            _, selected = git('ls-files', '-z', *inherited, '--', *paths)
            chosen = list(dict.fromkeys(p for p in selected.split(b'\0') if p))
            if not chosen:
                raise Blocked('已拦截：提交路径未匹配 Git 已跟踪文件；先独立 git add 对应文件再提交。')
        else:
            chosen = []
        if mode == 'only':
            git('read-tree', 'HEAD') if has_head else git('read-tree', '--empty')
        if mode == 'all':
            git('add', '-u', '--', '.', directory=root)
        elif chosen:
            # ls-files from a subdirectory returns cwd-relative paths. Literal
            # NUL pathspecs preserve filenames containing spaces/glob characters.
            pathspecs = b'\0'.join(b':(literal)' + path for path in chosen) + b'\0'
            git('add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul', data=pathspecs)

        base = []
        if snapshot is not None:
            if len(snapshot) != 2 or not all(re.fullmatch(r'[a-f0-9]{40,64}', value) for value in snapshot):
                raise Blocked('已拦截：凭据扫描快照无效。')
            base = [snapshot[0]]
            git('read-tree', snapshot[1])
        elif amend:
            if not has_head:
                raise Blocked('已拦截：没有可 amend 的 HEAD。')
            code, parent = git('rev-parse', '--verify', '--quiet', 'HEAD^', ok=(0, 1))
            if code:
                _, parent = git('hash-object', '-w', '-t', 'tree', '--stdin')
            base = [parent.strip().decode('ascii')]
        options = ['diff', '--cached', '--text', '--no-ext-diff', '--no-textconv', '--no-renames',
                   '--no-color', '--no-relative', '--unified=0']
        _, names = git(*options, '--name-only', '-z', *base, '--', directory=root)
        _, diff = git(*options, *base, '--', directory=root)
        report = temp / 'report.json'
        (temp / '.gitleaksignore').touch()
        for part, part_names in scan_chunks(diff, names, snapshot is not None):
            content, locations = additions(part, part_names)
            if not content:
                continue
            # 每片必须产生新报告，不能沿用前片的空报告伪造扫描成功。
            report.unlink(missing_ok=True)
            code, _ = runner.run([
                scanner, 'stdin', '--config', str(PIN / 'gitleaks.toml'), '--no-banner',
                '--redact=100', '--log-level=error', '--exit-code=23', '--ignore-gitleaks-allow',
                '--gitleaks-ignore-path', str(temp / '.gitleaksignore'),
                '--report-format=json', '--report-path', str(report),
            ], cwd=temp, env=env, data=content, ok=(0, 23))
            try:
                findings = json.loads(report.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                raise Blocked('已拦截：Gitleaks 扫描失败，未产生有效报告。') from None
            if not isinstance(findings, list) or (code == 23) != bool(findings):
                raise Blocked('已拦截：Gitleaks 报告与退出状态不一致，请检查扫描器后重试。')
            if findings:
                notices = []
                for finding in findings[:12]:
                    offset = finding.get('StartLine')
                    rule = finding.get('RuleID', '')
                    if not isinstance(offset, int) or offset < 1 or offset > len(locations):
                        raise Blocked('已拦截：Gitleaks 报告行号无效，请检查扫描器后重试。')
                    path, line = locations[offset - 1]
                    rule = rule if re.fullmatch(r'[a-z0-9-]{1,80}', rule) else 'credential'
                    notices.append(f'- {json.dumps(path, ensure_ascii=False)}:{line} ({rule})')
                raise Blocked('已拦截：拟提交新增内容含疑似凭据（只显示位置和规则）。\n' + '\n'.join(notices)
                              + '\n请移除真实凭据并重新 git add 后提交；若已泄露需轮换凭据。'
                                '合成测试值应在运行时构造，勿对白名单放开整个 test/vendor 目录。')


def scan_chunks(diff, names, snapshot):
    limit = SNAPSHOT_DIFF_LIMIT if snapshot else COMMIT_DIFF_LIMIT
    if len(diff) > limit:
        raise Blocked('已拦截：本次提交差异超过扫描大小上限，请拆分提交后重新扫描。')
    if len(diff) <= COMMIT_DIFF_LIMIT:
        yield diff, names
        return
    paths = [path for path in names.split(b'\0') if path]
    starts = [match.start() for match in re.finditer(rb'^diff --git ', diff, re.M)]
    if len(starts) != len(paths) or not starts or starts[0] != 0:
        raise Blocked('已拦截：累计扫描差异与文件清单不一致。')
    start, first = 0, 0
    # 只在文件边界分片，保留同一文件的所有新增行及跨行凭据上下文；不排除二进制。
    for index, begin in enumerate(starts):
        end = starts[index + 1] if index + 1 < len(starts) else len(diff)
        if end - begin > COMMIT_DIFF_LIMIT:
            raise Blocked('已拦截：单文件差异超过扫描分片上限，不能截断凭据上下文。')
        if end - start > COMMIT_DIFF_LIMIT:
            yield diff[start:begin], b'\0'.join(paths[first:index]) + b'\0'
            start, first = begin, index
    yield diff[start:], b'\0'.join(paths[first:]) + b'\0'


def additions(diff, names):
    """Map unified-diff additions to original filenames/line numbers, not removals.

    The separate NUL name list avoids reimplementing Git's C-quoted filename
    format. Both diff invocations use identical ordering and disable renames.
    """
    paths = iter(os.fsdecode(p) for p in names.split(b'\0') if p)
    output, locations, path, line = [], [], None, None
    for raw in diff.split(b'\n'):
        if raw.startswith(b'diff --git '):
            path, line = next(paths), None
        elif raw.startswith(b'@@ '):
            match = re.match(rb'@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@', raw)
            if not match or path is None:
                raise Blocked('已拦截：无法解析 Git 差异，请检查暂存区后重试。')
            line = int(match[1])
            output.append(b'\n')
            locations.append((path, line))
        elif line is not None and raw.startswith(b'+'):
            output.append(raw[1:] + b'\n')
            locations.append((path, line))
            line += 1
        elif line is not None and raw.startswith(b' '):
            line += 1
    return b''.join(output), locations


def scan_snapshot(root: str, base: str, tree: str) -> None:
    scan_commit((root, 'staged', False, []), Runner(), snapshot=(base, tree))


FAILED = '已拦截：凭据扫描失败；请检查 Git/Gitleaks 安装及检查输入后重试。'


def check(data):
    """One event's scan decision; never raises."""
    runner = Runner()
    try:
        if data['phase'] == 'inspect' and data['tool'] == 'snapshot':
            scan_snapshot(data['directory'], data['input']['base'], data['input']['tree'])
            return dict(decision='allow')
        if data['phase'] != 'before' or data['tool'] != 'shell':
            return dict(decision='allow')
        command = data['input'].get('command')
        if not isinstance(command, str):
            raise Blocked('已拦截：凭据扫描缺少 Bash command 输入。')
        cwd = Path(data['directory']) / windows_path(data['input'].get('workdir', ''))
        parsed = commit_command(command, str(cwd))
        if parsed:
            scan_commit(parsed, runner)
            # 结论取决于此刻的暂存区和工作区，插件不能缓存它。
            return dict(decision='allow', volatile=True)
    except Blocked as exc:
        return dict(decision='deny', reason=str(exc))
    except Exception:
        # Do not disclose exceptions containing command output, diff or reports.
        return dict(decision='deny', reason=FAILED)
    return dict(decision='allow')


def main():
    try:
        data = read_event(sys.stdin.read())
    except Exception:
        emit_result('deny', reason=FAILED)
        return 2
    result = check(data)
    emit_result(result['decision'], reason=result.get('reason', ''))
    return 0 if result['decision'] == 'allow' else 2


if __name__ == '__main__':
    raise SystemExit(main())
