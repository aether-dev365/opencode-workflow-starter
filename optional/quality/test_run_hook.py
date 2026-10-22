import json
import os
import time
import unittest
from quality_testing import TempRepo

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
        self.assertEqual(self.run_hook(), [HEADER, '注释审核：检查了 1 个文件，0 处需复核。', '跳过测试检查：检查了 1 个文件，0 处新增标记。'])

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

    def test_invalid_config_still_runs_both_checks(self):
        (self.here / 'quality.json').write_text('{"version": 1, "timeoutSeconds": 0}', encoding='utf-8')
        self.repo.write('a.ts', 'x\n'); self.repo.commit()
        out = self.run_hook()
        self.assertIn('注释审核未完成：配置无效：timeoutSeconds', out)
        self.assertIn('跳过测试检查未完成：配置无效：timeoutSeconds', out)

    def test_runner_does_not_write_files_even_with_bytecode_enabled(self):
        self.repo.env.pop('PYTHONDONTWRITEBYTECODE')
        self.repo.write('a.ts', 'x\n'); self.repo.commit()

        def snapshot():
            return {p.relative_to(self.repo.root).as_posix(): p.read_bytes()
                    for p in self.repo.root.rglob('*') if p.is_file()}
        before = snapshot()
        self.run_hook()
        self.assertEqual(snapshot(), before)
