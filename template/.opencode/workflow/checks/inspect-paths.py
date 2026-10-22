#!/usr/bin/env python3
"""Expose the shared, mature path analysis to the native asynchronous adapter."""
from hooklib import candidates_from, _analyze, _resolve
from protocol import emit_result, load_event

data = load_event()
paths, _ = candidates_from(data, include_readonly=True)
cwd = _resolve(data['directory'], data['input'].get('workdir', ''))
readonly = _analyze(data['input'].get('command', ''), cwd, {})[2] if data['tool'] == 'shell' else True
emit_result(input={'paths': paths, 'readonly': readonly})
