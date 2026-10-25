#!/usr/bin/env python3
"""仅供插件调用的 Node 自检进程树监督入口，不解释或合并子进程输出。"""
import sys
from protocol import run_node_check


if __name__ == '__main__':
    try:
        raise SystemExit(run_node_check(sys.argv[1:]))
    except (OSError, ValueError) as error:
        print(f'Node 自检未执行或未安全完成：{error}', file=sys.stderr)
        raise SystemExit(2) from None
