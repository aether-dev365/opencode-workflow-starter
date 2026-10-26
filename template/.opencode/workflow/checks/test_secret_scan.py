#!/usr/bin/env python3
"""Real repositories and real Gitleaks; doubles only exercise scanner failures."""
import importlib.util
import io
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / 'pre-secret-scan.py'
SCANNER_NAME = 'gitleaks.exe' if os.name == 'nt' else 'gitleaks'
REAL_SCANNER = shutil.which('gitleaks') or str(Path.home() / '.local/bin' / SCANNER_NAME)
# 只留测试扫描器所在目录和系统目录：机器上别处安装的 gitleaks 不能顶替测试里的扫描器。
SYSTEM_PATH = [str(Path(shutil.which('git') or 'git').parent)] if os.name == 'nt' else ['/usr/bin', '/bin']
POSIX_SHELL = unittest.skipIf(os.name == 'nt', '依赖 bash 逻辑目录与目录符号链接')
# Deliberately synthetic, assembled so the test source itself contains no token.
SECRET = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'
PAYLOAD = f'access_token = "{SECRET}"\n'


class SecretScanTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not Path(REAL_SCANNER).is_file():
            raise RuntimeError('Install the pinned real scanner: python3 .opencode/secret-scan/install.py')

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='secret scan ')
        self.addCleanup(self.tmp.cleanup)
        # 用真实路径：macOS 的临时目录在符号链接 /var 下，Windows runner 的 TEMP 是 8.3 短路径（RUNNER~1）。
        self.base = Path(os.path.realpath(self.tmp.name))
        self.root = self.base / 'repo'
        self.root.mkdir()
        self.bin = self.base / 'bin'
        self.bin.mkdir()
        self.scanner = self.bin / SCANNER_NAME
        try:
            self.scanner.symlink_to(REAL_SCANNER)
        except OSError:  # Windows 未开开发者模式时没有创建符号链接的权限
            shutil.copyfile(REAL_SCANNER, self.scanner)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(('GIT_', 'GITLEAKS_'))}
        self.env.pop('CDPATH', None)
        # Windows 上 Path.home() 读 USERPROFILE，不读 HOME。
        self.env.update(HOME=str(self.base), USERPROFILE=str(self.base), PATH=os.pathsep.join([str(self.bin), *SYSTEM_PATH]),
                        GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Credential scan test')
        self.git('config', 'user.email', 'scan@example.invalid')
        self.write('tracked.txt', 'safe\n')
        self.git('add', '.')
        self.git('commit', '-qm', 'base')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.root), *args], env=self.env,
                              capture_output=True, check=True).stdout

    def write(self, path, content):
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        # 按字节写入：Windows 文本模式会把换行改成 CRLF，各平台扫描的内容就不一致了。
        file.write_bytes(content.encode())

    def stage(self, path, content):
        self.write(path, content)
        self.git('add', '--', path)

    def hook(self, command='git commit -m safe', cwd=None, phase='before', tool='shell', workdir=None):
        data = dict(version=1, phase=phase,
                    directory=str(cwd or self.root), tool=tool,
                    input={'command': command}, paths=[], sessionId='test-session', callId='test-call')
        if workdir is not None:
            data['input']['workdir'] = str(workdir)
        return subprocess.run([sys.executable, str(SCRIPT)], input=json.dumps(data), encoding="utf-8",
                              env=self.env, cwd=self.root, capture_output=True, timeout=12)

    def assert_blocked(self, result, reason=None):
        self.assertEqual(result.returncode, 2, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response['decision'], 'deny')
        self.assertIsInstance(response['reminders'], list)
        self.assertTrue(response['reason'])
        self.assertTrue(result.stderr.strip())
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        if reason:
            self.assertIn(reason, result.stderr)

    def assert_allowed(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['decision'], 'allow')
        self.assertEqual(result.stderr, '')

    def test_real_scanner_positive_and_negative_on_staged_content(self):
        self.stage('settings.conf', PAYLOAD)
        self.assert_blocked(self.hook(), 'settings.conf')
        self.stage('settings.conf', 'access_token = "${ACCESS_TOKEN}"\n')
        self.assert_allowed(self.hook())

    def test_staged_type_change_keeps_scanning_and_locations(self):
        # 文件换成符号链接时补丁拆成删除和新增两段；直接改索引条目，不依赖创建符号链接的权限。
        (self.base / 'link-target').write_bytes(b'tracked-target')
        blob = self.git('hash-object', '-w', str(self.base / 'link-target')).decode().strip()
        self.git('update-index', '--cacheinfo', f'120000,{blob},tracked.txt')
        self.stage('z-settings.conf', PAYLOAD)
        result = self.hook()
        self.assert_blocked(result, '"z-settings.conf":1')
        self.assertNotIn('tracked.txt', result.stderr)
        self.stage('z-settings.conf', 'access_token = "${ACCESS_TOKEN}"\n')
        self.assert_allowed(self.hook())

    def test_fake_heredocs_do_not_hide_commits(self):
        self.stage('settings.conf', PAYLOAD)
        for header in ["cat '<<EOF'", 'cat "<<EOF"', r'cat \<\<EOF', 'cat # <<EOF']:
            with self.subTest(header=header):
                self.assert_blocked(self.hook(f'{header}\ngit commit -m x\nEOF'))
        for command in ['cat $((1 <<EOF))\ngit commit -m x\nEOF',
                        'cat <<EO"F"\nEOF\ngit commit -m x\nEO']:
            with self.subTest(command=command):
                self.assert_blocked(self.hook(command))

    def test_wrapped_commits_are_detected_and_fail_closed(self):
        self.stage('settings.conf', PAYLOAD)
        for command in [
            'sudo git commit -m x', 'sudo -u example git commit -m x',
            'sudo -n git commit -m x', 'xargs -o git commit -m x',
            'xargs -i git commit -m x', 'xargs --replace git commit -m x',
            'sudo --user=example /usr/bin/git commit -m x',
            'nohup git commit -m x', 'xargs git commit -m x',
            'xargs -I% -n 1 git commit -m x', 'xargs --arg-file list git commit -m x',
            'sudo env MODE=test nohup git commit -m x', 'setsid git commit -m x',
            'doas -u example git commit -m x', 'stdbuf -o L git commit -m x',
        ]:
            with self.subTest(command=command):
                self.assert_blocked(self.hook(command))
        for command in ["printf '%s' 'sudo git commit'", "xargs printf '%s' 'git commit'",
                        'xargs echo git commit', 'nohup echo git commit']:
            with self.subTest(command=command):
                self.assert_allowed(self.hook(command))

    def test_unknown_command_heads_and_leading_redirects_fail_closed(self):
        self.stage('settings.conf', PAYLOAD)
        for command in ['flock lock git commit -m x', 'unreviewed-runner git commit -m x',
                        '>out git commit -m x', '>out nohup git commit -m x',
                        'MODE=test 2>out git commit -m x']:
            with self.subTest(command=command):
                self.assert_blocked(self.hook(command))

    def test_staged_secret_is_blocked_after_worktree_cleaning(self):
        self.stage('settings.conf', PAYLOAD)
        self.write('settings.conf', 'clean\n')
        self.assert_blocked(self.hook(), 'settings.conf')

    def test_unstaged_secret_does_not_change_plain_commit_scope(self):
        self.write('tracked.txt', PAYLOAD)
        self.stage('safe.txt', 'safe\n')
        self.assert_allowed(self.hook())

    def test_all_scans_tracked_worktree_and_preserves_real_index(self):
        before = (self.root / '.git/index').read_bytes()
        self.write('tracked.txt', PAYLOAD)
        self.assert_allowed(self.hook())
        for flags in ['-am safe', '--all -m safe', '-a -m safe']:
            self.assert_blocked(self.hook('git commit ' + flags), 'tracked.txt')
        self.assertEqual(before, (self.root / '.git/index').read_bytes())

    def test_all_overwrites_staged_content_like_actual_commit(self):
        self.stage('tracked.txt', PAYLOAD)
        self.write('tracked.txt', 'clean\n')
        self.assert_blocked(self.hook())
        self.assert_allowed(self.hook('git commit -am safe'))

    def test_git_c_and_cd_find_target_repository(self):
        self.stage('settings.conf', PAYLOAD)
        for command in [f'git -C {shlex.quote(str(self.root))} commit -m safe',
                        f'cd {shlex.quote(str(self.root))} && git commit -m safe']:
            self.assert_blocked(self.hook(command, cwd=self.base), 'settings.conf')

    def test_workdir_selects_actual_repository_not_location(self):
        clean = self.base / 'clean'
        clean.mkdir()
        subprocess.run(['git', 'init', '-q', str(clean)], env=self.env, check=True)
        self.stage('settings.conf', PAYLOAD)
        self.assert_allowed(self.hook(cwd=clean))
        for workdir in [self.root, '../repo']:
            with self.subTest(workdir=workdir):
                self.assert_blocked(self.hook(cwd=clean, workdir=workdir), 'settings.conf')

    @POSIX_SHELL
    def test_cd_symlink_logical_parent_cannot_scan_a_different_repository(self):
        clean = self.base / 'clean'
        (clean / 'sub').mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(clean)], env=self.env, check=True)
        link = self.root / 'link'
        link.symlink_to(clean / 'sub', target_is_directory=True)
        self.stage('settings.conf', PAYLOAD)
        self.assert_allowed(self.hook(cwd=clean))
        self.assert_blocked(self.hook(), 'settings.conf')
        for prefix in ['cd link && cd ..', 'cd link/..',
                       f'cd {shlex.quote(str(link))} && cd ..']:
            with self.subTest(prefix=prefix):
                actual = subprocess.run(['bash', '--noprofile', '--norc', '-c', prefix + ' && pwd -P'],
                                        cwd=self.root, env=self.env, capture_output=True, text=True, check=True)
                self.assertEqual(actual.stdout.strip(), str(self.root))
                self.assert_blocked(self.hook(prefix + ' && git commit -m safe'), '符号链接')

    @POSIX_SHELL
    def test_initial_logical_cwd_alias_is_rejected_before_cd_parent(self):
        clean = self.base / 'clean'
        (clean / 'sub').mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(clean)], env=self.env, check=True)
        link = self.root / 'link'
        link.symlink_to(clean / 'sub', target_is_directory=True)
        self.stage('settings.conf', PAYLOAD)
        self.env['PWD'] = str(link)
        actual = subprocess.run(['bash', '--noprofile', '--norc', '-c', 'cd .. && pwd -P'],
                                cwd=link, env=self.env, capture_output=True, text=True, check=True)
        self.assertEqual(actual.stdout.strip(), str(self.root))
        for cwd in [link, clean / 'sub']:
            with self.subTest(cwd=cwd):
                self.assert_blocked(self.hook('cd .. && git commit -m safe', cwd=cwd), '符号链接')
        self.assert_allowed(self.hook('git status --short', cwd=link))
        # Both documented escape routes use a real absolute target, so an
        # ambiguous initial PWD must not trap a normal retry in a reject loop.
        self.assert_allowed(self.hook(f'git -C {shlex.quote(str(clean))} commit -m safe', cwd=link))
        self.assert_allowed(self.hook(f'cd {shlex.quote(str(clean))} && git commit -m safe', cwd=link))

    def test_cd_real_directories_with_parent_components_still_scans_correct_repo(self):
        (self.root / 'sub').mkdir()
        self.assert_allowed(self.hook('cd sub && cd .. && git commit -m safe'))
        self.stage('settings.conf', PAYLOAD)
        self.assert_blocked(self.hook('cd sub && cd .. && git commit -m safe'), 'settings.conf')

    @POSIX_SHELL
    def test_inherited_cdpath_cannot_redirect_relative_cd_to_another_repository(self):
        clean = self.base / 'clean'
        (clean / 'repo').mkdir(parents=True)
        subprocess.run(['git', 'init', '-q', str(clean)], env=self.env, check=True)
        self.stage('settings.conf', PAYLOAD)
        self.env['CDPATH'] = str(self.base)
        actual = subprocess.run(['bash', '--noprofile', '--norc', '-c', 'cd repo && pwd -P'],
                                cwd=clean, env=self.env, capture_output=True, text=True, check=True)
        self.assertEqual(actual.stdout.splitlines()[-1], str(self.root))
        self.assert_blocked(self.hook('cd repo && git commit -m safe', cwd=clean), 'CDPATH')
        self.assert_allowed(self.hook(f'cd {shlex.quote(str(clean))} && git commit -m safe'))

    def test_commit_paths_ignore_unrelated_staged_and_use_worktree(self):
        self.stage('unrelated.conf', PAYLOAD)
        self.write('tracked.txt', 'clean edit\n')
        self.assert_allowed(self.hook('git commit -m safe -- tracked.txt'))
        self.write('tracked.txt', PAYLOAD)
        self.assert_blocked(self.hook('git commit -m safe -- tracked.txt'), 'tracked.txt')

    def test_only_and_include_paths_have_different_scope(self):
        self.stage('unrelated.conf', PAYLOAD)
        self.write('tracked.txt', 'clean edit\n')
        self.assert_allowed(self.hook('git commit --only -m safe tracked.txt'))
        self.assert_blocked(self.hook('git commit --include -m safe tracked.txt'), 'unrelated.conf')

    def test_paths_from_subdirectory_and_literal_spaces(self):
        self.stage('sub/a b.conf', 'safe\n')
        self.git('commit', '-qm', 'add tracked path')
        self.write('sub/a b.conf', PAYLOAD)
        self.assert_blocked(self.hook('cd sub && git commit -m safe -- "a b.conf"'), 'sub/a b.conf')

    def test_path_selection_handles_staged_deletion_and_worktree_recreation(self):
        self.git('rm', '-q', 'tracked.txt')
        self.assert_allowed(self.hook('git commit -m safe -- tracked.txt'))
        self.write('tracked.txt', PAYLOAD)
        self.assert_blocked(self.hook('git commit -m safe -- tracked.txt'), 'tracked.txt')

    def test_old_findings_unchanged_and_removed_do_not_block(self):
        self.stage('legacy.conf', PAYLOAD)
        self.git('commit', '-qm', 'legacy fixture')
        self.stage('legacy.conf', PAYLOAD + 'safe new setting\n')
        self.assert_allowed(self.hook())
        self.stage('legacy.conf', 'safe replacement\n')
        self.assert_allowed(self.hook())

    def test_amend_scans_replacement_commit_increment(self):
        self.stage('new.conf', PAYLOAD)
        self.git('commit', '-qm', 'fixture to amend')
        self.assert_allowed(self.hook())
        self.assert_blocked(self.hook('git commit --amend --no-edit'), 'new.conf')
        self.stage('new.conf', 'clean\n')
        self.assert_allowed(self.hook('git commit --amend --no-edit'))

    def test_initial_commit_scans_staged_content(self):
        self.git('checkout', '--orphan', 'new-root')
        self.stage('new.conf', PAYLOAD)
        self.assert_blocked(self.hook(), 'new.conf')

    def large_snapshot(self, tail='safe\n'):
        base = self.git('rev-parse', 'HEAD').decode().strip()
        line = 'safe ' + 'x' * 4089 + '\n'
        self.stage('a.txt', line * 2304)
        self.stage('b.png', '\0' + line * 2304)
        self.stage('z-last.conf', tail)
        tree = self.git('write-tree').decode().strip()
        spec = importlib.util.spec_from_file_location('secret_snapshot_hook', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module, (base, tree)

    def test_snapshot_scans_get_a_longer_budget_than_commits(self):
        # 审核快照最多 128 MB，由用户手动触发；提交扫描保持 8 秒，快照扫描单独计时。
        self.stage('notes.txt', 'safe\n')
        base = self.git('rev-parse', 'HEAD').decode().strip()
        tree = self.git('write-tree').decode().strip()
        spec = importlib.util.spec_from_file_location('secret_budget_hook', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with patch.dict(os.environ, self.env, clear=True), patch.object(module, 'TOTAL_TIMEOUT', 0.001):
            with self.assertRaises(module.Blocked) as raised:
                module.scan_commit((self.root, 'staged', False, []), module.Runner())
            self.assertIn('超时', str(raised.exception))
            module.scan_snapshot(str(self.root), base, tree)

    def test_large_snapshot_scans_all_files_without_changing_real_index(self):
        module, snapshot = self.large_snapshot()
        before = (self.root / '.git/index').read_bytes()
        with patch.dict(os.environ, self.env, clear=True):
            module.scan_snapshot(str(self.root), *snapshot)
        self.assertEqual(before, (self.root / '.git/index').read_bytes())

    def test_large_snapshot_reports_secret_after_first_chunk_with_original_location(self):
        module, snapshot = self.large_snapshot(PAYLOAD)
        self.write('z-last.conf', 'clean worktree\n')
        with patch.dict(os.environ, self.env, clear=True), self.assertRaises(module.Blocked) as raised:
            module.scan_snapshot(str(self.root), *snapshot)
        self.assertIn('z-last.conf', str(raised.exception))
        self.assertIn(':1', str(raised.exception))
        self.assertNotIn(SECRET, str(raised.exception))

    def test_large_snapshot_scanner_failure_after_first_chunk_still_blocks(self):
        module, snapshot = self.large_snapshot()
        marker = self.base / 'scanner-count'
        self.fake_scanner('from pathlib import Path\n'
                          f'p=Path({str(marker)!r})\n'
                          'n=int(p.read_text())+1 if p.exists() else 1\n'
                          'p.write_text(str(n))\n'
                          'Path(sys.argv[sys.argv.index("--report-path")+1]).write_text("[]")\n'
                          'sys.stdin.buffer.read()\n'
                          'sys.exit(7 if n == 2 else 0)\n')
        with patch.dict(os.environ, self.env, clear=True), self.assertRaises(module.Blocked) as raised:
            module.scan_snapshot(str(self.root), *snapshot)
        self.assertIn('Git/Gitleaks 扫描失败', str(raised.exception))
        self.assertEqual('2', marker.read_text())

    def test_large_ordinary_commit_keeps_its_existing_size_limit(self):
        self.large_snapshot()
        self.assert_blocked(self.hook(), '扫描大小上限')

    def test_large_snapshot_binary_file_secret_is_not_skipped(self):
        module, snapshot = self.large_snapshot()
        with (self.root / 'b.png').open('a') as stream:
            stream.write(PAYLOAD)
        self.git('add', 'b.png')
        snapshot = (snapshot[0], self.git('write-tree').decode().strip())
        with patch.dict(os.environ, self.env, clear=True), self.assertRaises(module.Blocked) as raised:
            module.scan_snapshot(str(self.root), *snapshot)
        self.assertIn('b.png', str(raised.exception))
        self.assertIn(':2305', str(raised.exception))
        self.assertNotIn(SECRET, str(raised.exception))

    def test_later_chunk_without_report_cannot_reuse_previous_clean_report(self):
        module, snapshot = self.large_snapshot()
        marker = self.base / 'scanner-count'
        self.fake_scanner('from pathlib import Path\n'
                          f'p=Path({str(marker)!r})\n'
                          'n=int(p.read_text())+1 if p.exists() else 1\n'
                          'p.write_text(str(n))\n'
                          'if n == 1:\n'
                          ' Path(sys.argv[sys.argv.index("--report-path")+1]).write_text("[]")\n'
                          'sys.stdin.buffer.read()\n')
        with patch.dict(os.environ, self.env, clear=True), self.assertRaises(module.Blocked) as raised:
            module.scan_snapshot(str(self.root), *snapshot)
        self.assertIn('有效报告', str(raised.exception))
        self.assertEqual('2', marker.read_text())

    def test_snapshot_does_not_split_an_oversized_file(self):
        module, snapshot = self.large_snapshot()
        self.stage('a.txt', ('safe ' + 'x' * 4089 + '\n') * 4608)
        snapshot = (snapshot[0], self.git('write-tree').decode().strip())
        with patch.dict(os.environ, self.env, clear=True), self.assertRaises(module.Blocked) as raised:
            module.scan_snapshot(str(self.root), *snapshot)
        self.assertIn('单文件差异', str(raised.exception))

    def test_snapshot_keeps_a_total_size_bound(self):
        module, snapshot = self.large_snapshot()
        with patch.dict(os.environ, self.env, clear=True), \
                patch.object(module, 'SNAPSHOT_DIFF_LIMIT', 17 * 1024 * 1024), \
                self.assertRaises(module.Blocked) as raised:
            module.scan_snapshot(str(self.root), *snapshot)
        self.assertIn('扫描大小上限', str(raised.exception))

    def test_binary_attribute_and_ignored_directory_do_not_bypass_content_scan(self):
        for path in ['test/fixture.conf', 'vendor/github.com/demo/key.conf', 'binary.conf']:
            with self.subTest(path=path):
                self.stage('.gitattributes', '*.conf binary\n')
                self.stage(path, PAYLOAD)
                self.assert_blocked(self.hook(), path)
                self.git('reset', '--hard', '-q')

    def test_inline_allow_comment_and_repo_config_do_not_disable_scanning(self):
        self.stage('settings.conf', PAYLOAD.strip() + ' # gitleaks:allow\n')
        self.write('.gitleaks.toml', '[allowlist]\nregexes = [".*"]\n')
        self.env['GITLEAKS_CONFIG'] = str(self.root / '.gitleaks.toml')
        self.assert_blocked(self.hook(), 'settings.conf')

    def test_compound_commit_is_blocked_before_later_staging(self):
        self.write('tracked.txt', PAYLOAD)
        self.assert_allowed(self.hook('git add tracked.txt'))
        for command in ['git add tracked.txt && git commit -m safe',
                        'git add tracked.txt; git commit -m safe',
                        'git commit -am safe && git status',
                        'git commit -m safe | cat',
                        'env X=1 git commit -m safe',
                        'git -c core.hooksPath=/tmp commit -m safe',
                        'git commit --patch -m safe',
                        'bash -c "git commit -m safe"']:
            with self.subTest(command=command):
                self.assert_blocked(self.hook(command), '独立')

    def test_non_commit_commands_are_unaffected_without_scanner(self):
        self.scanner.unlink()
        for command in ['git status', 'git add tracked.txt', 'git log -1',
                        'git log --grep commit', 'git -C . log --grep commit',
                        'git -c example.value=commit status',
                        'echo "git commit -m example"',
                        "cat <<'EOF'\ngit commit -m example\nEOF"]:
            with self.subTest(command=command):
                self.assert_allowed(self.hook(command))
        self.assert_allowed(self.hook(phase='after'))
        self.assert_allowed(self.hook(tool='patch'))

    def test_unsupported_wrappers_do_not_hide_commit(self):
        for command in ['env -u NOTHING git commit -m safe',
                        'timeout 5 git commit -m safe',
                        'command -- git commit -m safe',
                        'nice -n 5 git commit -m safe']:
            with self.subTest(command=command):
                self.assert_blocked(self.hook(command), '独立')

    def test_bad_scanner_report_cannot_allow_a_commit(self):
        self.stage('safe.txt', 'safe\n')
        self.assert_allowed(self.hook())
        marker = self.base / 'scanner-ran'
        self.fake_scanner('from pathlib import Path\n'
                          f'Path({str(marker)!r}).touch()\n'
                          'Path(sys.argv[sys.argv.index("--report-path")+1]).write_text("not-json")\n')
        self.assert_blocked(self.hook(), '失败')
        self.assertTrue(marker.exists(), 'Must reach the invalid-report scanner branch')

    def test_path_selection_preserves_real_index_and_worktree(self):
        self.stage('unrelated.conf', PAYLOAD)
        self.write('tracked.txt', 'clean edit\n')
        before = (self.root / '.git/index').read_bytes()
        self.assert_allowed(self.hook('git commit --only -m safe tracked.txt'))
        self.assertEqual(before, (self.root / '.git/index').read_bytes())
        self.assertEqual(PAYLOAD, (self.root / 'unrelated.conf').read_text())
        self.assertEqual('clean edit\n', (self.root / 'tracked.txt').read_text())

    def test_all_and_paths_never_persist_prospective_blobs_in_real_objects(self):
        before = {path.relative_to(self.root / '.git/objects')
                  for path in (self.root / '.git/objects').rglob('*') if path.is_file()}
        for flags in ['-am safe', '-m safe -- tracked.txt']:
            for content, blocked in [(PAYLOAD, True), ('new clean worktree content\n', False)]:
                with self.subTest(flags=flags, blocked=blocked):
                    self.write('tracked.txt', content)
                    result = self.hook('git commit ' + flags)
                    self.assert_blocked(result, 'tracked.txt') if blocked else self.assert_allowed(result)
                    after = {path.relative_to(self.root / '.git/objects')
                             for path in (self.root / '.git/objects').rglob('*') if path.is_file()}
                    self.assertEqual(before, after)

    def test_linked_worktree_scans_its_own_index(self):
        checkout = self.base / 'other checkout'
        self.git('worktree', 'add', '-qb', 'other', str(checkout))
        self.stage('main.conf', PAYLOAD)
        self.assert_allowed(self.hook(cwd=checkout))
        (checkout / 'other.conf').write_text(PAYLOAD)
        subprocess.run(['git', '-C', str(checkout), 'add', 'other.conf'],
                       env=self.env, capture_output=True, check=True)
        self.assert_blocked(self.hook(cwd=checkout), 'other.conf')

    def test_install_refuses_to_overwrite_existing_different_binary(self):
        existing = self.scanner
        existing.unlink()
        existing.write_text('foreign binary\n')
        installer = HERE.parents[1] / 'secret-scan/install.py'
        result = subprocess.run([sys.executable, str(installer), '--bin-dir', str(self.bin)],
                                capture_output=True, encoding='utf-8', env=self.env, timeout=5)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('覆盖', result.stderr)
        self.assertEqual('foreign binary\n', existing.read_text())

    def test_quoted_commit_message_heredoc_is_not_shell_code(self):
        self.stage('safe.txt', 'safe\n')
        self.assert_allowed(self.hook("git commit -F - <<'EOF'\nmention git add && git commit\nEOF"))
        self.stage('settings.conf', PAYLOAD)
        self.assert_blocked(self.hook("git commit -F - <<'EOF'\nsafe message\nEOF"))

    def test_programs_planted_in_the_project_are_not_run(self):
        # Windows 的 CreateProcess 先在当前目录查找 git、gitleaks：用 hostname.exe 的副本冒充，它只输出主机名。
        # 其他平台不查当前目录，这里不做任何事。
        if os.name != 'nt':
            return
        hostname = Path(os.environ.get('SystemRoot', 'C:\\Windows')) / 'System32' / 'hostname.exe'
        for name in ('git.exe', 'gitleaks.exe'):
            shutil.copyfile(hostname, self.root / name)
        self.stage('safe.txt', 'safe\n')
        self.assert_allowed(self.hook())
        self.stage('settings.conf', PAYLOAD)
        self.assert_blocked(self.hook(), 'settings.conf')

    def test_missing_scanner_blocks_even_clean_commit(self):
        self.scanner.unlink()
        self.assert_blocked(self.hook(), 'install.py')

    def fake_scanner(self, code, version='8.30.1'):
        self.scanner.unlink()
        body = f'import sys,time\nif sys.argv[1:] == ["version"]:\n print("{version}")\n sys.exit(0)\n' + code
        if os.name == 'nt':
            # Windows 不认 shebang：用 .cmd 包装，shutil.which 按 PATHEXT 找到它。
            script = self.bin / 'fake-scanner.py'
            script.write_text(body)
            (self.bin / 'gitleaks.cmd').write_text(f'@"{sys.executable}" "{script}" %*\n')
        else:
            self.scanner.write_text('#!/usr/bin/python3\n' + body)
            self.scanner.chmod(0o755)

    def test_scanner_failure_is_closed_and_its_output_is_not_disclosed(self):
        self.stage('safe.txt', 'safe\n')
        self.assert_allowed(self.hook())
        marker = self.base / 'scanner-ran'
        self.fake_scanner('from pathlib import Path\n'
                          f'Path({str(marker)!r}).touch()\n'
                          'Path(sys.argv[sys.argv.index("--report-path")+1]).write_text("[]")\n'
                          f'print({SECRET!r}, file=sys.stderr)\nsys.exit(7)\n')
        self.assert_blocked(self.hook(), 'Git/Gitleaks 扫描失败')
        self.assertTrue(marker.exists(), 'Must reach the failing scanner branch')

    def test_scanner_wrong_version_blocks(self):
        self.fake_scanner('', version='0.0.0')
        self.assert_blocked(self.hook(), '版本')

    def test_scanner_timeout_is_closed_without_waiting_full_hook_budget(self):
        self.stage('safe.txt', 'safe\n')
        child_pid = self.base / 'child-pid'
        self.fake_scanner('import subprocess\nfrom pathlib import Path\n'
                          'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"])\n'
                          f'Path({str(child_pid)!r}).write_text(str(child.pid))\n'
                          'time.sleep(10)\n')
        spec = importlib.util.spec_from_file_location('secret_hook', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        data = dict(version=1, phase='before', directory=str(self.root), tool='shell',
                    input={'command': 'git commit -m safe'}, paths=[], sessionId='test-session', callId='test-call')
        err = io.StringIO()
        out = io.StringIO()
        # 预算要够走到扫描那一步（Windows 经 .cmd 包装、macOS runner 启动进程都慢）；仍远小于扫描器的 10 秒睡眠。
        budget = 3 if os.name == 'nt' else 2
        started = time.monotonic()
        with patch.dict(os.environ, self.env, clear=True), patch.object(module, 'TOTAL_TIMEOUT', budget), \
                patch.object(sys, 'stdin', io.StringIO(json.dumps(data))), redirect_stderr(err), redirect_stdout(out):
            self.assertEqual(module.main(), 2)
        self.assertEqual(json.loads(out.getvalue())['decision'], 'deny')
        self.assertIn('超时', err.getvalue())
        self.assertLess(time.monotonic() - started, budget + 1.7, 'timeout must kill/reap instead of waiting for scanner exit')
        self.assertTrue(child_pid.exists(), 'the scanner must actually reach its sleeping child')
        status = Path('/proc') / child_pid.read_text() / 'stat'
        if status.exists():
            self.assertEqual(status.read_text().split()[2], 'Z', 'scanner child must not remain running')
        if os.name == 'nt':
            listed = subprocess.run(['tasklist', '/fi', f'PID eq {child_pid.read_text()}', '/fo', 'csv', '/nh'],
                                    capture_output=True, text=True).stdout
            self.assertNotIn(f'"{child_pid.read_text()}"', listed, 'scanner child must not remain running')


if __name__ == '__main__':
    unittest.main()
