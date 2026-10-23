import contextlib
import io
import json
from pathlib import Path
import unittest
from unittest import mock
from quality_testing import TempRepo, load_script, NEEDS_SYMLINK
import quality_snapshot


class LinkChecks(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo(); self.addCleanup(self.repo.close)
        self.here = self.repo.install_scripts()
        self.repo.commit('scripts')

    def run_links(self, *args, code=0, cwd=None):
        result = self.repo.run(self.here / 'check-links.py', *args, cwd=cwd)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def configure(self, **values):
        (self.here / 'quality.json').write_text(json.dumps({'version': 1, **values}), encoding='utf-8')

    def test_link_defaults_and_invalid_config(self):
        self.configure(links={'unknown': []})
        self.assertIn('配置无效：links.unknown', self.run_links('--all', code=2))

    def test_changed_document_checks_all_links_and_reports_each_target(self):
        self.repo.write('doc.md', '[old](old.md)\n'); self.repo.commit()
        self.repo.write('doc.md', '[old](old.md)\n[z](z.md) [a](a.md)\n'); self.repo.commit()
        lines = self.run_links(code=1).splitlines()
        self.assertEqual(lines, ['doc.md:1: [link] 链接目标不存在：old.md',
                                 'doc.md:2: [link] 链接目标不存在：a.md', 'doc.md:2: [link] 链接目标不存在：z.md',
                                 '链接检查：检查了 1 个文档，3 处断链。'])

    def test_four_modes_use_their_snapshot(self):
        self.repo.write('doc.md', '[a](commit.txt)'); self.repo.write('commit.txt', '')
        base = self.repo.commit()
        self.repo.write('doc.md', '[a](index.txt)'); self.repo.git('add', 'doc.md')
        self.repo.write('index.txt', '')
        self.repo.write('doc.md', '[a](worktree.txt)'); self.repo.write('worktree.txt', '')
        self.run_links('--commit', base)
        self.assertIn('index.txt', self.run_links('--staged', code=1))
        self.run_links('--all')
        self.repo.git('checkout', '-b', 'right')
        self.repo.write('doc.md', '[a](right-missing.txt)'); right = self.repo.commit()
        self.repo.git('checkout', 'main')
        self.repo.write('right-missing.txt', '')
        out = self.run_links('--range', base + '..' + right, code=1, cwd=self.repo.root / 'scripts')
        self.assertIn('right-missing.txt', out); self.assertNotIn('worktree.txt', out)

    def test_document_rename_changes_relative_base(self):
        self.repo.write('doc.md', '[a](asset.txt)'); self.repo.write('asset.txt', ''); self.repo.commit()
        (self.repo.root / 'sub').mkdir(); self.repo.git('mv', 'doc.md', 'sub/doc.md'); self.repo.commit()
        self.assertIn('sub/doc.md:1: [link]', self.run_links(code=1))

    def asset_fixture(self, text='[image](assets/a.png)'):
        self.repo.write('doc.md', text); self.repo.write('assets/a.png', 'png'); self.repo.commit()

    def test_deleted_excluded_asset_affects_unchanged_doc(self):
        self.asset_fixture()
        self.repo.git('rm', 'assets/a.png'); self.repo.commit()
        self.configure(exclude=['assets/*'])
        self.assertIn('doc.md:1: [link] 链接目标不存在：assets/a.png', self.run_links(code=1))

    def test_renamed_asset_affects_unchanged_doc(self):
        self.asset_fixture()
        self.repo.git('mv', 'assets/a.png', 'assets/b.png'); self.repo.commit()
        self.assertIn('assets/a.png', self.run_links(code=1))

    def test_last_child_deletion_removes_directory_target(self):
        self.asset_fixture('[dir](assets/)')
        self.repo.git('rm', 'assets/a.png'); self.repo.commit()
        (self.repo.root / 'assets').mkdir(exist_ok=True)
        self.assertIn('链接目标不存在：assets/', self.run_links(code=1))
        self.run_links('--all')

    def test_deletion_does_not_report_unrelated_old_breakage(self):
        self.asset_fixture('[old](old-missing) [new](assets/a.png) [outside](../outside)')
        self.repo.git('rm', 'assets/a.png'); self.repo.commit()
        out = self.run_links(code=1)
        self.assertIn('assets/a.png', out); self.assertNotIn('old-missing', out); self.assertNotIn('超出', out)
        self.assertIn('1 处断链', out)
        self.repo.write('doc.md', '[old](old-missing) [new](assets/a.png)'); self.repo.commit()
        self.assertIn('2 处断链', self.run_links(code=1))

    def test_source_excludes_and_target_ignores_are_distinct(self):
        self.repo.write('doc.md', '[real](vendor/a.md) [ignored](generated/a%23b.md#x)')
        self.repo.write('vendor/a.md', '[bad](missing)')
        self.repo.write('excluded.md', '[bad](missing)')
        self.configure(links={'exclude': ['excluded.md'], 'ignoreTargets': ['generated/*']})
        self.assertIn('检查了 1 个文档，0 处断链', self.run_links('--all'))

    @NEEDS_SYMLINK
    def test_case_insensitive_extensions_and_generated_documents(self):
        for name in ['a.MD', 'b.markdown', 'c.mdx', 'vendor/ignored.md', 'scripts/quality/own.md']:
            self.repo.write(name, '<!-- @generated -->\n[x](missing)')
        (self.repo.root / 'alias.md').symlink_to('a.MD')
        out = self.run_links('--all', code=1)
        self.assertIn('检查了 3 个文档，3 处断链', out)
        self.assertNotIn('alias.md:', out)

    def test_unreadable_documents_keep_other_findings(self):
        self.repo.write('bom.md', b'\xef\xbb\xbf[x](missing)')
        self.repo.write('bad.md', b'\xff'); self.repo.write('binary.md', b'\0')
        self.repo.write('large.md', 'x' * (1024 * 1024 + 1))
        out = self.run_links('--all', code=2)
        self.assertIn('bom.md:1: [link]', out)
        for path in ('bad.md', 'binary.md', 'large.md'):
            self.assertIn(path + ' 未完成', out)
        self.assertIn('检查了 1 个文档，1 处断链', out)
        module = load_script('check-links.py')
        with mock.patch.object(module, 'extract_links', side_effect=ValueError()), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(module.main(['--all'], here=self.here, cwd=self.repo.root), 2)
        self.assertIn('检查了 0 个文档', output.getvalue())

    def test_merge_bad_revision_and_conflicted_index(self):
        self.repo.write('a', 'base'); self.repo.commit()
        self.repo.git('checkout', '-b', 'side'); self.repo.write('a', 'side'); self.repo.commit()
        self.repo.git('checkout', 'main'); self.repo.write('main', ''); self.repo.commit()
        self.repo.git('merge', '--no-ff', 'side', '-m', 'merge')
        self.assertEqual(self.run_links(), '链接检查：合并提交不检查。\n')
        self.assertIn('修订号无效', self.run_links('--commit', 'missing-rev', code=2))
        oid = self.repo.git('rev-parse', 'HEAD:a').stdout.strip()
        import subprocess
        subprocess.run(['git', 'update-index', '--index-info'], input=f'0 {"0" * 40}\ta\n100644 {oid} 1\ta\n',
                       text=True, cwd=self.repo.root, env=self.repo.env, check=True, capture_output=True)
        self.assertIn('索引存在冲突', self.run_links('--staged', code=2))

    def test_counts_deduplicate_affected_and_changed_documents(self):
        self.asset_fixture()
        self.repo.git('rm', 'assets/a.png')
        self.repo.write('doc.md', '[one](assets/a.png) [two](missing)'); self.repo.commit()
        self.assertIn('检查了 1 个文档，2 处断链', self.run_links(code=1))

    def test_link_queries_do_not_spawn_git_per_target(self):
        self.repo.write('asset/real', '')
        self.repo.write('doc.md', '[ok](asset/real) [dir](asset/)\n' + '\n'.join(f'[x](missing{n})' for n in range(300)))
        self.repo.commit()
        module = load_script('check-links.py')
        with mock.patch.object(quality_snapshot, 'git_bytes', wraps=quality_snapshot.git_bytes) as git, contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(module.main([], here=self.here, cwd=self.repo.root), 1)
        self.assertLess(git.call_count, 10)
        self.assertIn('300 处断链', out.getvalue())

    def test_initial_staged_and_root_commit(self):
        repo = TempRepo(); self.addCleanup(repo.close)
        here = repo.install_scripts()
        repo.write('doc.md', '[x](target)'); repo.git('add', '.')
        self.assertEqual(repo.run(here / 'check-links.py', '--staged').returncode, 1)
        repo.write('target', ''); repo.commit()
        self.assertEqual(repo.run(here / 'check-links.py').returncode, 0)

    def test_one_unreadable_worktree_document_does_not_hide_other_findings(self):
        self.repo.write('unreadable.md', '[x](missing)')
        self.repo.write('good.md', '[x](missing)')
        module = load_script('check-links.py')
        read = Path.read_bytes
        def read_bytes(path):
            if path.name == 'unreadable.md':
                raise PermissionError()
            return read(path)
        with mock.patch.object(Path, 'read_bytes', read_bytes), contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(module.main(['--all'], here=self.here, cwd=self.repo.root), 2)
        self.assertIn('unreadable.md 未完成', out.getvalue())
        self.assertIn('good.md:1: [link]', out.getvalue())
        self.assertIn('检查了 1 个文档，1 处断链', out.getvalue())
