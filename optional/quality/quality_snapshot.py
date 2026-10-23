"""File-level Git selection and snapshot namespaces, independent of line checks."""

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import re
import stat
from quality_lib import Incomplete, Mode, _revision, git_bytes


REGULAR = {'100644', '100755'}
OID = re.compile(r'[0-9a-f]{40}(?:[0-9a-f]{24})?')


class Snapshot:
    def __init__(self, root, entries=None, *, worktree=False, sources=()):
        self.root = root
        self._entries = entries or {}
        self._worktree = worktree
        self._sources = sources
        self._directories = {'.'}
        for path in self._entries:
            self._directories.update(str(p) for p in PurePosixPath(path).parents)

    def _file(self, path):
        parts = PurePosixPath(path).parts
        if PurePosixPath(path).is_absolute() or '..' in parts:
            return None
        current = self.root
        for n, part in enumerate(parts):
            current /= part
            if n < len(parts) - 1:
                entry = self._entries.get('/'.join(parts[:n + 1]))
                if current.is_symlink() or (entry and entry[0] == '160000'):
                    return None
        return current

    def regular_paths(self) -> tuple[str, ...]:
        if not self._worktree:
            return tuple(sorted(p for p, (mode, _) in self._entries.items() if mode in REGULAR))
        result = []
        for path in self._sources:
            file = self._file(path)
            if file is not None:
                try:
                    if stat.S_ISREG(file.lstat().st_mode):
                        result.append(path)
                except FileNotFoundError:
                    pass
        return tuple(sorted(set(result)))

    def exists(self, path: str) -> bool:
        if not self._worktree:
            return path in self._entries or path in self._directories
        file = self._file(path)
        return file is not None and (file.exists() or file.is_symlink())

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


def _entries(root, revision=None):
    raw = git_bytes(root, 'ls-tree', '-rz', '--full-tree', revision) if revision else git_bytes(root, 'ls-files', '--stage', '-z')
    entries = {}
    try:
        if raw and not raw.endswith(b'\0'):
            raise ValueError()
        for record in raw.split(b'\0')[:-1]:
            header, path = record.split(b'\t', 1)
            mode, kind, oid = header.decode('ascii').split() if revision else ('', '', '')
            if not revision:
                mode, oid, stage = header.decode('ascii').split()
                if stage != '0':
                    raise Incomplete('索引存在冲突')
            if mode not in REGULAR | {'120000', '160000'} or not OID.fullmatch(oid):
                raise ValueError()
            path = path.decode('utf-8', 'surrogateescape')
            if not path or path.startswith('/') or '..' in PurePosixPath(path).parts or path in entries:
                raise ValueError()
            entries[path] = mode, oid
        return entries
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
        after = Snapshot(root, _entries(root))
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
        before_rev = git_bytes(root, 'merge-base', left, right).decode('ascii').strip()
        if not OID.fullmatch(before_rev):
            raise Incomplete('git 合并基点无效')
        after = Snapshot(root, _entries(root, right))
        command = ['diff', before_rev, right]
    else:
        raise Incomplete('修订号无效')
    before = Snapshot(root, _entries(root, before_rev)) if before_rev else empty
    raw = git_bytes(root, *command, '-M', '--no-ext-diff', '--no-textconv', '--raw', '--no-abbrev', '-z')
    changed, removed = set(), set()
    try:
        records = raw.split(b'\0')
        i = 0
        while i < len(records) - 1:
            header = records[i].split()
            if len(header) != 5 or not header[0].startswith(b':') or header[4][:1] not in b'AMRCDTUX':
                raise ValueError()
            status = header[4][:1]
            old = records[i + 1].decode('utf-8', 'surrogateescape')
            new = records[i + 2].decode('utf-8', 'surrogateescape') if status in (b'R', b'C') else old
            if status in (b'D', b'R'):
                removed.add(old)
            if status in (b'A', b'M', b'R', b'C', b'T') and new in after.regular_paths():
                changed.add(new)
            if status == b'U':
                raise Incomplete('索引存在冲突')
            i += 3 if status in (b'R', b'C') else 2
        if records[-1] or i != len(records) - 1:
            raise ValueError()
    except (ValueError, IndexError):
        raise Incomplete('git 差异输出无效') from None
    return FileChanges(before, after, tuple(sorted(changed)), tuple(sorted(removed)))
