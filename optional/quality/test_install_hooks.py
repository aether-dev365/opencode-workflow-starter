import os
import shutil
import tempfile
import unittest
from pathlib import Path
from quality_testing import NEEDS_SYMLINK, TempRepo

HEADER = '质量检查（提交已完成，以下只是报告）：'


class Installer(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.repo.write('README.txt', 'base\n'); self.first = self.repo.commit('base')
        self.here = self.repo.install_scripts(); self.repo.commit('scripts')
        self.hook = self.repo.root / '.git' / 'hooks' / 'post-commit'

    def install(self, *args, cwd=None):
        return self.repo.run(self.here / 'install-hooks.py', *args, cwd=cwd)

    def commit_output(self, *git_args):
        result = self.repo.git(*git_args)
        return result.stdout + result.stderr

    def test_install_and_update(self):
        result = self.install()
        self.assertEqual((result.returncode, result.stdout.strip()), (0, f'已安装质量检查 hook：{self.hook}'))
        self.assertIn('# workflow-quality-hook', self.hook.read_text(encoding='utf-8'))
        self.assertNotIn(b'\r', self.hook.read_bytes())
        if os.name != 'nt':
            self.assertTrue(os.access(self.hook, os.X_OK))
        self.assertEqual(self.install(cwd=self.here).stdout.strip(), f'已更新质量检查 hook：{self.hook}')

    def test_foreign_hook_and_hooks_path_are_left_alone(self):
        self.hook.parent.mkdir(parents=True, exist_ok=True)
        self.hook.write_text('#!/bin/sh\necho mine\n', encoding='utf-8')
        result = self.install()
        self.assertEqual(result.returncode, 2)
        self.assertIn(f'已有其他 post-commit（{self.hook}），未安装。请在其中加入下面这行：', result.stdout + result.stderr)
        self.assertIn('scripts/quality/run-hook.py" post-commit || true', result.stdout + result.stderr)
        self.assertEqual(self.hook.read_text(encoding='utf-8'), '#!/bin/sh\necho mine\n')
        self.hook.unlink()
        self.repo.git('config', 'core.hooksPath', '.githooks')
        before = (self.repo.root / '.git' / 'config').read_bytes()
        result = self.install()
        self.assertEqual(result.returncode, 2)
        self.assertIn('已配置 core.hooksPath（.githooks），未安装。', result.stdout + result.stderr)
        self.assertFalse(self.hook.exists())
        self.assertEqual((self.repo.root / '.git' / 'config').read_bytes(), before)

    def test_global_hooks_path_is_respected_without_writes(self):
        config = Path(self.repo.env['GIT_CONFIG_GLOBAL'])
        config.write_text('[core]\n\thooksPath = global-hooks\n', encoding='utf-8')
        before = config.read_bytes()
        result = self.install()
        self.assertEqual(result.returncode, 2)
        self.assertIn('已配置 core.hooksPath（global-hooks），未安装。', result.stdout + result.stderr)
        self.assertEqual(config.read_bytes(), before)
        self.assertFalse((self.repo.root / 'global-hooks').exists())

    @NEEDS_SYMLINK
    def test_symlinked_hook_is_left_alone(self):
        self.hook.parent.mkdir(parents=True, exist_ok=True)
        target = self.repo.root / 'elsewhere.sh'
        source = '#!/bin/sh\n# workflow-quality-hook\n'
        target.write_text(source, encoding='utf-8')
        os.symlink(target, self.hook)
        self.assertEqual(self.install().returncode, 2)
        self.assertEqual(self.install('--uninstall').returncode, 2)
        self.assertTrue(self.hook.is_symlink())
        self.assertEqual(target.read_text(encoding='utf-8'), source)

    def test_uninstall_removes_only_its_own_hook(self):
        self.assertEqual(self.install('--uninstall').stdout.strip(), '未安装质量检查 hook，无需卸载。')
        self.install()
        self.assertEqual(self.install('--uninstall').stdout.strip(), '已卸载质量检查 hook。')
        self.assertFalse(self.hook.exists())
        self.hook.write_text('#!/bin/sh\n', encoding='utf-8')
        result = self.install('--uninstall')
        self.assertEqual(result.returncode, 2)
        self.assertIn('post-commit 不是本扩展安装的，未改动。', result.stdout + result.stderr)
        self.assertTrue(self.hook.exists())

    def test_marker_with_foreign_commands_is_never_owned(self):
        for content in (b'#!/bin/sh\n# workflow-quality-hook\necho mine\n',
                        b'#!/bin/sh\necho mine\n# workflow-quality-hook\n'):
            for args in ((), ('--uninstall',)):
                with self.subTest(content=content, args=args):
                    self.hook.write_bytes(content)
                    self.assertEqual(self.install(*args).returncode, 2)
                    self.assertEqual(self.hook.read_bytes(), content)

    def test_modified_dispatcher_is_preserved(self):
        self.assertEqual(self.install().returncode, 0)
        content = self.hook.read_bytes() + b'git lfs post-commit\n'
        self.hook.write_bytes(content)
        for args in ((), ('--uninstall',)):
            with self.subTest(args=args):
                self.assertEqual(self.install(*args).returncode, 2)
                self.assertEqual(self.hook.read_bytes(), content)

    @NEEDS_SYMLINK
    def test_symlinked_hooks_directory_refuses_install(self):
        target = self.repo.root / '.githooks'
        target.mkdir()
        self.repo.write('.githooks/keep', 'tracked\n')
        self.repo.commit()
        shutil.rmtree(self.hook.parent)
        os.symlink(target, self.hook.parent, target_is_directory=True)
        result = self.install()
        self.assertEqual(result.returncode, 2)
        self.assertIn('hooks 目录是符号链接', result.stdout)
        self.assertIn('run-hook.py" post-commit || true', result.stdout)
        self.assertEqual([p.name for p in target.iterdir()], ['keep'])

    def test_uninstall_with_configured_hooks_path(self):
        self.assertEqual(self.install().returncode, 0)
        target = self.repo.root / '.githooks'
        target.mkdir()
        shutil.move(self.hook, target / 'post-commit')
        self.repo.git('config', 'core.hooksPath', '.githooks')
        before = (self.repo.root / '.git/config').read_bytes()
        result = self.install('--uninstall')
        self.assertEqual((result.returncode, result.stdout.strip()), (0, '已卸载质量检查 hook。'))
        self.assertFalse((target / 'post-commit').exists())
        self.assertEqual((self.repo.root / '.git/config').read_bytes(), before)

    def test_outside_repository_reports_chinese_reason(self):
        result = self.install(cwd=self.repo.root.parent)
        self.assertEqual((result.returncode, result.stdout.strip()), (2, '安装失败：不在 git 仓库中'))

    def test_scripts_outside_the_checkout_or_with_unsupported_paths_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = Path(directory)
            for name in ['install-hooks.py', 'quality_lib.py', 'quality_lexer.py']:
                shutil.copy(self.here / name, outside / name)
            result = self.repo.run(outside / 'install-hooks.py')
            self.assertEqual(result.returncode, 2)
            self.assertIn('脚本不在当前检出内，未安装。', result.stdout + result.stderr)
        spaced = self.repo.install_scripts('scripts/my quality')
        result = self.repo.run(spaced / 'install-hooks.py')
        self.assertEqual(result.returncode, 2)
        self.assertIn('脚本目录的路径只能包含字母、数字和 . _ / -，未安装。', result.stdout + result.stderr)

    def test_real_commit_reports_and_succeeds(self):
        self.install()
        self.repo.write('src/a.test.ts', '// Task 3: later\nit.skip("x", () => {})\n')
        self.repo.git('add', '-A')
        out = self.commit_output('-C', 'src', 'commit', '-q', '-m', 'probe')
        self.assertIn(HEADER, out)
        self.assertIn('src/a.test.ts:1: [tracking]', out)
        self.assertIn('src/a.test.ts:2: [skip]', out)
        self.assertEqual(self.repo.git('log', '-1', '--format=%s').stdout.strip(), 'probe')

    def test_worktrees_use_their_own_scripts(self):
        self.install()
        current = self.repo.root.parent / 'current'
        self.repo.git('worktree', 'add', '-q', '-b', 'w', str(current))
        (current / 'b.ts').write_text('// Task 3\n', encoding='utf-8')
        self.repo.git('add', '-A', cwd=current)
        self.assertIn('b.ts:1: [tracking]', self.commit_output('-C', str(current), 'commit', '-q', '-m', 'wt'))
        old = self.repo.root.parent / 'old'
        self.repo.git('worktree', 'add', '-q', '--detach', str(old), self.first)
        (old / 'c.ts').write_text('x\n', encoding='utf-8')
        self.repo.git('add', '-A', cwd=old)
        self.assertIn('质量检查未执行：当前检出缺少 scripts/quality/run-hook.py。', self.commit_output('-C', str(old), 'commit', '-q', '-m', 'old'))

    def test_rebase_replays_are_not_reported(self):
        self.install()
        self.repo.git('checkout', '-q', '-b', 'topic'); self.repo.write('t.ts', '// Task 3\n'); self.repo.commit('topic')
        self.repo.git('checkout', '-q', 'main'); self.repo.write('m.ts', 'x\n'); self.repo.commit('main')
        self.repo.git('checkout', '-q', 'topic')
        self.assertNotIn(HEADER, self.commit_output('rebase', 'main'))

    def test_interpreter_below_310_is_skipped(self):
        self.install()
        log = self.repo.root.parent / 'probe.log'
        fake = self.repo.root.parent / 'old-python'
        fake.write_bytes(f'#!/bin/sh\necho "$@" >> "{log.as_posix()}"\nexit 1\n'.encode('utf-8'))
        fake.chmod(0o755)
        self.repo.env['WORKFLOW_PYTHON'] = fake.as_posix()
        self.repo.write('a.ts', 'x\n'); self.repo.git('add', '-A')
        self.assertIn(HEADER, self.commit_output('commit', '-q', '-m', 'probe'))
        self.assertNotIn('run-hook.py', log.read_text(encoding='utf-8'))
