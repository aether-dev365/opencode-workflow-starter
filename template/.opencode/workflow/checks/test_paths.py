import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from policy import policy_root

HERE = Path(__file__).resolve().parent
POLICY = HERE / 'fixtures/protection.json'


class PathGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workflow-guard-')
        self.root = Path(self.temp.name)
        (self.root / '.git').mkdir()
        config = self.root / '.opencode/workflow'
        config.mkdir(parents=True)
        (config / 'protection.json').write_bytes(POLICY.read_bytes())
        (self.root / '.env').write_text('synthetic-value')

    def tearDown(self):
        self.temp.cleanup()

    def result(self, tool='shell', paths=None, cwd=None, **tool_input):
        event = dict(version=1, phase='before', sessionId='s', callId='c',
                     directory=str(self.root), tool=tool, paths=paths or [], input=tool_input)
        run = subprocess.run([sys.executable, str(HERE / 'pre-guard-paths.py')],
                             input=json.dumps(event), encoding='utf-8', capture_output=True, cwd=cwd)
        self.assertIn(run.returncode, [0, 2], run.stderr)
        return json.loads(run.stdout)

    def guard(self, tool='shell', paths=None, **tool_input):
        return self.result(tool=tool, paths=paths, **tool_input)['decision']

    def test_checker_process_directory_does_not_change_decisions(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            (Path(elsewhere) / '.git').mkdir()
            for command, decision in [('ls -la', 'allow'), ('git status --short', 'allow'), ('grep -r value .', 'allow'),
                                      ('cat .env', 'deny'), ('cat ~/.env', 'deny'), ('cat $HOME/.env', 'deny')]:
                with self.subTest(command=command):
                    self.assertEqual(self.result(command=command, cwd=elsewhere)['decision'], decision)

    def test_foreign_checkout_without_policy_uses_session_rules(self):
        with tempfile.TemporaryDirectory() as other:
            (Path(other) / '.git').mkdir()
            (Path(other) / 'README.md').write_text('public')
            (Path(other) / '.env').write_text('synthetic-value')
            self.assertEqual(self.guard(tool='write', paths=[f'{other}/README.md'], action='read'), 'allow')
            self.assertEqual(self.guard(tool='write', paths=[f'{other}/.env'], action='read'), 'deny')

    def test_opencode_config_files_do_not_mark_a_checkout_root(self):
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / '.opencode').mkdir()
            (Path(home) / '.opencode/opencode.json').write_text('{}')
            (Path(home) / 'opencode.jsonc').write_text('{}')
            self.assertIsNone(policy_root(Path(home) / 'notes.md'))

    def test_sensitive_reads_and_recursive_deletion_are_denied(self):
        for command in ['cat .env', 'rm -rf .', 'grep value .env', 'git clean -fdx']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_recursive_delete_checks_only_unreadable_files_below_target(self):
        for path in ['node_modules/pkg/generated/x.js', 'node_modules/pkg/vendor/y.js', 'vendor/lib.js', 'build/.env.local', 'dist/app.js']:
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text('x')
        self.assertEqual(self.guard(command='rm -rf node_modules dist'), 'allow')
        self.assertEqual(self.guard(command="find node_modules -name '*.map' -delete"), 'allow')
        self.assertEqual(self.guard(command='rm -rf vendor'), 'deny')
        denied = self.result(command='rm -rf build')
        self.assertEqual(denied['decision'], 'deny')
        self.assertIn(str(Path('build/.env.local')), denied['reason'])

    def test_recursive_delete_of_a_large_dependency_tree_stays_within_budget(self):
        for index in range(20000):
            path = self.root / f'node_modules/pkg{index % 200}/lib/file{index}.js'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('x')
        start = time.monotonic()
        self.assertEqual(self.guard(command='rm -rf node_modules'), 'allow')
        self.assertLess(time.monotonic() - start, 5)

    def test_recursive_delete_reports_target_instead_of_internal_probe(self):
        target = self.root / 'vendor'
        target.mkdir()
        denied = self.result(command='rm -rf vendor')
        self.assertEqual(denied['decision'], 'deny')
        self.assertTrue(denied['reason'].endswith(f'路径：{target}'), denied['reason'])

    def test_examples_and_data_heredocs_are_allowed(self):
        for command in ['cat .env.example', "cat > notes.txt <<'EOF'\nrm -rf vendor\nEOF", 'source .env']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_all_patch_paths_and_symlink_targets_are_checked(self):
        self.assertEqual(self.guard(tool='patch', paths=[str(self.root / 'safe.txt'), str(self.root / 'vendor/new.txt')]), 'deny')
        (self.root / 'vendor').mkdir()
        (self.root / 'alias').symlink_to(self.root / 'vendor', target_is_directory=True)
        self.assertEqual(self.guard(tool='write', paths=[str(self.root / 'alias/new.txt')]), 'deny')

    def test_nested_location_and_workdir_use_repository_policy(self):
        (self.root / 'src').mkdir()
        self.assertEqual(self.guard(command='cat ../.env', workdir='src'), 'deny')
        self.assertEqual(self.guard(command='echo x > ../vendor/file', workdir='src'), 'deny')

    def test_missing_policy_fails_closed(self):
        (self.root / '.opencode/workflow/protection.json').unlink()
        self.assertEqual(self.guard(tool='write', paths=[str(self.root / 'file')]), 'deny')


if __name__ == '__main__':
    unittest.main()
