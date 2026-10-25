import os
import subprocess
import sys
import unittest
from unittest import mock
from quality_lib import Incomplete, collect
from quality_testing import HERE, TempRepo, needs_symlink


class SymlinkPermission(unittest.TestCase):
    def test_windows_with_permission_executes_the_test(self):
        self.assertEqual(needs_symlink(lambda: 'executed', os_name='nt')(), 'executed')

    def test_only_missing_windows_privilege_is_skipped(self):
        error = OSError('permission fixture')
        error.winerror = 1314

        def denied():
            raise error

        with self.assertRaises(unittest.SkipTest):
            needs_symlink(denied, os_name='nt')()
        with self.assertRaises(OSError):
            needs_symlink(denied, os_name='posix')()
        error.winerror = 5
        with self.assertRaises(OSError):
            needs_symlink(denied, os_name='nt')()


class PortableGit(unittest.TestCase):
    def test_basic_collection_does_not_require_new_git_options(self):
        run = subprocess.run

        def legacy_git(argv, **kwargs):
            if argv[0] == 'git' and ('--end-of-options' in argv or 'switch' in argv or ('init' in argv and '-b' in argv)):
                if kwargs.get('check'):
                    raise subprocess.CalledProcessError(129, argv, output='', stderr='unsupported option')
                return subprocess.CompletedProcess(argv, 129, b'', b'unsupported option')
            return run(argv, **kwargs)

        with mock.patch('subprocess.run', side_effect=legacy_git):
            r = TempRepo()
            self.addCleanup(r.close)
            r.write('a.ts', 'one\n'); r.commit()
            with mock.patch.dict(os.environ, r.env, clear=True):
                changes = collect(r.root, ('commit', 'HEAD'))
                self.assertEqual([(t.path, sorted(t.added)) for t in changes.targets], [('a.ts', [1])])
                for revision in ['--help', '--all', '-n1']:
                    with self.subTest(revision=revision), self.assertRaises(Incomplete):
                        collect(r.root, ('commit', revision))


class InheritedGitEnvironment(unittest.TestCase):
    def test_in_process_git_ignores_a_caller_repository(self):
        # 从 Git hook 等环境运行测试时会继承 GIT_DIR、GIT_WORK_TREE；进程内直接调用 Git 的用例不能因此指向别的仓库。
        other = TempRepo(); self.addCleanup(other.close)
        env = {**os.environ, 'GIT_DIR': str(other.root / '.git'), 'GIT_WORK_TREE': str(other.root)}
        result = subprocess.run([sys.executable, '-m', 'unittest', 'test_snapshot.Snapshots.test_change_events_compare_snapshot_entries'],
                                cwd=HERE, env=env, encoding='utf-8', errors='replace', capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
