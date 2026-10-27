#!/usr/bin/env python3
"""Expose the shared, mature path analysis to the native asynchronous adapter."""
from hooklib import candidates_from, _analyze, tool_path
from protocol import emit_result, load_event


def check(data):
    paths, _ = candidates_from(data, include_readonly=True)
    cwd = tool_path(data['directory'], data['input'].get('workdir', ''))
    readonly = True
    if data['tool'] == 'shell':
        # hooklib 的只读不管落盘的重定向；插件据此决定是否加载规则、检查配置，写重定向的命令不算只读。
        targets, _, readonly = _analyze(data['input'].get('command', ''), cwd, {})
        readonly = readonly and not targets
    return dict(decision='allow', input={'paths': paths, 'readonly': readonly})


if __name__ == '__main__':
    emit_result(input=check(load_event())['input'])
