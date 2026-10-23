import unittest
from unittest import mock
from quality_testing import TempRepo, NEEDS_SYMLINK
from quality_lib import default_config, selected, Incomplete
import quality_lib
import quality_snapshot as snapshot


class Snapshots(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)

    def collect(self, kind='commit', rev='HEAD'):
        return snapshot.collect_files(self.repo.root, (kind, rev))

    def test_file_changes_keep_deletions_empty_files_and_renames(self):
        self.repo.write('a.txt', 'one\ntwo\n')
        self.repo.write('old.md', 'unique document\n')
        self.repo.commit()
        self.repo.write('a.txt', 'one\n')
        self.repo.write('empty.txt', '')
        (self.repo.root / 'docs').mkdir()
        self.repo.git('mv', 'old.md', 'docs/new.md')
        self.repo.commit()
        c = self.collect()
        self.assertEqual(set(c.changed), {'a.txt', 'empty.txt', 'docs/new.md'})
        self.assertIn('old.md', c.removed)

    def test_path_selection_does_not_expand_old_source_selection(self):
        for path in ('README.md', 'data.json'):
            self.assertTrue(quality_lib.path_selected(path, default_config()))
            self.assertFalse(selected(path, default_config()))
        self.assertFalse(quality_lib.path_selected('vendor/a.txt', default_config()))

    def test_snapshot_content_and_existence_ignore_worktree(self):
        self.repo.write('doc.md', 'commit')
        self.repo.write('target.txt', '')
        sha = self.repo.commit()
        self.repo.write('doc.md', 'index')
        self.repo.git('rm', 'target.txt')
        self.repo.git('add', 'doc.md')
        self.repo.write('doc.md', 'worktree')
        self.repo.write('target.txt', 'untracked')
        for mode, rev, content, exists in [('commit', sha, b'commit', True), ('staged', None, b'index', False)]:
            with self.subTest(mode=mode):
                c = self.collect(mode, rev)
                self.assertEqual(c.after.read_many(['doc.md']), {'doc.md': content})
                self.assertEqual(c.after.exists('target.txt'), exists)

    def test_range_uses_merge_base_and_right_tree(self):
        self.repo.write('doc.md', 'base'); base = self.repo.commit()
        self.repo.git('checkout', '-b', 'right')
        self.repo.write('doc.md', 'right'); right = self.repo.commit()
        self.repo.git('checkout', 'main')
        self.repo.write('left-only.txt', 'left'); left = self.repo.commit()
        c = self.collect('range', left + '..' + right)
        self.assertNotIn('left-only.txt', c.changed)
        self.assertEqual(c.after.read_many(['doc.md'])['doc.md'], b'right')
        self.assertEqual(c.before.read_many(['doc.md'])['doc.md'], b'base')

    def test_initial_staged_and_merge_commit(self):
        self.repo.write('a.txt', 'initial'); self.repo.git('add', '.')
        c = self.collect('staged', None)
        self.assertEqual(c.changed, ('a.txt',))
        self.assertEqual(c.after.read_many(['a.txt'])['a.txt'], b'initial')
        self.assertFalse(c.before.exists('a.txt'))
        self.repo.commit()
        self.repo.git('checkout', '-b', 'side')
        self.repo.write('side', ''); self.repo.commit()
        self.repo.git('checkout', 'main')
        self.repo.write('main', ''); self.repo.commit()
        self.repo.git('merge', '--no-ff', 'side', '-m', 'merge')
        c = self.collect()
        self.assertTrue(c.merge)
        self.assertEqual(c.changed, ())

    @NEEDS_SYMLINK
    def test_all_source_list_and_target_namespace(self):
        self.repo.write('.gitignore', 'ignored*\n')
        self.repo.write('tracked.md', ''); self.repo.write('deleted.md', '')
        self.repo.commit()
        (self.repo.root / 'deleted.md').unlink()
        self.repo.write('untracked.md', '')
        self.repo.write('ignored-asset.bin', '')
        (self.repo.root / 'alias').symlink_to(self.repo.root, target_is_directory=True)
        c = self.collect('all', None)
        self.assertEqual(set(c.changed), {'.gitignore', 'tracked.md', 'untracked.md'})
        self.assertTrue(c.after.exists('ignored-asset.bin'))
        self.assertFalse(c.after.exists('alias/tracked.md'))

    @NEEDS_SYMLINK
    def test_snapshot_entries_do_not_traverse_links_or_submodules(self):
        self.repo.write('dir/a.md', 'content')
        (self.repo.root / 'link').symlink_to('dir', target_is_directory=True)
        sha = self.repo.commit()
        self.repo.git('update-index', '--add', '--cacheinfo', f'160000,{sha},module')
        self.repo.commit(add=False)
        self.repo.write('module/inside.md', 'not traversable')
        for kind in ('commit', 'staged', 'all'):
            c = self.collect(kind, 'HEAD' if kind == 'commit' else None)
            self.assertTrue(c.after.exists('link'))
            self.assertTrue(c.after.exists('module'))
            self.assertFalse(c.after.exists('link/a.md'))
            self.assertFalse(c.after.exists('module/inside.md'))
            self.assertNotIn('link/a.md', c.after.regular_paths())

    def test_conflicted_index_and_bad_git_output_are_incomplete(self):
        self.repo.write('a', 'base'); self.repo.commit()
        self.repo.git('checkout', '-b', 'side')
        self.repo.write('a', 'side'); self.repo.commit()
        self.repo.git('checkout', 'main')
        self.repo.write('a', 'main'); self.repo.commit()
        self.repo.git('merge', 'side', check=False)
        with self.assertRaises(Incomplete):
            self.collect('staged', None)
        with mock.patch.object(snapshot, 'git_bytes', return_value=b'bad output'):
            with self.assertRaises(Incomplete):
                self.collect('commit', 'HEAD')

    def test_reads_and_existence_queries_are_batched(self):
        paths = ['a space.md', '中文.md', 'tab\tname.md'] + [f'docs/{n}.md' for n in range(20)]
        for path in paths:
            self.repo.write(path, 'bytes')
        self.repo.commit()
        with mock.patch.object(snapshot, 'git_bytes', wraps=snapshot.git_bytes) as git:
            c = self.collect()
            count = git.call_count
            self.assertEqual(c.after.read_many(paths), dict.fromkeys(paths, b'bytes'))
            self.assertEqual(git.call_count - count, 1)
            for n in range(300):
                self.assertTrue(c.after.exists('docs'))
                self.assertFalse(c.after.exists(f'absent/{n}'))
            self.assertEqual(git.call_count - count, 1)

    def test_all_missing_submodule_is_not_a_worktree_target(self):
        self.repo.write('a', ''); sha = self.repo.commit()
        self.repo.git('update-index', '--add', '--cacheinfo', f'160000,{sha},missing-module')
        self.assertFalse(self.collect('all', None).after.exists('missing-module'))
        self.assertTrue(self.collect('staged', None).after.exists('missing-module'))
