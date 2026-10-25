import contextlib
import io
import json
import os
import subprocess
import sys
import unittest
from unittest import mock
from quality_lib import Incomplete
import quality_snapshot as snapshot
from quality_testing import TempRepo, load_script


@contextlib.contextmanager
def legacy_git():
    run = subprocess.run
    calls = []

    def invoke(argv, **kwargs):
        if argv[0] == 'git':
            calls.append(argv)
            if any(arg.startswith('--ita-') for arg in argv):
                return subprocess.CompletedProcess(argv, 129, b'', b'error: unknown option ita-invisible-in-index')
        return run(argv, **kwargs)

    with mock.patch.object(subprocess, 'run', side_effect=invoke):
        yield calls


class LegacyIndex(unittest.TestCase):
    def repo(self):
        repo = TempRepo(); self.addCleanup(repo.close)
        return repo, repo.install_scripts()

    def links(self, repo, here, code, mode='--staged'):
        with contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            result = load_script('check-links.py').main([mode], here=here, cwd=repo.root)
        self.assertEqual(result, code, out.getvalue() + err.getvalue())
        return out.getvalue()

    def test_staged_links_and_format_without_ita_switches(self):
        repo, here = self.repo()
        repo.write('doc.md', '[x](target.txt)')
        repo.write('target.txt', '')
        repo.git('add', 'doc.md', 'target.txt')
        marker = repo.root / 'ran'
        (here / 'quality.json').write_text(json.dumps({'version': 1, 'formats': [{
            'id': 'fmt', 'paths': ['*.txt'], 'check': [sys.executable, '-c',
                'from pathlib import Path; Path("ran").touch()']}]}), encoding='utf-8')
        with legacy_git():
            self.links(repo, here, 0)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                result = load_script('check-format.py').main(['--staged'], here=here, cwd=repo.root)
            self.assertEqual(result, 0, out.getvalue())
        self.assertTrue(marker.exists())

    def test_ita_variants_are_readonly_and_distinct_from_staged_empty_files(self):
        for state in ('unborn', 'head', 'old-empty', 'old-content'):
            with self.subTest(state=state):
                repo, here = self.repo()
                target = 'new/中文 [x].txt'
                if state.startswith('old-'):
                    repo.write(target, '' if state == 'old-empty' else 'old')
                if state != 'unborn':
                    repo.commit()
                if state.startswith('old-'):
                    repo.git('rm', '--cached', target)
                repo.write(target, '')
                repo.git('add', '-N', target)
                repo.write('doc.md', '[file](<new/中文 [x].txt>) [dir](new/)')
                repo.git('add', 'doc.md')
                index = (repo.root / '.git/index').read_bytes()
                objects = sorted((repo.root / '.git/objects').rglob('*'))
                with legacy_git():
                    self.assertIn('2 处断链', self.links(repo, here, 1))
                    self.links(repo, here, 0, '--all')
                self.assertEqual((repo.root / '.git/index').read_bytes(), index)
                self.assertEqual(sorted((repo.root / '.git/objects').rglob('*')), objects)
                repo.git('add', target)
                with legacy_git():
                    self.assertIn('0 处断链', self.links(repo, here, 0))

    def test_index_flags_are_batched_and_paths_remain_data(self):
        repo, _ = self.repo()
        names = ['a space.txt', '中文.txt', 'flags 20000000.txt']
        if os.name != 'nt':
            names.append('tab\tline\nflags: 20000000.txt')
        for name in names:
            repo.write(name, '')
        repo.git('add', '.')
        repo.write('ita/empty', ''); repo.git('add', '-N', 'ita/empty')
        with legacy_git() as calls:
            result = snapshot.collect_files(repo.root, ('staged', None))
            small = len(calls)
        self.assertTrue(all(result.after.exists(name) for name in names))
        self.assertFalse(result.after.exists('ita'))
        for i in range(100):
            repo.write(f'extra/{i}.txt', '')
        repo.git('add', 'extra')
        with legacy_git() as calls:
            result = snapshot.collect_files(repo.root, ('staged', None))
        self.assertEqual(len(calls), small)
        self.assertTrue(all(result.after.exists(f'extra/{i}.txt') for i in range(100)))

    def test_ita_replacement_affects_unchanged_documents_on_old_git(self):
        for content in ('', 'tracked'):
            with self.subTest(content=content):
                repo, here = self.repo()
                repo.write('doc.md', '[file](asset/target.txt) [dir](asset/)')
                repo.write('asset/target.txt', content); repo.commit()
                repo.git('rm', '--cached', 'asset/target.txt')
                repo.git('add', '-N', 'asset/target.txt')
                with legacy_git():
                    self.assertIn('2 处断链', self.links(repo, here, 1))

    def test_invalid_index_debug_output_is_not_assumed_to_have_no_ita(self):
        repo, _ = self.repo()
        repo.write('target.txt', ''); repo.git('add', 'target.txt')
        git = snapshot.git_bytes
        valid = git(repo.root, 'ls-files', '--stage', '--debug', '-z')
        for raw in (b'bad', valid.split(b'\0')[0] + b'\0', valid[:-1],
                    valid.replace(b'flags: 0', b'flags: nope'), valid + valid):
            def query(root, *args, **kwargs):
                return raw if '--debug' in args else git(root, *args, **kwargs)
            with self.subTest(raw=raw), mock.patch.object(snapshot, 'git_bytes', side_effect=query):
                with self.assertRaises(Incomplete):
                    snapshot.collect_files(repo.root, ('staged', None))
