#!/usr/bin/env python3
"""Expose the shared, mature path analysis to the native asynchronous adapter."""
from hooklib import candidates_from, _analyze, _resolve
from protocol import emit_result, load_event


def check(data):
    paths, _ = candidates_from(data, include_readonly=True)
    cwd = _resolve(data['directory'], data['input'].get('workdir', ''))
    readonly = _analyze(data['input'].get('command', ''), cwd, {})[2] if data['tool'] == 'shell' else True
    return dict(decision='allow', input={'paths': paths, 'readonly': readonly})


if __name__ == '__main__':
    emit_result(input=check(load_event())['input'])
