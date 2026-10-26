"""Shell-free execution with bounded capture and cooperative cancellation."""

import codecs
from contextlib import contextmanager
from dataclasses import dataclass
import functools
import ntpath
import os
import posixpath
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
    # 只查 PATH 中的绝对目录：空项和 `.` 一类相对项指向当前目录，项目里的同名程序会被执行。
    entries = [_unquote(p, windows) for p in env.get('PATH', os.defpath).split(';' if windows and os.name == 'nt' else os.pathsep)]
    directories = [cwd] if has_path else [Path(p) for p in entries if os.path.isabs(p) or (windows and ntpath.isabs(p))]
    for directory in directories:
        directory = cwd / directory
        for name in names:
            file = directory / (name.replace('\\', '/') if windows else name)
            if windows and os.name != 'nt' and not file.is_file():
                # 真实 Windows 不区分大小写，is_file 已经能找到；只在注入平台时逐个比对目录项，它在大目录上很慢。
                try:
                    file = next(p for p in file.parent.iterdir() if p.name.lower() == file.name.lower())
                except (OSError, StopIteration):
                    continue
            if file.is_file() and (windows or os.access(file, os.X_OK)):
                return file.absolute()
    return None


def _unquote(entry: str, windows: bool) -> str:
    # Windows 的 PATH 项可以带一对引号，与系统一样去掉。
    return entry[1:-1] if windows and len(entry) > 1 and entry[0] == entry[-1] == '"' else entry


def program(name: str, *, os_name=None, env=None) -> str | None:
    """启动外部程序用的绝对路径，找不到时返回 None：进程创建会在当前目录查找不带路径的命令，Windows 总是先查，
    macOS 和 Linux 在 PATH 有空项时也查。Windows 上只认 .com/.exe：经 cmd.exe 执行时，参数会被 cmd 解释。"""
    windows = (os_name or os.name) == 'nt'
    env = os.environ if env is None else env
    path = next((value for key, value in env.items() if key.upper() == 'PATH'), None)
    return _program(name, windows, ('' if windows else posixpath.defpath) if path is None else path)


# 每个检查会调用 git 几十次，按 PATH 缓存查找结果。
@functools.lru_cache(maxsize=32)
def _program(name: str, windows: bool, path: str) -> str | None:
    names = [name] if not windows or name.lower().endswith(('.com', '.exe')) else [name + '.com', name + '.exe']
    for directory in (_unquote(p, windows) for p in path.split(';' if windows and os.name == 'nt' else os.pathsep)):
        if not (os.path.isabs(directory) or (windows and ntpath.isabs(directory))):
            continue
        for item in names:
            file = os.path.join(directory, item)
            if os.path.isfile(file) and (windows or os.access(file, os.X_OK)):
                return file
    return None


def system_command(name: str, env=None) -> str:
    """taskkill.exe 等 Windows 系统程序固定取自 %SystemRoot%\\System32，没有 SystemRoot 时依次用 windir、C:\\Windows。"""
    env = os.environ if env is None else env
    root = next((v for k, v in env.items() if k.upper() == 'SYSTEMROOT'), None) or next((v for k, v in env.items() if k.upper() == 'WINDIR'), None)
    return ntpath.join(root or 'C:\\Windows', 'System32', name)


class _LifecycleError(OSError):
    pass


class _WindowsJob:
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        self.c = c
        self.handle = None
        self.kernel = c.WinDLL('kernel32', use_last_error=True)

        class Limits(c.Structure):
            _fields_ = [('process_time', c.c_int64), ('job_time', c.c_int64), ('flags', w.DWORD),
                        ('min_working_set', c.c_size_t), ('max_working_set', c.c_size_t),
                        ('active_limit', w.DWORD), ('affinity', c.c_size_t),
                        ('priority', w.DWORD), ('scheduling', w.DWORD)]

        class ExtendedLimits(c.Structure):
            _fields_ = [('basic', Limits), ('io', c.c_uint64 * 6),
                        ('process_memory', c.c_size_t), ('job_memory', c.c_size_t),
                        ('peak_process_memory', c.c_size_t), ('peak_job_memory', c.c_size_t)]

        class Accounting(c.Structure):
            _fields_ = [('times', c.c_int64 * 4), ('page_faults', w.DWORD),
                        ('total', w.DWORD), ('active', w.DWORD), ('terminated', w.DWORD)]

        class ThreadEntry(c.Structure):
            _fields_ = [('size', w.DWORD), ('usage', w.DWORD), ('tid', w.DWORD),
                        ('pid', w.DWORD), ('base_priority', w.LONG),
                        ('delta_priority', w.LONG), ('flags', w.DWORD)]

        self.Accounting, self.ThreadEntry = Accounting, ThreadEntry
        signatures = {
            'CreateJobObjectW': ([c.c_void_p, w.LPCWSTR], w.HANDLE),
            'SetInformationJobObject': ([w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
            'QueryInformationJobObject': ([w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p], w.BOOL),
            'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
            'TerminateJobObject': ([w.HANDLE, w.UINT], w.BOOL),
            'CloseHandle': ([w.HANDLE], w.BOOL),
            'CreateToolhelp32Snapshot': ([w.DWORD, w.DWORD], w.HANDLE),
            'Thread32First': ([w.HANDLE, c.POINTER(ThreadEntry)], w.BOOL),
            'Thread32Next': ([w.HANDLE, c.POINTER(ThreadEntry)], w.BOOL),
            'OpenThread': ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
            'ResumeThread': ([w.HANDLE], w.DWORD),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = args, result
        self.handle = self._check(self.kernel.CreateJobObjectW(None, None))
        try:
            limits = ExtendedLimits()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            self._check(self.kernel.SetInformationJobObject(self.handle, 9, c.byref(limits), c.sizeof(limits)))
        except OSError:
            self.close()
            raise

    def _check(self, result):
        if not result:
            raise self.c.WinError(self.c.get_last_error())
        return result

    def assign(self, process):
        self._check(self.kernel.AssignProcessToJobObject(self.handle, int(process._handle)))

    def resume(self, process):
        # Popen 已关闭主线程句柄；通过公开 Toolhelp/ResumeThread API 恢复挂起线程。
        snapshot = self.kernel.CreateToolhelp32Snapshot(4, 0)
        if snapshot == self.c.c_void_p(-1).value:
            raise self.c.WinError(self.c.get_last_error())
        try:
            entry = self.ThreadEntry()
            entry.size = self.c.sizeof(entry)
            found = self.kernel.Thread32First(snapshot, self.c.byref(entry))
            while found:
                if entry.pid == process.pid:
                    thread = self._check(self.kernel.OpenThread(2, False, entry.tid))
                    try:
                        if self.kernel.ResumeThread(thread) == 0xffffffff:
                            raise self.c.WinError(self.c.get_last_error())
                        return
                    finally:
                        self.kernel.CloseHandle(thread)
                found = self.kernel.Thread32Next(snapshot, self.c.byref(entry))
            raise OSError('找不到挂起的主线程')
        finally:
            self.kernel.CloseHandle(snapshot)

    def active(self):
        info = self.Accounting()
        self._check(self.kernel.QueryInformationJobObject(self.handle, 1, self.c.byref(info), self.c.sizeof(info), None))
        return info.active

    def terminate(self):
        self._check(self.kernel.TerminateJobObject(self.handle, 1))

    def close(self):
        if self.handle is not None:
            self._check(self.kernel.CloseHandle(self.handle))
            self.handle = None


def start_process(argv, *, cwd, env=None, os_name=None):
    windows = (os_name or os.name) == 'nt'
    job = child = None
    try:
        if windows:
            job = _WindowsJob()
        # 主线程恢复之前完成归属；工具代码没有先派生后代的窗口。
        options = {'creationflags': 0x08000004} if windows else {'start_new_session': True}
        child = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **options)
        if job is not None:
            child._quality_job = job
            job.assign(child)
            job.resume(child)
        return child
    except (OSError, ValueError, AttributeError) as error:
        if child is not None:
            child.kill()
            child.wait(timeout=5)
            child.stdout.close()
        if job is not None:
            job.close()
        if windows:
            raise _LifecycleError('生命周期初始化失败：' + type(error).__name__) from error
        raise


def close_process(process):
    job = getattr(process, '_quality_job', None)
    if job is not None:
        try:
            job.close()
        except OSError:
            return False
    return True


def tree_active(process):
    job = getattr(process, '_quality_job', None)
    return bool(job and job.active())


def kill_tree(process: subprocess.Popen, *, os_name=None) -> bool:
    job = getattr(process, '_quality_job', None)
    if job is not None:
        try:
            job.terminate()
            return True
        except OSError:
            # 关闭最后一个 Job 句柄仍会结束后代，但保留清理失败分类。
            close_process(process)
            return False
    try:
        if (os_name or os.name) == 'nt':
            subprocess.run([system_command('taskkill.exe'), '/F', '/T', '/PID', str(process.pid)],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=5)
        else:
            os.killpg(process.pid, signal.SIGKILL)
        return True
    except ProcessLookupError:
        return True
    except (OSError, subprocess.SubprocessError, AttributeError):
        pass
    try:
        process.kill()
    except OSError:
        pass
    return False


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
                cancelled: Callable[[], bool] | None = None, cooperative: bool = False) -> ProcessResult:
    os_name = os_name or os.name
    if cancelled and cancelled():
        return ProcessResult(False, None, '', False, False, True, '已取消')
    if timeout <= 0:
        return ProcessResult(False, None, '', False, True, False, '预算用尽')
    deadline = time.monotonic() + timeout
    try:
        child = start_process(argv, cwd=cwd, env=env, os_name=os_name)
    except (OSError, ValueError) as error:
        reason = str(error) if isinstance(error, _LifecycleError) else type(error).__name__
        return ProcessResult(False, None, '', False, False, False, reason)
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
    error = None
    while True:
        try:
            if done.is_set() and child.poll() is not None and not tree_active(child):
                break
        except OSError:
            error = '后代生命周期查询失败'
        stopped = bool(cancelled and cancelled())
        timed_out = time.monotonic() >= deadline
        if stopped or timed_out or error:
            # 格式入口拥有独立的工具进程组，先让入口取消并回收它们。
            if cooperative and os_name != 'nt':
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                    child.wait(timeout=5)
                except (OSError, subprocess.TimeoutExpired):
                    pass
            if not kill_tree(child, os_name=os_name):
                error = '进程树清理失败'
            finish = time.monotonic() + 5
            try:
                child.wait(timeout=max(0, finish - time.monotonic()))
            except subprocess.TimeoutExpired:
                error = '进程树清理未完成'
            if not done.wait(max(0, finish - time.monotonic())):
                error = '输出收尾未完成'
            break
        time.sleep(.01)
    if not close_process(child):
        error = '生命周期句柄清理失败'
    with lock:
        return ProcessResult(True, child.poll(), buffer.output, buffer.truncated, timed_out, stopped, error)
