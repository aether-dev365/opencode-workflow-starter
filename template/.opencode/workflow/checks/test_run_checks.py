"""run-checks.py 在一个进程里完成路径分析与全部守卫，结论必须与逐个运行脚本一致。"""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ALL = ['inspect-paths', 'pre-guard-paths', 'pre-secret-scan', 'pre-bash-pipefail']


class RunChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workflow-run-checks-')
        self.root = Path(self.temp.name)
        (self.root / '.git').mkdir()
        (self.root / '.opencode/workflow').mkdir(parents=True)
        (self.root / '.opencode/workflow/protection.json').write_bytes((HERE / 'fixtures/protection.json').read_bytes())

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, name, payload):
        result = subprocess.run([sys.executable, str(HERE / name)], input=json.dumps(payload), encoding='utf-8', capture_output=True, timeout=20)
        return result.returncode, json.loads(result.stdout)

    def event(self, command):
        return dict(version=1, phase='before', sessionId='s', callId='c', directory=str(self.root), tool='shell', paths=[], input={'command': command})

    def individually(self, event):
        """逐个运行脚本并像插件那样串联 input，作为对照。"""
        current = dict(event, input=dict(event['input']))
        changed = False
        for name in ALL[1:]:
            code, result = self.run_script(f'{name}.py', current)
            if result['decision'] != 'allow':
                return code, {'decision': result['decision'], 'reason': result['reason']}
            if 'input' in result:
                current['input'] = {**current['input'], **result['input']}
                changed = True
        return 0, {'decision': 'allow', **({'input': current['input']} if changed else {})}

    def test_combined_result_matches_individual_scripts(self):
        for command in ['npm test | tail -n 3', 'cat .env', 'ls -la', 'git status --short', 'echo x > vendor/a.js']:
            with self.subTest(command=command):
                event = self.event(command)
                code, combined = self.run_script('run-checks.py', {**event, 'checks': ALL})
                expected_code, expected = self.individually(event)
                self.assertEqual(code, expected_code)
                self.assertEqual({k: combined[k] for k in ('decision', 'reason', 'input') if k in combined}, expected)
                self.assertEqual(combined['inspect'], self.run_script('inspect-paths.py', event)[1]['input'])

    def test_content_dependent_decisions_are_marked_volatile(self):
        # 依赖仓库内容的结论（提交扫描、递归删除时遍历目标）不能被插件缓存，shell 创建时要按当时的内容重查。
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'build').mkdir()
        for command, volatile in [('git commit -m safe', True), ('rm -rf build', True), ('ls -la', False), ('cat README.md', False)]:
            with self.subTest(command=command):
                code, result = self.run_script('run-checks.py', {**self.event(command), 'checks': ALL})
                self.assertEqual((code, result['decision']), (0, 'allow'), result)
                self.assertEqual(result.get('volatile', False), volatile)

    def test_combined_result_for_known_commands(self):
        code, result = self.run_script('run-checks.py', {**self.event('npm test | tail -n 3'), 'checks': ALL})
        self.assertEqual((code, result['decision'], result['input']['command']), (0, 'allow', 'set -o pipefail; npm test | tail -n 3'))
        self.assertFalse(result['inspect']['readonly'])
        code, result = self.run_script('run-checks.py', {**self.event('cat .env'), 'checks': ALL})
        self.assertEqual((code, result['decision']), (2, 'deny'))
        self.assertIn('Synthetic credential protection', result['reason'])
        self.assertIn(str(self.root / '.env'), result['inspect']['paths'])
        code, result = self.run_script('run-checks.py', {**self.event('ls -la'), 'checks': ALL})
        self.assertEqual((code, result['decision'], result['inspect']['readonly']), (0, 'allow', True))
        self.assertNotIn('input', result)

    def test_file_redirects_are_not_reported_readonly(self):
        # 插件按只读分类决定是否先加载领域规则、是否检查配置；落盘的重定向和 heredoc 都在写文件。
        for command, readonly in [('> src/x', False), ('echo hi > src/x', False), ('ls >> notes.txt', False),
                                  ("cat > src/new.ts <<'EOF'\nx\nEOF", False),
                                  ('echo hi >/dev/null 2>&1', True), ('ls -la 2>&1 | head -n 3', True)]:
            with self.subTest(command=command):
                code, result = self.run_script('run-checks.py', {**self.event(command), 'checks': ALL})
                self.assertEqual((code, result['decision'], result['inspect']['readonly']), (0, 'allow', readonly))

    def test_unknown_or_missing_check_names_are_denied(self):
        for checks in [['rm-everything'], [], 'pre-guard-paths', ['pre-guard-paths', 'pre-guard-paths']]:
            with self.subTest(checks=checks):
                code, result = self.run_script('run-checks.py', {**self.event('ls'), 'checks': checks})
                self.assertEqual((code, result['decision']), (2, 'deny'))


if __name__ == '__main__':
    unittest.main()
