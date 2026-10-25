"""Versioned, harness-independent check input and output."""
import json
import os
import signal
import subprocess
import sys


def utf8_stdio() -> None:
    """插件与检查器之间的 JSON 固定为 UTF-8；Windows 管道默认使用 ANSI 代码页（cp936、cp1252 等）。"""
    for stream, errors in ((sys.stdin, 'strict'), (sys.stdout, 'strict'), (sys.stderr, 'backslashreplace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure:
            reconfigure(encoding='utf-8', errors=errors)


# 所有检查器都先导入本模块，再读取 stdin。
utf8_stdio()


def read_event(raw: str) -> dict:
    data = json.loads(raw)
    if not isinstance(data, dict) or data.get('version') != 1:
        raise ValueError('Unsupported check event')
    if data.get('phase') not in ('before', 'after', 'inspect'):
        raise ValueError('Missing phase')
    for name in ('sessionId', 'callId', 'directory', 'tool'):
        if not isinstance(data.get(name), str) or not data[name]:
            raise ValueError('Missing event identity')
    if not os.path.isabs(data['directory']):
        raise ValueError('Location must be absolute')
    if not isinstance(data.get('input'), dict) or not isinstance(data.get('paths'), list):
        raise ValueError('Incomplete tool input')
    if not all(isinstance(path, str) and path for path in data['paths']):
        raise ValueError('Invalid paths')
    if 'file_paths' in data['input']:
        paths = data['input']['file_paths']
        if not isinstance(paths, list) or not all(isinstance(path, str) and path for path in paths):
            raise ValueError('Invalid tool paths')
    for name in ('command', 'workdir', 'file_path'):
        if name in data['input'] and not isinstance(data['input'][name], str):
            raise ValueError('Invalid tool input')
    if 'stateDirectory' in data and (not isinstance(data['stateDirectory'], str)
                                     or not os.path.isabs(data['stateDirectory'])):
        raise ValueError('Invalid state directory')
    return data


def emit_result(decision: str = 'allow', *, reason: str = '', input: dict | None = None,
                reminders: list[str] | None = None, extra: dict | None = None) -> None:
    if decision not in ('allow', 'deny', 'ask'):
        raise ValueError('Invalid check decision')
    reminder_text = '\n'.join(reminders or [])
    if len(reminder_text) > 8000:
        reminder_text = reminder_text[:7970] + '\n…（已截断，请运行完整检查）'
        reminders = [reminder_text]
    result = dict(decision=decision, reminders=reminders or [])
    if reason:
        result['reason'] = reason
    if input is not None:
        result['input'] = input
    if extra:
        result.update(extra)
    print(json.dumps(result, ensure_ascii=False))
    if decision == 'deny' and reason:
        print(reason, file=sys.stderr)


def load_event() -> dict:
    try:
        return read_event(sys.stdin.read())
    except (ValueError, TypeError, OSError):
        emit_result('deny', reason='已拦截：检查输入不完整或无效；未执行操作。')
        raise SystemExit(2) from None


class _NodeCheckJob:
    def __init__(self):
        import ctypes as c
        from ctypes import wintypes as w
        self.c, self.handle = c, None
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

        class ThreadEntry(c.Structure):
            _fields_ = [('size', w.DWORD), ('usage', w.DWORD), ('tid', w.DWORD),
                        ('pid', w.DWORD), ('base_priority', w.LONG),
                        ('delta_priority', w.LONG), ('flags', w.DWORD)]

        self.ThreadEntry = ThreadEntry
        signatures = {
            'CreateJobObjectW': ([c.c_void_p, w.LPCWSTR], w.HANDLE),
            'SetInformationJobObject': ([w.HANDLE, c.c_int, c.c_void_p, w.DWORD], w.BOOL),
            'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
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
        # Popen 已关闭主线程句柄；进程仍挂起，归入 Job 后才恢复唯一的初始线程。
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
                        if self.kernel.ResumeThread(thread) != 1:
                            raise OSError('挂起的 Node 主线程无法安全恢复')
                        return
                    finally:
                        self.kernel.CloseHandle(thread)
                found = self.kernel.Thread32Next(snapshot, self.c.byref(entry))
            raise OSError('找不到挂起的 Node 主线程')
        finally:
            self.kernel.CloseHandle(snapshot)

    def close(self):
        if self.handle is not None:
            self._check(self.kernel.CloseHandle(self.handle))
            self.handle = None


def run_node_check(argv, *, os_name=None):
    """原始继承 stdout/stderr；Windows 在任何 Node 代码执行前完成 Job 归属。"""
    if not argv or any(not isinstance(value, str) or not value or '\0' in value for value in argv):
        raise ValueError('Node 自检命令无效')
    windows = (os_name or os.name) == 'nt'
    job = child = None
    try:
        if windows:
            job = _NodeCheckJob()
        options = {'creationflags': 0x08000004} if windows else {'start_new_session': True}
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, **options)
        if job is not None:
            job.assign(child)
            job.resume(child)
        return child.wait()
    except (OSError, ValueError, AttributeError, subprocess.SubprocessError) as error:
        if child is not None:
            child.kill()
            child.wait(timeout=5)
        raise OSError('Node 自检生命周期验证失败：' + type(error).__name__) from error
    finally:
        if job is not None:
            job.close()
        elif child is not None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
