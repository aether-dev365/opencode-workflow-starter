"""Windows 与 Git Bash 的路径和进程差异；平台由参数或 mock 注入，在任何系统上都能运行。"""
import errno
import importlib.util
import io
import json
import ntpath
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
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
    def test_link_queries_distinguish_missing_files_and_reparse_points(self):
        for info, expected in [(SimpleNamespace(st_mode=stat.S_IFREG), False),
                               (SimpleNamespace(st_mode=stat.S_IFLNK), True),
                               (SimpleNamespace(st_mode=stat.S_IFDIR, st_reparse_tag=0xA0000003), True),
                               (SimpleNamespace(st_mode=stat.S_IFREG, st_reparse_tag=0x8000001B), False)]:
            with self.subTest(info=info), mock.patch('os.lstat', return_value=info):
                self.assertEqual(hooklib.path_is_link('C:/repo/entry', 'nt'), expected)
        for code in [errno.ENOENT, errno.ENOTDIR, errno.ENAMETOOLONG]:
            with self.subTest(code=code), mock.patch('os.lstat', side_effect=OSError(code, 'missing', 'x' * 300)):
                self.assertFalse(hooklib.path_is_link('x' * 300))

    def test_symlink_mappings_match_windows_short_parent_names(self):
        def realpath(path):
            return ntpath.normpath(path).replace('EXAMPL~1', 'example-directory')
        for source_root in [r'C:\workspace\EXAMPL~1\repo', r'C:\workspace\example-directory\repo']:
            for access_root in [r'C:\workspace\EXAMPL~1\repo', r'C:\workspace\example-directory\repo']:
                with self.subTest(source=source_root, access=access_root), mock.patch('ntpath.realpath', realpath), \
                        mock.patch('os.lstat', return_value=SimpleNamespace(st_mode=stat.S_IFDIR)):
                    self.assertEqual(hooklib._linked_paths([access_root + r'\alias\locked.txt'],
                                     [(source_root + r'\alias', r'C:\records')], os_name='nt'),
                                     [r'C:\records\locked.txt'])
                    with self.assertRaises(ValueError):
                        hooklib._linked_paths([], [(source_root + r'\alias', r'C:\records'),
                                              (r'C:\second', access_root + r'\alias\nested')], os_name='nt')

    def test_symlink_pairs_resolve_injected_windows_paths(self):
        directories = {r'c:\repo\links', r'\\server\share\links'}
        def query(path):
            if ntpath.normcase(ntpath.normpath(path)) in directories:
                return SimpleNamespace(st_mode=stat.S_IFDIR)
            raise FileNotFoundError(errno.ENOENT, 'missing', path)
        cases = [(['ln', '-s', '../records', 'links/alias'],
                  (r'C:\repo\links\alias', r'C:\repo\links\../records')),
                 (['ln', '-s', '/d/data', '/c/repo/links/alias'],
                  (r'C:/repo/links/alias', 'D:/data')),
                 (['ln', '-s', 'D:/data', 'C:/repo/links/alias'],
                  ('C:/repo/links/alias', 'D:/data')),
                 (['ln', '-s', '../records', '//server/share/links/alias'],
                  ('//server/share/links/alias', r'\\server\share\links\../records'))]
        with mock.patch('os.stat', query), mock.patch('ntpath.realpath', ntpath.normpath):
            for words, expected in cases:
                with self.subTest(words=words):
                    pairs = hooklib._symlink_pairs(words, r'C:\repo', os_name='nt')
                    self.assertEqual([(ntpath.normpath(a), ntpath.normpath(b)) for a, b in pairs],
                                     [(ntpath.normpath(expected[0]), ntpath.normpath(expected[1]))])

    def test_existing_windows_link_short_names_cannot_hide_replacements(self):
        for mode, tag in [(stat.S_IFLNK, 0), (stat.S_IFDIR, 0xA0000003)]:
            def query(path):
                linked = ntpath.normcase(path) in {r'c:\repo\longal~1', r'c:\repo\long-alias', r'c:\repo\public-link'}
                return SimpleNamespace(st_mode=mode if linked else stat.S_IFDIR,
                                       st_reparse_tag=tag if linked else 0)
            with self.subTest(tag=tag), mock.patch('os.lstat', query), \
                    mock.patch('os.readlink', return_value=r'C:\old'), mock.patch('ntpath.realpath', ntpath.normpath):
                links = [(r'C:\repo\long-alias', r'C:\records')]
                with self.assertRaises(ValueError):
                    hooklib._linked_paths([r'C:\repo\LONGAL~1\locked.txt'], links, os_name='nt')
                with self.assertRaises(ValueError):
                    hooklib._linked_paths([r'C:\repo\long-alias\locked.txt'],
                                         [(r'C:\repo\LONGAL~1', r'C:\records')], os_name='nt')
                self.assertEqual(hooklib._linked_paths([r'C:\repo\public-link\locked.txt'], links, os_name='nt'), [])

    def test_missing_windows_short_names_cannot_guess_new_links(self):
        with mock.patch('os.lstat', side_effect=FileNotFoundError(errno.ENOENT, 'missing')), \
                mock.patch('ntpath.realpath', ntpath.normpath):
            for name in ['LONGAL~1', 'LONGA~12']:
                with self.subTest(name=name), self.assertRaises(ValueError):
                    hooklib._linked_paths([fr'C:\repo\{name}\locked.txt'],
                                         [(r'C:\repo\long-alias', r'C:\records')], os_name='nt')
                with self.subTest(link=name), self.assertRaises(ValueError):
                    hooklib._linked_paths([], [(fr'C:\repo\{name}', r'C:\records')], os_name='nt')

    def test_windows_ordinary_tildes_are_not_short_names(self):
        with mock.patch('os.lstat', side_effect=FileNotFoundError(errno.ENOENT, 'missing')), \
                mock.patch('ntpath.realpath', ntpath.normpath):
            for name in ['proj~v2', 'draft~', 'proj~１２']:
                cases = [(fr'C:\repo\{name}', r'C:\records', fr'C:\repo\{name}\locked.txt', r'C:\records\locked.txt'),
                         (fr'C:\{name}\alias', r'C:\records', fr'C:\{name}\alias\locked.txt', r'C:\records\locked.txt'),
                         (r'C:\repo\alias', fr'C:\{name}', r'C:\repo\alias\locked.txt', fr'C:\{name}\locked.txt'),
                         (r'C:\repo\alias', r'C:\records', fr'C:\repo\alias\{name}', fr'C:\records\{name}')]
                for source, target, access, expected in cases:
                    with self.subTest(source=source, target=target, access=access):
                        self.assertEqual(hooklib._linked_paths([access], [(source, target)], os_name='nt'), [expected])

    def test_windows_link_targets_with_extended_prefixes_are_followed(self):
        cases = [(r'\\?\C:\records\nested', r'C:\records\locked.txt'),
                 (r'\\?\UNC\server\share\records\nested', r'\\server\share\records\locked.txt')]
        for target, expected in cases:
            for mode, tag in [(stat.S_IFLNK, 0), (stat.S_IFDIR, 0xA0000003)]:
                def query(path):
                    linked = ntpath.normcase(path) == r'c:\existing'
                    return SimpleNamespace(st_mode=mode if linked else stat.S_IFDIR,
                                           st_reparse_tag=tag if linked else 0)
                def readlink(path):
                    self.assertEqual(ntpath.normcase(path), r'c:\existing')
                    return target
                with self.subTest(target=target, tag=tag), mock.patch('os.lstat', query), \
                        mock.patch('os.readlink', readlink), mock.patch('ntpath.realpath', ntpath.normpath):
                    self.assertEqual(hooklib._linked_paths([r'C:\existing\..\alias\locked.txt'],
                                     [(ntpath.dirname(expected) + r'\alias', r'C:\public')], os_name='nt'),
                                     [r'C:\public\locked.txt'])

    def test_windows_path_matches_opencode(self):
        # 与 OpenCode FSUtil.windowsPath 相同的四种盘符写法。
        for value, expected in [('/c/Users/example', 'C:/Users/example'), ('/C:/x', 'C:/x'), ('/C:\\x', 'C:/x'), ('/cygdrive/d/x', 'D:/x'),
                                ('/mnt/e/x', 'E:/x'), ('/c', 'C:/'), ('/home/x', '/home/x'), ('src/a', 'src/a')]:
            with self.subTest(value=value):
                self.assertEqual(hooklib.windows_path(value, 'nt'), expected)
        self.assertEqual(hooklib.windows_path('/c/Users/example', 'posix'), '/c/Users/example')

    def test_absolute_paths_accept_windows_normalized_separators(self):
        for path in [r'C:\repo', r'\repo', r'\\server\share\repo']:
            with self.subTest(path=path):
                self.assertTrue(hooklib.is_absolute(path, 'nt'))
                self.assertFalse(hooklib.is_absolute(path, 'posix'))
        self.assertFalse(hooklib.is_absolute('C:repo', 'nt'))

    def test_rooted_windows_directory_changes_are_not_dropped(self):
        def query(path):
            if ntpath.normpath(path) == r'\repo':
                return SimpleNamespace(st_mode=stat.S_IFDIR)
            raise FileNotFoundError(errno.ENOENT, 'missing', path)
        # Python 3.13 起 ntpath.isabs 不再把单分隔符根路径视为绝对路径。
        with mock.patch('ntpath.isabs', lambda path: bool(ntpath.splitdrive(path)[0])), \
                mock.patch('ntpath.realpath', ntpath.normpath), mock.patch('os.stat', query), mock.patch('os.lstat', query):
            with self.assertRaises(ValueError):
                hooklib.command_paths('mkdir /repo/new; ln -s records /repo/new', '/repo', os_name='nt')

    def test_command_link_mappings_keep_the_injected_platform(self):
        def query(path):
            if ntpath.normcase(ntpath.normpath(path)) in {r'c:\repo', r'd:\repo', r'\\server\share\repo'}:
                return SimpleNamespace(st_mode=stat.S_IFDIR)
            raise FileNotFoundError(errno.ENOENT, 'missing', path)
        commands = ['ln -s records alias; cat alias/locked.txt',
                    'ln -s records alias | cat alias/locked.txt',
                    'echo "$(ln -s records alias; cat alias/locked.txt)"',
                    'echo "`ln -s records alias; cat alias/locked.txt`"']
        with mock.patch('os.stat', query), mock.patch('os.lstat', query), mock.patch('ntpath.realpath', ntpath.normpath):
            for cwd, expected in [('C:/repo', r'C:\repo\records\locked.txt'),
                                  ('//server/share/repo', r'\\server\share\repo\records\locked.txt')]:
                for command in commands:
                    with self.subTest(cwd=cwd, command=command):
                        self.assertIn(expected, hooklib.command_paths(command, cwd, os_name='nt'))
            self.assertIn(r'D:\repo\records\locked.txt', hooklib.command_paths(
                'cd /d/repo && ln -s records alias; cat alias/locked.txt', 'C:/repo', os_name='nt'))

    def test_tool_paths_match_opencode_file_access(self):
        # 与 OpenCode FileAccess.resolve 相同（插件 platform.ts 的 toolPath 用同一组例子）：盘符写法、`~` 与 `~/`、字面合并 `..`。
        with mock.patch.dict(os.environ, {'OPENCODE_TEST_HOME': 'C:/Users/example'}):
            for value, expected in [('~/x', 'C:\\Users\\example\\x'), ('~', 'C:\\Users\\example'), ('~\\x', 'C:\\repo\\~\\x'),
                                    ('~//x', 'C:\\Users\\example\\x'), ('~/\\x', 'C:\\Users\\example\\x'), ('~/a//b', 'C:\\Users\\example\\a\\b'),
                                    ('/d/data/../x', 'D:\\x'), ('src/missing/..', 'C:\\repo\\src'), ('', 'C:\\repo')]:
                with self.subTest(value=value, os_name='nt'):
                    self.assertEqual(hooklib.tool_path('C:\\repo', value, 'nt'), expected)
        with mock.patch.dict(os.environ, {'OPENCODE_TEST_HOME': '/home/example'}):
            for value, expected in [('~/x', '/home/example/x'), ('~', '/home/example'), ('~user/x', '/repo/~user/x'),
                                    ('~//x', '/home/example/x'), ('~/a//b', '/home/example/a/b'),
                                    ('/c/x', '/c/x'), ('src/missing/..', '/repo/src'), ('', '/repo')]:
                with self.subTest(value=value, os_name='posix'):
                    self.assertEqual(hooklib.tool_path('/repo', value, 'posix'), expected)

    def test_git_clean_backslash_is_a_separator_only_on_windows(self):
        # POSIX 上 `\` 是 git pathspec 的转义字符，拒绝；Windows 上是目录分隔符，不算通配。
        self.assertIsNone(hooklib.git_clean_pathspec_problem('build\\out', 'nt'))
        self.assertIsNotNone(hooklib.git_clean_pathspec_problem('build\\out', 'posix'))
        for os_name in ['nt', 'posix']:
            self.assertIsNotNone(hooklib.git_clean_pathspec_problem('bu*ld', os_name))
            self.assertIsNotNone(hooklib.git_clean_pathspec_problem(':/', os_name))
            self.assertIsNone(hooklib.git_clean_pathspec_problem('build/out', os_name))

    def test_parent_segments_are_found_with_platform_separators(self):
        # Windows 的 `\` 是分隔符，POSIX 上是名字里的普通字符。符号链接解析在 test_paths 用真实文件系统覆盖，
        # 这里把 realpath 固定为恒等，只验证分隔符拆分，不依赖本机是否存在同名目录。
        with mock.patch('ntpath.realpath', lambda path: path), mock.patch('posixpath.realpath', lambda path: path):
            self.assertEqual(hooklib.physical_path('C:\\repo\\L\\..\\x', 'nt'), 'C:\\repo\\x')
            self.assertEqual(hooklib.physical_path('C:/repo/L/../x', 'nt'), 'C:\\repo\\x')
            self.assertEqual(hooklib.physical_path('/repo/a\\..\\b', 'posix'), '/repo/a\\..\\b')
            self.assertEqual(hooklib.physical_path('/repo/a/../b', 'posix'), '/repo/b')

    def test_rooted_windows_parent_segments_follow_links(self):
        def realpath(path):
            normalized = ntpath.normpath(path)
            return r'\records\nested' if normalized == r'\repo\L' else normalized
        with mock.patch('ntpath.isabs', lambda path: bool(ntpath.splitdrive(path)[0])), \
                mock.patch('ntpath.realpath', realpath):
            for path in [r'\repo\L\..\locked.txt', '/repo/L/../locked.txt']:
                with self.subTest(path=path):
                    self.assertEqual(hooklib.physical_path(path, 'nt'), r'\records\locked.txt')
            for command in ['echo x > /repo/L/../locked.txt', 'cd /repo/L/.. && echo x > locked.txt']:
                with self.subTest(command=command):
                    self.assertIn(r'\records\locked.txt', hooklib.command_paths(command, '/repo', os_name='nt'))

    def test_policy_input_rejects_rooted_paths_without_os_path_isabs(self):
        # 让 policy 模块所用的 os.path.isabs 只认检出根（Python 3.13 起 Windows 的单分隔符根路径即判作相对），
        # 确认策略检查入口改由 hooklib.is_absolute 拒绝根路径参数。
        with tempfile.TemporaryDirectory() as folder:
            request = json.dumps({'root': folder, 'action': 'read', 'paths': ['/outside.txt']})
            with mock.patch.object(policy.os.path, 'isabs', lambda path: path == folder), \
                    mock.patch.object(policy.sys, 'stdin', io.StringIO(request)), \
                    mock.patch.object(policy.sys, 'stdout', io.StringIO()) as output:
                code = policy.main()
            self.assertEqual((code, json.loads(output.getvalue())), (2, {'error': '策略检查输入无效'}))

    def test_external_checkout_policy_does_not_depend_on_os_path_isabs(self):
        guard = load('pre-guard-paths')
        with tempfile.TemporaryDirectory() as folder:
            root, external = Path(folder) / 'repo', Path(folder) / 'external'
            for repo, effect in [(root, 'allow'), (external, 'deny')]:
                (repo / '.git').mkdir(parents=True)
                config = repo / '.opencode/workflow/protection.json'
                config.parent.mkdir(parents=True)
                config.write_text(json.dumps({'version': 1, 'rules': [
                    {'id': 'read', 'actions': ['read'], 'paths': ['*'], 'effect': effect, 'reason': '检出读取规则'}
                ]}), encoding='utf-8')
            event = {'directory': str(root), 'tool': 'read', 'input': {}, 'paths': [str(external / 'locked.txt')]}
            # 让守卫模块自己的 os.path.isabs 把所有路径判作相对（Python 3.13 起 Windows 的单分隔符根路径即如此），
            # 确认外部检出的规则选择改由 hooklib.is_absolute 判断；Windows 根路径写法由 is_absolute 的用例覆盖。
            with mock.patch.object(guard, 'os', SimpleNamespace(path=SimpleNamespace(isabs=lambda path: False))):
                with self.assertRaisesRegex(ValueError, '检出读取规则'):
                    guard.check_event(event)

    def test_git_bash_drive_paths_resolve_as_absolute(self):
        self.assertIn(r'C:\repo\.env', hooklib.command_paths('cat /c/repo/.env', 'C:/work', include_readonly=True, os_name='nt'))
        self.assertIn(r'C:\work\src\a.ts', hooklib.command_paths('cat src/a.ts', 'C:/work', include_readonly=True, os_name='nt'))
        self.assertIn(r'D:\data\vendor\x.js', hooklib.command_paths('cd /d/data && echo x > vendor/x.js', 'C:/work', os_name='nt'))
        self.assertIn('/repo/C:/x/z', hooklib.command_paths('cd C:/x && echo y > z', '/repo', os_name='posix'))

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
