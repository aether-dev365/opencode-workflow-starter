#!/usr/bin/env python3
"""Preserve test/build failures in pipelines without changing other input fields.

Quoted pipes and data heredocs are not pipelines. Consumers that exit early
after a grep match are exempt; head truncation retains its real SIGPIPE status.
"""
import re
import sys
import json
import shlex
from pathlib import Path
from policy import policy_root

from hooklib import HEREDOC_OP, PREFIX, _lift_substitutions, _mask_quotes, windows_path
from protocol import emit_result, load_event

# 管道里非末端的这些命令，失败时退出码会被末端吞掉
TEST_CMD = re.compile(
    r"^(?:\S*/)?(?:mvnw?|gradlew?)(?=\s|$)"
    r"|^(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|type-check|build|lint)[\w:.-]*)(?=\s|$)"
    r"|^npx\s+(?:vitest|playwright|vue-tsc|tsc|eslint|jest)(?=\s|$)"
    r"|^(?:bash|sh)\s+(?:-\w+\s+)*\S*(?:run-tests|run|test-[\w-]+)\.sh(?=\s|$)"
    r"|^(?:python3?\s+-m\s+)?pytest(?=\s|$)"
    r"|^node\s+--test(?=\s|$)")
# 切管道的分隔符：|| && ; & 换行结束一条管道，| 与 |& 连接阶段
SEPARATOR = re.compile(r"\|\||&&|\|&?|[;&\n]")
# 提前退出的消费者：grep 找到就走（-q / -m / -l），写端随后收到 SIGPIPE、以 141 退出——pipefail 会把
# `mvn test | grep -q "BUILD SUCCESS"` 这种条件判反。head 不在此列：测试没写完就被截断时报 141 正是实情。
EARLY_EXIT_GREP = re.compile(
    r"^(?:\S*/)?[ef]?grep\b.*\s-(?:[a-zA-Z]*[qlm]|-quiet|-silent|-max-count|-files-with-matches)")
# 组命令收尾的「; }」「换行 }」：组的退出码是组里最后一条的，这个分隔符不切管道，最后一条才和组外的 | 连成一段
# （`{ mvn test; } | tail` 按 ; 切开后，管道首段只剩「}」）。( … ) 不用管：切出来的「mvn test)」本来就认。
GROUP_CLOSE = re.compile(r"[;\n](?=[ \t]*\})")


def _drop_heredoc_bodies(command):
    lines, out, i = command.split("\n"), [], 0
    while i < len(lines):
        out.append(lines[i])
        m = HEREDOC_OP.search(lines[i])
        if m:
            j = i + 1
            while j < len(lines) and lines[j].strip() != m.group(2):
                j += 1
            if j < len(lines):
                i = j
        i += 1
    return "\n".join(out)


def _pipelines(text):
    """[[阶段, …], …]；在引号掩码上找分隔符，2>&1 / &> / >| 这类重定向里的 & | 不算。"""
    masked = _mask_quotes(text)
    for m in GROUP_CLOSE.finditer(masked):  # 等长替换，下标仍能回原文取
        masked = masked[:m.start()] + " " + masked[m.end():]
        text = text[:m.start()] + " " + text[m.end():]
    pipes, stages, start = [], [], 0
    for m in SEPARATOR.finditer(masked):
        tok, s = m.group(), m.start()
        if tok == "&" and ((s and masked[s - 1] in "<>") or masked[s + 1:s + 2] == ">"):
            continue
        if tok == "|" and s and masked[s - 1] == ">":
            continue
        stages.append(text[start:s].strip())
        start = m.end()
        if tok not in ("|", "|&"):
            pipes.append(stages)
            stages = []
    stages.append(text[start:].strip())
    pipes.append(stages)
    return pipes


def _is_test(stage, prefixes):
    core = stage.lstrip("({! \t")
    core = PREFIX.sub("", PREFIX.sub("", core).strip()).strip()
    try:
        tokens = shlex.split(core)
    except ValueError:
        tokens = []
    return bool(TEST_CMD.match(core)) or any(tokens[:len(prefix)] == prefix for prefix in prefixes)


def needs_pipefail(text, prefixes=()):
    inners = []
    outer, _ = _lift_substitutions(text, inners)
    for stages in _pipelines(outer):
        if any(_is_test(st, prefixes) and not EARLY_EXIT_GREP.match(nxt) for st, nxt in zip(stages, stages[1:])):
            return True
    return any(needs_pipefail(inner, prefixes) for inner in inners)


def check(data):
    tool_input = data['input']
    command = tool_input.get("command")
    if data['tool'] != 'shell' or not isinstance(command, str) or "pipefail" in command:
        return dict(decision='allow')
    prefixes = []
    try:
        root = policy_root(Path(data['directory']) / windows_path(tool_input.get('workdir', '')))
        config = root / '.opencode/workflow/pipefail.json' if root else None
        if config and config.exists():
            value = json.loads(config.read_text(encoding='utf-8'))
            prefixes = value['commandPrefixes']
            if value.get('version') != 1 or not isinstance(prefixes, list) or any(
                    not isinstance(p, list) or not p or any(not isinstance(t, str) or not t for t in p) for p in prefixes):
                raise ValueError('命令前缀格式无效')
    except (OSError, ValueError, TypeError, KeyError):
        return dict(decision='deny', reason='pipefail.json 无效；未执行操作。')
    if not needs_pipefail(_drop_heredoc_bodies(command), prefixes):
        return dict(decision='allow')
    return dict(decision='allow', input=dict(tool_input, command='set -o pipefail; ' + command))


if __name__ == '__main__':
    result = check(load_event())
    emit_result(result['decision'], reason=result.get('reason', ''), input=result.get('input'))
    sys.exit(0 if result['decision'] == 'allow' else 2)
