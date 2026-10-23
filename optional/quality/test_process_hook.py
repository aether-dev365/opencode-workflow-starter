import contextlib
import io
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from quality_testing import HERE, load_script


class HookLifecycle(unittest.TestCase):
    def test_native_outer_timeout_owns_nested_tool_descendants_without_git(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            here = root / 'quality'; here.mkdir()
            shutil.copyfile(HERE / 'quality_process.py', here / 'quality_process.py')
            pidfile = root / 'worker.pid'
            sentinel = root / 'late'
            worker = (f'import os,time,pathlib; pathlib.Path({str(pidfile)!r}).write_text(str(os.getpid())); '
                      f'print("NESTED_READY",flush=True); time.sleep(1.5); pathlib.Path({str(sentinel)!r}).touch(); time.sleep(30)')
            tool = f'import subprocess,sys; subprocess.Popen([sys.executable,"-c",{worker!r}])'
            (here / 'check-format.py').write_text(
                'import sys\nfrom pathlib import Path\nfrom quality_process import run_process,termination_flag\n'
                'with termination_flag() as cancelled:\n'
                f' r=run_process([sys.executable,"-c",{tool!r}],cwd=Path.cwd(),timeout=30,cancelled=cancelled)\n'
                ' print(r.output,flush=True)\n', encoding='utf-8')
            for name in ('review-comments.py', 'check-skips.py', 'check-links.py'):
                (here / name).write_text('print("NEXT_CHECK")', encoding='utf-8')
            module = load_script('run-hook.py')
            try:
                with mock.patch.object(module, '__file__', str(here / 'run-hook.py')), \
                        mock.patch.object(module, 'repo_root', return_value=root), \
                        mock.patch.object(module, 'git_bytes', return_value=b'example'), \
                        mock.patch.object(module, 'timeout_for', return_value=.5), \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(module.main(['post-commit']), 0)
                self.assertTrue(pidfile.exists(), output.getvalue())
                self.assertIn('格式检查超时', output.getvalue())
                self.assertEqual(output.getvalue().count('NEXT_CHECK'), 3)
                time.sleep(1.6)
                self.assertFalse(sentinel.exists())
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
