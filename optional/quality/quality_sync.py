"""Report registered couplings whose related files did not change together."""

import sys
from pathlib import Path
from quality_lib import ConfigError, Incomplete, glob_regex, load_config, parse_line_options, repo_root, utf8_stdio
from quality_links import escape_display
from quality_snapshot import change_events, collect_files


def _matches(pattern: str, paths) -> bool:
    regex = glob_regex(pattern)
    return any(regex.fullmatch(path) for path in paths)


def _reminders(rules: list[dict], events: tuple[tuple[str, str], ...]) -> list[str]:
    touched = [path for path, _ in events]
    lines = []
    for rule in rules:
        triggers = [path for path, kind in events if kind in rule['on']
                    and any(glob_regex(p).fullmatch(path) for p in rule['paths'])
                    and not any(glob_regex(p).fullmatch(path) for p in rule['exclude'])]
        missing = [p for p in dict.fromkeys(rule['related']) if not _matches(p, touched)]
        if triggers and missing:
            shown = '、'.join(escape_display(p) for p in triggers[:3]) + (f' 等 {len(triggers)} 个' if len(triggers) > 3 else '')
            lines.append(f'[sync] {rule["id"]}：{escape_display(rule["message"])}'
                         f'（改动：{shown}；未改动：{"、".join(escape_display(p) for p in missing)}）')
    return lines


def _stale(rules: list[dict], before: tuple[str, ...], after: tuple[str, ...], full: bool) -> list[str]:
    # 只报告本次改动造成的失效：改动前能匹配、改动后匹配不到；登记本身改动或 --all 时校验全部模式。
    lines = []
    for rule in rules:
        for field in ('paths', 'related'):
            for pattern in dict.fromkeys(rule[field]):
                if not _matches(pattern, after) and (full or _matches(pattern, before)):
                    lines.append(f'[sync-stale] {rule["id"]}：{field} 中的 {escape_display(pattern)} 已匹配不到文件，请更新登记')
    return lines


def main(argv: list[str], *, here: Path, cwd: Path | None = None) -> int:
    utf8_stdio()
    try:
        here = here.resolve()
        mode, strict = parse_line_options(argv, description='报告登记的关联是否一起改动', incomplete_help='登记失效时退出 2')
        root = repo_root(cwd or Path.cwd())
        rules = load_config(here, root=root)['sync']
        changes = collect_files(root, mode)
        if changes.merge:
            print('关联检查：合并提交不检查。')
            return 0
        if not rules:
            print('关联检查：没有登记关联。')
            return 0
        after = changes.after.paths(changes.changed)
        if mode[0] == 'all':
            reminders, stale = [], _stale(rules, (), after, True)
            summary = f'关联检查：校验了 {len(rules)} 条登记，{len(stale)} 处登记失效。'
        else:
            events = change_events(changes)
            registry = here / 'quality.json'
            full = registry.is_relative_to(root) and registry.relative_to(root).as_posix() in {path for path, _ in events}
            reminders, stale = _reminders(rules, events), _stale(rules, changes.before.paths(), after, full)
            summary = f'关联检查：检查了 {len(rules)} 条登记，{len(reminders)} 条需要确认同步，{len(stale)} 处登记失效。'
        for line in reminders + stale:
            print(line)
        print(summary)
        if not (stale and strict):
            return 1 if reminders or stale else 0
        reason = '登记失效'
    except ConfigError as error:
        reason = '配置无效：' + error.args[0]
    except Incomplete as error:
        reason = error.args[0]
    except Exception as error:
        reason = type(error).__name__
    print('关联检查未完成：' + reason, file=sys.stderr)
    return 2
