"""非 UTF-8 环境不能改变检查结论：Windows 的 open() 与管道默认使用 ANSI 代码页（cp936、cp1252 等）。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
# 模板实际使用的保护配置，reason 为中文。
PROTECTION = HERE.parent / 'protection.json'
DENIED = '真实凭据不可读取或编辑'


def clean_env(**extra):
    env = {k: v for k, v in os.environ.items() if k not in ('PYTHONUTF8', 'PYTHONIOENCODING', 'LC_ALL', 'LC_CTYPE', 'LANG')}
    env.update(extra)
    return env


class Encoding:
    env = None
    prefix = 'workflow-'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix=self.prefix)
        self.root = Path(self.temp.name)
        (self.root / '.git').mkdir()
        (self.root / '.opencode/workflow').mkdir(parents=True)
        (self.root / '.opencode/workflow/protection.json').write_bytes(PROTECTION.read_bytes())

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, name, payload):
        result = subprocess.run([sys.executable, str(HERE / name)], input=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
                                capture_output=True, env=self.env, timeout=20)
        self.assertTrue(result.stdout, result.stderr.decode('utf-8', 'replace'))
        return result.returncode, json.loads(result.stdout.decode('utf-8'))

    def event(self, tool='shell', paths=None, **tool_input):
        return dict(version=1, phase='before', sessionId='s', callId='c', directory=str(self.root),
                    tool=tool, paths=paths or [], input=tool_input)


class LegacyLocale(Encoding, unittest.TestCase):
    """open() 默认编码不是 UTF-8。Linux 上 C 区域会让文件系统编码也退化为 ASCII，所以这里只用 ASCII 路径。"""
    env = clean_env(LC_ALL='C', LANG='C', PYTHONCOERCECLOCALE='0', PYTHONUTF8='0')

    def test_guard_denies_with_utf8_reason(self):
        code, result = self.run_script('pre-guard-paths.py', self.event(tool='write', paths=[str(self.root / 'conf/.env')]))
        self.assertEqual((code, result['decision']), (2, 'deny'))
        self.assertIn(DENIED, result['reason'])

    def test_guard_allows_ordinary_command(self):
        code, result = self.run_script('pre-guard-paths.py', self.event(command='ls -la'))
        self.assertEqual((code, result['decision']), (0, 'allow'))

    def test_pipefail_reads_utf8_config(self):
        (self.root / '.opencode/workflow/pipefail.json').write_text(
            json.dumps({'version': 1, 'commandPrefixes': [['测试工具', 'run']]}, ensure_ascii=False), encoding='utf-8')
        code, result = self.run_script('pre-bash-pipefail.py', self.event(command='测试工具 run | tail -n 3'))
        self.assertEqual(code, 0)
        self.assertEqual(result['input']['command'], 'set -o pipefail; 测试工具 run | tail -n 3')

    def test_policy_cli_reads_utf8_protection(self):
        code, result = self.run_script('policy.py', {'root': str(self.root), 'action': 'read', 'paths': ['conf/.env', 'README.md']})
        self.assertEqual((code, result), (0, {'denied': ['conf/.env']}))


class LegacyPipes(Encoding, unittest.TestCase):
    """管道使用 ANSI 代码页，路径与文件系统仍是 Unicode：Node 发送的 UTF-8 JSON 不能被错误解码。"""
    env = clean_env(PYTHONIOENCODING='cp1252')
    prefix = '工作流-'

    def test_inspect_keeps_non_ascii_paths(self):
        code, result = self.run_script('inspect-paths.py', self.event(command='cat 文档/说明.md'))
        self.assertEqual(code, 0)
        self.assertIn(str(self.root / '文档/说明.md'), result['input']['paths'])

    def test_guard_reports_non_ascii_protected_path(self):
        code, result = self.run_script('pre-guard-paths.py', self.event(tool='write', paths=[str(self.root / '配置/.env')]))
        self.assertEqual((code, result['decision']), (2, 'deny'))
        self.assertIn(DENIED, result['reason'])
        self.assertIn(str(self.root / '配置/.env'), result['reason'])

    def test_policy_cli_reports_non_ascii_paths(self):
        code, result = self.run_script('policy.py', {'root': str(self.root), 'action': 'read', 'paths': ['配置/.env', '文档/说明.md']})
        self.assertEqual((code, result), (0, {'denied': ['配置/.env']}))

    def test_secret_scan_passes_non_commit_command(self):
        code, result = self.run_script('pre-secret-scan.py', self.event(command='echo 你好'))
        self.assertEqual((code, result['decision']), (0, 'allow'))


if __name__ == '__main__':
    unittest.main()
