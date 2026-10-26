import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock
import quality_process as process


class Processes(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def run_tool(self, source, timeout=3, **kwargs):
        return process.run_process([sys.executable, '-c', source], cwd=self.root, timeout=timeout, **kwargs)

    def test_exit_and_merged_utf8_output(self):
        for code in (0, 7):
            r = self.run_tool(f'import os; os.write(1, "中文\\n".encode()); os.write(2,b"stderr\\xff"); exit({code})')
            self.assertTrue(r.started)
            self.assertEqual(r.returncode, code)
            self.assertIn('中文', r.output)
            self.assertIn('stderr�', r.output)
            self.assertFalse(r.timed_out)

    def test_output_limits_do_not_block_a_writer(self):
        r = self.run_tool('import sys; print("x" * 1000000); print("line\\n" * 60); sys.exit(7)')
        self.assertEqual(r.returncode, 7)
        self.assertFalse(r.timed_out)
        self.assertTrue(r.truncated)
        self.assertLessEqual(len(r.output.splitlines()), 40)
        self.assertTrue(all(len(line) <= 4096 for line in r.output.split('\n')))

    def test_partial_multibyte_characters_decode_incrementally(self):
        r = self.run_tool('import os,time\nfor b in "中文".encode():\n os.write(1,bytes([b])); time.sleep(.01)')
        self.assertEqual(r.output, '中文')

    def test_start_failure_differs_from_nonzero_exit(self):
        for command in (self.root / 'missing', self.root):
            r = process.run_process([str(command)], cwd=self.root, timeout=1)
            self.assertFalse(r.started)
            self.assertIsNotNone(r.error)
            self.assertIsNone(r.returncode)

    def tree_source(self):
        return ('import subprocess,sys,time,pathlib\n'
                'subprocess.Popen([sys.executable,"-c",'
                '"import time,pathlib; time.sleep(1.5); pathlib.Path(\'late\').write_text(\'x\')"])\n'
                'print("ready",flush=True)\n'
                'time.sleep(10)\n')

    def test_timeout_kills_child_and_inherited_pipe_holder(self):
        start = time.monotonic()
        r = self.run_tool(self.tree_source(), .25)
        self.assertTrue(r.timed_out)
        self.assertIn('ready', r.output)
        self.assertLess(time.monotonic() - start, 6)
        time.sleep(1.6)
        self.assertFalse((self.root / 'late').exists())

    def test_cancel_flag_stops_active_process(self):
        start = time.monotonic()
        r = self.run_tool(self.tree_source(), cancelled=lambda: time.monotonic() - start > .25)
        self.assertTrue(r.cancelled)
        self.assertFalse(r.timed_out)
        time.sleep(1.6)
        self.assertFalse((self.root / 'late').exists())

    def test_exited_root_descendant_is_killed_before_delayed_write(self):
        pidfile = self.root / 'worker.pid'
        worker = ('import os,time,pathlib; '
                  f'pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid())); '
                  'print("WORKER_READY",flush=True); time.sleep(1.2); '
                  'pathlib.Path("late").touch(); time.sleep(30)')
        source = f'import subprocess,sys; subprocess.Popen([sys.executable,"-c",{worker!r}])'
        try:
            start = time.monotonic()
            r = self.run_tool(source, .3)
            self.assertTrue(r.timed_out)
            self.assertEqual(r.returncode, 0)
            self.assertIn('WORKER_READY', r.output)
            self.assertLess(time.monotonic() - start, 2)
            time.sleep(1.3)
            self.assertFalse((self.root / 'late').exists())
            if sys.platform.startswith('linux'):
                state = Path('/proc') / pidfile.read_text() / 'stat'
                self.assertTrue(not state.exists() or state.read_text().split(') ')[1].startswith('Z'))
            elif os.name == 'nt':
                import ctypes
                kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                kernel.OpenProcess.restype = ctypes.c_void_p
                kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
                kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                handle = kernel.OpenProcess(0x1000, False, int(pidfile.read_text()))
                if handle:
                    try:
                        code = ctypes.c_ulong()
                        self.assertTrue(kernel.GetExitCodeProcess(handle, ctypes.byref(code)))
                        self.assertNotEqual(code.value, 259)
                    finally:
                        kernel.CloseHandle(handle)
        finally:
            if pidfile.exists():
                pid = int(pidfile.read_text())
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)], capture_output=True, timeout=5)
                else:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_lifecycle_initialization_failure_never_runs_tool(self):
        with mock.patch.object(process, '_WindowsJob', side_effect=PermissionError(), create=True):
            r = self.run_tool('from pathlib import Path; Path("unexpected").touch()', os_name='nt')
        self.assertFalse(r.started)
        self.assertIn('生命周期初始化失败', r.error)
        self.assertFalse((self.root / 'unexpected').exists())

    def test_lifecycle_cleanup_failure_is_incomplete(self):
        with mock.patch.object(process, 'kill_tree', return_value=False):
            r = self.run_tool('import time; time.sleep(.3)', .1)
        self.assertTrue(r.timed_out)
        self.assertIsNotNone(r.error)

    def test_failed_job_assignment_or_resume_never_executes_tool(self):
        for method in ('assign', 'resume'):
            with self.subTest(method=method):
                job = mock.Mock()
                getattr(job, method).side_effect = PermissionError()
                with mock.patch.object(process, '_WindowsJob', return_value=job, create=True):
                    r = self.run_tool('from pathlib import Path; Path("unexpected").touch()', os_name='nt')
                self.assertFalse(r.started)
                self.assertIn('生命周期初始化失败', r.error)
                self.assertFalse((self.root / 'unexpected').exists())

    def test_tree_kill_failure_and_bounded_drain(self):
        for os_name in ('posix', 'nt'):
            for error in (FileNotFoundError(), subprocess.CalledProcessError(1, 'taskkill')):
                p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
                try:
                    with mock.patch.object(process.os, 'killpg', side_effect=PermissionError(), create=True), \
                            mock.patch.object(process.subprocess, 'run', side_effect=error) as run:
                        process.kill_tree(p, os_name=os_name)
                    p.wait(timeout=5)
                    self.assertNotEqual(p.returncode, 0)
                    if os_name == 'nt':
                        self.assertEqual(run.call_args.kwargs['timeout'], 5)
                finally:
                    if p.poll() is None:
                        p.kill(); p.wait(timeout=5)
        # 模拟杀树失败且后代持管道；结束直接子进程后仍必须有限返回。
        self.assert_bounded_drain()

    def test_bounded_drain_survives_controlled_slow_start(self):
        run_tool = self.run_tool
        def delayed(source, *args, **kwargs):
            return run_tool('import time; time.sleep(.2)\n' + source, *args, **kwargs)
        with mock.patch.object(self, 'run_tool', side_effect=delayed):
            self.assert_bounded_drain()

    def assert_bounded_drain(self):
        ready = self.root / 'ready'
        pidfile = self.root / 'worker.pid'
        ready_at = None
        worker = ('import os,time,pathlib; print("PIPE_READY",flush=True); '
                  'pathlib.Path("ready.tmp").write_text(str(os.getpid())); '
                  'pathlib.Path("ready.tmp").replace("ready"); time.sleep(30); '
                  'pathlib.Path("natural-exit").touch()')
        source = ('import subprocess,sys,time,pathlib; print("partial",flush=True); '
                  f'p=subprocess.Popen([sys.executable,"-c",{worker!r}]); '
                  'pathlib.Path("worker.pid").write_text(str(p.pid)); time.sleep(30)')

        def cancelled():
            nonlocal ready_at
            if ready.is_file():
                ready_at = time.monotonic() if ready_at is None else ready_at
                return True
            return False

        def kill_root_only(child, **kwargs):
            # 真正结束根进程，故意留下持管道后代，跨平台注入同一种清理失败。
            child.kill()
            return False

        try:
            # 10 秒只保护启动/握手；ready 后取消，独立测量原有 5 秒输出收尾。
            with mock.patch.object(process, 'kill_tree', side_effect=kill_root_only):
                r = self.run_tool(source, timeout=10, cancelled=cancelled)
            self.assertIsNotNone(ready_at, '启动保护期限内未就绪')
            self.assertTrue(r.cancelled)
            self.assertFalse(r.timed_out)
            self.assertIn('partial', r.output)
            self.assertIn('PIPE_READY', r.output)
            self.assertEqual(r.error, '输出收尾未完成')
            self.assertLess(time.monotonic() - ready_at, 5.8)
            self.assertFalse((self.root / 'natural-exit').exists())
        finally:
            recorded = ready if ready.is_file() else pidfile
            if recorded.is_file() and recorded.read_text().strip():
                pid = int(recorded.read_text())
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)], capture_output=True, timeout=5)
                else:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass

    def test_cooperative_wrapper_cleans_independent_groups_on_cancel_and_timeout(self):
        for kind in ('cancel', 'timeout'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                ready = root / 'ready'
                worker = ('import os,time; from pathlib import Path; '
                          'Path("worker.pid").write_text(str(os.getpid())); Path("ready").touch(); '
                          'time.sleep(1); Path("late").touch(); time.sleep(30)')
                outer = ('import sys,os; from pathlib import Path; '
                         f'sys.path.insert(0,{str(Path(process.__file__).parent)!r}); '
                         'from quality_process import run_process,termination_flag\n'
                         'Path("outer.pid").write_text(str(os.getpid()))\n'
                         'with termination_flag() as stopped:\n'
                         f' result=run_process([sys.executable,"-c",{worker!r}],cwd=Path.cwd(),timeout=30,cancelled=stopped)\n'
                         'print("CLEANED",flush=True)\n')
                clock = time.monotonic
                def deadline_clock():
                    return clock() + (20 if kind == 'timeout' and ready.exists() else 0)
                try:
                    with mock.patch.object(process.time, 'monotonic', side_effect=deadline_clock):
                        result = process.run_process([sys.executable, '-c', outer], cwd=root, timeout=10,
                                                     cancelled=lambda: kind == 'cancel' and ready.exists(), cooperative=True)
                    self.assertTrue(ready.exists(), '启动握手未完成')
                    self.assertEqual(result.cancelled, kind == 'cancel')
                    self.assertEqual(result.timed_out, kind == 'timeout')
                    if os.name != 'nt':
                        self.assertIn('CLEANED', result.output)
                    time.sleep(1.1)
                    self.assertFalse((root / 'late').exists())
                    for name in ('outer.pid', 'worker.pid'):
                        pid = int((root / name).read_text())
                        if sys.platform.startswith('linux'):
                            status = Path('/proc') / str(pid) / 'stat'
                            self.assertTrue(not status.exists() or status.read_text().split(') ')[1].startswith('Z'))
                        elif os.name != 'nt':
                            probe = subprocess.run(['ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
                            self.assertTrue(probe.returncode != 0 or probe.stdout.strip().startswith('Z'))
                finally:
                    for name in ('outer.pid', 'worker.pid'):
                        file = root / name
                        if file.exists():
                            pid = int(file.read_text())
                            if os.name == 'nt':
                                subprocess.run(['taskkill', '/F', '/T', '/PID', str(pid)], capture_output=True, timeout=5)
                            else:
                                try:
                                    os.kill(pid, signal.SIGKILL)
                                except ProcessLookupError:
                                    pass

    def test_command_lookup_windows_pathext_and_paths(self):
        for name in ('tool.EXE', 'launch.CMD', 'direct'):
            file = self.root / name
            file.write_text('not executable source', encoding='utf-8')
            file.chmod(0o755)
        env = {'PATH': str(self.root), 'PATHEXT': '.EXE;.CMD;.BAT'}
        for command, expected in [('tool', 'tool.EXE'), ('launch', 'launch.CMD'), ('launch.CMD', 'launch.CMD')]:
            self.assertEqual(process.resolve_executable(command, cwd=self.root, env=env, os_name='nt'), self.root / expected)
        self.assertEqual(process.resolve_executable('./direct', cwd=self.root), self.root / 'direct')
        self.assertEqual(process.resolve_executable('direct', cwd=self.root, env={'PATH': str(self.root)}), self.root / 'direct')
        self.assertIsNone(process.resolve_executable('missing', cwd=self.root, env=env))

    def test_command_lookup_skips_relative_path_entries(self):
        # 相对 PATH 项指向当前目录：Windows 的进程创建本来就会先查它，项目里的同名程序不能因此被执行。
        for directory in ('.', 'bin', 'abs'):
            (self.root / directory).mkdir(exist_ok=True)
            (self.root / directory / 'tool').write_text('', encoding='utf-8')
            (self.root / directory / 'tool').chmod(0o755)
        relative = os.pathsep.join(['.', 'bin'])
        self.assertEqual(process.resolve_executable('tool', cwd=self.root, env={'PATH': os.pathsep.join([relative, str(self.root / 'abs')])}), self.root / 'abs' / 'tool')
        self.assertIsNone(process.resolve_executable('tool', cwd=self.root, env={'PATH': relative}))

    def test_programs_resolve_to_absolute_paths(self):
        # 进程创建会在当前目录查找不带路径的命令：Windows 总是先查，macOS 和 Linux 在 PATH 有空项时也查。
        for name in ('git.exe', 'git', 'bin/git.exe', 'bin/git', 'scripts/git.cmd'):
            (self.root / name).parent.mkdir(exist_ok=True)
            (self.root / name).write_text('', encoding='utf-8')
            (self.root / name).chmod(0o755)
        previous = os.getcwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        bin, scripts = str(self.root / 'bin'), str(self.root / 'scripts')
        # Windows 上启动 Git 只认 .com/.exe：经 cmd.exe 执行时，参数会被 cmd 解释。
        self.assertEqual(process.program('git', os_name='nt', env={'PATH': os.pathsep.join(['', '.', scripts, bin])}), os.path.join(bin, 'git.exe'))
        self.assertEqual(process.program('git', os_name='nt', env={'PATH': f'"{bin}"'}), os.path.join(bin, 'git.exe'))
        self.assertIsNone(process.program('git', os_name='nt', env={'PATH': os.pathsep.join(['', '.'])}))
        self.assertEqual(process.program('git', os_name='posix', env={'PATH': os.pathsep.join(['', bin])}), os.path.join(bin, 'git'))
        self.assertIsNone(process.program('git', os_name='posix', env={'PATH': os.pathsep + '.'}))
        self.assertEqual(process.system_command('taskkill.exe', env={'SystemRoot': 'D:\\Windows'}), 'D:\\Windows\\System32\\taskkill.exe')
        self.assertEqual(process.system_command('taskkill.exe', env={'windir': 'E:\\WINNT'}), 'E:\\WINNT\\System32\\taskkill.exe')
        self.assertEqual(process.system_command('taskkill.exe', env={}), 'C:\\Windows\\System32\\taskkill.exe')

    def test_program_lookup_is_cached_per_path(self):
        # 每个检查会调用 git 几十次；Windows 上逐个探测 PATH 目录很慢。
        (self.root / 'bin').mkdir()
        for name in ('git', 'git.exe'):
            (self.root / 'bin' / name).write_text('', encoding='utf-8')
            (self.root / 'bin' / name).chmod(0o755)
        env = {'PATH': str(self.root / 'bin')}
        with mock.patch.object(process.os.path, 'isfile', wraps=os.path.isfile) as isfile:
            first = process.program('git', env=env)
            calls = isfile.call_count
            self.assertEqual(process.program('git', env=env), first)
            self.assertEqual(isfile.call_count, calls)
        self.assertTrue(first)

    def test_termination_handlers_are_restored(self):
        before = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        with process.termination_flag() as cancelled:
            self.assertFalse(cancelled())
            signal.getsignal(signal.SIGTERM)(signal.SIGTERM, None)
            self.assertTrue(cancelled())
        self.assertEqual(before, {sig: signal.getsignal(sig) for sig in before})

    def test_injected_posix_kill_without_platform_signal_falls_back(self):
        p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
        try:
            with mock.patch.object(process, 'signal', SimpleNamespace()):
                process.kill_tree(p, os_name='posix')
            p.wait(timeout=5)
            self.assertNotEqual(p.returncode, 0)
        finally:
            if p.poll() is None:
                p.kill(); p.wait(timeout=5)
