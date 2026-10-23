"""Shell-free execution with bounded capture and cooperative cancellation."""

import codecs
from contextlib import contextmanager
from dataclasses import dataclass
import os
from pathlib import Path
import signal
import subprocess
import threading
import time
from typing import Callable


class OutputBuffer:
    def __init__(self):
        self.output = ''
        self.truncated = False
        self._line = 0
        self._column = 0

    def add(self, text):
        kept = []
        for ch in text:
            if self._line >= 40:
                self.truncated = True
            elif ch == '\n':
                kept.append(ch)
            elif self._column < 4096:
                kept.append(ch)
            else:
                self.truncated = True
            if ch == '\n':
                self._line += 1
                self._column = 0
            else:
                self._column = min(4096, self._column + 1)
        self.output += ''.join(kept)


@dataclass(frozen=True)
class ProcessResult:
    started: bool
    returncode: int | None
    output: str
    truncated: bool
    timed_out: bool
    cancelled: bool
    error: str | None


def resolve_executable(command: str, *, cwd: Path, env=None, os_name=None) -> Path | None:
    env = os.environ if env is None else env
    windows = (os_name or os.name) == 'nt'
    has_path = '/' in command or (windows and ('\\' in command or ':' in command))
    names = [command]
    if windows:
        extensions = env.get('PATHEXT', '.COM;.EXE;.BAT;.CMD').split(';')
        if not any(command.lower().endswith(ext.lower()) for ext in extensions if ext):
            names += [command + ext for ext in extensions if ext]
    directories = [cwd] if has_path else [Path(p) for p in env.get('PATH', os.defpath).split(';' if windows and os.name == 'nt' else os.pathsep)]
    for directory in directories:
        directory = cwd / directory
        for name in names:
            file = directory / (name.replace('\\', '/') if windows else name)
            if windows and not file.is_file():
                # 真实 Windows 不区分大小写；注入平台时也保留此查找语义。
                try:
                    file = next(p for p in file.parent.iterdir() if p.name.lower() == file.name.lower())
                except (OSError, StopIteration):
                    continue
            if file.is_file() and (windows or os.access(file, os.X_OK)):
                return file.absolute()
    return None


def kill_tree(process: subprocess.Popen, *, os_name=None) -> None:
    try:
        if (os_name or os.name) == 'nt':
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(process.pid)],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=5)
        else:
            os.killpg(process.pid, signal.SIGKILL)
        return
    except (OSError, subprocess.SubprocessError, AttributeError):
        pass
    try:
        process.kill()
    except OSError:
        pass


@contextmanager
def termination_flag():
    stopped = False

    def handle(signum, frame):
        nonlocal stopped
        stopped = True

    previous = {}
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, handle)
        yield lambda: stopped
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def run_process(argv: list[str], *, cwd: Path, timeout: float, env=None, os_name=None,
                cancelled: Callable[[], bool] | None = None) -> ProcessResult:
    os_name = os_name or os.name
    if cancelled and cancelled():
        return ProcessResult(False, None, '', False, False, True, '已取消')
    if timeout <= 0:
        return ProcessResult(False, None, '', False, True, False, '预算用尽')
    deadline = time.monotonic() + timeout
    options = {'creationflags': 0x08000000} if os_name == 'nt' else {'start_new_session': True}
    try:
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **options)
    except (OSError, ValueError) as error:
        return ProcessResult(False, None, '', False, False, False, type(error).__name__)
    buffer = OutputBuffer()
    lock = threading.Lock()
    done = threading.Event()

    def drain():
        decoder = codecs.getincrementaldecoder('utf-8')('replace')
        try:
            while True:
                chunk = os.read(child.stdout.fileno(), 8192)
                with lock:
                    buffer.add(decoder.decode(chunk, final=not chunk))
                if not chunk:
                    break
        except OSError:
            pass
        finally:
            child.stdout.close()
            done.set()

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    timed_out = stopped = False
    while not (done.is_set() and child.poll() is not None):
        stopped = bool(cancelled and cancelled())
        timed_out = time.monotonic() >= deadline
        if stopped or timed_out:
            kill_tree(child, os_name=os_name)
            finish = time.monotonic() + 5
            try:
                child.wait(timeout=max(0, finish - time.monotonic()))
            except subprocess.TimeoutExpired:
                pass
            done.wait(max(0, finish - time.monotonic()))
            break
        time.sleep(.01)
    with lock:
        return ProcessResult(True, child.poll(), buffer.output, buffer.truncated, timed_out, stopped, None)
