"""基础 Node 自检监督器：Windows Job 启动顺序与跨平台后代回收。"""
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import protocol

HERE = Path(__file__).resolve().parent


class NodeCheck(unittest.TestCase):
    def test_job_must_be_ready_before_suspended_node_resumes(self):
        events = []
        job, child = mock.Mock(), mock.Mock()
        job.assign.side_effect = lambda process: events.append('assign')
        job.resume.side_effect = lambda process: events.append('resume')
        job.close.side_effect = lambda: events.append('close')
        child.wait.side_effect = lambda **kwargs: events.append('wait') or 0
        def create_job():
            events.append('job')
            return job
        def launch(*args, **kwargs):
            events.append('spawn')
            return child
        with mock.patch.object(protocol, '_NodeCheckJob', side_effect=create_job), \
                mock.patch.object(protocol.subprocess, 'Popen', side_effect=launch) as popen:
            self.assertEqual(protocol.run_node_check(['node', 'doctor.mjs'], os_name='nt'), 0)
        self.assertEqual(events, ['job', 'spawn', 'assign', 'resume', 'wait', 'close'])
        self.assertEqual(popen.call_args.kwargs['creationflags'], 0x08000004)
        for name in ('stdout', 'stderr', 'encoding', 'text', 'shell'):
            self.assertNotIn(name, popen.call_args.kwargs)

    def test_job_creation_failure_does_not_start_node(self):
        with mock.patch.object(protocol, '_NodeCheckJob', side_effect=PermissionError('job')), \
                mock.patch.object(protocol.subprocess, 'Popen') as popen:
            with self.assertRaisesRegex(OSError, '生命周期'):
                protocol.run_node_check(['node', 'doctor.mjs'], os_name='nt')
        popen.assert_not_called()

    def test_assignment_and_resume_failures_reap_suspended_node(self):
        for phase in ('assign', 'resume'):
            with self.subTest(phase=phase):
                job, child = mock.Mock(), mock.Mock()
                getattr(job, phase).side_effect = PermissionError(phase)
                with mock.patch.object(protocol, '_NodeCheckJob', return_value=job), \
                        mock.patch.object(protocol.subprocess, 'Popen', return_value=child):
                    with self.assertRaisesRegex(OSError, '生命周期'):
                        protocol.run_node_check(['node', 'doctor.mjs'], os_name='nt')
                child.kill.assert_called_once()
                child.wait.assert_called_once_with(timeout=5)
                job.close.assert_called_once()
                if phase == 'assign':
                    job.resume.assert_not_called()

    def test_failed_windows_assignment_or_resume_never_executes_real_child(self):
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / 'unexpected'
            for phase in ('assign', 'resume'):
                with self.subTest(phase=phase):
                    job = mock.Mock()
                    getattr(job, phase).side_effect = PermissionError(phase)
                    with mock.patch.object(protocol, '_NodeCheckJob', return_value=job), self.assertRaises(OSError):
                        protocol.run_node_check([sys.executable, '-c', f'from pathlib import Path; Path({str(marker)!r}).touch()'], os_name='nt')
                    self.assertFalse(marker.exists())

    def test_job_cleanup_failure_cannot_return_success(self):
        job, child = mock.Mock(), mock.Mock()
        child.wait.return_value = 0
        job.close.side_effect = PermissionError('close')
        with mock.patch.object(protocol, '_NodeCheckJob', return_value=job), \
                mock.patch.object(protocol.subprocess, 'Popen', return_value=child), self.assertRaises(OSError):
            protocol.run_node_check(['node', 'doctor.mjs'], os_name='nt')

    def test_supervisor_preserves_raw_stdout_stderr_and_exit_code(self):
        code = 'import os; os.write(1,b"\\xffstdout"); os.write(2,b"\\xfestderr"); raise SystemExit(4)'
        result = subprocess.run([sys.executable, str(HERE / 'run-node-check.py'), sys.executable, '-c', code],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
        self.assertEqual(result.returncode, 4)
        self.assertEqual(result.stdout, b'\xffstdout')
        self.assertEqual(result.stderr, b'\xfestderr')

    def test_forced_supervisor_exit_reaps_deep_orphans(self):
        with tempfile.TemporaryDirectory() as directory:
            marker, alive = Path(directory) / 'late-marker', Path(directory) / 'alive'
            release, owner = Path(directory) / 'release', Path(directory) / 'owner'
            worker = ('import os,pathlib,time; '
                      f'pathlib.Path({str(alive)!r}).write_text(str(os.getpid())); '
                      f'gate=pathlib.Path({str(release)!r});\n'
                      'while not gate.exists(): time.sleep(.01)\n'
                      f'pathlib.Path({str(marker)!r}).touch()')
            intermediate = ('import subprocess,sys; '
                            f'subprocess.Popen([sys.executable,"-c",{worker!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)')
            parent = (f'import os,pathlib,subprocess,sys,time; pathlib.Path({str(owner)!r}).write_text(str(os.getpid())); '
                      f'subprocess.run([sys.executable,"-c",{intermediate!r}],check=True); time.sleep(30)')
            supervisor = subprocess.Popen([sys.executable, str(HERE / 'run-node-check.py'), sys.executable, '-c', parent],
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 10
                while not alive.exists() and time.monotonic() < deadline:
                    time.sleep(.01)
                self.assertTrue(alive.exists(), '深层后代未在启动期限内就绪')
                if os.name != 'nt':
                    os.killpg(int(owner.read_text()), signal.SIGKILL)
                # Windows 只结束监督器本身；由 OS 关闭 Job 句柄，不靠仍可查询的父子 PID 链。
                supervisor.kill()
                supervisor.communicate(timeout=5)
                release.touch()
                time.sleep(.3)
                self.assertFalse(marker.exists())
            finally:
                if supervisor.poll() is None:
                    supervisor.kill()
                supervisor.communicate(timeout=5)
                release.touch()
                for file in (owner, alive):
                    if file.exists():
                        if os.name == 'nt':
                            subprocess.run(['taskkill', '/F', '/T', '/PID', file.read_text()],
                                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
                        else:
                            try:
                                os.kill(int(file.read_text()), signal.SIGKILL)
                            except ProcessLookupError:
                                pass

    def test_normal_and_failed_node_exits_reap_deep_orphans_after_intermediate_exit(self):
        for exit_code in (0, 4):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory() as directory:
                marker, alive = Path(directory) / 'late-marker', Path(directory) / 'alive'
                worker = f'import pathlib,time; pathlib.Path({str(alive)!r}).touch(); time.sleep(.65); pathlib.Path({str(marker)!r}).touch()'
                intermediate = ('import subprocess,sys; '
                                f'subprocess.Popen([sys.executable,"-c",{worker!r}],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)')
                parent = ('import pathlib,subprocess,sys,time; '
                          f'subprocess.run([sys.executable,"-c",{intermediate!r}],check=True); '
                          f'path=pathlib.Path({str(alive)!r});\n'
                          'while not path.exists(): time.sleep(.01)\n'
                          f'print("result",flush=True); raise SystemExit({exit_code})')
                result = subprocess.run([sys.executable, str(HERE / 'run-node-check.py'), sys.executable, '-c', parent],
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
                self.assertEqual(result.returncode, exit_code, result.stderr)
                self.assertEqual(result.stdout, b'result\r\n' if os.name == 'nt' else b'result\n')
                time.sleep(.9)
                self.assertFalse(marker.exists(), '监督器结束后不允许深层孤儿后代继续执行')


if __name__ == '__main__':
    unittest.main()
