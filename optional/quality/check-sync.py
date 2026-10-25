"""Report registered couplings that changed without their related files."""

import sys
sys.dont_write_bytecode = True

from pathlib import Path

# 共用模块缺失或版本不配套时，未捕获的导入错误会以 1 退出，被 CI 当成提醒；这里明确报告未完成。
try:
    from quality_sync import main
except Exception as error:
    reconfigure = getattr(sys.stderr, 'reconfigure', None)
    if reconfigure:
        reconfigure(encoding='utf-8', errors='backslashreplace', newline='\n')
    print(f'关联检查未完成：质量扩展文件不完整（{type(error).__name__}）', file=sys.stderr)
    sys.exit(2)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:], here=Path(__file__).resolve().parent))
