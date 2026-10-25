"""File-level Git selection and snapshot namespaces, independent of line checks."""

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import os
import re
import stat
from quality_lib import Incomplete, Mode, _revision, git_bytes


REGULAR = {'100644', '100755'}
OID = re.compile(r'[0-9a-f]{40}(?:[0-9a-f]{24})?')
INDEX_DEBUG = re.compile(
    rb'  ctime: -?\d+:-?\d+\n  mtime: -?\d+:-?\d+\n'
    rb'  dev: -?\d+\tino: -?\d+\n  uid: -?\d+\tgid: -?\d+\n'
    rb'  size: -?\d+\tflags: ([0-9a-fA-F]+)\n')


def _link_entry(info):
    # Python 3.10 的 lstat 已提供 reparse 属性；无需 Path.is_junction。
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, 'st_file_attributes', 0) & 0x400)


def _windows_special(part):
    device = part.split('.')[0].rstrip(' ').upper()
    return (part.endswith((' ', '.')) or device in {'CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$'}
            or re.fullmatch(r'(?:COM|LPT)[1-9¹²³]', device) is not None)


class Snapshot:
    def __init__(self, root, entries=None, *, worktree=False, sources=(), os_name=None):
        self.root = root
        self._entries = entries or {}
        self._worktree = worktree
        self._sources = sources
        self._os_name = os_name or os.name
        self._directories = {'.'}
        for path in self._entries:
            self._directories.update(str(p) for p in PurePosixPath(path).parents)

    def _file(self, path):
        parts = PurePosixPath(path).parts
        if PurePosixPath(path).is_absolute() or '..' in parts:
            return None
        if self._os_name == 'nt' and ('\\' in path or ':' in path or any(_windows_special(p) for p in parts)):
            return None
        current = self.root
        for n, part in enumerate(parts):
            current /= part
            if n < len(parts) - 1:
                entry = self._entries.get('/'.join(parts[:n + 1]))
                try:
                    info = current.lstat()
                except FileNotFoundError:
                    return None
                if _link_entry(info) or (entry and entry[0] == '160000'):
                    return None
        return current

    def regular_paths(self, paths=None) -> tuple[str, ...]:
        if not self._worktree:
            return tuple(sorted(p for p, (mode, _) in self._entries.items() if mode in REGULAR))
        result = []
        for path in self._sources if paths is None else paths:
            file = self._file(path)
            if file is not None:
                try:
                    info = file.lstat()
                    if stat.S_ISREG(info.st_mode) and not _link_entry(info):
                        result.append(path)
                except FileNotFoundError:
                    pass
        return tuple(sorted(set(result)))

    def paths(self, regular=()) -> tuple[str, ...]:
        # regular 是调用方刚由 regular_paths 确认的常规文件，不再逐个 lstat。
        if not self._worktree:
            return tuple(sorted(self._entries))
        known = set(regular)
        return tuple(sorted(known | {p for p in set(self._sources) - known if self.exists(p)}))

    def exists(self, path: str) -> bool:
        if not self._worktree:
            return path in self._entries or path in self._directories
        file = self._file(path)
        if file is None:
            return False
        try:
            info = file.lstat()
        except FileNotFoundError:
            return False
        return stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or _link_entry(info)

    def read_many(self, paths: list[str]) -> dict[str, bytes]:
        paths = list(dict.fromkeys(paths))
        if not paths:
            return {}
        try:
            if self._worktree:
                regular = set(self.regular_paths())
                if not set(paths) <= regular:
                    raise Incomplete('文件已不在快照中')
                result = {}
                for path in paths:
                    try:
                        result[path] = self._file(path).read_bytes()
                    except OSError:
                        # 缺失的键由消费者作为单文件未完成报告，其他文件仍可检查。
                        pass
                return result
            oids = [self._entries[path][1] for path in paths]
            output = git_bytes(self.root, 'cat-file', '--batch', input=''.join(oid + '\n' for oid in oids).encode('ascii'))
            offset, result = 0, {}
            for path, oid in zip(paths, oids):
                end = output.index(b'\n', offset)
                header = output[offset:end].split()
                if len(header) != 3 or header[:2] != [oid.encode('ascii'), b'blob'] or not header[2].isdigit():
                    raise ValueError()
                size = int(header[2])
                stop = end + 1 + size
                if output[stop:stop + 1] != b'\n':
                    raise ValueError()
                result[path] = output[end + 1:stop]
                offset = stop + 1
            if offset != len(output):
                raise ValueError()
            return result
        except (OSError, ValueError, KeyError, IndexError):
            raise Incomplete('快照内容读取失败') from None


@dataclass(frozen=True)
class FileChanges:
    before: Snapshot
    after: Snapshot
    changed: tuple[str, ...]
    removed: tuple[str, ...]
    merge: bool = False


def change_events(changes: FileChanges) -> tuple[tuple[str, str], ...]:
    """按两侧快照条目（mode、oid）之差给出新增、修改、删除；工作区快照没有改动前一侧，返回空。"""
    if changes.after._worktree:
        return ()
    before, after = changes.before._entries, changes.after._entries
    events = [(path, 'delete') for path in before.keys() - after.keys()]
    events += [(path, 'add') for path in after.keys() - before.keys()]
    events += [(path, 'modify') for path in before.keys() & after.keys() if before[path] != after[path]]
    return tuple(sorted(events))


def _entries(root, revision=None, *, staged=False):
    raw = (git_bytes(root, 'ls-tree', '-rz', '--full-tree', revision) if revision else
           git_bytes(root, 'ls-files', '--stage', '-z', *(['--debug'] if staged else [])))
    entries = {}
    omitted = set()
    try:
        offset = 0
        while offset < len(raw):
            end = raw.index(b'\0', offset)
            record = raw[offset:end]
            offset = end + 1
            flags = 0
            if staged:
                # Git 2.5 已支持此输出；NUL 分隔路径，固定元数据格式必须完整有效。
                metadata = INDEX_DEBUG.match(raw, offset)
                if metadata is None:
                    raise ValueError()
                flags = int(metadata[1], 16)
                offset = metadata.end()
            header, path = record.split(b'\t', 1)
            mode, kind, oid = header.decode('ascii').split() if revision else ('', '', '')
            if not revision:
                mode, oid, stage = header.decode('ascii').split()
                if stage != '0':
                    raise Incomplete('索引存在冲突')
            if mode not in REGULAR | {'120000', '160000'} or not OID.fullmatch(oid):
                raise ValueError()
            if revision and kind != ('commit' if mode == '160000' else 'blob'):
                raise ValueError()
            path = path.decode('utf-8', 'surrogateescape')
            if not path or path.startswith('/') or '..' in PurePosixPath(path).parts or path in entries:
                raise ValueError()
            entries[path] = mode, oid
            if flags & (1 << 29):  # CE_INTENT_TO_ADD，不能根据空 blob 判断。
                omitted.add(path)
        return {path: entry for path, entry in entries.items() if path not in omitted}
    except (ValueError, IndexError, UnicodeError):
        raise Incomplete('git 快照输出无效') from None


def collect_files(root: Path, mode: Mode) -> FileChanges:
    kind, rev = mode
    empty = Snapshot(root)
    before_rev = None
    if kind == 'all':
        entries = _entries(root)
        raw = git_bytes(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard')
        if raw and not raw.endswith(b'\0'):
            raise Incomplete('git 文件清单无效')
        sources = [p.decode('utf-8', 'surrogateescape') for p in raw.split(b'\0') if p]
        after = Snapshot(root, entries, worktree=True, sources=sources)
        return FileChanges(empty, after, after.regular_paths(), ())
    if kind == 'commit':
        sha = _revision(root, rev)
        parents = git_bytes(root, 'rev-list', '--parents', '-n', '1', sha).decode('ascii').split()
        if not parents or any(not OID.fullmatch(p) for p in parents) or parents[0] != sha:
            raise Incomplete('git 历史输出无效')
        if len(parents) > 2:
            return FileChanges(empty, empty, (), (), True)
        before_rev = parents[1] if len(parents) == 2 else None
        after = Snapshot(root, _entries(root, sha))
        command = ['diff-tree', '-r', '--root', '--no-commit-id', sha]
    elif kind == 'staged':
        after = Snapshot(root, _entries(root, staged=True))
        # 未出生分支没有 HEAD，其他 Git 故障仍由后续命令报告。
        try:
            before_rev = _revision(root, 'HEAD')
        except Incomplete:
            git_bytes(root, 'symbolic-ref', 'HEAD')
        command = ['diff', '--cached']
    elif kind == 'range':
        parts = rev.split('..')
        if len(parts) != 2 or not all(parts) or '...' in rev:
            raise Incomplete('修订号无效')
        left, right = (_revision(root, p) for p in parts)
        before_rev = git_bytes(root, 'merge-base', left, right, reason='范围两端没有共同历史').decode('ascii').strip()
        if not OID.fullmatch(before_rev):
            raise Incomplete('git 合并基点无效')
        after = Snapshot(root, _entries(root, right))
        command = ['diff', before_rev, right]
    else:
        raise Incomplete('修订号无效')
    before = Snapshot(root, _entries(root, before_rev)) if before_rev else empty
    raw = git_bytes(root, *command, '-M', '--no-ext-diff', '--no-textconv', '--raw', '--no-abbrev', '-z')
    changed, removed = set(), set()
    regular = set(after.regular_paths())
    try:
        records = raw.split(b'\0')
        i = 0
        while i < len(records) - 1:
            header = records[i].split()
            if (len(header) != 5 or header[0][1:].decode('ascii') not in REGULAR | {'000000', '120000', '160000'}
                    or not header[0].startswith(b':') or header[1].decode('ascii') not in REGULAR | {'000000', '120000', '160000'}
                    or any(not OID.fullmatch(oid.decode('ascii')) for oid in header[2:4])
                    or not re.fullmatch(rb'(?:[AMDTU]|[RC](?:100|[0-9]{1,2}))', header[4])):
                raise ValueError()
            status = header[4][:1]
            old = records[i + 1].decode('utf-8', 'surrogateescape')
            new = records[i + 2].decode('utf-8', 'surrogateescape') if status in (b'R', b'C') else old
            if status in (b'D', b'R'):
                removed.add(old)
            if status in (b'A', b'M', b'R', b'C', b'T') and new in regular:
                changed.add(new)
            if status == b'U':
                raise Incomplete('索引存在冲突')
            i += 3 if status in (b'R', b'C') else 2
        if records[-1] or i != len(records) - 1:
            raise ValueError()
    except (ValueError, IndexError, UnicodeError):
        raise Incomplete('git 差异输出无效') from None
    if kind == 'staged':
        # 旧 Git 的 diff 把 ITA 显示为空文件；删除影响以实际可提交命名空间为准。
        removed.update(before._entries.keys() - after._entries.keys())
    return FileChanges(before, after, tuple(sorted(changed)), tuple(sorted(removed)))
