"""Windows 与 Git Bash 的路径和进程差异；平台由参数或 mock 注入，在任何系统上都能运行。"""
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest import mock

import hooklib
import policy

HERE = Path(__file__).resolve().parent


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), HERE / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class Platform(unittest.TestCase):
    def test_windows_path_matches_opencode(self):
        # 与 OpenCode FSUtil.windowsPath 相同的四种盘符写法。
        for value, expected in [('/c/Users/example', 'C:/Users/example'), ('/C:/x', 'C:/x'), ('/C:\\x', 'C:/x'), ('/cygdrive/d/x', 'D:/x'),
                                ('/mnt/e/x', 'E:/x'), ('/c', 'C:/'), ('/home/x', '/home/x'), ('src/a', 'src/a')]:
            with self.subTest(value=value):
                self.assertEqual(hooklib.windows_path(value, 'nt'), expected)
        self.assertEqual(hooklib.windows_path('/c/Users/example', 'posix'), '/c/Users/example')

    def test_git_bash_drive_paths_resolve_as_absolute(self):
        with mock.patch.object(hooklib.os, 'name', 'nt'):
            # 结果是本机格式：Windows 上 normpath 输出反斜杠。
            self.assertIn(os.path.normpath('C:/repo/.env'), hooklib.command_paths('cat /c/repo/.env', 'C:/work', include_readonly=True))
            self.assertIn(os.path.normpath('C:/work/src/a.ts'), hooklib.command_paths('cat src/a.ts', 'C:/work', include_readonly=True))
            self.assertIn(os.path.normpath('D:/data/vendor/x.js'), hooklib.command_paths('cd /d/data && echo x > vendor/x.js', 'C:/work'))

    def test_drive_letter_paths_are_absolute_only_on_windows(self):
        # POSIX 上 C:/x 是相对路径（目录可以叫 C:），必须挂到当前目录下检查；只有 Windows 把它当盘符绝对路径。
        self.assertTrue(hooklib.is_absolute('C:/x', 'nt'))
        self.assertFalse(hooklib.is_absolute('C:/x', 'posix'))
        self.assertTrue(hooklib.is_absolute('/x', 'posix'))
        cwd = 'C:/work' if os.name == 'nt' else '/repo/sub'
        target = os.path.normpath('C:/private.txt') if os.name == 'nt' else '/repo/sub/C:/private.txt'
        self.assertIn(target, hooklib.command_paths('cat C:/private.txt', cwd, include_readonly=True))
        written = os.path.normpath('C:/x/z') if os.name == 'nt' else '/repo/sub/C:/x/z'
        self.assertIn(written, hooklib.command_paths('cd C:/x && echo y > z', cwd))

    def test_cross_drive_path_is_still_protected(self):
        rules = json.loads((HERE / 'fixtures/protection.json').read_text(encoding='utf-8'))
        # Windows 上 relpath 跨盘符会抛 ValueError；此时按绝对路径匹配，而不是整次检查报错。
        with mock.patch.object(policy.os.path, 'relpath', side_effect=ValueError('path is on mount D:, start on mount C:')):
            self.assertIsNotNone(policy.check_path('/repo', '/elsewhere/.env', 'read', rules))
            self.assertIsNone(policy.check_path('/repo', '/elsewhere/README.md', 'read', rules))

    def test_timeout_kills_tree_with_taskkill_on_windows(self):
        scan = load('pre-secret-scan')
        calls = []

        class Proc:
            pid = 42
        scan.kill_tree(Proc(), os_name='nt', run=lambda args, **kwargs: calls.append(args))
        self.assertEqual(calls, [[hooklib.system_command('taskkill.exe'), '/PID', '42', '/T', '/F']])

    def test_programs_are_found_only_in_absolute_path_entries(self):
        # Windows 的 CreateProcess 和 shutil.which 都先查当前目录；相对 PATH 项同样指向当前目录。
        files = {'C:\\bin\\git.exe', 'git.exe', 'tools\\git.exe', 'C:\\scan\\gitleaks.cmd'}
        env = {'Path': '.;tools;C:\\bin;C:\\scan', 'PATHEXT': '.com;.exe;.bat;.cmd'}
        find = lambda name: hooklib.find_program(name, os_name='nt', env=env, exists=files.__contains__)
        self.assertEqual(find('git'), 'C:\\bin\\git.exe')
        self.assertEqual(find('gitleaks'), 'C:\\scan\\gitleaks.cmd')
        self.assertIsNone(find('missing'))
        self.assertEqual(hooklib.program('git', os_name='nt', env=env, exists=files.__contains__), 'C:\\bin\\git.exe')
        self.assertIsNone(hooklib.program('git', os_name='nt', env={}, exists=files.__contains__))
        posix = {'git', 'bin/git', '/usr/bin/git'}
        self.assertEqual(hooklib.find_program('git', os_name='posix', env={'PATH': '.:bin:/usr/bin'}, exists=posix.__contains__), '/usr/bin/git')
        self.assertEqual(hooklib.program('git', os_name='posix', env={}, exists=posix.__contains__), 'git')
        self.assertEqual(hooklib.system_command('taskkill.exe', env={'SystemRoot': 'D:\\Windows'}), 'D:\\Windows\\System32\\taskkill.exe')
        self.assertEqual(hooklib.system_command('cmd.exe', env={}), 'C:\\Windows\\System32\\cmd.exe')

    def test_install_command_uses_the_python_launcher_on_windows(self):
        scan = load('pre-secret-scan')
        self.assertEqual(scan.install_command('nt'), 'py -3 .opencode/secret-scan/install.py')
        self.assertEqual(scan.install_command('posix'), 'python3 .opencode/secret-scan/install.py')

    def test_missing_scanner_hint_mentions_service_restart(self):
        # OpenCode 后台服务的 PATH 在服务启动时确定；安装扫描器后需要重启服务。
        scan = load('pre-secret-scan')
        env = {k: v for k, v in os.environ.items() if k not in scan.GIT_ENV}
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(scan, 'find_program', return_value=None), \
                mock.patch.object(scan.Path, 'home', return_value=Path('/nonexistent-home')), self.assertRaises(scan.Blocked) as raised:
            scan.scan_commit((Path('/repo'), 'staged', False, []), scan.Runner())
        self.assertIn('install.py', str(raised.exception))
        self.assertIn('opencode service restart', str(raised.exception))


if __name__ == '__main__':
    unittest.main()
