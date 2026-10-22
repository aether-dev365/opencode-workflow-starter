"""扫描器安装脚本的平台映射和解包；不访问网络，固定校验值另行用官方发布包核对。"""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest
import zipfile

HERE = Path(__file__).resolve().parent
INSTALLER = HERE.parents[1] / 'secret-scan/install.py'


def load():
    spec = importlib.util.spec_from_file_location('secret_scan_install', INSTALLER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tar_with(name, data):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        info = tarfile.TarInfo(name)
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def zip_with(name, data):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('LICENSE', 'text')
        archive.writestr(name, data)
    return buffer.getvalue()


class Installer(unittest.TestCase):
    def setUp(self):
        self.install = load()

    def test_platform_keys(self):
        for system, machine, key in [('Linux', 'x86_64', 'linux_x64'), ('Linux', 'aarch64', 'linux_arm64'),
                                     ('Darwin', 'arm64', 'darwin_arm64'), ('Darwin', 'x86_64', 'darwin_x64'),
                                     ('Windows', 'AMD64', 'windows_x64'), ('Windows', 'ARM64', 'windows_arm64'),
                                     ('FreeBSD', 'amd64', None), ('Linux', 'riscv64', None)]:
            with self.subTest(system=system, machine=machine):
                self.assertEqual(self.install.platform_key(system, machine), key)

    def test_windows_binary_comes_from_the_zip(self):
        self.assertEqual(self.install.extract_binary(zip_with('gitleaks.exe', b'windows-binary'), 'windows_x64'), b'windows-binary')
        for archive in [zip_with('other.exe', b'x'), tar_with('gitleaks.exe', b'x')]:
            with self.assertRaises(ValueError):
                self.install.extract_binary(archive, 'windows_x64')

    def test_posix_binary_comes_from_the_tarball(self):
        self.assertEqual(self.install.extract_binary(tar_with('gitleaks', b'posix-binary'), 'darwin_arm64'), b'posix-binary')
        with self.assertRaises(ValueError):
            self.install.extract_binary(tar_with('other', b'x'), 'linux_x64')

    def test_every_supported_platform_has_both_digests(self):
        pins = json.loads((INSTALLER.parent / 'pinned.json').read_text(encoding='utf-8'))['artifacts']
        self.assertEqual(sorted(pins), ['darwin_arm64', 'darwin_x64', 'linux_arm64', 'linux_x64', 'windows_arm64', 'windows_x64'])
        for key, artifact in pins.items():
            for name in ('sha256', 'binary_sha256'):
                self.assertRegex(artifact[name], r'^[0-9a-f]{64}$', f'{key}.{name}')


if __name__ == '__main__':
    unittest.main()
