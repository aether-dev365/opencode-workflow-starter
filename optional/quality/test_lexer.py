import unittest
from unittest import mock
import warnings
from quality_lexer import family, scan
from quality_lexer import test_titles


def comments(path, text):
    return [(c.line, c.text.strip()) for c in scan(path, text).comments]


class Families(unittest.TestCase):
    def test_family_by_name_and_case_insensitive_suffix(self):
        cases = {'src/A.TS': 'c', 'a.go': 'c', 'a.jsonc': 'c', 'a.scss': 'c', 'a.css': 'css', 'a.sql': 'sql',
                 'a.vue': 'markup', 'a.html': 'markup', 'a.py': 'hash', 'x.R': 'hash', 'Dockerfile': 'hash',
                 'deploy/Dockerfile.prod': 'hash', 'app.dockerfile': 'hash', 'Makefile': 'hash', '.env.example': 'hash',
                 'README.md': None, 'data.json': None, '.env': None, 'image.png': None}
        for path, expected in cases.items():
            with self.subTest(path=path):
                self.assertEqual(family(path), expected)


class CLikeComments(unittest.TestCase):
    CASES = [
        ('a.ts', 'const u = "http://x" // tail\n', [(1, 'tail')]),
        ('a.ts', "const s = '//not'; /* one\n * two */\n", [(1, 'one'), (2, 'two')]),
        ('a.js', 'const t = `a ${b} // no`; // yes\n', [(1, 'yes')]),
        ('a.js', "const re = /'/; // Task 3\n", [(1, 'Task 3')]),
        ('a.go', 'var s = `raw // no` // yes\n', [(1, 'yes')]),
        ('a.rs', "fn f<'a>(x: &'a str) -> &'a str { x } // yes\n", [(1, 'yes')]),
        ('a.rs', 'let s = r#"say "//" here"#; // yes\n', [(1, 'yes')]),
        ('a.c', "char c = '\"'; // yes\n", [(1, 'yes')]),
        ('a.cs', 'var p = @"C:\\dir\\"; // yes\n', [(1, 'yes')]),
        ('a.kt', 'val s = """a // no""" // yes\n', [(1, 'yes')]),
        ('a.php', '$a = 1; # yes\n#[Attr]\nfunction f() {}\n', [(1, 'yes')]),
        ('a.css', 'a { background: url(http://x/y.png); } /* yes */\n', [(1, 'yes')]),
        ('a.scss', 'a { background: url(http://x/y.png); } // yes\n', [(1, 'yes')]),
        ('a.sql', "SELECT 'a--b' AS x; -- yes\nSELECT a--b FROM t; /* two */\n", [(1, 'yes'), (2, 'two')]),
        ('a.html', '<!-- yes -->\n<script>\n// js\n</script>\n<style>/* css */</style>\n<p>http://x // text</p>\n',
         [(1, 'yes'), (3, 'js'), (5, 'css')]),
        ('a.vue', '<template><!-- t --></template>\n<script setup lang="ts">\nconst a = 1 // s\n</script>\n', [(1, 't'), (3, 's')]),
        ('a.ts', 'const a = 1 // one\r\n// two\r\n', [(1, 'one'), (2, 'two')]),
        ('a.ts', '// last', [(1, 'last')]), ('a.ts', '', []),
        ('a.ts', '/* open\nstill', [(1, 'open'), (2, 'still')]),
        ('a.ts', 'const s = "open\n// next\n', [(2, 'next')]),
    ]

    def test_comments_are_separated_from_strings(self):
        for path, text, expected in self.CASES:
            with self.subTest(path=path, text=text):
                self.assertEqual(comments(path, text), expected)

    def test_comment_text_has_no_carriage_return(self):
        self.assertTrue(all('\r' not in c.text for c in scan('a.ts', '// one\r\n/* two\r\n*/\r\n').comments))

    def test_nested_template_literals_stay_data(self):
        for text in ['const s = `outer ${`// Task 3`} tail`; // real\n',
                     'const s = `outer ${`it.skip("x", fn)`} tail`; // real\n',
                     'const s = `outer ${f({x: `inner ${"}"}`})} tail`; // real\n',
                     'const s = `outer ${/}/.test(x) ? `// Task 3` : ""} tail`; // real\n']:
            with self.subTest(text=text):
                result = scan('a.ts', text)
                self.assertEqual([(c.line, c.text) for c in result.comments], [(1, 'real')])
                self.assertNotIn('it.skip', result.code)


class CodeMask(unittest.TestCase):
    def test_code_keeps_layout_and_blanks_comments_and_string_contents(self):
        text = 'it.skip("x y") // it.only(\n/* fit( */ test("a")\n'
        code = scan('a.test.ts', text).code
        self.assertEqual(len(code), len(text))
        self.assertEqual([i for i, ch in enumerate(code) if ch == '\n'], [i for i, ch in enumerate(text) if ch == '\n'])
        self.assertIn('it.skip("', code)
        for value in ['it.only', 'fit(', 'x y']:
            self.assertNotIn(value, code)


class HashComments(unittest.TestCase):
    CASES = [
        ('a.sh', "echo \"#no\" '#no' a#b ${#x} $# # yes\n", [(1, 'yes')]),
        ('a.sh', "cat <<'EOF'\n# data\nEOF\n# yes\n", [(4, 'yes')]),
        ('a.sh', 'cat <<-EOF\n\t# data\n\tEOF\n# yes\n', [(4, 'yes')]),
        ('Makefile', 'all:\n\techo a#b # yes\n', [(2, 'yes')]),
        ('a.yaml', 'key: a#b # yes\nurl: "http://x#frag"\n', [(1, 'yes')]),
        ('a.py', 'x = "#no"  # yes\ns = """\n# in string\n"""\n', [(1, 'yes')]),
        ('a.rb', '=begin\nblock\n=end\nputs "a#{b}" # yes\n', [(2, 'block'), (4, 'yes')]),
        ('a.ps1', "<# block #>\n$a = 'it''s' # yes\n", [(1, 'block'), (2, 'yes')]),
        ('a.ps1', "$a = @'\n# data\n'@\n# yes\n", [(4, 'yes')]),
        ('Dockerfile', 'RUN echo a # not comment\n# yes\n', [(2, 'yes')]),
        ('a.ini', '; yes\nkey = a;b\n', [(1, 'yes')]),
        ('a.properties', '! yes\nkey=a!b\n', [(1, 'yes')]),
        ('a.tf', '# one\n// two\n/* three */\n', [(1, 'one'), (2, 'two'), (3, 'three')]),
        ('.env.example', '# yes\nKEY=a#b\n', [(1, 'yes')]),
        ('a.toml', 'k = "a#b" # data\n# yes\n', [(1, 'data'), (2, 'yes')]),
    ]

    def test_hash_comments_follow_each_language(self):
        for path, text, expected in self.CASES:
            with self.subTest(path=path, text=text):
                self.assertEqual(comments(path, text), expected)

    def test_toml_four_string_forms_preserve_trailing_comments(self):
        cases = [
            ('key = "escaped \\" # data" # real\n', [(1, 'real')]),
            ("key = 'literal \\' # real\n", [(1, 'real')]),
            ('key = """multi\n# data \\""" still data\n""" # real\n', [(3, 'real')]),
            ("key = '''multi\n# data \\''' # real\n", [(2, 'real')]),
        ]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(comments('a.toml', text), expected)

    def test_toml_multiline_closing_quotes_do_not_hide_trailing_comments(self):
        for quote in ('"', "'"):
            for count in (4, 5):
                with self.subTest(quote=quote, count=count):
                    text = 'key = ' + quote * 3 + 'text' + quote * count + ' # Task 3\n'
                    self.assertEqual(comments('a.toml', text), [(1, 'Task 3')])

    def test_heredoc_body_is_blank_code(self):
        self.assertNotIn('rm -rf', scan('a.sh', "cat <<'EOF'\nrm -rf x\nEOF\n").code)

    def test_here_strings_do_not_consume_later_lines(self):
        self.assertEqual(comments('a.sh', 'cat <<<"hello"\n# Task 4\n'), [(2, 'Task 4')])

    def test_yaml_form_feed_does_not_end_a_physical_data_line(self):
        self.assertEqual(comments('a.yaml', 'value: |\n  data\f# Task 3\n# real\n'), [(3, 'real')])

    def test_heredoc_delimiters_can_contain_punctuation_and_quotes(self):
        for word in ['EOF.data', "'EOF'.data", '"EOF.data"', r'EOF\.data']:
            with self.subTest(word=word):
                text = 'cat <<' + word + '\n# data\nEOF.data\n# real\n'
                self.assertEqual(comments('a.sh', text), [(4, 'real')])

    def test_multiline_strings_remain_data(self):
        for path in ['a.rb', 'a.php']:
            with self.subTest(path=path):
                result = scan(path, 'value = "data\n# Task 3\nskip\n"\n# real\n')
                self.assertEqual([(c.line, c.text) for c in result.comments], [(5, 'real')])
                self.assertNotIn('skip', result.code)

    def test_yaml_block_scalars_remain_data(self):
        for marker in ['|', '>', '|-', '>+', '|2', '|2-']:
            with self.subTest(marker=marker):
                text = 'script: ' + marker + ' # header\n  # Task 3\n  it.skip("data")\n\n# real\nnext: 1\n'
                result = scan('a.yaml', text)
                self.assertEqual([(c.line, c.text) for c in result.comments], [(1, 'header'), (5, 'real')])
                self.assertNotIn('it.skip', result.code)
        self.assertEqual(comments('a.yaml', '- text: |\n    # data\n  value: 1 # real\n'), [(3, 'real')])


class Docstrings(unittest.TestCase):
    def test_python_docstrings_are_comments(self):
        text = '"""Module doc."""\ndef f():\n    """Line one.\n    Line two.\n    """\n    return 1\n'
        self.assertEqual(comments('a.py', text), [(1, 'Module doc.'), (3, 'Line one.'), (4, 'Line two.')])

    def test_unparsable_python_keeps_hash_comments(self):
        self.assertEqual(comments('bad.py', 'def f(:\n    # yes\n'), [(2, 'yes')])

    def test_python_parse_warnings_are_silenced_even_when_errors(self):
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('error')
            self.assertEqual(comments('a.py', '"""Task 3 \\q"""\n'), [(1, 'Task 3 \\q')])
            self.assertEqual(caught, [])

    def test_all_ast_warning_categories_are_silenced(self):
        import ast
        parse = ast.parse
        def warning_parse(text):
            warnings.warn('不能回显的内容', RuntimeWarning)
            return parse(text)
        with mock.patch('quality_lexer.ast.parse', side_effect=warning_parse), warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter('error')
            self.assertEqual(comments('a.py', '"""Task 3"""\n'), [(1, 'Task 3')])
            self.assertEqual(caught, [])


class TestTitles(unittest.TestCase):
    CASES = [
        ('a.test.ts', "describe('suite title', () => {\n  it.only(\"case title\", () => {})\n})\n", [(1, 'suite title'), (2, 'case title')]),
        ('a.ts', "if (/x/.test('Task 3')) {}\n", []),
        ('a.ts', 'it(`with ${x}`, () => {})\n', []),
        ('a.ts', "// it('commented', () => {})\n", []),
        ('A.java', '@DisplayName("bug #12 regression")\n', [(1, 'bug #12 regression')]),
        ('a_test.go', 't.Run("FR-001 case", func(t *testing.T) {})\n', [(1, 'FR-001 case')]),
        ('a_test.dart', "testWidgets('renders', (t) async {})\n", [(1, 'renders')]),
        ('a.py', 'def test_x():\n    pass\n', []),
    ]

    def test_titles_come_from_string_literals_in_code(self):
        for path, text, expected in self.CASES:
            with self.subTest(path=path, text=text):
                self.assertEqual([(c.line, c.text) for c in test_titles(path, text)], expected)

    def test_multiline_titles_keep_physical_lines(self):
        cases = [
            ('a.test.ts', 'it(`works\nTask 3`, fn)', [(1, 'works'), (2, 'Task 3')]),
            ('a.test.ts', 'it("works\\\nTask 3", fn)', [(1, 'works\\'), (2, 'Task 3')]),
            ('a_test.dart', 'test("""works\nTask 3""", fn)', [(1, 'works'), (2, 'Task 3')]),
            ('a_test.dart', "test(r'''Task 3''', fn)", [(1, 'Task 3')]),
            ('a_test.go', 't.Run(`works\nTask 3`, fn)', [(1, 'works'), (2, 'Task 3')]),
        ]
        for path, text, expected in cases:
            with self.subTest(path=path, text=text):
                self.assertEqual([(c.line, c.text) for c in test_titles(path, text)], expected)

    def test_computed_title_arguments_are_not_literals(self):
        for text in ['it("Task 3" + suffix, fn)', 'it("Task 3".trim(), fn)', 'it(`Task 3` + suffix, fn)']:
            with self.subTest(text=text):
                self.assertEqual(test_titles('a.test.ts', text), [])
