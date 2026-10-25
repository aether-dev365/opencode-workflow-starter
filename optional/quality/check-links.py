"""Check static local document links in the selected Git snapshot."""

import sys
sys.dont_write_bytecode = True

# 共用模块需要 Python 3.10+；版本过低、共用模块缺失或版本不配套时，未捕获的导入错误会以 1 退出，被 CI 当成有发现；这里明确报告未完成。
try:
    if sys.version_info < (3, 10):
        raise ImportError
    from quality_lib import ConfigError, Incomplete, glob_match, load_config, parse_mode, path_selected, repo_root, utf8_stdio
    from quality_links import OutsideRoot, escape_display, extract_links, resolve_target
    from quality_snapshot import collect_files
except Exception as error:
    reconfigure = getattr(sys.stderr, 'reconfigure', None)
    if reconfigure:
        reconfigure(encoding='utf-8', errors='backslashreplace', newline='\n')
    reason = '需要 Python 3.10 或更高版本' if sys.version_info < (3, 10) else f'质量扩展文件不完整（{type(error).__name__}）'
    print(f'链接检查未完成：{reason}', file=sys.stderr)
    sys.exit(2)

from pathlib import Path, PurePosixPath


def main(argv: list[str], *, here: Path | None = None, cwd: Path | None = None) -> int:
    utf8_stdio()
    try:
        mode = parse_mode(argv, description='检查所选范围内文档中本地链接的目标是否存在')
        root = repo_root(cwd or Path.cwd())
        here = (here or Path(__file__).parent).resolve()
        config = load_config(here, root=root)
        changes = collect_files(root, mode)
        if changes.merge:
            print('链接检查：合并提交不检查。')
            return 0

        def selected(path):
            return (PurePosixPath(path).suffix.lower() in ('.md', '.markdown', '.mdx')
                    and path_selected(path, config) and not (root / path).is_relative_to(here)
                    and not any(glob_match(p, path) for p in config['links']['exclude']))

        changed = {p for p in changes.changed if selected(p)}
        paths = changed | ({p for p in changes.after.regular_paths() if selected(p)} if changes.removed else set())
        contents = changes.after.read_many(sorted(paths))
        findings = {}
        checked = 0
        incomplete = False
        for path in sorted(paths):
            try:
                if path not in contents:
                    raise Incomplete('无法读取文档')
                raw = contents[path]
                if len(raw) > 1024 * 1024:
                    raise Incomplete('文档超过 1 MiB')
                if b'\0' in raw:
                    raise Incomplete('二进制文档')
                text = raw.decode('utf-8-sig')
                links = extract_links(text)
            except Exception as error:
                reason = error.args[0] if isinstance(error, Incomplete) else type(error).__name__
                print(f'{escape_display(path)} 未完成：{reason}')
                incomplete = True
                continue
            checked += 1
            for link in links:
                reason = None
                try:
                    target = resolve_target(path, link.target, config['links']['ignoreTargets'])
                    if target is not None and not changes.after.exists(target):
                        if path in changed or changes.before.exists(target):
                            reason = '链接目标不存在'
                except OutsideRoot:
                    if path in changed:
                        reason = '链接目标超出检出范围'
                if reason:
                    findings[(path, link.offset, link.target)] = (path, link.line, link.target, reason)
        for path, line, target, reason in sorted(findings.values(), key=lambda f: f[:3]):
            print(f'{escape_display(path)}:{line}: [link] {reason}：{escape_display(target)}')
        print(f'链接检查：检查了 {checked} 个文档，{len(findings)} 处断链。')
        return 2 if incomplete else 1 if findings else 0
    except ConfigError as error:
        reason = '配置无效：' + error.args[0]
    except Incomplete as error:
        reason = error.args[0]
    except Exception as error:
        reason = type(error).__name__
    print('链接检查未完成：' + reason, file=sys.stderr)
    return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
