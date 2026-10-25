"""Report registered couplings that changed without their related files."""

import sys
sys.dont_write_bytecode = True

# 共用模块需要 Python 3.10+；版本过低、共用模块缺失或版本不配套时，未捕获的导入错误会以 1 退出，被 CI 当成提醒；这里明确报告未完成。
try:
    if sys.version_info < (3, 10):
        raise ImportError
    from quality_sync import main
except Exception as error:
    reconfigure = getattr(sys.stderr, 'reconfigure', None)
    if reconfigure:
        reconfigure(encoding='utf-8', errors='backslashreplace', newline='\n')
    reason = '需要 Python 3.10 或更高版本' if sys.version_info < (3, 10) else f'质量扩展文件不完整（{type(error).__name__}）'
    print(f'关联检查未完成：{reason}', file=sys.stderr)
    sys.exit(2)

from pathlib import Path


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:], here=Path(__file__).resolve().parent))
