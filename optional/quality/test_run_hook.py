import json
import contextlib
import io
import os
from pathlib import Path
import subprocess
import sys
import time
import unittest
from types import SimpleNamespace
from unittest import mock
from quality_testing import TempRepo, load_script

module = load_script('run-hook.py')

INTERPRETER = 'py -3' if os.name == 'nt' else 'python3'
HEADER = '质量检查（提交已完成，以下只是报告）：'


class Runner(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.here = self.repo.install_scripts()
        self.repo.commit('scripts')

    def run_hook(self):
        result = self.repo.run(self.here / 'run-hook.py', 'post-commit')
        self.assertEqual(result.returncode, 0)
        return result.stdout.splitlines()

    def replace(self, name, source):
        (self.here / name).write_text(source, encoding='utf-8')

    def test_clean_commit_prints_header_and_summaries(self):
        self.repo.write('src/a.ts', 'export const a = 1\n'); self.repo.commit()
        self.assertEqual(self.run_hook(), [HEADER, '注释审核：检查了 1 个文件，0 处需复核。', '跳过测试检查：检查了 1 个文件，0 处新增标记。',
                                          '链接检查：检查了 0 个文档，0 处断链。', '格式检查：没有登记格式命令。'])

    def test_findings_from_both_checks_are_forwarded(self):
        self.repo.write('tests/a.test.ts', '// Task 3: later\nit.skip("x", () => {})\n'); self.repo.commit()
        out = '\n'.join(self.run_hook())
        self.assertIn('tests/a.test.ts:1: [tracking]', out)
        self.assertIn('tests/a.test.ts:2: [skip]', out)

    def test_incomplete_failed_and_missing_checks_get_hints(self):
        self.repo.write('a.ts', 'x\n'); self.repo.commit()
        short = self.repo.git('rev-parse', '--short', 'HEAD').stdout.strip()
        self.replace('check-skips.py', 'import sys\nsys.exit(2)\n')
        self.assertIn(f'跳过测试检查未完成，请手动重跑：{INTERPRETER} scripts/quality/check-skips.py --commit {short}', self.run_hook())
        self.replace('check-skips.py', 'import sys\nsys.exit(3)\n')
        self.assertTrue(any(line.startswith('跳过测试检查执行失败（退出码 3），请手动重跑：') for line in self.run_hook()))
        (self.here / 'review-comments.py').unlink()
        self.assertIn('注释审核未执行：缺少 scripts/quality/review-comments.py。', self.run_hook())

    def test_timeout_kills_the_whole_process_tree(self):
        (self.here / 'quality.json').write_text(json.dumps({'version': 1, 'timeoutSeconds': 1}), encoding='utf-8')
        self.replace('check-skips.py', 'import subprocess, sys, time\n'
                     'subprocess.Popen([sys.executable, "-c", "import time, pathlib; time.sleep(3); pathlib.Path(\'late.txt\').write_text(\'x\')"])\n'
                     'time.sleep(10)\n')
        self.repo.write('a.ts', 'x\n'); self.repo.commit()
        start = time.monotonic()
        out = self.run_hook()
        self.assertLess(time.monotonic() - start, 6)
        self.assertTrue(any(line.startswith('跳过测试检查超时（1 秒）未完成，请手动重跑：') for line in out))
        time.sleep(4)
        self.assertFalse((self.repo.root / 'late.txt').exists())

    def test_rebase_in_progress_prints_nothing(self):
        self.repo.write('a.ts', '// Task 3\n'); self.repo.commit()
        for name in ['rebase-merge', 'rebase-apply']:
            with self.subTest(name=name):
                state = self.repo.root / '.git' / name
                state.mkdir()
                self.assertEqual(self.run_hook(), [])
                state.rmdir()

    def test_invalid_config_reports_four_incomplete_checks(self):
        (self.here / 'quality.json').write_text('{"version": 1, "timeoutSeconds": 0}', encoding='utf-8')
        self.repo.write('a.ts', 'x\n'); self.repo.commit()
        out = self.run_hook()
        self.assertIn('注释审核未完成：配置无效：timeoutSeconds', out)
        self.assertIn('跳过测试检查未完成：配置无效：timeoutSeconds', out)
        self.assertIn('链接检查未完成：配置无效：timeoutSeconds', out)
        self.assertIn('格式检查未完成：配置无效：timeoutSeconds', out)

    def test_runner_does_not_write_files_even_with_bytecode_enabled(self):
        self.repo.env.pop('PYTHONDONTWRITEBYTECODE')
        self.repo.write('a.ts', 'x\n'); self.repo.commit()

        def snapshot():
            return {p.relative_to(self.repo.root).as_posix(): p.read_bytes()
                    for p in self.repo.root.rglob('*') if p.is_file()}
        before = snapshot()
        self.run_hook()
        self.assertEqual(snapshot(), before)

    def run_with_failed_tree_kill(self, os_name, *, stalled_output=False, missing_taskkill=False):
        (self.here / 'quality.json').write_text('{"version":1,"timeoutSeconds":1}', encoding='utf-8')
        self.replace('review-comments.py', 'import time\nprint("开始检查", flush=True)\ntime.sleep(30)\n')
        self.replace('check-skips.py', 'print("第二项已运行")\n')
        processes, deadlines = [], []
        popen, run = subprocess.Popen, subprocess.run

        def launch(command, **kwargs):
            if os.name != 'nt':
                kwargs.pop('creationflags', None)
            else:
                kwargs.pop('start_new_session', None)
            process = popen(command, **kwargs)
            if command[0] != 'git':
                processes.append(process)
                if stalled_output and len(processes) == 1:
                    communicate = process.communicate
                    def drain(*args, **options):
                        deadlines.append(options.get('timeout'))
                        if len(deadlines) > 1:
                            raise subprocess.TimeoutExpired(command, options.get('timeout'), output=b'partial\n')
                        return communicate(*args, **options)
                    process.communicate = drain
            return process

        def command_run(command, **kwargs):
            if command[0] == 'taskkill':
                if missing_taskkill:
                    raise FileNotFoundError()
                raise subprocess.CalledProcessError(1, command)
            return run(command, **kwargs)

        def unmanaged_start(command, *, cwd, env, os_name):
            # 专门保留无 Job 的 taskkill/kill 回退测试；受管启动由原生生命周期测试覆盖。
            options = {'creationflags': 0x08000000} if os_name == 'nt' else {'start_new_session': True}
            return subprocess.Popen(command, cwd=cwd, env=env, stdout=subprocess.PIPE,
                                    stderr=subprocess.STDOUT, **options)

        out = io.StringIO()
        try:
            with mock.patch.dict(os.environ, self.repo.env, clear=True), \
                    mock.patch.object(module, '__file__', str(self.here / 'run-hook.py')), \
                    mock.patch.object(module.Path, 'cwd', return_value=self.repo.root), \
                    mock.patch.object(module.os, 'killpg', side_effect=PermissionError(), create=True), \
                    mock.patch.object(module.signal, 'SIGKILL', 9, create=True), \
                    mock.patch.object(module.subprocess, 'Popen', side_effect=launch), \
                    mock.patch.object(module, 'start_process', side_effect=unmanaged_start), \
                    mock.patch.object(module.subprocess, 'run', side_effect=command_run), \
                    contextlib.redirect_stdout(out):
                self.assertEqual(module.main(['post-commit'], os_name=os_name), 0)
            self.assertEqual(len(processes), 4)
            self.assertIsNotNone(processes[0].poll())
            self.assertIn('注释审核超时（1 秒）未完成，请手动重跑：', out.getvalue())
            self.assertIn('第二项已运行', out.getvalue())
            self.assertNotIn(module.FAILURE, out.getvalue())
            if os_name == 'nt':
                self.assertIn('py -3 scripts/quality/review-comments.py', out.getvalue())
            if stalled_output:
                self.assertEqual(deadlines, [1, 5])
                self.assertIn('partial', out.getvalue())
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=5)
                if process.stdout:
                    process.stdout.close()

    def test_failed_posix_tree_kill_falls_back_and_continues(self):
        with mock.patch.object(module, 'signal', SimpleNamespace()):
            self.run_with_failed_tree_kill('posix')

    def test_failed_windows_taskkill_falls_back_and_continues(self):
        for missing in (False, True):
            with self.subTest(missing=missing):
                self.run_with_failed_tree_kill('nt', missing_taskkill=missing)

    def test_timeout_output_drain_is_bounded_and_next_check_runs(self):
        for os_name in ('nt', 'posix'):
            with self.subTest(os_name=os_name):
                self.run_with_failed_tree_kill(os_name, stalled_output=True)

    def invoke(self, **patches):
        out = io.StringIO()
        with mock.patch.dict(os.environ, self.repo.env, clear=True), \
                mock.patch.object(module, '__file__', str(self.here / 'run-hook.py')), \
                mock.patch.object(module.Path, 'cwd', return_value=self.repo.root), contextlib.redirect_stdout(out):
            self.assertEqual(module.main(['post-commit']), 0)
        return out.getvalue()

    def configure(self, formats):
        (self.here / 'quality.json').write_text(json.dumps({'version': 1, 'formats': formats}), encoding='utf-8')

    def test_timeout_for_uses_all_auto_entry_budgets(self):
        self.assertEqual(module.timeout_for('check-format.py', {'formats': [
            {'hook': True, 'timeoutSeconds': 2}, {'hook': False, 'timeoutSeconds': 600}, {'hook': True, 'timeoutSeconds': 3}]}), 15)
        self.assertEqual(module.timeout_for('check-format.py', {'formats': []}), 10)
        self.assertEqual(module.timeout_for('check-format.py', None), 30)
        self.assertEqual(module.timeout_for('check-links.py', {'timeoutSeconds': 7}), 7)

    def test_four_checks_run_in_order_and_commit_succeeds(self):
        self.configure([{'id': 'probe', 'paths': ['tests/*'], 'check': [sys.executable, '-c', 'print("FORMAT_PROBE"); exit(1)']}])
        self.repo.commit('config')
        self.repo.run(self.here / 'install-hooks.py')
        head = self.repo.git('rev-parse', 'HEAD').stdout
        self.repo.write('tests/probe.test.js', '// Task 3: probe\nit.skip("x",()=>{})\n')
        self.repo.write('docs/probe.md', '[x](missing)')
        self.repo.git('add', '-A')
        r = self.repo.git('commit', '-m', 'probe')
        out = r.stdout + r.stderr
        positions = [out.index(text) for text in ('[tracking]', '[skip]', '[link]', '格式检查 [probe] 未通过')]
        self.assertEqual(positions, sorted(positions)); self.assertIn('FORMAT_PROBE', out)
        self.assertNotEqual(head, self.repo.git('rev-parse', 'HEAD').stdout)
        self.assertEqual(self.repo.git('status', '--porcelain').stdout, '')
        before = {p: p.read_bytes() for p in self.repo.root.rglob('*') if p.is_file()}
        self.run_hook()
        self.assertEqual(before, {p: p.read_bytes() for p in self.repo.root.rglob('*') if p.is_file()})

    def test_hook_never_runs_fix_or_disabled_entries(self):
        marker = self.repo.root.parent / 'unexpected'
        bad = [sys.executable, '-c', f'from pathlib import Path; Path({str(marker)!r}).touch()']
        self.configure([{'id': 'disabled', 'paths': ['*.txt'], 'check': bad, 'hook': False},
                        {'id': 'active', 'paths': ['*.txt'], 'check': [sys.executable, '-c', 'print("READ_ONLY")'], 'fix': bad}])
        self.repo.write('a.txt', ''); self.repo.commit()
        self.assertIn('格式检查 [active] 通过', '\n'.join(self.run_hook()))
        self.assertFalse(marker.exists())

    def test_start_failure_does_not_stop_later_checks(self):
        popen = subprocess.Popen
        started = []
        def launch(command, **kwargs):
            if command[0] != 'git':
                started.append(Path(command[1]).name)
                if len(started) == 1:
                    raise PermissionError()
            return popen(command, **kwargs)
        with mock.patch.object(module.subprocess, 'Popen', side_effect=launch):
            out = self.invoke()
        self.assertEqual(started, ['review-comments.py', 'check-skips.py', 'check-links.py', 'check-format.py'])
        self.assertIn('注释审核未执行', out); self.assertIn('格式检查：没有登记格式命令', out)

    def test_format_rerun_keeps_hook_and_fixed_sha(self):
        self.replace('check-format.py', 'raise SystemExit(2)')
        short = self.repo.git('rev-parse', '--short', 'HEAD').stdout.strip()
        self.assertIn(f'格式检查未完成，请手动重跑：{INTERPRETER} scripts/quality/check-format.py --commit {short} --hook', self.run_hook())
        self.assertIn('只能固定候选文件范围', '\n'.join(self.run_hook()))

    def test_outer_timeout_cleans_format_grandchildren(self):
        ready = self.repo.root.parent / 'ready'
        sentinel = self.repo.root.parent / 'late'
        pidfile = self.repo.root.parent / 'pids'
        child = ('import os,time,pathlib; '
                 f'pathlib.Path({str(pidfile)!r}).open("a").write(str(os.getpid())+"\\n"); '
                 f'time.sleep(2); pathlib.Path({str(sentinel)!r}).touch(); time.sleep(30)')
        tool = ('import os,subprocess,sys,time,pathlib; '
                f'pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid())+"\\n"); '
                f'pathlib.Path({str(ready)!r}).touch(); subprocess.Popen([sys.executable,"-c",{child!r}]); time.sleep(30)')
        self.configure([{'id': 'slow', 'paths': ['*.txt'], 'timeoutSeconds': 60, 'check': [sys.executable, '-c', tool]}])
        self.repo.write('a.txt', ''); self.repo.commit()
        deadlines = []
        popen = subprocess.Popen
        def launch(command, **kwargs):
            p = popen(command, **kwargs)
            if command[0] != 'git' and Path(command[1]).name == 'check-format.py':
                communicate = p.communicate
                def drain(**options):
                    deadlines.append(options['timeout'])
                    return communicate(**options)
                p.communicate = drain
            return p
        with mock.patch.object(module, 'timeout_for', side_effect=lambda filename, config: .5 if filename == 'check-format.py' else 30), \
                mock.patch.object(module.subprocess, 'Popen', side_effect=launch):
            out = self.invoke()
        self.assertTrue(ready.exists(), out)
        self.assertIn('格式检查超时（0.5 秒）未完成', out)
        self.assertNotIn('格式检查 [slow] 通过', out)
        if os.name != 'nt':
            self.assertEqual(deadlines, [.5, 5])
        time.sleep(2.1)
        self.assertFalse(sentinel.exists())
        pids = [int(pid) for pid in pidfile.read_text().splitlines()]
        self.assertEqual(len(pids), 2)
        for pid in pids:
            if sys.platform.startswith('linux'):
                state = Path(f'/proc/{pid}/stat')
                self.assertTrue(not state.exists() or state.read_text().split(') ')[1].startswith('Z'))
