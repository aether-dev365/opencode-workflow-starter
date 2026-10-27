import contextlib
import io
import json
import os
from pathlib import Path
import sys
import time
import unittest
from unittest import mock
from quality_lib import Incomplete
from quality_process import ProcessResult
from quality_testing import TempRepo, load_script, NEEDS_SYMLINK


class Formatting(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo(); self.addCleanup(self.repo.close)
        self.here = self.repo.install_scripts()
        self.log = self.repo.root.parent / 'calls.jsonl'
        self.tool = self.repo.root.parent / 'fake.py'
        self.tool.write_text('import json,sys,pathlib\n'
                             f'with pathlib.Path({str(self.log)!r}).open("a",encoding="utf-8") as out:\n'
                             ' out.write(json.dumps({"argv":sys.argv[1:],"cwd":str(pathlib.Path.cwd()),'
                             '"contents":[pathlib.Path(p).read_bytes().hex() for p in sys.argv[1:]]})+"\\n")\n', encoding='utf-8')
        self.repo.commit('scripts')

    def entry(self, **values):
        return {'id': 'fmt', 'paths': ['*.txt'], 'check': [sys.executable, str(self.tool), '{files}'],
                'cwd': '.', 'hook': True, 'timeoutSeconds': 60, **values}

    def configure(self, entries, **values):
        (self.here / 'quality.json').write_text(json.dumps({'version': 1, 'formats': entries, **values}), encoding='utf-8')

    def run_format(self, *args, code=0):
        r = self.repo.run(self.here / 'check-format.py', *args)
        self.assertEqual(r.returncode, code, r.stdout + r.stderr)
        return r.stdout + r.stderr

    def calls(self):
        return [json.loads(line) for line in self.log.read_text(encoding='utf-8').splitlines()] if self.log.exists() else []

    def test_help_describes_the_format_check(self):
        out = self.run_format('--help')
        self.assertIn('对所选范围内的文件运行登记的格式命令', out); self.assertIn('不能同时使用', out)
        self.assertIn('--fix', out); self.assertIn('--hook', out)
        self.assertNotIn('检查新增或改动的行', out)

    def test_default_and_empty_selection_are_successful(self):
        self.assertEqual(self.run_format(), '格式检查：没有登记格式命令。\n')
        self.configure([self.entry()])
        self.assertEqual(self.run_format('--all'), '格式检查：运行了 0 条命令，0 条未通过。\n')
        self.assertEqual(self.calls(), [])

    def test_historical_candidate_can_be_currently_ignored(self):
        base = self.repo.git('rev-parse', 'HEAD').stdout.strip()
        self.repo.write('a.txt', 'current'); old = self.repo.commit()
        self.repo.git('rm', '--cached', 'a.txt')
        self.repo.write('.gitignore', 'a.txt\n'); self.repo.commit()
        self.configure([self.entry()])
        for args in [('--commit', old), ('--range', base + '..' + old)]:
            self.run_format(*args)
            self.assertEqual(self.calls()[-1]['argv'], ['a.txt'])
            self.assertEqual(self.calls()[-1]['contents'], [b'current'.hex()])
        self.run_format('--all')
        self.assertEqual(len(self.calls()), 2)

    def test_modes_select_files_but_tools_read_worktree(self):
        self.repo.write('a.txt', 'one\ntwo\n'); self.repo.write('old.txt', 'rename content')
        base = self.repo.commit()
        self.repo.write('a.txt', 'one\n'); self.repo.write('empty.txt', '')
        self.repo.git('mv', 'old.txt', 'new.txt'); sha = self.repo.commit()
        self.repo.write('a.txt', 'working')
        self.configure([self.entry()])
        for args in [(), ('--commit', sha), ('--range', base + '..' + sha)]:
            self.run_format(*args)
            self.assertEqual(self.calls()[-1]['argv'], ['a.txt', 'empty.txt', 'new.txt'])
            self.assertEqual(self.calls()[-1]['contents'], [b'working'.hex(), '', b'rename content'.hex()])
        self.repo.git('add', 'a.txt')
        self.repo.write('a.txt', 'partially staged')
        self.run_format('--staged')
        self.assertEqual(self.calls()[-1]['argv'], ['a.txt'])
        self.assertEqual(self.calls()[-1]['contents'], [b'partially staged'.hex()])
        self.repo.write('untracked.txt', b'\xff\0')
        self.run_format('--all')
        self.assertIn('untracked.txt', self.calls()[-1]['argv'])

    @NEEDS_SYMLINK
    def test_scope_and_missing_worktree_file(self):
        for path in ['a.txt', 'missing.txt', 'link.txt', 'vendor/x.txt', 'skip.txt', 'scripts/quality/own.txt']:
            self.repo.write(path, b'\xff\0')
        self.repo.commit()
        self.configure([self.entry()], exclude=['skip.txt'])
        (self.repo.root / 'missing.txt').unlink()
        (self.repo.root / 'link.txt').unlink(); (self.repo.root / 'link.txt').symlink_to('a.txt')
        out = self.run_format(code=2)
        self.assertIn('missing.txt', out); self.assertIn('link.txt', out)
        self.assertEqual(self.calls()[-1]['argv'], ['a.txt'])
        self.configure([self.entry()], include=['nothing/*'])
        self.run_format('--all')
        self.assertEqual(len(self.calls()), 1)

    def test_arguments_keep_spaces_unicode_and_leading_dash(self):
        for name in ['-option.txt', 'a space.txt', '中文.txt', 'sub/in.txt']:
            self.repo.write(name, '')
        self.configure([self.entry(cwd='sub')])
        self.run_format('--all')
        self.assertEqual(self.calls()[0]['argv'], [os.path.join('..', '-option.txt'), os.path.join('..', 'a space.txt'), 'in.txt', os.path.join('..', '中文.txt')])
        self.configure([self.entry()]); self.run_format('--all')
        self.assertEqual(self.calls()[-1]['argv'][0], os.path.join('.', '-option.txt'))

    def test_project_command_and_hook_filter(self):
        self.repo.write('a.txt', ''); self.repo.write('b.txt', '')
        self.configure([self.entry(check=[sys.executable, str(self.tool)], hook=False)])
        self.run_format('--all', '--hook'); self.assertEqual(self.calls(), [])
        self.run_format('--all'); self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.calls()[0]['argv'], [])

    def test_fix_is_manual_and_missing_fix_is_incomplete(self):
        self.repo.write('a.txt', 'before'); self.repo.commit()
        self.configure([self.entry(fix=[sys.executable, '-c', 'from pathlib import Path; Path("a.txt").write_text("fixed")'])])
        index = self.repo.git('show', ':a.txt').stdout
        self.run_format('--all', '--fix')
        self.assertEqual(self.calls(), [])
        self.assertEqual((self.repo.root / 'a.txt').read_text(), 'fixed')
        self.assertEqual(self.repo.git('show', ':a.txt').stdout, index)
        self.run_format('--all', '--hook', '--fix', code=2)
        self.configure([self.entry()])
        self.assertIn('未登记修复命令', self.run_format('--all', '--fix', code=2))
        self.assertEqual(self.calls(), [])

    def test_batching_preserves_all_files_and_shared_deadline(self):
        module = load_script('check-format.py')
        files = ['a' * 15 + str(n) for n in range(5)]
        for platform in ('posix', 'nt'):
            batches = module.command_batches(['tool', 'fixed', '{files}'], files, os_name=platform, max_length=45)
            self.assertEqual([p for batch in batches for p in batch[2:]], files)
            self.assertTrue(all(batch[:2] == ['tool', 'fixed'] for batch in batches))
            for argv in [['x' * 100, '{files}'], ['tool', '{files}']]:
                with self.assertRaises(Incomplete):
                    module.command_batches(argv, ['x' * 100], os_name=platform, max_length=45)
        for name in files:
            self.repo.write(name, '')
        budgets = []
        def run(argv, **kwargs):
            budgets.append(kwargs['timeout'])
            return ProcessResult(True, 1, '', False, False, False, None)
        with mock.patch.object(module, 'run_process', side_effect=run), contextlib.redirect_stdout(io.StringIO()):
            result = module.run_entry(self.entry(timeoutSeconds=3), files, root=self.repo.root, fix=False,
                                      max_length=len(sys.executable) + len(str(self.tool)) + 25,
                                      clock=iter([0, .5, 2, 4]).__next__)
        self.assertEqual(budgets, [2.5, 1])
        self.assertTrue(result.started); self.assertTrue(result.failed); self.assertTrue(result.incomplete)

    def test_status_priority_and_counts(self):
        self.repo.write('a.txt', '')
        self.configure([self.entry(id='pass'), self.entry(id='fail', check=[sys.executable, '-c', 'print("FAILED"); exit(7)']),
                        self.entry(id='missing', check=['no-such-quality-tool'])])
        out = self.run_format('--all', code=2)
        self.assertIn('格式检查 [fail] 未通过', out); self.assertIn('FAILED', out)
        self.assertIn('格式检查：运行了 2 条命令，1 条未通过。', out)

    def test_lifecycle_error_is_incomplete_even_after_root_exit_zero(self):
        module = load_script('check-format.py')
        result = ProcessResult(True, 0, 'partial', False, False, False, '进程树清理失败')
        with mock.patch.object(module, 'run_process', return_value=result), contextlib.redirect_stdout(io.StringIO()) as out:
            r = module.run_entry(self.entry(), ['a.txt'], root=self.repo.root, fix=False)
        self.assertTrue(r.started)
        self.assertTrue(r.incomplete)
        self.assertFalse(r.failed)
        self.assertIn('进程树清理失败', out.getvalue())

    def test_output_cap_applies_across_failed_batches(self):
        module = load_script('check-format.py')
        names = [f'{n}-' + 'x' * 30 for n in range(4)]
        for name in names:
            self.repo.write(name, '')
        results = [ProcessResult(True, 0, 'SUCCESS\n' * 40, True, False, False, None)] + [
            ProcessResult(True, 1, ('x' * 4096 + '\n') * 30, True, False, False, None)] * 3
        out = io.StringIO()
        with mock.patch.object(module, 'run_process', side_effect=results), contextlib.redirect_stdout(out):
            r = module.run_entry(self.entry(), names, root=self.repo.root, fix=False,
                                 max_length=len(sys.executable) + len(str(self.tool)) + 45)
        self.assertTrue(r.failed)
        lines = out.getvalue().splitlines()
        self.assertEqual(sum(line.startswith('x') for line in lines), 40)
        self.assertNotIn('SUCCESS', out.getvalue()); self.assertIn('省略', out.getvalue())

    def test_missing_command_and_windows_launchers_are_not_run(self):
        self.repo.write('a.txt', '')
        self.configure([self.entry(check=['no-such-quality-tool'])])
        self.assertIn('未执行：找不到命令 no-such-quality-tool', self.run_format('--all', code=2))
        module = load_script('check-format.py')
        for suffix in ('.CMD', '.bat'):
            tool = self.repo.write('launch' + suffix, 'must not run')
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                r = module.run_entry(self.entry(check=[str(tool)]), ['a.txt'], root=self.repo.root, fix=False, os_name='nt')
            self.assertTrue(r.incomplete); self.assertFalse(r.started)
            self.assertIn('直接调用解释器', out.getvalue())
        # npm 的 .bin 目录同时有无扩展名的 sh 启动脚本：Windows 上应找到 .cmd 并给出同样的提示，而不是启动错误。
        for name in ('prettier', 'prettier.cmd'):
            self.repo.write('node_modules/.bin/' + name, 'must not run')
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            r = module.run_entry(self.entry(check=['node_modules/.bin/prettier', '{files}']), ['a.txt'], root=self.repo.root, fix=False, os_name='nt')
        self.assertTrue(r.incomplete); self.assertFalse(r.started)
        self.assertIn('直接调用解释器', out.getvalue())

    def test_cwd_and_timeout_are_not_reported_as_format_failures(self):
        self.repo.write('a.txt', '')
        for cwd in ('absent', 'a.txt'):
            self.configure([self.entry(cwd=cwd)])
            self.assertIn('未执行', self.run_format('--all', code=2))
        self.configure([self.entry(id='slow', timeoutSeconds=1, check=[sys.executable, '-c', 'import time; time.sleep(10)']), self.entry(id='next')])
        out = self.run_format('--all', code=2)
        self.assertIn('超时', out)
        self.assertIn('运行了 2 条命令，0 条未通过', out)
        self.assertEqual(len(self.calls()), 1)

    def test_entry_timeout_removes_tool_descendants(self):
        self.repo.write('a.txt', '')
        sentinel = self.repo.root.parent / 'late-format'
        child = f'import time,pathlib; time.sleep(2); pathlib.Path({str(sentinel)!r}).write_text("orphan")'
        source = f'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",{child!r}]); print("FORMAT_READY",flush=True); time.sleep(30)'
        self.configure([self.entry(timeoutSeconds=1, check=[sys.executable, '-c', source]), self.entry(id='next')])
        out = self.run_format('--all', code=2)
        self.assertIn('FORMAT_READY', out); self.assertIn('超时未完成', out)
        self.assertEqual(len(self.calls()), 1)
        time.sleep(2.1)
        self.assertFalse(sentinel.exists())

    def test_old_entries_reject_invalid_format_config(self):
        self.configure([self.entry(hook='yes')])
        for filename in ('review-comments.py', 'check-skips.py'):
            r = self.repo.run(self.here / filename, '--all')
            self.assertEqual(r.returncode, 2)
            self.assertIn('配置无效：formats[0].hook', r.stderr)
