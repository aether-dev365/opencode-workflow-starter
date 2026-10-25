import ast
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from quality_lib import ConfigError, default_config, glob_match, load_config, selected
import quality_lib
from quality_testing import config_from, NEEDS_SYMLINK, TempRepo

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
        self.assertEqual(config['sync'], [])

    def test_sync_entries_get_defaults(self):
        self.assertEqual(default_config()['sync'], [])
        entry = {'id': 'api', 'paths': ['src/*'], 'related': ['docs/api.md'], 'message': '接口变化要同步文档'}
        self.assertEqual(config_from({'version': 1, 'sync': [entry]})['sync'],
                         [{**entry, 'exclude': [], 'on': ['add', 'modify', 'delete']}])

    def test_glob_patterns_compile_once(self):
        self.assertIs(quality_lib.glob_regex('src/*'), quality_lib.glob_regex('src/*'))

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
        ('{"version": 1, "sync": {}}', 'sync'),
        ('{"version": 1, "sync": [{"id": "Bad", "paths": ["a"], "related": ["b"], "message": "m"}]}', 'sync[0].id'),
        ('{"version": 1, "sync": [{"id": "a", "paths": ["a"], "related": ["b"], "message": "m"}, {"id": "a", "paths": ["a"], "related": ["b"], "message": "m"}]}', 'sync[1].id'),
        ('{"version": 1, "sync": [{"id": "a", "related": ["b"], "message": "m"}]}', 'sync[0].paths'),
        ('{"version": 1, "sync": [{"id": "a", "paths": [], "related": ["b"], "message": "m"}]}', 'sync[0].paths'),
        ('{"version": 1, "sync": [{"id": "a", "paths": ["a"], "related": [], "message": "m"}]}', 'sync[0].related'),
        ('{"version": 1, "sync": [{"id": "a", "paths": ["a"], "exclude": [""], "related": ["b"], "message": "m"}]}', 'sync[0].exclude[0]'),
        ('{"version": 1, "sync": [{"id": "a", "paths": ["a"], "related": ["b"], "message": ""}]}', 'sync[0].message'),
        ('{"version": 1, "sync": [{"id": "a", "paths": ["a"], "related": ["b"], "message": "m", "on": ["rename"]}]}', 'sync[0].on[0]'),
        ('{"version": 1, "sync": [{"id": "a", "paths": ["a"], "related": ["b"], "message": "m", "on": []}]}', 'sync[0].on'),
        ('{"version": 1, "sync": [{"id": "a", "paths": ["a"], "related": ["b"], "message": "m", "extra": 1}]}', 'sync[0].extra'),
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


class LinksConfig(unittest.TestCase):
    def test_link_defaults_and_invalid_config(self):
        self.assertEqual(config_from({'version': 1})['links'], {'exclude': [], 'ignoreTargets': []})
        cases = [(None, 'links'), ([], 'links'), ({'unknown': []}, 'links.unknown')]
        for key in ('exclude', 'ignoreTargets'):
            cases += [({key: value}, 'links.' + key + ('[0]' if value == [''] else ''))
                      for value in (None, '*', [''])]
        for links, field in cases:
            with self.subTest(links=links), self.assertRaises(ConfigError) as caught:
                config_from({'version': 1, 'links': links})
            self.assertEqual(caught.exception.args[0], field)


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


class EntryImports(unittest.TestCase):
    ENTRIES = {'review-comments.py': '注释审核', 'check-skips.py': '跳过测试检查', 'check-links.py': '链接检查',
               'check-format.py': '格式检查', 'check-sync.py': '关联检查'}

    def test_missing_or_mismatched_shared_module_is_incomplete(self):
        # 退出 1 会被 CI 记为提醒或失败，导入失败必须以 2 报告未完成。
        for content, error in ((None, 'ModuleNotFoundError'), ('', 'ImportError')):
            repo = TempRepo(); self.addCleanup(repo.close)
            here = repo.install_scripts()
            if content is None:
                (here / 'quality_lib.py').unlink()
            else:
                (here / 'quality_lib.py').write_text(content, encoding='utf-8')
            for entry, name in self.ENTRIES.items():
                with self.subTest(entry=entry, error=error):
                    result = repo.run(here / entry, '--all')
                    self.assertEqual((result.returncode, result.stdout, result.stderr),
                                     (2, '', f'{name}未完成：质量扩展文件不完整（{error}）\n'))

    def test_old_python_is_told_the_required_version(self):
        # 共用模块用到 3.10 的写法，旧版本导入时的报错会被误读成文件不完整；入口须能在 3.9 语法下解析到版本检查。
        repo = TempRepo(); self.addCleanup(repo.close)
        here = repo.install_scripts()
        for entry, name in self.ENTRIES.items():
            with self.subTest(entry=entry):
                ast.parse((here / entry).read_text(encoding='utf-8'), feature_version=(3, 9))
                # 旧版本可能缺少新的标准库模块：拦截入口自己的全部新导入，版本检查必须先于它们执行。
                code = ('import sys\nsys.version_info = (3, 9, 18, "final", 0)\n'
                        f'path = {str(here / entry)!r}\nsource = open(path, encoding="utf-8").read()\n'
                        'class Block:\n    def find_spec(self, name, *args):\n        raise ImportError(name)\n'
                        'sys.argv = [path, "--all"]\nsys.meta_path.insert(0, Block())\n'
                        'exec(compile(source, path, "exec"), {"__name__": "__main__", "__file__": path})\n')
                result = subprocess.run([sys.executable, '-c', code], cwd=repo.root, env=repo.env,
                                        encoding='utf-8', errors='replace', capture_output=True, timeout=60)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (2, '', f'{name}未完成：需要 Python 3.10 或更高版本\n'))
