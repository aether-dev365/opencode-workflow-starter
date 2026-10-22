import contextlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from quality_lib import Finding, Incomplete, collect, main, parse_mode
from quality_testing import NEEDS_SYMLINK, TempRepo


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
        r.git('switch', '-q', '-c', 'side'); r.write('a.ts', 'side\n'); r.commit()
        r.git('switch', '-q', 'main'); r.write('a.ts', 'main\n'); r.commit()
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
        r.git('switch', '-q', '-c', 'feature'); r.write('a.ts', '1\nfeature\n'); r.commit()
        r.git('switch', '-q', 'main'); r.write('b.ts', 'main only\n'); r.commit()
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
        r.git('switch', '-q', '-c', 'side'); r.write('a.ts', 'side\n'); r.commit()
        r.git('switch', '-q', 'main'); r.write('a.ts', 'main\n'); r.commit()
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
        self.assertEqual(self.run_main([], check=broken), (2, [], ['演示检查未完成：RuntimeError']))

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
