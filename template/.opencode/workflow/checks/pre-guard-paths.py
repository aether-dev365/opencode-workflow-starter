#!/usr/bin/env python3
"""Apply configured protection to native paths and supported shell operations."""
import os
from pathlib import Path
import shlex
from hooklib import candidates_from, split_segments, _command_lines, PREFIX, SYS_BIN, _cd
from policy import check_path, load_policy, policy_root
from protocol import emit_result, load_event


def check_event(event):
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

    def check(path, action, selected=None, reported_path=None):
        target_root, policy = selected if selected is not None else policy_for(path)
        reason = check_path(target_root, path, action, policy)
        if reason:
            raise ValueError(f'{reason} 路径：{reported_path or path}')

    if event['tool'] != 'shell':
        for path in candidates_from(event)[0]:
            check(path, 'read' if event['tool'] == 'read' or event['input'].get('action') == 'read' else 'edit')
        return
    cwd = str(Path(event['directory']) / event['input'].get('workdir', ''))
    command = event['input'].get('command', '')
    segments = split_segments('\n'.join(_command_lines(command.splitlines())))
    filtered = []
    for segment in segments:
        core = segment
        while True:
            next_core = PREFIX.sub('', core, count=1).strip()
            if core == next_core:
                break
            core = next_core
        try:
            words = shlex.split(SYS_BIN.sub('', core, count=1))
        except ValueError:
            words = []
        if words and words[0] in ['source', '.']:
            continue
        filtered.append(segment)
        if not words:
            continue
        if words[0] == 'cd' and len(words) > 1:
            cwd = _cd(cwd, words[-1])
        targets = []
        if words[0] == 'rm' and any(w == '--recursive' or (w.startswith('-') and ('r' in w or 'R' in w)) for w in words[1:]):
            targets = [w for w in words[1:] if not w.startswith('-')]
        elif words[0] == 'find' and any(w in ['-delete', '-exec', '-execdir'] for w in words):
            targets = [words[1]] if len(words) > 1 and not words[1].startswith('-') else ['.']
        elif words[0] == 'git' and 'clean' in words and any(w.startswith('-') and ('x' in w or 'X' in w) for w in words):
            if '-C' in words:
                cwd = _cd(cwd, words[words.index('-C') + 1])
            targets = [w for w in words[words.index('clean') + 1:] if not w.startswith('-')] or ['.']
        for target in targets:
            absolute = Path(cwd) / target
            selected = policy_for(str(absolute))
            # 删除目录会编辑其内容；子项探针让受保护目录本身也命中编辑规则。
            check(str(absolute), 'edit', selected)
            check(str(absolute / '_'), 'edit', selected, reported_path=str(absolute))
            if absolute.is_dir():
                # 目标内只拦截不可读文件，避免依赖内部的生成目录阻断清理；复用目标策略。
                for folder, dirs, files in os.walk(absolute):
                    dirs[:] = [d for d in dirs if d != '.git']
                    for name in dirs + files:
                        check(str(Path(folder) / name), 'read', selected)
    candidate_event = {**event, 'paths': [], 'input': {**event['input'], 'command': '; '.join(filtered)}}
    for path in candidates_from(candidate_event, include_readonly=True)[0]:
        check(path, 'read')
    for path in candidates_from(candidate_event)[0]:
        check(path, 'edit')


def main():
    try:
        check_event(load_event())
        emit_result()
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        emit_result('deny', reason=f'文件保护检查拒绝：{error}')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
