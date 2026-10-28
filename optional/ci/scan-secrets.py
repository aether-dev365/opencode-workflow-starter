"""扫描候选提交可达历史，只显示安全的位置与规则。"""
import sys
sys.dont_write_bytecode = True

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time

LIMIT = 16 * 1024 * 1024
OID = r'(?:[0-9a-f]{40}|[0-9a-f]{64})'


def validate_report(path: Path, exit_code: int) -> list[dict]:
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
            raise ValueError('报告文件无效')
        with path.open('rb') as source:
            content = source.read(LIMIT + 1)
        if len(content) > LIMIT:
            raise ValueError('报告过大')
        findings = json.loads(content.decode('utf-8'))
    except (OSError, UnicodeError, RecursionError) as error:
        raise ValueError('报告不可读取') from None
    if exit_code not in (0, 23) or not isinstance(findings, list) or (exit_code == 23) != bool(findings):
        raise ValueError('报告与退出状态不一致')
    locations = []
    for finding in findings:
        if not isinstance(finding, dict):
            raise ValueError('发现记录无效')
        path, line, rule, commit = (finding.get(key) for key in ('File', 'StartLine', 'RuleID', 'Commit'))
        if (not isinstance(path, str) or not path or '\0' in path or type(line) is not int or line <= 0
                or not isinstance(rule, str) or not re.fullmatch(r'[a-z0-9-]{1,80}', rule)
                or not isinstance(commit, str) or not re.fullmatch(OID, commit)):
            raise ValueError('发现字段无效')
        locations.append({'path': path, 'line': line, 'rule': rule, 'commit': commit})
    return locations


def scan(root: Path, head: str, *, timeout: float = 600) -> int:
    try:
        sys.path.insert(0, str(root / 'scripts/quality'))
        from quality_process import program, run_process, termination_flag
        deadline = time.monotonic() + timeout
        env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONDONTWRITEBYTECODE': '1'}
        # 只按 PATH 中的绝对路径启动 git 和 Gitleaks：PATH 有空项时，按名字查找会选中项目里的同名程序。
        executable = program('git')
        if executable is None:
            raise ValueError('找不到 git 命令')
        def git(*args):
            result = subprocess.run([executable, *args], cwd=root, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=max(.001, min(10, deadline - time.monotonic())))
            if result.returncode:
                raise ValueError('Git 查询失败')
            return result.stdout.decode('utf-8', 'strict').rstrip('\n')
        if not re.fullmatch(OID, head) or git('rev-parse', '--verify', 'HEAD^{commit}') != head:
            raise ValueError('候选提交不匹配')
        if git('cat-file', '-t', head) != 'commit' or Path(git('rev-parse', '--show-toplevel')).resolve() != root.resolve() or Path.cwd().resolve() != root.resolve():
            raise ValueError('检出无效')
        shallow = root / git('rev-parse', '--git-path', 'shallow')
        if shallow.exists() and shallow.read_bytes().strip():
            raise ValueError('历史不完整')
        scanner = program('gitleaks')
        if not scanner:
            raise ValueError('扫描器缺失')
        scanner = Path(scanner).absolute()
        pin = root / '.opencode/secret-scan'
        metadata = (root / git('rev-parse', '--git-dir')).resolve()
        with termination_flag() as cancelled:
            checked = run_process([sys.executable, str(pin / 'install.py'), '--check', '--bin-dir', str(scanner.parent)],
                                  cwd=root, env=env, timeout=deadline - time.monotonic(), cancelled=cancelled)
            if not checked.started or checked.returncode != 0 or checked.error or checked.timed_out or checked.cancelled:
                raise ValueError('扫描器校验未完成')
            with tempfile.TemporaryDirectory(prefix='workflow-ci-secrets-') as directory:
                report = Path(directory) / 'report.json'
                ignore = Path(directory) / 'empty.gitleaksignore'
                ignore.write_bytes(b'')
                # 固定版还会额外加载 source/.gitleaksignore；以 Git 元数据目录为源，避开候选工作区。
                result = run_process([str(scanner), 'git', '--config', str(pin / 'gitleaks.toml'),
                                      '--no-banner', '--redact=100', '--log-level=error', '--exit-code=23',
                                      '--gitleaks-ignore-path', str(ignore),
                                      '--ignore-gitleaks-allow', '--report-format=json', '--report-path', str(report),
                                      '--log-opts', f'--full-history -m --no-ext-diff --no-textconv {head} --', str(metadata)],
                                     cwd=root, env=env, timeout=deadline - time.monotonic(), cancelled=cancelled)
                if not result.started or result.error or result.timed_out or result.cancelled:
                    raise ValueError('扫描执行未完成')
                locations = validate_report(report, result.returncode)
                for item in locations[:40]:
                    # runner 的旧式命令解析会在整行查找前缀，而不只检查行首。
                    path = json.dumps(item['path'], ensure_ascii=True).replace('##[', '\\u0023\\u0023[')
                    print(f'凭据位置：{path}:{item["line"]} [{item["rule"]}] {item["commit"]}')
                if len(locations) > 40:
                    print(f'凭据扫描：其余 {len(locations) - 40} 条位置已省略。')
                print(f'凭据扫描：候选历史中发现 {len(locations)} 处疑似凭据。')
                return 1 if locations else 0
    except (OSError, ValueError, TypeError, ImportError, subprocess.SubprocessError):
        print('凭据扫描未完成：检出、固定工具或扫描报告无效；原始工具输出不公开。', file=sys.stderr)
        return 2


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description='扫描候选提交完整可达历史')
    parser.add_argument('--head', required=True)
    args = parser.parse_args(argv)
    return scan(Path(__file__).resolve().parents[2], args.head)


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
