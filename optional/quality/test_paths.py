import os
import contextlib
import io
from pathlib import Path
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from quality_lib import Incomplete, default_config
from quality_snapshot import Snapshot, FileChanges
from quality_testing import load_script


class WorktreePaths(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()

    def test_directory_reparse_points_are_entries_not_traversable_paths(self):
        for external in (False, True):
            with self.subTest(external=external):
                target = (self.root.parent if external else self.root) / ('outside' if external else 'inside')
                target.mkdir()
                (target / 'example.md').write_text('synthetic', encoding='utf-8')
                alias = self.root / ('external' if external else 'internal')
                if os.name == 'nt':
                    subprocess.run(['cmd', '/c', 'mklink', '/J', str(alias), str(target)],
                                   check=True, capture_output=True, timeout=5)
                    self.addCleanup(alias.rmdir)
                    context = mock.patch.dict(os.environ, {})
                else:
                    alias.mkdir()
                    (alias / 'example.md').write_text('synthetic', encoding='utf-8')
                    original = Path.lstat
                    def lstat(path, *args, **kwargs):
                        if path == alias:
                            return SimpleNamespace(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
                        return original(path, *args, **kwargs)
                    context = mock.patch.object(Path, 'lstat', lstat)
                name = alias.name + '/example.md'
                snap = Snapshot(self.root, worktree=True, sources=[name], os_name='nt')
                with context:
                    self.assertTrue(snap.exists(alias.name))
                    with self.subTest(access='exists'):
                        self.assertFalse(snap.exists(name))
                    with self.subTest(access='sources'):
                        self.assertEqual(snap.regular_paths(), ())
                    with self.subTest(access='read'):
                        with self.assertRaises(Incomplete):
                            snap.read_many([name])
                    module = load_script('check-format.py')
                    config = default_config()
                    config['formats'] = [{'id': 'fmt', 'paths': ['*.md'], 'hook': True}]
                    changes = FileChanges(Snapshot(self.root), snap, (name,), ())
                    with self.subTest(access='format'), \
                            mock.patch.object(module, 'repo_root', return_value=self.root), \
                            mock.patch.object(module, 'load_config', return_value=config), \
                            mock.patch.object(module, 'collect_files', return_value=changes), \
                            contextlib.redirect_stdout(io.StringIO()) as output:
                        self.assertEqual(module.main(['--commit', 'HEAD'], here=self.root / 'scripts'), 2)
                        self.assertIn('工作区缺失或不是普通文件', output.getvalue())

    def test_windows_devices_and_reinterpreted_names_are_not_targets(self):
        names = ['NUL', 'nul.txt', 'CON', 'aux.md', 'PRN', 'COM1', 'LPT9.txt', 'COM¹', 'normal.']
        (self.root / 'normal').write_text('regular', encoding='utf-8')
        (self.root / 'dir').mkdir()
        if os.name != 'nt':
            for name in names:
                (self.root / name).write_text('not a Windows file', encoding='utf-8')
        snap = Snapshot(self.root, worktree=True, sources=names, os_name='nt')
        self.assertTrue(snap.exists('normal'))
        self.assertTrue(snap.exists('dir'))
        for name in names:
            with self.subTest(name=name):
                self.assertFalse(snap.exists(name))
        self.assertEqual(snap.regular_paths(), ())
