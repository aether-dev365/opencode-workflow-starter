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
        start = time.monotonic()
        with mock.patch.object(process.os, 'killpg', side_effect=PermissionError(), create=True):
            r = self.run_tool('import subprocess,sys,time; print("partial",flush=True); '
                              'subprocess.Popen([sys.executable,"-c","import time; time.sleep(6)"]); time.sleep(30)', .1)
        self.assertTrue(r.timed_out)
        self.assertIn('partial', r.output)
        self.assertLess(time.monotonic() - start, 5.8)

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
