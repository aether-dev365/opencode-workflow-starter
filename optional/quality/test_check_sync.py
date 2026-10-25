import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import time
import unittest
from unittest import mock
import quality_sync
from quality_testing import NEEDS_SYMLINK, TempRepo

API = {'id': 'api', 'paths': ['src/api/*'], 'exclude': ['src/api/*_test.py'], 'related': ['docs/api.md', 'CHANGELOG.md'],
       'message': '接口变化要同步接口文档和变更记录'}
REMIND = '[sync] api：接口变化要同步接口文档和变更记录（改动：src/api/a.py；未改动：docs/api.md、CHANGELOG.md）'


class SyncChecks(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo(); self.addCleanup(self.repo.close)
        self.here = self.repo.install_scripts()
        for path in ('src/api/a.py', 'docs/api.md', 'CHANGELOG.md'):
            self.repo.write(path, 'x\n')
        self.configure(API)
        self.repo.commit('base')

    def configure(self, *rules, **values):
        (self.here / 'quality.json').write_text(json.dumps({'version': 1, 'sync': list(rules), **values}), encoding='utf-8')

    def change(self, *paths):
        # 每次写入不同内容，保证重复改同一个文件也是真实修改。
        self.changes = getattr(self, 'changes', 0) + 1
        for path in paths:
            self.repo.write(path, f'change {self.changes}\n')
        return self.repo.commit()

    def run_sync(self, *args, code=0, cwd=None):
        result = self.repo.run(self.here / 'check-sync.py', *args, cwd=cwd)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return result.stdout, result.stderr

    def test_without_rules_reports_nothing_to_check(self):
        self.configure()
        self.assertEqual(self.run_sync()[0], '关联检查：没有登记关联。\n')
        # 没有登记也先读取改动，Git 错误不能被当作“没有登记”放过。
        self.assertEqual(self.run_sync('--commit', 'nope', code=2)[1], '关联检查未完成：修订号无效\n')

    def test_reminder_names_changed_and_unchanged_targets(self):
        self.change('src/api/a.py')
        self.assertEqual(self.run_sync(code=1)[0].splitlines(), [REMIND, '关联检查：检查了 1 条登记，1 条需要确认同步，0 处登记失效。'])

    def test_partial_complete_and_one_way_sync(self):
        self.change('src/api/a.py', 'docs/api.md')
        self.assertTrue(self.run_sync(code=1)[0].splitlines()[0].endswith('；未改动：CHANGELOG.md）'))
        self.change('src/api/a.py', 'docs/api.md', 'CHANGELOG.md')
        self.assertEqual(self.run_sync()[0].splitlines()[-1], '关联检查：检查了 1 条登记，0 条需要确认同步，0 处登记失效。')
        self.change('docs/api.md')
        self.run_sync()

    def test_on_limits_change_kinds(self):
        self.configure({**API, 'on': ['add', 'delete']}); self.repo.commit('config')
        self.change('src/api/a.py')
        self.run_sync()
        self.change('src/api/b.py')
        self.assertIn('改动：src/api/b.py；', self.run_sync(code=1)[0])
        self.repo.git('rm', '-q', 'src/api/b.py'); self.repo.commit()
        self.assertIn('改动：src/api/b.py；', self.run_sync(code=1)[0])
        self.repo.git('mv', 'src/api/a.py', 'src/api/c.py'); self.repo.commit()
        self.assertIn('改动：src/api/a.py、src/api/c.py；', self.run_sync(code=1)[0])

    def test_rule_exclude_applies_but_global_filters_do_not(self):
        vendor = {'id': 'vendor', 'paths': ['vendor/*'], 'related': ['generated/index.md'], 'message': '依赖更新要重新生成索引'}
        self.configure(API, vendor, include=['src/*'], exclude=['vendor/*'])
        self.repo.write('generated/index.md', 'x\n'); self.repo.write('vendor/lib.py', 'x\n'); self.repo.commit('setup')
        self.change('vendor/lib.py')
        self.assertIn('[sync] vendor：依赖更新要重新生成索引（改动：vendor/lib.py；未改动：generated/index.md）', self.run_sync(code=1)[0])
        self.change('src/api/a_test.py')
        self.run_sync()

    def test_trigger_list_is_truncated_after_three(self):
        self.change('src/api/a.py', 'src/api/b.py', 'src/api/c.py', 'src/api/d.py', 'src/api/e.py')
        self.assertIn('改动：src/api/a.py、src/api/b.py、src/api/c.py 等 5 个；', self.run_sync(code=1)[0])

    def test_deleted_related_target_counts_as_changed_but_is_stale(self):
        self.repo.git('rm', '-q', 'docs/api.md'); self.change('src/api/a.py')
        self.assertEqual(self.run_sync(code=1)[0].splitlines(), [
            '[sync] api：接口变化要同步接口文档和变更记录（改动：src/api/a.py；未改动：CHANGELOG.md）',
            '[sync-stale] api：related 中的 docs/api.md 已匹配不到文件，请更新登记',
            '关联检查：检查了 1 条登记，1 条需要确认同步，1 处登记失效。'])

    def test_fail_on_incomplete_turns_stale_into_incomplete(self):
        self.repo.git('rm', '-q', 'docs/api.md'); self.repo.commit()
        self.run_sync(code=1)
        out, err = self.run_sync('--fail-on-incomplete', code=2)
        self.assertIn('[sync-stale] api：related 中的 docs/api.md 已匹配不到文件，请更新登记', out)
        self.assertIn('关联检查：检查了 1 条登记，0 条需要确认同步，1 处登记失效。', out)
        self.assertEqual(err, '关联检查未完成：登记失效\n')

    def test_stale_scope_depends_on_mode(self):
        legacy = {'id': 'legacy', 'paths': ['src/api/*'], 'related': ['docs/never.md'], 'message': '旧规则'}
        self.configure(API, legacy); self.repo.commit('config')
        self.repo.git('rm', '-q', 'docs/api.md'); self.repo.commit()
        out = self.run_sync(code=1)[0]
        self.assertIn('related 中的 docs/api.md', out); self.assertNotIn('docs/never.md', out)
        out = self.run_sync('--all', code=1)[0]
        self.assertIn('related 中的 docs/api.md', out); self.assertIn('related 中的 docs/never.md', out)
        self.configure(API, {**legacy, 'message': '旧规则，待清理'}); self.repo.commit('config')
        self.assertIn('related 中的 docs/never.md', self.run_sync(code=1)[0])

    def test_all_mode_only_validates_the_registry(self):
        self.repo.write('src/api/a.py', 'dirty\n')
        self.assertEqual(self.run_sync('--all')[0], '关联检查：校验了 1 条登记，0 处登记失效。\n')

    def test_case_mismatch_and_control_characters_are_stale(self):
        self.configure({**API, 'related': ['Docs/API.md', 'docs/\x1b.md']})
        out = self.run_sync('--all', code=1)[0]
        self.assertIn('[sync-stale] api：related 中的 Docs/API.md 已匹配不到文件，请更新登记', out)
        self.assertIn('related 中的 docs/\\x1b.md', out)

    def test_staged_and_range_modes(self):
        self.repo.write('src/api/a.py', 'staged\n'); self.repo.git('add', 'src/api/a.py')
        self.assertIn('[sync] api', self.run_sync('--staged', code=1)[0])
        self.repo.commit(add=False)
        self.repo.git('checkout', '-q', '-b', 'feature'); self.change('src/api/a.py')
        self.repo.git('checkout', '-q', 'main'); self.change('docs/api.md')
        self.assertIn('（改动：src/api/a.py；未改动：docs/api.md、CHANGELOG.md）', self.run_sync('--range', 'main..feature', code=1)[0])

    def test_intent_to_add_is_not_a_staged_change(self):
        self.repo.write('src/api/b.py', 'x\n'); self.repo.git('add', '-N', 'src/api/b.py')
        self.assertEqual(self.run_sync('--staged')[0], '关联检查：检查了 1 条登记，0 条需要确认同步，0 处登记失效。\n')
        self.repo.git('add', 'src/api/b.py')
        self.assertIn('（改动：src/api/b.py；', self.run_sync('--staged', code=1)[0])

    @NEEDS_SYMLINK
    def test_links_and_submodules_are_changes_and_existing_entries(self):
        base = self.repo.git('rev-parse', 'HEAD').stdout.strip()
        os.symlink('a.py', self.repo.root / 'src/api/link')
        self.repo.git('add', 'src/api/link')
        self.repo.git('update-index', '--add', '--cacheinfo', f'160000,{base},src/api/sub')
        (self.repo.root / 'src/api/sub').mkdir()  # 未初始化的子模块在工作区是空目录。
        self.repo.commit(add=False)
        self.assertIn('（改动：src/api/link、src/api/sub；', self.run_sync(code=1)[0])
        self.configure({**API, 'related': ['src/api/link', 'src/api/sub']})
        self.assertEqual(self.run_sync('--all')[0], '关联检查：校验了 1 条登记，0 处登记失效。\n')

    def test_staged_before_the_first_commit(self):
        fresh = TempRepo(); self.addCleanup(fresh.close)
        here = fresh.install_scripts()
        (here / 'quality.json').write_text(json.dumps({'version': 1, 'sync': [API]}), encoding='utf-8')
        fresh.write('src/api/a.py', 'x\n'); fresh.git('add', 'src/api/a.py')
        result = fresh.run(here / 'check-sync.py', '--staged')
        self.assertEqual((result.returncode, result.stdout.splitlines()), (1, [REMIND, '关联检查：检查了 1 条登记，1 条需要确认同步，0 处登记失效。']))

    def test_copy_counts_only_the_new_path(self):
        shutil.copyfile(self.repo.root / 'src/api/a.py', self.repo.root / 'src/api/c.py'); self.repo.commit()
        self.assertIn('（改动：src/api/c.py；未改动：docs/api.md、CHANGELOG.md）', self.run_sync(code=1)[0])

    def test_root_commit_reports_reminders_and_full_validation(self):
        fresh = TempRepo(); self.addCleanup(fresh.close)
        here = fresh.install_scripts()
        (here / 'quality.json').write_text(json.dumps({'version': 1, 'sync': [API]}), encoding='utf-8')
        fresh.write('src/api/a.py', 'x\n'); fresh.commit('root')
        result = fresh.run(here / 'check-sync.py', '--commit', 'HEAD')
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        for text in ('[sync] api', 'related 中的 docs/api.md 已匹配不到文件', 'related 中的 CHANGELOG.md 已匹配不到文件'):
            self.assertIn(text, result.stdout)

    def test_merge_commits_are_skipped(self):
        self.repo.git('checkout', '-q', '-b', 'side'); self.change('docs/api.md')
        self.repo.git('checkout', '-q', 'main'); self.change('CHANGELOG.md')
        self.repo.git('merge', '--no-ff', '-q', '-m', 'merge', 'side')
        self.assertEqual(self.run_sync()[0], '关联检查：合并提交不检查。\n')

    def test_invalid_config_and_revision_are_incomplete(self):
        self.configure({**API, 'paths': []})
        self.assertEqual(self.run_sync(code=2)[1], '关联检查未完成：配置无效：sync[0].paths\n')
        self.configure(API)
        self.assertEqual(self.run_sync('--commit', 'nope', code=2)[1], '关联检查未完成：修订号无效\n')

    def test_missing_shared_module_is_incomplete(self):
        (self.here / 'quality_sync.py').unlink()
        self.assertEqual(self.run_sync(code=2)[1], '关联检查未完成：质量扩展文件不完整（ModuleNotFoundError）\n')

    def test_all_mode_inspects_each_entry_once(self):
        for n in range(5):
            self.repo.write(f'docs/{n}.md', 'x\n')
        self.repo.commit('docs')
        seen, lstat = [], Path.lstat

        def record(path):
            seen.append(path)
            return lstat(path)
        with mock.patch.object(Path, 'lstat', autospec=True, side_effect=record), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(quality_sync.main(['--all'], here=self.here, cwd=self.repo.root), 0)
        files = [path for path in seen if path.parent == self.repo.root / 'docs']
        self.assertEqual(sorted(path.name for path in files), ['0.md', '1.md', '2.md', '3.md', '4.md', 'api.md'])

    def test_subdirectory_and_unicode_paths(self):
        self.configure({'id': 'zh', 'paths': ['接口 目录/*'], 'related': ['说明 文档.md'], 'message': '接口变化要同步说明'})
        self.repo.write('说明 文档.md', 'x\n'); self.repo.write('接口 目录/甲.py', 'x\n'); self.repo.commit('setup')
        self.change('接口 目录/甲.py')
        self.assertIn('（改动：接口 目录/甲.py；未改动：说明 文档.md）', self.run_sync(code=1, cwd=self.repo.root / '接口 目录')[0])

    def test_many_changes_and_rules_finish_quickly(self):
        self.configure(*[{**API, 'id': f'r{n}'} for n in range(30)]); self.repo.commit('config')
        for n in range(2000):
            self.repo.write(f'src/api/f{n}.py', 'x\n')
        self.repo.commit()
        start = time.monotonic()
        self.run_sync(code=1)
        self.assertLess(time.monotonic() - start, 15)

