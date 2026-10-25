import contextlib
import io
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock
from quality_lib import Finding, Incomplete, collect, main, parse_mode
from quality_testing import HERE, NEEDS_SYMLINK, TempRepo


def added(changes):
    return {t.path: (None if t.added is None else sorted(t.added)) for t in changes.targets}


def flag(path, text, lines, config):
    return [Finding(path, n, 'demo', '演示') for n, line in enumerate(text.splitlines(), 1)
            if 'FLAG' in line and (lines is None or n in lines)] * 2


class Collect(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        patch = mock.patch.dict(os.environ, self.repo.env, clear=True)
        patch.start()
        self.addCleanup(patch.stop)

    def test_commit_mode_reports_added_and_modified_lines(self):
        r = self.repo
        r.write('a.ts', '1\n2\n3\n'); r.commit()
        self.assertEqual(added(collect(r.root, ('commit', 'HEAD'))), {'a.ts': [1, 2, 3]})
        r.write('a.ts', '1\nchanged\n3\n4\n'); r.commit()
        self.assertEqual(added(collect(r.root, ('commit', 'HEAD'))), {'a.ts': [2, 4]})

    def test_renamed_file_reports_only_changed_lines(self):
        r = self.repo
        r.write('a.ts', 'one\ntwo\nthree\nfour\n'); r.commit()
        r.git('mv', 'a.ts', 'b.ts'); r.write('b.ts', 'ONE\ntwo\nthree\nfour\n'); r.commit()
        self.assertEqual(added(collect(r.root, ('commit', 'HEAD'))), {'b.ts': [1]})
        r.git('mv', 'b.ts', 'c.ts'); r.commit()
        self.assertEqual(added(collect(r.root, ('commit', 'HEAD'))), {})

    def test_rename_hunks_are_not_mixed_with_a_replacement_directory(self):
        r = self.repo
        r.write('a.ts', '// Task 3\n// keep one\n// keep two\n// keep three\n')
        base = r.commit()
        r.git('mv', 'a.ts', 'b.ts')
        r.write('b.ts', '// Task 3\n// keep one\n// changed\n// keep three\n')
        r.write('a.ts/new.ts', 'new one\nnew two\nnew three\nnew four\n')
        r.git('add', '-A')
        self.assertRegex(r.git('diff', '--cached', '--name-status', '-M').stdout, r'R\d+\s+a.ts\s+b.ts')
        self.assertEqual(added(collect(r.root, ('staged', None)))['b.ts'], [3])
        r.commit(add=False)
        for mode in [('commit', 'HEAD'), ('range', base + '..HEAD')]:
            with self.subTest(mode=mode):
                self.assertEqual(added(collect(r.root, mode))['b.ts'], [3])

    def test_deleted_binary_and_gitlink_entries_are_ignored(self):
        r = self.repo
        r.write('a.ts', 'x\n'); head = r.commit()
        (r.root / 'a.ts').unlink(); r.write('img.bin', b'\x00\x01\x02')
        r.git('add', '-A'); r.git('update-index', '--add', '--cacheinfo', f'160000,{head},sub')
        r.commit('mixed', add=False)
        self.assertEqual(added(collect(r.root, ('commit', 'HEAD'))), {})

    @NEEDS_SYMLINK
    def test_symlinks_are_ignored(self):
        r = self.repo
        r.write('a.ts', 'x\n'); r.commit()
        os.symlink('a.ts', r.root / 'link.ts'); r.commit()
        self.assertEqual(added(collect(r.root, ('commit', 'HEAD'))), {})
        self.assertNotIn('link.ts', added(collect(r.root, ('all', None))))

    def test_merge_commit_is_marked(self):
        r = self.repo
        r.write('a.ts', 'x\n'); r.commit()
        r.git('checkout', '-q', '-b', 'side'); r.write('a.ts', 'side\n'); r.commit()
        r.git('checkout', '-q', 'main'); r.write('a.ts', 'main\n'); r.commit()
        r.git('merge', '-q', 'side', check=False); r.write('a.ts', 'merged\n'); r.commit('merge')
        self.assertTrue(collect(r.root, ('commit', 'HEAD')).merge)

    def test_staged_mode_without_commits_uses_empty_tree(self):
        r = self.repo
        r.write('a.ts', 'a\nb\n'); r.git('add', '-A')
        changes = collect(r.root, ('staged', None))
        r.write('a.ts', 'worktree\n')
        self.assertEqual(added(changes), {'a.ts': [1, 2]})
        self.assertEqual(changes.targets[0].read(), b'a\nb\n')

    def test_range_mode_uses_merge_base(self):
        r = self.repo
        r.write('a.ts', '1\n'); r.commit()
        r.git('checkout', '-q', '-b', 'feature'); r.write('a.ts', '1\nfeature\n'); r.commit()
        r.git('checkout', '-q', 'main'); r.write('b.ts', 'main only\n'); r.commit()
        changes = collect(r.root, ('range', 'main..feature'))
        self.assertEqual(added(changes), {'a.ts': [2]})
        self.assertEqual(changes.targets[0].read(), b'1\nfeature\n')

    def test_all_mode_includes_untracked_but_not_ignored_files(self):
        r = self.repo
        r.write('.gitignore', 'ignored.ts\n'); r.write('a.ts', 'x\n'); r.commit()
        r.write('new.ts', 'y\n'); r.write('ignored.ts', 'z\n')
        self.assertEqual(added(collect(r.root, ('all', None))), {'.gitignore': None, 'a.ts': None, 'new.ts': None})

    def test_paths_with_spaces_and_non_ascii_are_kept(self):
        r = self.repo
        r.write('src/my file.ts', 'a\n'); r.write('src/中文.ts', 'b\n'); r.commit()
        self.assertEqual(set(added(collect(r.root, ('commit', 'HEAD')))), {'src/my file.ts', 'src/中文.ts'})

    def test_selected_paths_use_batched_diff_and_blob_reads(self):
        paths = [f'src/{n:03d}-' + 'a' * 150 + '.ts' for n in range(100)]
        paths += ['src/中文 file.ts', "src/[literal]'name.ts"]
        for path in paths:
            self.repo.write(path, 'first\nsecond\n')
        self.repo.commit()
        with mock.patch('quality_lib.subprocess.run', wraps=subprocess.run) as run:
            changes = collect(self.repo.root, ('commit', 'HEAD'))
            self.assertEqual(added(changes), {path: [1, 2] for path in paths})
            self.assertTrue(all(target.read() == b'first\nsecond\n' for target in changes.targets))
        commands = [call.args[0] for call in run.call_args_list]
        diffs = [cmd for cmd in commands if '-p' in cmd]
        self.assertGreater(len(diffs), 1)
        self.assertLess(len(diffs), 10)
        self.assertEqual(len([cmd for cmd in commands if 'cat-file' in cmd]), 1)
        self.assertTrue(all(sum(len(p.encode('utf-8')) + 1 for p in cmd[cmd.index('--') + 1:]) <= 12000 for cmd in diffs))

    def test_user_diff_context_never_marks_unchanged_lines(self):
        r = self.repo
        r.write('a.ts', 'one\n// Task 3\nthree\nfour\nfive\n')
        base = r.commit()
        r.write('a.ts', 'ONE\n// Task 3\nthree\nfour\nFIVE\n')
        r.git('add', '-A')
        for setting in ('config', 'environment'):
            with self.subTest(setting=setting):
                r.git('config', 'diff.interHunkContext', '10' if setting == 'config' else '0')
                with mock.patch.dict(os.environ, {'GIT_DIFF_OPTS': '--unified=10'} if setting == 'environment' else {}):
                    self.assertEqual(added(collect(r.root, ('staged', None))), {'a.ts': [1, 5]})
        r.commit(add=False)
        r.git('config', 'diff.interHunkContext', '10')
        for mode in [('commit', 'HEAD'), ('range', base + '..HEAD')]:
            with self.subTest(mode=mode), mock.patch.dict(os.environ, {'GIT_DIFF_OPTS': '-u10'}):
                self.assertEqual(added(collect(r.root, mode)), {'a.ts': [1, 5]})

    def test_git_subprocesses_do_not_inherit_diff_overrides(self):
        self.repo.write('a.ts', 'x\n'); self.repo.commit()
        real_run = subprocess.run
        def run(*args, **kwargs):
            environment = kwargs.get('env', os.environ)
            self.assertFalse('GIT_DIFF_OPTS' in environment)
            self.assertFalse('GIT_EXTERNAL_DIFF' in environment)
            return real_run(*args, **kwargs)
        with mock.patch.dict(os.environ, {'GIT_DIFF_OPTS': '-u10', 'GIT_EXTERNAL_DIFF': 'unused'}), mock.patch('quality_lib.subprocess.run', side_effect=run):
            self.assertEqual(added(collect(self.repo.root, ('commit', 'HEAD'))), {'a.ts': [1]})

    def test_type_change_to_regular_file_keeps_all_added_lines_and_other_files(self):
        r = self.repo
        r.write('a.ts', 'link-target\n')
        oid = r.git('hash-object', '-w', 'a.ts').stdout.strip()
        r.git('update-index', '--add', '--cacheinfo', f'120000,{oid},a.ts')
        base = r.commit(add=False)
        r.write('a.ts', '// Task 3\n// next\n')
        r.write('ok.ts', '// Task 4\n')
        r.git('-c', 'core.symlinks=false', 'add', '-A')
        oid = r.git('hash-object', '-w', 'a.ts').stdout.strip()
        r.git('update-index', '--cacheinfo', f'100644,{oid},a.ts')
        expected = {'a.ts': [1, 2], 'ok.ts': [1]}
        with self.subTest(mode='staged'):
            self.assertEqual(added(collect(r.root, ('staged', None))), expected)
        r.commit(add=False)
        for mode in [('commit', 'HEAD'), ('range', base + '..HEAD')]:
            with self.subTest(mode=mode):
                changes = collect(r.root, mode)
                self.assertEqual(added(changes), expected)
                self.assertEqual({t.path: t.read() for t in changes.targets},
                                 {'a.ts': b'// Task 3\n// next\n', 'ok.ts': b'// Task 4\n'})

    def test_invalid_revisions_are_incomplete(self):
        r = self.repo
        r.write('a.ts', 'x\n'); r.commit()
        for mode in [('commit', 'nope'), ('range', 'main...main'), ('range', 'main..nope'), ('range', '..main')]:
            with self.subTest(mode=mode):
                with self.assertRaises(Incomplete) as caught:
                    collect(r.root, mode)
                self.assertEqual(caught.exception.args[0], '修订号无效')

    def test_modes_are_mutually_exclusive(self):
        self.assertEqual(parse_mode([]), ('commit', 'HEAD'))
        self.assertEqual(parse_mode(['--all']), ('all', None))
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
            parse_mode(['--all', '--staged'])
        self.assertEqual(caught.exception.code, 2)


class Driver(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.here = Path(temp.name)

    def run_main(self, argv, check=flag, cwd=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, self.repo.env, clear=True), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main('演示检查', '需复核', check, argv, self.here, cwd or self.repo.root)
        return code, out.getvalue().splitlines(), err.getvalue().splitlines()

    def test_findings_are_sorted_deduplicated_and_summarized(self):
        r = self.repo
        r.write('c.ts', 'x\nFLAG\n'); r.write('b.ts', 'FLAG\nx\nFLAG\n'); r.commit()
        self.assertEqual(self.run_main(['--commit', 'HEAD']), (1, [
            'b.ts:1: [demo] 演示', 'b.ts:3: [demo] 演示', 'c.ts:2: [demo] 演示', '演示检查：检查了 2 个文件，3 处需复核。'], []))

    def test_clean_run_returns_zero(self):
        self.repo.write('a.ts', 'x\n'); self.repo.commit()
        self.assertEqual(self.run_main([]), (0, ['演示检查：检查了 1 个文件，0 处需复核。'], []))

    def test_large_vendor_commit_checks_only_selected_file_within_five_seconds(self):
        for n in range(10000):
            self.repo.write(f'vendor/file{n}.go', '// Task 3\n')
        self.repo.write('main.go', '// Task 3\n')
        self.repo.commit()
        start = time.monotonic()
        try:
            result = subprocess.run([sys.executable, str(HERE / 'review-comments.py')],
                                    cwd=self.repo.root, env=self.repo.env, capture_output=True,
                                    encoding='utf-8', timeout=5)
        except subprocess.TimeoutExpired:
            self.fail('排除 vendor 后的检查超过 5 秒')
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual(result.returncode, 1)
        self.assertIn('main.go:1: [tracking]', result.stdout)
        self.assertIn('检查了 1 个文件', result.stdout)

    def test_large_and_non_utf8_files_are_counted_as_skipped(self):
        r = self.repo
        r.write('a.ts', 'x\n'); r.write('big.ts', 'x' * (1024 * 1024 + 1)); r.write('latin.ts', b'\xff\xfe\n'); r.commit()
        self.assertEqual(self.run_main([])[1], ['演示检查：检查了 1 个文件，0 处需复核（跳过 2 个非 UTF-8 或过大的文件）。'])

    def test_generated_files_are_skipped_silently(self):
        self.repo.write('gen.ts', '// Code generated by tool. DO NOT EDIT.\nFLAG\n'); self.repo.commit()
        self.assertEqual(self.run_main([]), (0, ['演示检查：检查了 0 个文件，0 处需复核。'], []))

    def test_merge_commit_prints_a_single_line(self):
        r = self.repo
        r.write('a.ts', 'x\n'); r.commit()
        r.git('checkout', '-q', '-b', 'side'); r.write('a.ts', 'side\n'); r.commit()
        r.git('checkout', '-q', 'main'); r.write('a.ts', 'main\n'); r.commit()
        r.git('merge', '-q', 'side', check=False); r.write('a.ts', 'FLAG\n'); r.commit('merge')
        self.assertEqual(self.run_main([]), (0, ['演示检查：合并提交不检查。'], []))

    def test_config_errors_and_outside_repository_are_incomplete(self):
        (self.here / 'quality.json').write_text('{"version": 1, "timeoutSeconds": 0}', encoding='utf-8')
        self.repo.write('a.ts', 'x\n'); self.repo.commit()
        self.assertEqual(self.run_main([]), (2, [], ['演示检查未完成：配置无效：timeoutSeconds']))
        (self.here / 'quality.json').unlink()
        self.assertEqual(self.run_main([], cwd=self.here), (2, [], ['演示检查未完成：不在 git 仓库中']))

    def test_output_never_contains_file_content_or_exception_text(self):
        self.repo.write('a.ts', 'const token = "FLAG-synthetic-value"\n'); self.repo.commit()
        code, out, err = self.run_main([])
        self.assertNotIn('synthetic-value', '\n'.join(out + err))

        def broken(*args):
            raise RuntimeError('synthetic-value')
        self.assertEqual(self.run_main([], check=broken), (0, ['演示检查：检查了 0 个文件，0 处需复核（跳过 1 个无法分析的文件）。'], []))

    def test_analysis_failure_skips_one_file_and_keeps_other_findings(self):
        self.repo.write('a.ts', 'FLAG\n')
        self.repo.write('b.ts', 'FLAG\n')
        self.repo.write('bad.ts', b'\xff')
        self.repo.commit()
        def check(path, text, lines, config):
            if path == 'a.ts':
                raise ValueError('不能回显的内容')
            return flag(path, text, lines, config)
        self.assertEqual(self.run_main([], check=check), (1, [
            'b.ts:1: [demo] 演示',
            '演示检查：检查了 1 个文件，1 处需复核（跳过 1 个非 UTF-8 或过大的文件，1 个无法分析的文件）。'], []))

    def test_all_mode_binary_is_not_a_source_file(self):
        self.repo.write('binary.ts', b'FLAG\x00payload')
        self.assertEqual(self.run_main(['--all']), (0, ['演示检查：检查了 0 个文件，0 处需复核。'], []))

    def test_include_exclude_and_generated_paths_apply_to_driver(self):
        self.repo.write('src/a.ts', 'FLAG\n')
        self.repo.write('src/generated/b.ts', 'FLAG\n')
        self.repo.write('src/old.ts', 'FLAG\n')
        self.repo.write('lib/a.ts', 'FLAG\n')
        (self.here / 'quality.json').write_text('{"version":1,"include":["src/*"],"exclude":["src/old.ts"]}', encoding='utf-8')
        result = self.run_main(['--all'])
        self.assertEqual(result, (1, ['src/a.ts:1: [demo] 演示', '演示检查：检查了 1 个文件，1 处需复核。'], []))

    def test_extension_directory_is_excluded_in_every_mode(self):
        here = self.repo.install_scripts('tools/quality')
        self.repo.write('base.txt', 'base\n'); base = self.repo.commit()
        self.repo.write('tools/quality/fixture.ts', '// Task 3\nit.skip("x", fn)\n')
        self.repo.write('tools/quality-other/app.ts', '// Task 3\nit.skip("x", fn)\n')
        self.repo.git('add', '-A')
        for script in ('review-comments.py', 'check-skips.py'):
            with self.subTest(script=script, mode='staged'):
                result = self.repo.run(here / script, '--staged')
                self.assertEqual(result.returncode, 1)
                self.assertNotIn('tools/quality/fixture.ts:', result.stdout)
                self.assertIn('检查了 1 个文件', result.stdout)
        self.repo.commit(add=False)
        for script in ('review-comments.py', 'check-skips.py'):
            for args in ((), ('--range', base + '..HEAD'), ('--all',)):
                with self.subTest(script=script, args=args):
                    result = self.repo.run(here / script, *args)
                    self.assertEqual(result.returncode, 1)
                    self.assertNotIn('tools/quality/fixture.ts:', result.stdout)
                    self.assertIn('检查了 1 个文件', result.stdout)

    def test_generated_header_counts_only_newline_characters(self):
        self.repo.write('a.ts', '\f' * 6 + '// DO NOT EDIT\nFLAG\n')
        self.assertEqual(self.run_main(['--all']), (0, ['演示检查：检查了 0 个文件，0 处需复核。'], []))
