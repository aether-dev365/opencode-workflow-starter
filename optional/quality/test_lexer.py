import unittest
from quality_lexer import family, scan


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


class CodeMask(unittest.TestCase):
    def test_code_keeps_layout_and_blanks_comments_and_string_contents(self):
        text = 'it.skip("x y") // it.only(\n/* fit( */ test("a")\n'
        code = scan('a.test.ts', text).code
        self.assertEqual(len(code), len(text))
        self.assertEqual([i for i, ch in enumerate(code) if ch == '\n'], [i for i, ch in enumerate(text) if ch == '\n'])
        self.assertIn('it.skip("', code)
        for value in ['it.only', 'fit(', 'x y']:
            self.assertNotIn(value, code)
