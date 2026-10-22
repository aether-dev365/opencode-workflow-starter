#!/usr/bin/env python3
"""在一个解释器里依次运行路径分析与守卫：结论与逐个启动脚本相同，只是少启动几个进程。

输入是检查事件加 `checks`（检查名称列表）。inspect-paths 的结果单独放进 `inspect`；守卫按固定顺序运行，
前一个守卫改写的 input 交给下一个，遇到第一个拒绝即停止。拒绝退出 2，其余退出 0。
"""
import importlib.util
from pathlib import Path

from protocol import emit_result, load_event

HERE = Path(__file__).resolve().parent
INSPECT = 'inspect-paths'
GUARDS = ('pre-guard-paths', 'pre-secret-scan', 'pre-bash-pipefail')


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(data):
    names = data.get('checks')
    if (not isinstance(names, list) or not names or len(set(names)) != len(names)
            or any(name not in (INSPECT, *GUARDS) for name in names)):
        return dict(decision='deny', reason='已拦截：检查列表无效；未执行操作。')
    result = dict(decision='allow')
    if INSPECT in names:
        # 拒绝时也带上 inspect：插件先按只读分类决定是否报告配置问题，再报告守卫结论。
        result['inspect'] = load(INSPECT).check(data)['input']
    event = dict(data, input=dict(data['input']))
    changed = False
    for name in GUARDS:
        if name not in names:
            continue
        outcome = load(name).check(event)
        if outcome['decision'] != 'allow':
            return {**result, 'decision': outcome['decision'], 'reason': outcome.get('reason', '')}
        if outcome.get('input'):
            event['input'] = {**event['input'], **outcome['input']}
            changed = True
    if changed:
        result['input'] = event['input']
    return result


def main():
    data = load_event()
    try:
        result = run(data)
    except Exception:
        result = dict(decision='deny', reason='已拦截：检查失败；未执行操作。')
    extra = {'inspect': result['inspect']} if 'inspect' in result else None
    emit_result(result['decision'], reason=result.get('reason', ''), input=result.get('input'), extra=extra)
    return 2 if result['decision'] == 'deny' else 0


if __name__ == '__main__':
    raise SystemExit(main())
