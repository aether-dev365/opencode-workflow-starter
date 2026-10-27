"""Windows 与 Git Bash 的路径和进程差异；平台由参数或 mock 注入，在任何系统上都能运行。"""
import errno
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

    def test_tool_paths_match_opencode_file_access(self):
        # 与 OpenCode FileAccess.resolve 相同（插件 platform.ts 的 toolPath 用同一组例子）：盘符写法、`~` 与 `~/`、字面合并 `..`。
        with mock.patch.dict(os.environ, {'OPENCODE_TEST_HOME': 'C:/Users/example'}):
            for value, expected in [('~/x', 'C:\\Users\\example\\x'), ('~', 'C:\\Users\\example'), ('~\\x', 'C:\\repo\\~\\x'),
                                    ('/d/data/../x', 'D:\\x'), ('src/missing/..', 'C:\\repo\\src'), ('', 'C:\\repo')]:
                with self.subTest(value=value, os_name='nt'):
                    self.assertEqual(hooklib.tool_path('C:\\repo', value, 'nt'), expected)
        with mock.patch.dict(os.environ, {'OPENCODE_TEST_HOME': '/home/example'}):
            for value, expected in [('~/x', '/home/example/x'), ('~', '/home/example'), ('~user/x', '/repo/~user/x'),
                                    ('/c/x', '/c/x'), ('src/missing/..', '/repo/src'), ('', '/repo')]:
                with self.subTest(value=value, os_name='posix'):
                    self.assertEqual(hooklib.tool_path('/repo', value, 'posix'), expected)

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

    def test_overlong_names_count_as_missing_only_when_no_file_can_have_them(self):
        # 整条路径短于上限时名字过长只能来自某一段，或某段超过 255 个 UTF-16 码元；整条路径超长而每段正常时可能真实存在。
        def too_long(path, code=errno.ENAMETOOLONG):
            return OSError(code, 'File name too long', path)
        deep = '/repo' + ('/' + 'a' * 200) * 30
        wide = '/repo/' + '说' * 200 + '/' + '明' * 200
        windows = 'C:\\repo' + ('\\' + 'a' * 200) * 30
        for platform, path, missing in [
                ('linux', '/repo/' + 'x' * 300 + '/.git', True), ('linux', '/repo/' + '提交说明' * 25, True),
                ('linux', deep, False), ('linux', deep + '/' + 'x' * 256, True), ('linux', wide, True), ('darwin', wide, False),
                ('win32', windows, True), ('win32', windows * 6, False), ('win32', windows * 6 + '\\' + 'x' * 256, True),
                ('freebsd14', '/repo/' + 'x' * 300, True), ('freebsd14', '/repo/x', False)]:
            with self.subTest(platform=platform, length=len(path)):
                self.assertEqual(hooklib.missing_long_name(too_long(path), platform), missing)
        self.assertFalse(hooklib.missing_long_name(too_long('/repo/' + 'x' * 300, errno.EACCES), 'linux'))
        self.assertFalse(hooklib.missing_long_name(OSError(errno.ENAMETOOLONG, 'File name too long'), 'linux'))

    def test_path_queries_treat_only_missing_paths_as_absent_on_every_python(self):
        # Python 3.14 的 Path.exists 把所有 OSError 当作不存在；守卫自己判断，其余错误照常抛出、按出错拒绝。
        def windows(code):
            error = OSError(errno.EINVAL, 'Windows error', '/repo/a')
            error.winerror = code
            return error
        absent = [FileNotFoundError(errno.ENOENT, 'missing', '/repo/a'), OSError(errno.ENOTDIR, 'not a directory', '/repo/a'),
                  OSError(errno.ELOOP, 'loop', '/repo/a'), windows(21), windows(123), windows(1920), windows(1921), ValueError('embedded null byte')]
        for error in absent:
            with self.subTest(error=repr(error)), mock.patch.object(hooklib.os, 'stat', side_effect=error):
                self.assertFalse(hooklib.path_exists('/repo/a'))
                self.assertFalse(hooklib.path_is_dir('/repo/a'))
        for error in [PermissionError(errno.EACCES, 'denied', '/repo/a'), OSError(errno.EIO, 'I/O error', '/repo/a'), windows(5)]:
            with self.subTest(error=repr(error)), mock.patch.object(hooklib.os, 'stat', side_effect=error):
                self.assertRaises(OSError, hooklib.path_exists, '/repo/a')
                self.assertRaises(OSError, hooklib.path_is_dir, '/repo/a')
                self.assertRaises(OSError, policy.policy_root, '/repo/a')

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
        # 启动 Git 只认 .com/.exe：经 cmd.exe 执行时，代理可控的参数会被 cmd 解释。
        wrapped = files | {'C:\\scripts\\git.cmd'}
        self.assertEqual(hooklib.program('git', os_name='nt', env={**env, 'Path': 'C:\\scripts;C:\\bin'}, exists=wrapped.__contains__), 'C:\\bin\\git.exe')
        # 带引号的 PATH 项按其中的目录查找，与系统一致。
        self.assertEqual(find_quoted := hooklib.find_program('git', os_name='nt', env={'Path': '"C:\\bin"', 'PATHEXT': '.exe'}, exists=files.__contains__), 'C:\\bin\\git.exe', find_quoted)
        # macOS 和 Linux 的 PATH 空项同样指向当前目录；没有 PATH 时与 shutil.which 一样用默认路径。
        posix = {'git', 'bin/git', '/usr/bin/git', '/bin/git'}
        self.assertEqual(hooklib.find_program('git', os_name='posix', env={'PATH': '.:bin:/usr/bin'}, exists=posix.__contains__), '/usr/bin/git')
        self.assertEqual(hooklib.program('git', os_name='posix', env={'PATH': ':/usr/bin'}, exists=posix.__contains__), '/usr/bin/git')
        self.assertIsNone(hooklib.program('git', os_name='posix', env={'PATH': '::.'}, exists=posix.__contains__))
        self.assertIn(hooklib.find_program('git', os_name='posix', env={}, exists=posix.__contains__), {'/bin/git', '/usr/bin/git'})
        self.assertEqual(hooklib.system_command('taskkill.exe', env={'SystemRoot': 'D:\\Windows'}), 'D:\\Windows\\System32\\taskkill.exe')
        self.assertEqual(hooklib.system_command('taskkill.exe', env={'windir': 'E:\\WINNT'}), 'E:\\WINNT\\System32\\taskkill.exe')
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
