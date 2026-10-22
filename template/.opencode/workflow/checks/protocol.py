"""Versioned, harness-independent check input and output."""
import json
import os
import sys


def utf8_stdio() -> None:
    """插件与检查器之间的 JSON 固定为 UTF-8；Windows 管道默认使用 ANSI 代码页（cp936、cp1252 等）。"""
    for stream, errors in ((sys.stdin, 'strict'), (sys.stdout, 'strict'), (sys.stderr, 'backslashreplace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure:
            reconfigure(encoding='utf-8', errors=errors)


# 所有检查器都先导入本模块，再读取 stdin。
utf8_stdio()


def read_event(raw: str) -> dict:
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get('version') != 1:
        raise ValueError('Unsupported check event')
    if data.get('phase') not in ('before', 'after', 'inspect'):
        raise ValueError('Missing phase')
    for name in ('sessionId', 'callId', 'directory', 'tool'):
        if not isinstance(data.get(name), str) or not data[name]:
            raise ValueError('Missing event identity')
    if not os.path.isabs(data['directory']):
        raise ValueError('Location must be absolute')
    if not isinstance(data.get('input'), dict) or not isinstance(data.get('paths'), list):
        raise ValueError('Incomplete tool input')
    if not all(isinstance(path, str) and path for path in data['paths']):
        raise ValueError('Invalid paths')
    if 'file_paths' in data['input']:
        paths = data['input']['file_paths']
        if not isinstance(paths, list) or not all(isinstance(path, str) and path for path in paths):
            raise ValueError('Invalid tool paths')
    for name in ('command', 'workdir', 'file_path'):
        if name in data['input'] and not isinstance(data['input'][name], str):
            raise ValueError('Invalid tool input')
    if 'stateDirectory' in data and (not isinstance(data['stateDirectory'], str)
                                     or not os.path.isabs(data['stateDirectory'])):
        raise ValueError('Invalid state directory')
    return data


def emit_result(decision: str = 'allow', *, reason: str = '', input: dict | None = None,
                reminders: list[str] | None = None, extra: dict | None = None) -> None:
    if decision not in ('allow', 'deny', 'ask'):
        raise ValueError('Invalid check decision')
    reminder_text = '\n'.join(reminders or [])
    if len(reminder_text) > 8000:
        reminder_text = reminder_text[:7970] + '\n…（已截断，请运行完整检查）'
        reminders = [reminder_text]
    result = dict(decision=decision, reminders=reminders or [])
    if reason:
        result['reason'] = reason
    if input is not None:
        result['input'] = input
    if extra:
        result.update(extra)
    print(json.dumps(result, ensure_ascii=False))
    if decision == 'deny' and reason:
        print(reason, file=sys.stderr)


def load_event() -> dict:
    try:
        return read_event(sys.stdin.read())
    except (ValueError, TypeError, OSError):
        emit_result('deny', reason='已拦截：检查输入不完整或无效；未执行操作。')
        raise SystemExit(2) from None
