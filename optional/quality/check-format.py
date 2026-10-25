"""Run explicitly registered format commands against the working tree."""

import sys
sys.dont_write_bytecode = True

from dataclasses import dataclass
import os
from pathlib import Path
import subprocess
import time
from typing import Callable

# 共用模块缺失或版本不配套时，未捕获的导入错误会以 1 退出，被 CI 当成有发现；这里明确报告未完成。
try:
    from quality_lib import ConfigError, Incomplete, glob_match, load_config, parse_mode, path_selected, repo_root, utf8_stdio
    from quality_process import OutputBuffer, resolve_executable, run_process, termination_flag
    from quality_snapshot import collect_files
except Exception as error:
    reconfigure = getattr(sys.stderr, 'reconfigure', None)
    if reconfigure:
        reconfigure(encoding='utf-8', errors='backslashreplace', newline='\n')
    print(f'格式检查未完成：质量扩展文件不完整（{type(error).__name__}）', file=sys.stderr)
    sys.exit(2)


def command_batches(argv: list[str], files: list[str], *, os_name=None, max_length=12000) -> list[list[str]]:
    def length(args):
        if (os_name or os.name) == 'nt':
            return len(subprocess.list2cmdline(args).encode('utf-16-le', 'surrogatepass')) // 2 + 1
        return sum(len(os.fsencode(arg)) + 1 for arg in args)

    if '{files}' not in argv:
        if length(argv) > max_length:
            raise Incomplete('固定命令过长')
        return [argv]
    index = argv.index('{files}')
    prefix, suffix = argv[:index], argv[index + 1:]
    if length(prefix + suffix) > max_length:
        raise Incomplete('固定命令过长')
    batches, batch = [], []
    for file in files:
        if length(prefix + [file] + suffix) > max_length:
            raise Incomplete('文件参数过长')
        if batch and length(prefix + batch + [file] + suffix) > max_length:
            batches.append(prefix + batch + suffix)
            batch = []
        batch.append(file)
    if batch:
        batches.append(prefix + batch + suffix)
    return batches


@dataclass(frozen=True)
class FormatResult:
    started: bool
    failed: bool
    incomplete: bool


def run_entry(entry: dict, files: list[str], *, root: Path, fix: bool, os_name=None,
              cancelled: Callable[[], bool] | None = None, clock=time.monotonic, max_length=12000) -> FormatResult:
    label = f'格式检查 [{entry["id"]}]'
    started = failed = incomplete = False
    output = OutputBuffer()
    try:
        cwd = (root / entry['cwd']).resolve()
        if not cwd.is_relative_to(root.resolve()):
            raise Incomplete('目录超出检出范围')
        if not cwd.is_dir():
            raise Incomplete('目录不存在或不是目录')
        if fix and 'fix' not in entry:
            raise Incomplete('未登记修复命令')
        argv = entry['fix' if fix else 'check'][:]
        executable = resolve_executable(argv[0], cwd=cwd, os_name=os_name)
        if executable is None:
            raise Incomplete('找不到命令 ' + argv[0])
        if (os_name or os.name) == 'nt' and executable.suffix.lower() in ('.cmd', '.bat'):
            raise Incomplete('不自动执行 .cmd/.bat，请直接调用解释器及其脚本入口')
        argv[0] = str(executable)
        relative = []
        for path in sorted(set(files)):
            arg = os.path.relpath(root / path, cwd)
            relative.append(os.path.join('.', arg) if arg.startswith('-') else arg)
        batches = command_batches(argv, relative, os_name=os_name, max_length=max_length)
        deadline = clock() + entry['timeoutSeconds']
        for batch in batches:
            if cancelled and cancelled():
                raise Incomplete('已取消')
            remaining = deadline - clock()
            if remaining <= 0:
                raise Incomplete('超时未完成（总预算用尽）')
            r = run_process(batch, cwd=cwd, timeout=remaining, os_name=os_name, cancelled=cancelled)
            started |= r.started
            if r.returncode != 0 or r.timed_out or r.cancelled or r.error:
                output.add(r.output)
                output.truncated |= r.truncated
            if r.timed_out or r.cancelled:
                reason = '超时未完成' if r.timed_out else '已取消'
                raise Incomplete(reason + ('：' + r.error if r.error else ''))
            if r.error:
                raise Incomplete(r.error)
            if not r.started:
                raise Incomplete(r.error or '启动失败')
            failed |= r.returncode != 0
    except (Incomplete, OSError, RuntimeError) as error:
        incomplete = True
        print(f'{label} 未执行：{error.args[0] if isinstance(error, Incomplete) else type(error).__name__}')
    if failed:
        print(f'{label} 未通过。')
    elif started and not incomplete:
        print(f'{label} 通过。')
    if output.output:
        print(output.output, end='' if output.output.endswith('\n') else '\n')
    if output.truncated:
        print('（输出超出上限，已省略）')
    return FormatResult(started, failed, incomplete)


def main(argv: list[str], *, here: Path | None = None, cwd: Path | None = None, os_name=None) -> int:
    utf8_stdio()
    try:
        hook, fix = '--hook' in argv, '--fix' in argv
        if hook and fix:
            raise Incomplete('--hook 与 --fix 不能一起使用')
        mode = parse_mode([arg for arg in argv if arg not in ('--hook', '--fix')])
        root = repo_root(cwd or Path.cwd())
        here = (here or Path(__file__).parent).resolve()
        config = load_config(here, root=root)
        changes = collect_files(root, mode)
        if changes.merge:
            print('格式检查：合并提交不检查。')
            return 0
        if not config['formats']:
            print('格式检查：没有登记格式命令。')
            return 0
        paths = [p for p in changes.changed if path_selected(p, config) and not (root / p).is_relative_to(here)]
        current = set(collect_files(root, ('all', None)).after.regular_paths(paths)) if mode[0] != 'all' else set(changes.changed)
        runs = failures = 0
        incomplete = False
        with termination_flag() as cancelled:
            for entry in config['formats']:
                if cancelled():
                    incomplete = True
                    print('格式检查未完成：已取消')
                    break
                if hook and not entry['hook']:
                    continue
                matching = sorted({p for p in paths if any(glob_match(pattern, p) for pattern in entry['paths'])})
                if not matching:
                    continue
                missing = set(matching) - current
                for path in sorted(missing):
                    print(f'格式检查 [{entry["id"]}] 未执行：工作区缺失或不是普通文件：{path}')
                    incomplete = True
                files = [p for p in matching if p not in missing]
                if not files:
                    continue
                r = run_entry(entry, files, root=root, fix=fix, os_name=os_name, cancelled=cancelled)
                runs += r.started
                failures += r.failed
                incomplete |= r.incomplete
        print(f'格式检查：运行了 {runs} 条命令，{failures} 条未通过。')
        return 2 if incomplete else 1 if failures else 0
    except ConfigError as error:
        reason = '配置无效：' + error.args[0]
    except Incomplete as error:
        reason = error.args[0]
    except Exception as error:
        reason = type(error).__name__
    print('格式检查未完成：' + reason, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
