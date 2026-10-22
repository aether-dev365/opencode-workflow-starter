import json
from pathlib import Path
import unittest
import tempfile
from protocol import read_event
from policy import check_path, load_policy


class Protocol(unittest.TestCase):
    def test_brace_patterns_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            config = Path(root) / '.opencode/workflow'
            config.mkdir(parents=True)
            (config / 'protection.json').write_text(json.dumps({'version': 1, 'rules': [
                {'id': 'secret', 'actions': ['read'], 'paths': ['*.{env,key}'], 'effect': 'deny', 'reason': 'x'}]}))
            with self.assertRaisesRegex(ValueError, '花括号'):
                load_policy(root)

    def test_invalid_identity_paths_and_version_are_rejected(self):
        base = dict(version=1, phase='before', directory='/workspace', sessionId='s', callId='c', tool='patch', input={}, paths=['file'])
        for update in [dict(version=2), dict(directory='relative'), dict(paths=[None]), dict(sessionId=''), dict(input={'file_paths': [1]})]:
            with self.subTest(update=update), self.assertRaises(ValueError):
                read_event(json.dumps({**base, **update}))

    def test_policy_matches_shared_native_permission_cases(self):
        root = Path(__file__).resolve().parents[3]
        policy = json.loads((Path(__file__).parent / 'fixtures/protection.json').read_text())
        cases = json.loads((Path(__file__).parent / 'fixtures/path-policy.json').read_text())
        for case in cases:
            with self.subTest(case=case):
                self.assertEqual(check_path(root, case['path'], case['action'], policy) is not None, case['deny'])
