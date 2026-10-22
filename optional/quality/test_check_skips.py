import unittest
from quality_lib import default_config
from quality_testing import TempRepo, config_from, load_script

module = load_script('check-skips.py')


def cats(path, text, config=None):
    return [(f.line, f.rule) for f in module.find_skips(path, text + '\n', None, config or default_config())]


POSITIVE = [
    ('a.test.ts', 'describe.skip("x", () => {})', 'skip'), ('a.ts', 'it.skip("x", fn)', 'skip'), ('a.ts', 'test.skip("x", fn)', 'skip'),
    ('a.ts', 'context.skip("x", fn)', 'skip'), ('a.ts', 'suite.skip("x", fn)', 'skip'), ('a.spec.ts', 'test.describe.skip("x", fn)', 'skip'),
    ('a.ts', 'it.skipIf(win)("x", fn)', 'skip'), ('a.spec.ts', 'test.fixme("x", fn)', 'skip'),
    ('a.test.js', 'xit("x", fn)', 'skip'), ('a.test.js', 'xdescribe("x", fn)', 'skip'), ('a.test.js', 'xtest("x", fn)', 'skip'),
    ('a.test.js', 'xcontext("x", fn)', 'skip'),
    ('a.ts', 'it.only("x", fn)', 'focus'), ('a.ts', 'describe.only("x", fn)', 'focus'), ('a.spec.ts', 'test.describe.only("x", fn)', 'focus'),
    ('a.test.js', 'fit("x", fn)', 'focus'), ('a.test.js', 'fdescribe("x", fn)', 'focus'),
    ('test_a.py', '@pytest.mark.skip(reason="x")', 'skip'), ('test_a.py', '@pytest.mark.skipif(True, reason="x")', 'skip'),
    ('test_a.py', 'pytest.skip("x")', 'skip'), ('test_a.py', '@unittest.skip("x")', 'skip'),
    ('test_a.py', '@unittest.skipIf(True, "x")', 'skip'), ('test_a.py', '@unittest.skipUnless(False, "x")', 'skip'),
    ('test_a.py', '        self.skipTest("x")', 'skip'), ('test_a.py', '    raise unittest.SkipTest("x")', 'skip'),
    ('test_a.py', '    raise SkipTest("x")', 'skip'),
    ('test_a.py', '@pytest.mark.xfail', 'expected-failure'), ('test_a.py', '    pytest.xfail("x")', 'expected-failure'),
    ('test_a.py', '@unittest.expectedFailure', 'expected-failure'),
    ('ATest.java', '@Disabled("x")', 'skip'), ('ATest.java', '@DisabledOnOs(OS.WINDOWS)', 'skip'), ('ATest.java', '@Ignore', 'skip'),
    ('ATest.java', '@Test(enabled = false)', 'skip'), ('ATest.kt', '@Disabled', 'skip'),
    ('a_test.go', '\tt.Skip("x")', 'skip'), ('a_test.go', '\tb.Skipf("x %d", 1)', 'skip'), ('a_test.go', '\tt.SkipNow()', 'skip'),
    ('lib.rs', '#[ignore]', 'skip'), ('lib.rs', '#[ignore = "slow"]', 'skip'),
    ('ATests.cs', '[Fact(Skip = "x")]', 'skip'), ('ATests.cs', '[Theory(Skip = "x")]', 'skip'), ('ATests.cs', '[Ignore("x")]', 'skip'),
    ('ATests.cs', 'Assert.Ignore("x");', 'skip'), ('ATests.cs', 'Assert.Inconclusive("x");', 'skip'),
    ('ATest.php', '$this->markTestSkipped("x");', 'skip'), ('ATest.php', '$this->markTestIncomplete("x");', 'skip'),
    ('ATests.swift', 'throw XCTSkip("x")', 'skip'), ('ATests.swift', 'try XCTSkipIf(true)', 'skip'),
    ('ATests.swift', 'try XCTSkipUnless(false)', 'skip'),
    ('test/a_test.dart', "test('x', () {}, skip: 'flaky');", 'skip'),
    ('spec/a_spec.rb', '  xit "x" do', 'skip'), ('spec/a_spec.rb', '  skip "flaky"', 'skip'), ('spec/a_spec.rb', '  pending', 'skip'),
    ('test/a.bats', '  skip "x"', 'skip'),
    ('a.vue', '<script>it.skip("x", fn)</script>', 'skip'),
]
NEGATIVE = [
    ('a.ts', '// it.skip("x", fn)'), ('a.ts', 'const s = "it.only("'), ('src/a.js', 'model.fit(x)'), ('src/a.js', 'fit(x)'),
    ('src/a.js', 'xit(x)'), ('test_a.py', 'pytest.importorskip("numpy")'), ('test/a_test.dart', "test('x', () {}, skip: false);"),
    ('test/a_test.dart', "test('x', () {}, skip: null);"), ('lib/a.rb', '  skip "x"'), ('lib/a.dart', "test('x', () {}, skip: 'y');"),
    ('a.ts', 'items.skip(2)'), ('a.py', 'def skipTest(self): pass'), ('a.vue', '<p>it.skip("x")</p>'),
]


class Markers(unittest.TestCase):
    def test_each_ecosystem_marker_is_reported(self):
        for path, text, category in POSITIVE:
            with self.subTest(path=path, text=text):
                self.assertEqual(cats(path, text), [(1, category)])

    def test_comments_strings_and_lookalikes_are_not_reported(self):
        for path, text in NEGATIVE:
            with self.subTest(path=path, text=text):
                self.assertEqual(cats(path, text), [])

    def test_test_file_detection(self):
        for path in ['a.test.ts', 'a.spec.js', 'a_test.go', 'test_a.py', 'a_spec.rb', 'FooTest.java', 'FooTests.cs', 'src/test/A.java',
                     'tests/a.py', 'pkg/__tests__/a.js', 'spec/a.rb', 'e2e/login.ts', 'cypress/a.js']:
            with self.subTest(path=path):
                self.assertTrue(module.is_test_file(path))
        for path in ['src/a.js', 'src/contest.py', 'lib/attestation.rb', 'Contest.java', 'latest/a.js']:
            with self.subTest(path=path):
                self.assertFalse(module.is_test_file(path))

    def test_messages_follow_the_spec(self):
        self.assertEqual(module.MESSAGES, {
            'skip': '新增跳过测试：修好后移除；确需保留时在提交说明里写明原因',
            'focus': '新增只运行部分测试的标记：提交后其他测试不会运行，提交前移除',
            'expected-failure': '新增预期失败标记：失败会被当成通过；修好后移除，确需保留时在提交说明里写明原因'})

    def test_disabled_categories_and_extra_markers(self):
        config = config_from({'version': 1, 'skips': {'disable': ['focus'], 'extraMarkers': [
            {'id': 'later', 'pattern': r'\bLATER\(', 'paths': ['*.ts']}]}})
        self.assertEqual(cats('a.ts', 'it.only("x", fn)', config), [])
        self.assertEqual(cats('a.ts', 'LATER(fn)', config), [(1, 'skip')])
        self.assertEqual(cats('a.js', 'LATER(fn)', config), [])

    def test_only_added_lines_are_reported(self):
        findings = module.find_skips('a.ts', 'it.skip("a", f)\nit.skip("b", f)\n', frozenset({2}), default_config())
        self.assertEqual([f.line for f in findings], [2])


class CommandLine(unittest.TestCase):
    def test_commit_markers_are_reported_with_exit_one(self):
        r = TempRepo()
        self.addCleanup(r.close)
        here = r.install_scripts(); r.commit()
        r.write('tests/a.test.ts', 'import { it } from "vitest"\nit.skip("x", () => {})\n'); r.commit()
        result = r.run(here / 'check-skips.py')
        self.assertEqual((result.returncode, result.stdout.splitlines()), (1, [
            'tests/a.test.ts:2: [skip] 新增跳过测试：修好后移除；确需保留时在提交说明里写明原因',
            '跳过测试检查：检查了 1 个文件，1 处新增标记。']))
