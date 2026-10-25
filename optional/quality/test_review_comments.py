import json
import time
import subprocess
import sys
import unittest
from unittest import mock
from quality_lib import default_config
from quality_testing import HERE, TempRepo, config_from, load_script

module = load_script('review-comments.py')


def rules(path, text, config=None):
    return [(f.line, f.rule) for f in module.review(path, text, None, config or default_config())]


def assert_review_fast(case, expression, *, setup='', finish='', timeout=10):
    source = ('import json,time\nfrom quality_testing import load_script\nfrom quality_lib import default_config\n'
              'review = load_script("review-comments.py").review\n'
              + setup + '\n'
              'text = "// " + (' + expression + ')\nconfig = default_config()\n'
              'print("READY", flush=True)\n'
              'start = time.monotonic()\n'
              'result = review("a.ts", text, None, config)\n'
              'elapsed = time.monotonic() - start\n'
              'print("REVIEW_DONE " + json.dumps({"elapsed": elapsed, "result": result}, default=repr), flush=True)\n'
              + finish + '\n')
    try:
        result = subprocess.run([sys.executable, '-B', '-c', source], cwd=HERE,
                                capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        evidence = ((error.stdout or b'') + (error.stderr or b'')).decode('utf-8', 'replace')
        case.fail(f'子进程保护期限（{timeout} 秒）耗尽；不能据此判定实际匹配耗时。\n{evidence}')
    output = result.stdout.decode('utf-8', 'replace')
    evidence = output + result.stderr.decode('utf-8', 'replace')
    print(f'{expression}:\n{output}', end='')
    case.assertEqual(result.returncode, 0, f'性能探针异常退出。\n{evidence}')
    lines = output.splitlines()
    case.assertEqual(len(lines), 2, f'缺少或无效的匹配完成证据。\n{evidence}')
    case.assertEqual(lines[0], 'READY', evidence)
    case.assertTrue(lines[1].startswith('REVIEW_DONE '), evidence)
    try:
        receipt = json.loads(lines[1].removeprefix('REVIEW_DONE '))
    except ValueError:
        case.fail(f'匹配完成证据不是有效 JSON。\n{evidence}')
    case.assertIsInstance(receipt, dict, evidence)
    case.assertEqual(set(receipt), {'elapsed', 'result'}, evidence)
    case.assertIs(type(receipt['elapsed']), float, evidence)
    case.assertGreaterEqual(receipt['elapsed'], 0, evidence)
    case.assertLess(receipt['elapsed'], 1, f'实际匹配耗时必须小于 1 秒。\n{evidence}')
    case.assertEqual(receipt['result'], [], evidence)


class PerformanceProbe(unittest.TestCase):
    def test_slow_preparation_does_not_consume_review_budget(self):
        assert_review_fast(self, '"ordinary"', setup='time.sleep(1.25)')

    def test_slow_review_fails_with_measured_completion(self):
        setup = ('original_review = review\ndef review(*args):\n'
                 ' time.sleep(1.25)\n return original_review(*args)\n')
        with self.assertRaisesRegex(AssertionError, '实际匹配耗时') as failure:
            assert_review_fast(self, '"ordinary"', setup=setup)
        self.assertIn('READY', str(failure.exception))
        self.assertIn('REVIEW_DONE', str(failure.exception))

    def test_nonterminating_process_is_bounded_and_reaped(self):
        processes = []
        popen = subprocess.Popen
        def launch(*args, **kwargs):
            process = popen(*args, **kwargs)
            processes.append(process)
            return process
        start = time.monotonic()
        with mock.patch.object(subprocess, 'Popen', side_effect=launch):
            with self.assertRaises(AssertionError) as failure:
                assert_review_fast(self, '"ordinary"', finish='time.sleep(30)', timeout=2)
        self.assertLess(time.monotonic() - start, 7)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].returncode)
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)
        self.assertTrue(processes[0].stderr.closed)
        self.assertIn('子进程保护期限', str(failure.exception))
        self.assertIn('READY', str(failure.exception))
        self.assertIn('REVIEW_DONE', str(failure.exception))

    def test_zero_exit_without_completion_is_rejected(self):
        with self.assertRaises(AssertionError):
            assert_review_fast(self, '"ordinary"', setup='raise SystemExit(0)')

    def test_abnormal_exit_is_rejected(self):
        with self.assertRaises(AssertionError):
            assert_review_fast(self, '"ordinary"', finish='raise SystemExit(7)')


POSITIVE = [
    ('document', '// 详见 docs/api.md'), ('document', '// see README'), ('document', '// 参见设计文档'),
    ('document', '/* refer to the design doc */'), ('document', '// [[设计说明]]'), ('document', '// 规则在 README.md#setup'),
    ('document', '// see docs/runbook.rst'),
    ('tracking', '// Task 3: 初始化'), ('tracking', '// phase 2 再做'), ('tracking', '// 任务 5'), ('tracking', '// 阶段 2'),
    ('tracking', '// FR-001'), ('tracking', '// bug #123 的修复'), ('tracking', '// 反馈 4567'), ('tracking', '// 工单号：88'),
    ('tracking', '// Critical #2'), ('tracking', '// 审核意见 #2'), ('tracking', '// 2026-10-22 修复'),
    ('tracking', '// changed on 2025-03-01'), ('tracking', '// as of 2026/10/22'), ('tracking', '// 2026年10月 调整'),
    ('process', '// 本次修复空指针'), ('process', '// 评审发现这里会重复提交'), ('process', '// 用户要求保留旧字段'),
    ('process', '// 按评审意见改为同步调用'), ('process', '// 原来的实现会丢数据'), ('process', '// per review feedback'),
    ('process', '// as requested'), ('process', '// reviewer asked for this'), ('process', '// in this PR we cache'),
    ('process', '// this commit fixes the race'), ('process', '// previous implementation leaked'),
    ('generator', '// generated by ChatGPT'), ('generator', '// Written with Claude'), ('generator', '// 由 AI 生成'),
    ('generator', '// 使用大模型辅助编写'), ('generator', '/** @author Copilot */'), ('generator', '// as an AI language model'),
]
NEGATIVE = [
    '// https://github.com/org/repo/blob/main/README.md', '// https://github.com/org/repo/issues/123',
    '// 参考实现来自上游', '// Copyright 2026 Example Corp. Task 3', '// © Example Task 3', '// Licensed under MIT Task 3',
    '// SPDX-License-Identifier: MIT', '// RFC 9110 §15.5', '// ISO 8601', '// Step 1: parse header', '// 日期格式 YYYY-MM-DD',
    '// 2024-01-01T00:00:00Z 是示例', '// 2027-01-01 起停用旧接口', '// 兼容旧版本客户端', '// US-ASCII 编码',
    '// 用户输入为空时返回默认值', '// 按时间排序', '// the previous value is cached', '// generated by protoc',
    '// AI 推荐结果按分数排序', 'const s = "Task 3 详见 docs/api.md"',
]


class Rules(unittest.TestCase):
    def test_each_category_matches_its_examples(self):
        for rule, text in POSITIVE:
            with self.subTest(text=text):
                self.assertIn((1, rule), rules('a.ts', text + '\n'))
        self.assertEqual(rules('a.py', '# see README\n'), [(1, 'document')])

    def test_exempt_and_ordinary_text_is_not_reported(self):
        for text in NEGATIVE:
            with self.subTest(text=text):
                self.assertEqual(rules('a.ts', text + '\n'), [])

    def test_url_schemes_in_template_text_do_not_start_comments(self):
        for path in ('view.php', 'view.jsx', 'view.tsx', 'a.hcl'):
            for scheme in ('https', 'file'):
                with self.subTest(path=path, scheme=scheme):
                    self.assertEqual(rules(path, '<p>' + scheme + '://example.invalid/docs/api.md</p>\n'), [])
        self.assertEqual(rules('a.ts', 'x: // Task 3\n'), [(1, 'tracking')])

    def test_php_literal_contents_do_not_hide_later_comments_or_create_findings(self):
        for opening, closing in [('<<<END', 'END'), ('<<<"END"', 'END'), ("<<<'END'", 'END'), ('`', '`')]:
            with self.subTest(opening=opening):
                text = ('<?php\nclass ExampleTest {\nfunction testExample() {\n'
                        '$value = ' + opening + '\n// 本次修复\n?>\n' + closing + ';\n'
                        '// 本次修复\n}\n}\n?>\n// 本次修复\n')
                self.assertEqual(rules('ExampleTest.php', text), [(8, 'process')])
                self.assertEqual(module.review('ExampleTest.php', text, frozenset({5, 12}), default_config()), [])

    def test_ordinary_chinese_jian_is_not_a_document_reference(self):
        for text in ('常见设计', '可见文档', '见设计'):
            with self.subTest(text=text):
                self.assertEqual(rules('a.ts', '// ' + text), [])
        for text in ('详见设计', '参见文档', '参考： docs/'):
            with self.subTest(text=text):
                self.assertEqual(rules('a.ts', '// ' + text), [(1, 'document')])

    def test_document_suffix_followed_by_dot_alphanumeric_is_not_reported(self):
        for text in ('schema.md.ts', 'schema.mdx.js', 'schema.rst.1', 'schema.adoc.Z'):
            with self.subTest(text=text):
                self.assertEqual(rules('a.ts', '// ' + text), [])
        for text in ('schema.md.', 'schema.md#anchor', 'schema.mdx'):
            with self.subTest(text=text):
                self.assertEqual(rules('a.ts', '// ' + text), [(1, 'document')])

    def test_messages_follow_the_spec(self):
        self.assertEqual({rule: message for rule, _, message in module.RULES}, {
            'document': '文档引用：改为直接写出规则和原因',
            'tracking': '追踪编号或日期：写进提交说明，注释只写现行规则和原因',
            'process': '开发过程叙述：改写成当前规则和原因，过程写进提交说明',
            'generator': '生成工具署名或模型自述：删除'})

    def test_test_titles_follow_the_same_rules(self):
        self.assertIn((2, 'tracking'), rules('a.test.ts', "describe('ok', () => {\n  it('Task 3 returns empty', () => {})\n})\n"))
        self.assertEqual(rules('a.ts', "if (/x/.test('Task 3')) {}\n"), [])

    def test_only_added_lines_are_reported(self):
        findings = module.review('a.ts', '/* Task 3\n * keep\n * bug #1 */\n', frozenset({3}), default_config())
        self.assertEqual([(f.line, f.rule) for f in findings], [(3, 'tracking')])

    def test_crlf_lines_keep_their_numbers(self):
        self.assertEqual(rules('a.ts', '// ok\r\n// Task 3\r\n'), [(2, 'tracking')])

    def test_multiline_title_only_reports_the_changed_physical_line(self):
        findings = module.review('a.test.ts', 'it(`works\nTask 3`, fn)', frozenset({2}), default_config())
        self.assertEqual([(f.line, f.rule) for f in findings], [(2, 'tracking')])

    def test_disabled_categories_and_extra_rules(self):
        config = config_from({'version': 1, 'comments': {'disable': ['tracking'], 'extraRules': [
            {'id': 'jira', 'pattern': r'\b[A-Z][A-Z0-9]+-\d+\b', 'message': 'JIRA 编号：写进提交说明'}]}})
        findings = module.review('a.ts', '// Task 3 ABC-12\n', None, config)
        self.assertEqual([(f.rule, f.message) for f in findings], [('jira', 'JIRA 编号：写进提交说明')])

    def test_a_huge_comment_line_finishes_quickly(self):
        start = time.monotonic()
        module.review('a.ts', '// ' + '2026-10-22 起 ' * 20000 + '\n', None, default_config())
        self.assertLess(time.monotonic() - start, 5)

    def test_a_long_unbroken_comment_finishes_quickly(self):
        source = ('from quality_testing import load_script\nfrom quality_lib import default_config\n'
                  'load_script("review-comments.py").review("a.ts", "// " + "x" * 260000, None, default_config())\n')
        try:
            result = subprocess.run([sys.executable, '-B', '-c', source], cwd=HERE, capture_output=True, timeout=5)
        except subprocess.TimeoutExpired:
            self.fail('连续长注释超过 5 秒仍未完成')
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', 'replace'))

    def test_extreme_note_and_optional_whitespace_lines_finish_within_one_second(self):
        expressions = ['"[[" * 131072', '"Task" + " " * 40000 + "x"',
                       '"详见" + " " * 40000 + "x"', '"bug" + " " * 40000 + "x"',
                       '"评审" + " " * 40000 + "x"']
        for expression in expressions:
            with self.subTest(expression=expression):
                assert_review_fast(self, expression)

    def test_note_link_length_is_bounded(self):
        self.assertEqual(rules('a.ts', '// [[' + 'x' * 200 + ']]'), [(1, 'document')])
        self.assertEqual(rules('a.ts', '// [[' + 'x' * 201 + ']]'), [])


class CommandLine(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.here = self.repo.install_scripts()

    def test_commit_findings_are_reported_with_exit_one(self):
        r = self.repo
        r.write('src/a.ts', 'export const a = 1\n'); r.commit()
        r.write('src/a.ts', 'export const a = 1\n// Task 3: later\n'); r.commit()
        result = r.run(self.here / 'review-comments.py', '--commit', 'HEAD')
        self.assertEqual((result.returncode, result.stdout.splitlines()), (1, [
            'src/a.ts:2: [tracking] 追踪编号或日期：写进提交说明，注释只写现行规则和原因', '注释审核：检查了 1 个文件，1 处需复核。']))

    def test_staged_mode_runs_from_a_subdirectory(self):
        r = self.repo
        r.commit()
        r.write('src/b.ts', '// 详见 docs/x.md\n'); r.git('add', '-A')
        result = r.run(self.here / 'review-comments.py', '--staged', cwd=r.root / 'src')
        self.assertEqual(result.returncode, 1)
        self.assertIn('src/b.ts:1: [document] 文档引用：改为直接写出规则和原因', result.stdout.splitlines())

    def test_bom_python_docstring_is_reviewed(self):
        self.repo.write('a.py', '\ufeff"""Task 3"""\n')
        self.repo.commit()
        result = self.repo.run(self.here / 'review-comments.py')
        self.assertEqual(result.returncode, 1)
        self.assertIn('a.py:1: [tracking]', result.stdout)
        self.assertEqual(result.stderr, '')

    def test_each_invalid_config_exits_two(self):
        from test_lib import Config
        for text, field in Config.INVALID:
            with self.subTest(field=field, text=text):
                (self.here / 'quality.json').write_text(text, encoding='utf-8')
                result = self.repo.run(self.here / 'review-comments.py', '--all')
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stderr.strip(), '注释审核未完成：配置无效：' + field)
