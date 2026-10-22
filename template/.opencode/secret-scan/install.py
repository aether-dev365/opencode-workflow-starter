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

HERE = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Verify installed bytes without network access')
    parser.add_argument('--bin-dir', type=Path, default=Path.home() / '.local/bin')
    args = parser.parse_args()
    pin = json.loads((HERE / 'pinned.json').read_text())
    arch = {'x86_64': 'x64', 'aarch64': 'arm64'}.get(platform.machine())
    key = f'{platform.system().lower()}_{arch}'
    if key not in pin['artifacts']:
        raise ValueError('当前平台未固定校验值；此入口支持 Linux x64/arm64。')
    artifact = pin['artifacts'][key]
    destination = args.bin_dir.expanduser() / 'gitleaks'
    if destination.exists() or destination.is_symlink():
        if digest(destination.read_bytes()) != artifact['binary_sha256']:
            raise ValueError('已有不同或损坏的 Gitleaks，拒绝覆盖；请用 --bin-dir 选择独立目录并调整 PATH。')
        print(f'Gitleaks {pin["version"]} checksum OK: {destination}')
        return 0
    if args.check:
        raise ValueError('未安装固定版本；先运行 python3 .opencode/secret-scan/install.py。')
    name = f'gitleaks_{pin["version"]}_{key}.tar.gz'
    url = f'https://github.com/gitleaks/gitleaks/releases/download/v{pin["version"]}/{name}'
    with urllib.request.urlopen(url, timeout=30) as response:
        archive = response.read()
    if digest(archive) != artifact['sha256']:
        raise ValueError('官方发布包 SHA-256 不匹配，拒绝安装。')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as package:
        entry = package.getmember('gitleaks')
        if not entry.isfile():
            raise ValueError('发布包中的 gitleaks 不是普通文件。')
        binary = package.extractfile(entry).read()
    if digest(binary) != artifact['binary_sha256']:
        raise ValueError('扫描器二进制 SHA-256 不匹配，拒绝安装。')
    destination.parent.mkdir(parents=True, exist_ok=True)
    # O_EXCL also prevents a concurrent installation from being overwritten.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o755)
    with os.fdopen(descriptor, 'wb') as output:
        output.write(binary)
    print(f'Installed Gitleaks {pin["version"]}: {destination}')
    print('将该目录加入 PATH；可用相同参数加 --check 离线校验。')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, tarfile.TarError) as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
