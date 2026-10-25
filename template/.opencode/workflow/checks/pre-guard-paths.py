#!/usr/bin/env python3
"""Apply configured protection to native paths and supported shell operations."""
import os
from pathlib import Path
from hooklib import (candidates_from, split_segments, _command_lines, _lift_substitutions, _backtick_commands,
                     _cd, windows_path, has_hidden_shell_eval, static_command_words, find_roots)
from policy import check_path, load_policy, policy_root
from protocol import emit_result, load_event


def check_event(event):
    """拒绝时抛出 ValueError；放行时返回结论是否取决于仓库内容（递归删除要遍历目标目录）。"""
    root = policy_root(event['directory'])
    if root is None:
        raise ValueError('无法定位检出，未执行操作')
    policies = {root: load_policy(root)}

    def policy_for(path):
        # 选项与未展开变量不是绝对路径，检查结果不能受检查器进程目录影响。
        target_root = (policy_root(path) or root) if os.path.isabs(path) else root
        # 外部检出缺配置时沿用会话规则，读取普通参考文件仍可用，凭据规则继续生效。
        if target_root != root and not (target_root / '.opencode/workflow/protection.json').exists():
            target_root = root
        if target_root not in policies:
            policies[target_root] = load_policy(target_root)
        return target_root, policies[target_root]

    def check(path, action, selected=None, reported_path=None, real=None):
        target_root, policy = selected if selected is not None else policy_for(path)
        reason = check_path(target_root, path, action, policy, real, descendants=action == 'edit')
        if reason:
            raise ValueError(f'{reason} 路径：{reported_path or path}')

    if event['tool'] == 'grep':
        path = event['input'].get('path', '')
        if not isinstance(path, str):
            raise ValueError('搜索路径无效')
        target = Path(event['directory']) / windows_path(path)
        check(str(target), 'read')
        pending = [target] if target.is_dir() else []
        while pending:
            folder = pending.pop()
            # 不能依赖 rg 的忽略文件来豁免凭据；按可能搜索到的全部文件检查。
            for entry in os.scandir(folder):
                if entry.name == '.git':
                    continue
                check(entry.path, 'read')
                if entry.is_dir():
                    if entry.is_symlink():
                        raise ValueError('无法确认符号链接目录的搜索范围')
                    pending.append(Path(entry.path))
        return True
    if event['tool'] != 'shell':
        for path in candidates_from(event)[0]:
            check(path, 'read' if event['tool'] == 'read' or event['input'].get('action') == 'read' else 'edit')
        return False
    cwd = str(Path(event['directory']) / windows_path(event['input'].get('workdir', '')))
    command = event['input'].get('command', '')
    reason = '无法静态检查这条 shell 命令，请改写成直接的命令'
    try:
        hidden_eval = has_hidden_shell_eval(command)
    except (ValueError, RecursionError) as error:
        raise ValueError(reason) from error
    if hidden_eval:
        raise ValueError(reason)
    def command_words(segment):
        try:
            return static_command_words(segment)
        except ValueError as error:
            raise ValueError(reason) from error

    def deletes(words, cwd):
        """cd 与递归删除类命令：返回 (之后的 cwd, 是否有删除目标)，目标逐个检查。"""
        if words[0] == 'cd' and len(words) > 1:
            cwd = _cd(cwd, words[-1])
        targets = []
        if words[0] == 'rm' and any(w == '--recursive' or (w.startswith('-') and ('r' in w or 'R' in w)) for w in words[1:]):
            targets = [w for w in words[1:] if not w.startswith('-')]
        elif words[0] == 'find' and any(w in ['-delete', '-exec', '-execdir'] for w in words):
            targets = find_roots(words)
        elif words[0] == 'git' and 'clean' in words and any(w.startswith('-') and ('x' in w or 'X' in w) for w in words):
            targets = [w for w in words[words.index('clean') + 1:] if not w.startswith('-')] or ['.']
        for target in targets:
            absolute = Path(cwd) / target
            selected = policy_for(str(absolute))
            # 删除目录会编辑其内容；check 对全部写候选统一使用子项探针。
            check(str(absolute), 'edit', selected)
            if absolute.is_dir():
                # 目标内只拦截不可读文件，避免依赖内部的生成目录阻断清理；复用目标策略。
                for entry, real in walk_with_real_paths(absolute):
                    check(str(entry), 'read', selected, real=real)
        return cwd, bool(targets)

    def nested_deletes(segment, cwd):
        """命令替换、进程替换与反引号里的递归删除同样检查；内层 cd 只影响内层。返回是否有删除目标。"""
        inners = []
        lifted, _ = _lift_substitutions(segment, inners)
        found = False
        for inner in inners + _backtick_commands(lifted):
            local = cwd
            for part in split_segments(inner):
                words = command_words(part)
                if words:
                    local, removed = deletes(words, local)
                    found = found or removed
                found = nested_deletes(part, local) or found
        return found

    segments = split_segments('\n'.join(_command_lines(command.splitlines(), literal=True)))
    filtered = []
    volatile = False
    for segment in segments:
        words = command_words(segment)
        volatile = nested_deletes(segment, cwd) or volatile
        filtered.append(segment)
        if not words:
            continue
        cwd, removed = deletes(words, cwd)
        volatile = volatile or removed
    candidate_event = {**event, 'paths': [], 'input': {**event['input'], 'command': '; '.join(filtered)}}
    for path in candidates_from(candidate_event, include_readonly=True)[0]:
        check(path, 'read')
    for path in candidates_from(candidate_event)[0]:
        check(path, 'edit')
    return volatile


def walk_with_real_paths(top):
    """遍历范围与 os.walk(top) 相同（不进入 .git 目录，不跟随指向目录的符号链接），并给出每项的真实路径。

    普通项的真实路径是所在目录的真实路径加名字，不必逐个解析；链接和 Windows 联接点给 None，由调用方完整解析。
    """
    pending = [(top, top.resolve())]
    while pending:
        folder, real = pending.pop()
        try:
            entries = list(os.scandir(folder))
        except OSError:
            continue
        for entry in entries:
            try:
                directory = entry.is_dir()
            except OSError:
                directory = False
            if directory and entry.name == '.git':
                continue
            try:
                symlink = entry.is_symlink()
            except OSError:
                symlink = False
            linked = symlink or (hasattr(entry, 'is_junction') and entry.is_junction())
            path = Path(entry.path)
            yield path, None if linked else real / entry.name
            if directory and not symlink:
                pending.append((path, path.resolve() if linked else real / entry.name))


def check(data):
    try:
        return dict(decision='allow', volatile=True) if check_event(data) else dict(decision='allow')
    except (ValueError, OSError, KeyError, TypeError) as error:
        return dict(decision='deny', reason=f'文件保护检查拒绝：{error}')


def main():
    result = check(load_event())
    emit_result(result['decision'], reason=result.get('reason', ''))
    return 0 if result['decision'] == 'allow' else 2


if __name__ == '__main__':
    raise SystemExit(main())
