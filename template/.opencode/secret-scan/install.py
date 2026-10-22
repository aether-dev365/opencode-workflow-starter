#!/usr/bin/env python3
"""Install/check a checksum-pinned official Gitleaks binary; never overwrite one."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import sys
import tarfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
SYSTEMS = {'linux': 'linux', 'darwin': 'darwin', 'windows': 'windows'}
ARCHES = {'x86_64': 'x64', 'amd64': 'x64', 'aarch64': 'arm64', 'arm64': 'arm64'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def platform_key(system, machine):
    """官方发布包的平台名，例如 linux_x64、darwin_arm64、windows_x64；不支持的平台返回 None。"""
    name, arch = SYSTEMS.get(system.lower()), ARCHES.get(machine.lower())
    return f'{name}_{arch}' if name and arch else None


def binary_name(key):
    return 'gitleaks.exe' if key.startswith('windows_') else 'gitleaks'


def archive_name(version, key):
    return f'gitleaks_{version}_{key}.' + ('zip' if key.startswith('windows_') else 'tar.gz')


def extract_binary(archive, key):
    """Windows 发布包是 zip，其他平台是 tar.gz；只取扫描器本体，并要求它是普通文件。"""
    name = binary_name(key)
    try:
        if key.startswith('windows_'):
            with zipfile.ZipFile(io.BytesIO(archive)) as package:
                entry = package.getinfo(name)
                if entry.is_dir():
                    raise ValueError(f'发布包中的 {name} 不是普通文件。')
                return package.read(entry)
        with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
            entry = package.getmember(name)
            if not entry.isfile():
                raise ValueError(f'发布包中的 {name} 不是普通文件。')
            return package.extractfile(entry).read()
    except (KeyError, zipfile.BadZipFile, tarfile.TarError) as error:
        raise ValueError(f'发布包中没有可用的 {name}：{error}') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Verify installed bytes without network access')
    parser.add_argument('--bin-dir', type=Path, default=Path.home() / '.local/bin')
    args = parser.parse_args()
    pin = json.loads((HERE / 'pinned.json').read_text(encoding='utf-8'))
    key = platform_key(platform.system(), platform.machine())
    if key not in pin['artifacts']:
        raise ValueError('当前平台未固定校验值；此入口支持 Linux、macOS 和 Windows 的 x64/arm64。')
    artifact = pin['artifacts'][key]
    destination = args.bin_dir.expanduser() / binary_name(key)
    if destination.exists() or destination.is_symlink():
        if digest(destination.read_bytes()) != artifact['binary_sha256']:
            raise ValueError('已有不同或损坏的 Gitleaks，拒绝覆盖；请用 --bin-dir 选择独立目录并调整 PATH。')
        print(f'Gitleaks {pin["version"]} checksum OK: {destination}')
        return 0
    if args.check:
        raise ValueError(f'未安装固定版本；先运行 {"py -3" if os.name == "nt" else "python3"} .opencode/secret-scan/install.py。')
    url = f'https://github.com/gitleaks/gitleaks/releases/download/v{pin["version"]}/{archive_name(pin["version"], key)}'
    with urllib.request.urlopen(url, timeout=30) as response:
        archive = response.read()
    if digest(archive) != artifact['sha256']:
        raise ValueError('官方发布包 SHA-256 不匹配，拒绝安装。')
    binary = extract_binary(archive, key)
    if digest(binary) != artifact['binary_sha256']:
        raise ValueError('扫描器二进制 SHA-256 不匹配，拒绝安装。')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # O_EXCL also prevents a concurrent installation from being overwritten.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o755)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(binary)
    print(f'Installed Gitleaks {pin["version"]}: {destination}')
    print('将该目录加入 PATH（Windows 见 docs/workflow/opencode-install.md）；OpenCode 以后台服务运行时，再执行 opencode service restart。'
          '可用相同参数加 --check 离线校验。')
    return 0


if __name__ == '__main__':
    # 输出接管道时 Windows 默认用 ANSI 代码页（GitHub runner 上是 cp1252），中文提示会编码失败；统一按 UTF-8 输出。
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding='utf-8', errors='backslashreplace')
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, tarfile.TarError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
