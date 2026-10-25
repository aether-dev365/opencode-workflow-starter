import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
import quality_lib as lib
from quality_testing import TempRepo


class StrictMode(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.scripts = self.repo.install_scripts()

    def run_both(self, *args):
        return [self.repo.run(self.scripts / name, *args)
                for name in ('review-comments.py', 'check-skips.py')]

    def test_clean_strict_cli_runs_instead_of_rejecting_option(self):
        self.repo.write('a.ts', 'const value = 1;\n')
        for result in self.run_both('--all', '--fail-on-incomplete'):
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('unrecognized arguments', result.stderr)

    def test_unreadable_text_is_incomplete_only_when_requested(self):
        for content in (b'\xff', b'x' * (1024 * 1024 + 1)):
            self.repo.write('bad.ts', content)
            for result in self.run_both('--all'):
                self.assertEqual(result.returncode, 0, result.stderr)
            for result in self.run_both('--all', '--fail-on-incomplete'):
                self.assertEqual(result.returncode, 2)
                self.assertIn('非 UTF-8 或过大的文件', result.stdout)

    def test_php_literals_preserve_real_findings_in_strict_cli(self):
        for opening, closing in [('<<<END', 'END'), ('<<<"END"', 'END'), ("<<<'END'", 'END'), ('`', '`')]:
            with self.subTest(opening=opening):
                self.repo.write('ExampleTest.php', '<?php\nclass ExampleTest {\nfunction testExample() {\n'
                                '$value = ' + opening + '\nmarkTestIncomplete(); // 本次修复\n?>\n' + closing + ';\n'
                                '$this->markTestSkipped(); // 本次修复\n}\n}\n')
                for result, rule in zip(self.run_both('--all', '--fail-on-incomplete'), ('process', 'skip')):
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    findings = [line for line in result.stdout.splitlines() if line.startswith('ExampleTest.php:')]
                    self.assertEqual(len(findings), 1, result.stdout)
                    self.assertIn('ExampleTest.php:8: [' + rule + ']', findings[0])
                    self.assertEqual(result.stderr, '')

    def test_unclosed_php_literals_fail_closed_and_keep_other_file_findings(self):
        self.repo.write('ok.ts', '// 本次修复\ntest.skip("case", fn);\n')
        for opening in ('<<<END\n', '<<<"END"\n', "<<<'END'\n", '`'):
            with self.subTest(opening=opening):
                self.repo.write('ExampleTest.php', '<?php\nclass ExampleTest {\nfunction testExample() {\n'
                                '$value = ' + opening + '?>\n')
                for result in self.run_both('--all', '--fail-on-incomplete'):
                    self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
                    self.assertIn('1 个无法分析的文件', result.stdout)
                    self.assertIn('ok.ts:', result.stdout)
                    self.assertNotIn('ExampleTest.php:', result.stdout)
                    self.assertEqual(result.stderr, '')

    def test_callback_error_keeps_other_findings_and_returns_two(self):
        self.repo.write('bad.ts', 'bad\n')
        self.repo.write('ok.ts', 'ok\n')
        def check(path, text, lines, config):
            if path == 'bad.ts':
                raise ValueError('private source detail')
            return [lib.Finding(path, 1, 'demo', '演示')]
        for strict, expected in ((False, 1), (True, 2)):
            out = io.StringIO()
            with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, self.repo.env, clear=True), contextlib.redirect_stdout(out):
                code = lib.main('检查', '发现', check, ['--all'] + (['--fail-on-incomplete'] if strict else []), Path(directory), self.repo.root)
            self.assertEqual(code, expected)
            self.assertIn('ok.ts:1:', out.getvalue())
            self.assertIn('1 个无法分析的文件', out.getvalue())
            self.assertNotIn('private source detail', out.getvalue())

    def test_rule_exclusions_remain_exclusions(self):
        self.repo.write('generated.ts', '// @generated\n// Task 3\n')
        self.repo.write('binary.ts', b'\0\xff')
        self.repo.write('data.unknown', b'\xff')
        self.repo.write('ignored.ts', b'\xff')
        (self.scripts / 'quality.json').write_text(json.dumps({'version': 1, 'exclude': ['ignored.ts']}))
        for result in self.run_both('--all', '--fail-on-incomplete'):
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_generated_headers_still_exclude_large_or_non_utf8_files(self):
        for marker in ('@generated', 'DO NOT EDIT', 'Code generated', 'auto-generated'):
            for body in (b'x' * (1024 * 1024 + 1), b'\xff'):
                with self.subTest(marker=marker, large=len(body) > 1):
                    self.repo.write('generated.ts', b'\n' * 4 + ('// ' + marker + '\n').encode() + body)
                    for result in self.run_both('--all'):
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIn('非 UTF-8 或过大的文件', result.stdout)
                    for result in self.run_both('--all', '--fail-on-incomplete'):
                        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                        self.assertNotIn('非 UTF-8 或过大的文件', result.stdout)
        self.repo.write('generated.ts', b'\n' * 5 + b'// @generated\n\xff')
        for result in self.run_both('--all', '--fail-on-incomplete'):
            self.assertEqual(result.returncode, 2)

    def test_option_parsing_preserves_values_and_mode_contract(self):
        self.assertEqual(lib.parse_mode(['--all']), ('all', None))
        self.assertTrue(hasattr(lib, 'parse_line_options'))
        self.assertEqual(lib.parse_line_options(['--commit=--fail-on-incomplete']), (('commit', '--fail-on-incomplete'), False))
        self.assertEqual(lib.parse_line_options(['--all', '--fail-on-incomplete']), (('all', None), True))
        for args in (['--all', '--staged'], ['--unknown']):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                lib.parse_line_options(args)
            self.assertEqual(caught.exception.code, 2)

    def test_incomplete_wins_over_ordinary_findings(self):
        self.repo.write('bad.ts', b'\xff')
        self.repo.write('example.test.ts', '// Task 3\ntest.skip("case", () => {});\n')
        for result in self.run_both('--all', '--fail-on-incomplete'):
            self.assertEqual(result.returncode, 2)
            self.assertIn('example.test.ts:', result.stdout)
