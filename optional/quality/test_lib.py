import json
import shutil
import tempfile
import unittest
from pathlib import Path
from quality_lib import ConfigError, default_config, glob_match, load_config, selected
from quality_testing import config_from, NEEDS_SYMLINK

HERE = Path(__file__).resolve().parent


def load_text(text):
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / 'quality.json').write_text(text, encoding='utf-8')
        return load_config(Path(d))


class Config(unittest.TestCase):
    def test_missing_file_gives_defaults(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(load_config(Path(d)), default_config())
        self.assertEqual(default_config()['timeoutSeconds'], 30)
        self.assertEqual(default_config()['include'], ['*'])

    def test_example_config_is_valid(self):
        with tempfile.TemporaryDirectory() as d:
            shutil.copy(HERE / 'quality.example.json', Path(d) / 'quality.json')
            config = load_config(Path(d))
        rule = config['comments']['extraRules'][0]
        self.assertEqual((rule['id'], config['timeoutSeconds']), ('jira', 30))
        self.assertTrue(rule['regex'].search('ABC-123'))
        self.assertEqual(config['skips']['extraMarkers'][0]['category'], 'skip')

    INVALID = [
        ('{', 'quality.json'), ('[]', 'quality.json'), ('{"version": 2}', 'version'), ('{"include": ["*"]}', 'version'),
        ('{"version": true}', 'version'), ('{"version": 1, "extra": 1}', 'extra'), ('{"version": 1, "include": "*"}', 'include'),
        ('{"version": 1, "exclude": [""]}', 'exclude[0]'),
        ('{"version": 1, "timeoutSeconds": 0}', 'timeoutSeconds'), ('{"version": 1, "timeoutSeconds": 601}', 'timeoutSeconds'),
        ('{"version": 1, "timeoutSeconds": 1.5}', 'timeoutSeconds'), ('{"version": 1, "timeoutSeconds": true}', 'timeoutSeconds'),
        ('{"version": 1, "comments": {"disable": ["nope"]}}', 'comments.disable[0]'),
        ('{"version": 1, "comments": {"other": []}}', 'comments.other'),
        ('{"version": 1, "comments": {"extraRules": [{"id": "Bad", "pattern": "x", "message": "m"}]}}', 'comments.extraRules[0].id'),
        ('{"version": 1, "comments": {"extraRules": [{"id": "tracking", "pattern": "x", "message": "m"}]}}', 'comments.extraRules[0].id'),
        ('{"version": 1, "comments": {"extraRules": [{"id": "a", "pattern": "x", "message": "m"}, {"id": "a", "pattern": "y", "message": "m"}]}}', 'comments.extraRules[1].id'),
        ('{"version": 1, "comments": {"extraRules": [{"id": "a", "pattern": "(", "message": "m"}]}}', 'comments.extraRules[0].pattern'),
        ('{"version": 1, "comments": {"extraRules": [{"id": "a", "pattern": "x", "message": ""}]}}', 'comments.extraRules[0].message'),
        ('{"version": 1, "comments": {"extraRules": [{"id": "a", "pattern": "x", "message": "m", "more": 1}]}}', 'comments.extraRules[0].more'),
        ('{"version": 1, "skips": {"disable": ["later"]}}', 'skips.disable[0]'),
        ('{"version": 1, "skips": {"extraMarkers": [{"id": "a", "pattern": "x", "category": "slow"}]}}', 'skips.extraMarkers[0].category'),
        ('{"version": 1, "skips": {"extraMarkers": [{"id": "a", "pattern": "x", "paths": "*"}]}}', 'skips.extraMarkers[0].paths'),
        ('{"version": 1, "skips": {"extraMarkers": [{"id": "skip", "pattern": "x"}]}}', 'skips.extraMarkers[0].id'),
    ]

    def test_invalid_configs_name_the_field(self):
        for text, field in self.INVALID:
            with self.subTest(text=text):
                with self.assertRaises(ConfigError) as caught:
                    load_text(text)
                self.assertEqual(caught.exception.args[0], field)

    def test_wrong_container_and_required_field_types_are_rejected(self):
        for section in ['comments', 'skips']:
            key = 'extraRules' if section == 'comments' else 'extraMarkers'
            for value in [None, [], 'x']:
                with self.subTest(section=section, value=value), self.assertRaises(ConfigError):
                    load_text(json.dumps({'version': 1, section: value}))
            for value in [None, {}, [None], [{'id': 'a'}], [{'id': 'a', 'pattern': 1}]]:
                with self.subTest(section=section, value=value), self.assertRaises(ConfigError):
                    load_text(json.dumps({'version': 1, section: {key: value}}))


class FormatsConfig(unittest.TestCase):
    def test_defaults_and_independent_ids(self):
        self.assertEqual(config_from({'version': 1})['formats'], [])
        entry = config_from({'version': 1, 'formats': [self.entry(id='tracking')]})['formats'][0]
        self.assertEqual((entry['cwd'], entry['hook'], entry['timeoutSeconds']), ('.', True, 60))
        self.assertNotIn('fix', entry)
        self.assertEqual(config_from({'version': 1, 'formats': [self.entry(check=['tool'])]})['formats'][0]['check'], ['tool'])

    def entry(self, **values):
        return {'id': 'fmt', 'paths': ['*.txt'], 'check': ['tool', '{files}'], **values}

    def test_invalid_formats_name_exact_field(self):
        cases = [(None, 'formats'), ({}, 'formats'), ([None], 'formats[0]'),
                 ([{'paths': ['*'], 'check': ['x']}], 'formats[0].id'),
                 ([self.entry(), self.entry()], 'formats[1].id')]
        for key, values in {
            'id': [None, '', 'Bad', '1bad'], 'paths': [None, [], '*', ['']],
            'check': [None, [], 'x', [''], ['x', '\0'], ['{files}'], ['x', '{files}', '{files}'], ['x', '--files={files}']],
            'fix': [None, [], [''], ['x', 'prefix{files}']], 'hook': [0, 'yes'],
            'timeoutSeconds': [True, 0, 601, 1.5],
            'cwd': [None, '', '/tmp', 'C:\\example', '\\\\server\\share', '../escape', 'sub/../../escape'],
            'unknown': [True],
        }.items():
            for value in values:
                field = 'formats[0].' + key
                if key in ('paths', 'check', 'fix') and isinstance(value, list) and value and (not value[0] or '\0' in value[0]):
                    field += '[0]'
                if key == 'check' and value == ['x', '\0']:
                    field += '[1]'
                cases.append(([self.entry(**{key: value})], field))
        for value, field in cases:
            with self.subTest(value=value):
                with self.assertRaises(ConfigError) as caught:
                    config_from({'version': 1, 'formats': value})
                self.assertEqual(caught.exception.args[0], field)

    @NEEDS_SYMLINK
    def test_cwd_symlink_escape_is_configuration_error(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / 'repo'; root.mkdir()
            (root / 'outside').symlink_to(Path(d), target_is_directory=True)
            (root / 'quality.json').write_text(json.dumps({'version': 1, 'formats': [self.entry(cwd='outside')]}), encoding='utf-8')
            with self.assertRaises(ConfigError) as caught:
                load_config(root, root=root)
            self.assertEqual(caught.exception.args[0], 'formats[0].cwd')


class Selection(unittest.TestCase):
    def test_glob_matches_like_workflow_configs(self):
        for pattern, path, expected in [('*', 'a/b.py', True), ('src/*', 'src/a/b.py', True), ('src/*', 'lib/src/a.py', False),
                                        ('*.py', 'a/b.py', True), ('a?b', 'a/b', True), ('a?b', 'ab', False),
                                        ('[a].py', '[a].py', True), ('{a,b}.py', 'a.py', False)]:
            with self.subTest(pattern=pattern, path=path):
                self.assertEqual(glob_match(pattern, path), expected)

    def test_default_selection(self):
        config = default_config()
        for path in ['src/a.ts', 'Dockerfile', 'deploy/Dockerfile.prod', 'x.R', 'web/A.VUE', '.env.example', 'conf/app.ini']:
            with self.subTest(path=path):
                self.assertTrue(selected(path, config))
        for path in ['README.md', 'data.json', 'node_modules/x/a.js', 'packages/a/dist/b.js', 'vendor/a.go', 'src/generated/a.ts',
                     'web/app.min.js', 'web/app.bundle.js', 'lib/.venv/a.py', 'third_party/a.c', 'coverage/a.js', '.env', 'image.png']:
            with self.subTest(path=path):
                self.assertFalse(selected(path, config))

    def test_include_and_exclude(self):
        config = load_text(json.dumps({'version': 1, 'include': ['src/*'], 'exclude': ['src/legacy/*']}))
        self.assertEqual([selected(p, config) for p in ['src/a.ts', 'src/legacy/a.ts', 'lib/a.ts']], [True, False, False])
