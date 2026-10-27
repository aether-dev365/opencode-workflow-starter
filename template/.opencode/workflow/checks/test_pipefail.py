import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class Pipefail(unittest.TestCase):
    def test_custom_command_prefix_is_data_and_invalid_configuration_denies(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / '.opencode/workflow/pipefail.json'
            config.parent.mkdir(parents=True)
            (Path(root) / '.git').mkdir()
            event = dict(version=1, phase='before', directory=root, sessionId='s', callId='c',
                         tool='shell', paths=[], input={'command': 'cargo test | tail'})
            for value, decision in [({'version': 1, 'commandPrefixes': [['cargo', 'test']]}, 'allow'),
                                    ({'version': 1, 'commandPrefixes': 'invalid'}, 'deny')]:
                config.write_text(json.dumps(value))
                result = subprocess.run([sys.executable, str(HERE / 'pre-bash-pipefail.py')], input=json.dumps(event), encoding='utf-8', capture_output=True)
                output = json.loads(result.stdout)
                self.assertEqual(output['decision'], decision)
                if decision == 'allow':
                    self.assertTrue(output['input']['command'].startswith('set -o pipefail; '))

    def test_workdir_home_shorthand_finds_the_project_configuration(self):
        # workdir 与 OpenCode 一样展开 `~/`，配置按实际执行目录所在的检出查找。
        with tempfile.TemporaryDirectory() as home, tempfile.TemporaryDirectory() as location:
            project = Path(home) / 'project'
            config = project / '.opencode/workflow/pipefail.json'
            config.parent.mkdir(parents=True)
            (project / '.git').mkdir()
            (Path(location) / '.git').mkdir()
            config.write_text(json.dumps({'version': 1, 'commandPrefixes': [['cargo', 'test']]}))
            event = dict(version=1, phase='before', directory=location, sessionId='s', callId='c',
                         tool='shell', paths=[], input={'command': 'cargo test | tail', 'workdir': '~/project'})
            result = subprocess.run([sys.executable, str(HERE / 'pre-bash-pipefail.py')], input=json.dumps(event),
                                    encoding='utf-8', capture_output=True, env={**os.environ, 'OPENCODE_TEST_HOME': home})
            self.assertTrue(json.loads(result.stdout).get('input', {}).get('command', '').startswith('set -o pipefail; '), result.stdout)

    def test_exit_status_is_preserved_only_for_test_pipelines(self):
        with tempfile.TemporaryDirectory() as root:
            for command, changed in [
                ('npm test | tail -n 20', True), ('printf test | cat', False),
                ('npm test | grep -q passed', False), ('npm test | head -n 20', True),
                ("printf 'npm test | tail'", False),
                ('npm run legal:gen | tail -n 3', False),
                ('grep -rn pipefail docs; npm test | tail -n 20', True),
            ]:
                event = dict(version=1, phase='before', directory=root, sessionId='s', callId='c',
                             tool='shell', paths=[], input={'command': command})
                result = subprocess.run([sys.executable, str(HERE / 'pre-bash-pipefail.py')],
                                        input=json.dumps(event), encoding='utf-8', capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                value = json.loads(result.stdout)
                self.assertEqual(value.get('input', {}).get('command', command), ('set -o pipefail; ' if changed else '') + command)


if __name__ == '__main__':
    unittest.main()
