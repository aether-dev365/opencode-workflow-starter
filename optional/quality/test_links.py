import json
from pathlib import Path
import subprocess
import sys
import unittest
from quality_links import extract_links, resolve_target, OutsideRoot, escape_display


class Links(unittest.TestCase):
    def pairs(self, text):
        return [(x.line, x.target) for x in extract_links(text)]

    def test_nested_images_multiline_labels_and_escaped_titles(self):
        cases = [('[![badge](badge.svg)](page.md)', [(1, 'badge.svg'), (1, 'page.md')]),
                 ('[wrapped\nlabel](page.md)', [(1, 'page.md')]),
                 (r'[x](page.md "a \"quote\" title")', [(1, 'page.md')]),
                 (r"[x](page.md 'a \'quote\' title')", [(1, 'page.md')]),
                 ('[x]( "title")', [(1, '')]),
                 (r'[a\]b [nested]](page.md)', [(1, 'page.md')])]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertCountEqual(self.pairs(text), expected)

    def test_email_autolink_is_external_but_other_at_targets_are_local(self):
        text = '<example@example.invalid> <first.last+tag@example.invalid> [x](local@example.md) ![x](img@example.png) <img src="html@example.png">'
        self.assertEqual(self.pairs(text), [(1, 'local@example.md'), (1, 'img@example.png'), (1, 'html@example.png')])

    def test_markdown_entities_and_escapes_decode_source_once(self):
        cases = [('a&amp;b.md', 'a&b.md'), ('a&#38;b.md', 'a&b.md'), ('a&#x26;b.md', 'a&b.md'),
                 (r'a\&amp;b.md', 'a&amp;b.md'), ('a&amp;amp;b.md', 'a&amp;b.md'),
                 ('a&bsol;&amp;b.md', 'a\\&b.md'), ('a&#92;&amp;b.md', 'a\\&b.md'),
                 ('a&bogus;b.md', 'a&bogus;b.md')]
        for source, expected in cases:
            for text in (f'[x]({source})', f'[id]: {source}', f'[x](<{source}>)'):
                with self.subTest(text=text):
                    self.assertEqual(self.pairs(text), [(1, expected)])
        target = extract_links('[x](a&amp;b.md?query#part)')[0].target
        self.assertIsNone(resolve_target('doc.md', target, ['a&b.md?query#part']))

    def test_quoted_html_braces_are_literal_and_expressions_are_dynamic(self):
        for attribute in ('href', 'src'):
            for quote in ('"', "'"):
                text = f'<X {attribute}={quote}a{{b}}&amp;c.md{quote} other={{nested: {{href: "bad"}}}} />'
                with self.subTest(text=text):
                    self.assertEqual(self.pairs(text), [(1, 'a{b}&c.md')])
        self.assertEqual(self.pairs('<X href={"a{b}.md"} src={{value: "bad"}} />'), [])

    def test_malformed_prefix_growth_is_bounded_and_keeps_tail_link(self):
        source = ('import json,time\nfrom quality_links import extract_links\n'
                  'results=[]\n'
                  'for token in ("[", "[x](", "<"):\n'
                  ' times=[]\n'
                  ' for size in (65536,262144):\n'
                  '  text=token*(size//len(token))+"\\n[tail](missing.md)"\n'
                  '  start=time.monotonic(); links=extract_links(text); times.append(time.monotonic()-start)\n'
                  '  assert any(x.target=="missing.md" and x.line==2 for x in links), links\n'
                  ' results.append(times)\n'
                  'print(json.dumps(results))\n')
        try:
            result = subprocess.run([sys.executable, '-c', source], cwd=Path(__file__).parent,
                                    capture_output=True, text=True, timeout=5)
        except subprocess.TimeoutExpired:
            self.fail('解析 256 KiB 畸形输入超过 5 秒')
        self.assertEqual(result.returncode, 0, result.stderr)
        for small, large in json.loads(result.stdout):
            self.assertLess(large, 2)
            self.assertLess(large, small * 8 + .05)

    def test_inline_images_titles_and_reference_definitions(self):
        cases = [('[文档](docs/a.md "标题")\n![图](img/a.png)\n[id]: other.md\n',
                  [(1, 'docs/a.md'), (2, 'img/a.png'), (3, 'other.md')]),
                 ("[x](a.md 'title') [y](b.md (title))", [(1, 'a.md'), (1, 'b.md')]),
                 ('[id]: a.md "title"\n[x][id] [id][]\n[unused]: b.md\n', [(1, 'a.md'), (3, 'b.md')]),
                 ('[a](same.md) [b](same.md)', [(1, 'same.md'), (1, 'same.md')])]
        for text, expected in cases:
            with self.subTest(text=text):
                self.assertEqual(self.pairs(text), expected)
        links = extract_links('[a](x) [b](y)')
        self.assertEqual([x.offset for x in links], [0, 7])

    def test_angle_destinations_spaces_balanced_parentheses_and_escapes(self):
        for text, target in [('[x](<a space.md> "title")', 'a space.md'), ('<docs/file.md>', 'docs/file.md'),
                             ('[x](dir/a(b(c)).md)', 'dir/a(b(c)).md'), (r'[x](a\(b\).md)', 'a(b).md'),
                             (r'[x](a\ b.md)', None), ('[id]: <a space.md> "title"', 'a space.md'),
                             (r'\[x](ignored.md)', None)]:
            with self.subTest(text=text):
                self.assertEqual(self.pairs(text), [] if target is None else [(1, target)])

    def test_static_html_attributes_entities_and_mdx_expressions(self):
        text = '<a HREF="a&amp;b.md">x</a> <img src=img/a.png>\n<X src=\'x y.png\' href={variable} />'
        self.assertEqual(self.pairs(text), [(1, 'a&b.md'), (1, 'img/a.png'), (2, 'x y.png')])
        links = extract_links('<a href="a.md" src="b.md">')
        self.assertEqual([x.offset for x in links], [3, 15])
        self.assertEqual(self.pairs('<X href={{text: "href=bad.md"}} src={"x"} />'), [])
        self.assertEqual(self.pairs('<a title="href=not-a-link" data-src="also-not" href="real.md">'), [(1, 'real.md')])

    def test_fences_and_backtick_spans_preserve_line_numbers(self):
        text = ('[a](first)\n````python\n[x](ignored)\n```\n[y](still-ignored)\n````\n'
                '[b](second)\n~~~md\n[x](ignored)\n~~~~\n[c](third)\n'
                '`[x](no)` ``a ` [x](no)`` [d](fourth)\n``across\n[x](no)``\n[e](fifth)\n')
        self.assertEqual(self.pairs(text), [(1, 'first'), (7, 'second'), (11, 'third'), (12, 'fourth'), (15, 'fifth')])
        self.assertEqual(self.pairs('~~~\n[x](no)\n'), [])
        self.assertEqual(self.pairs('[x](one)\f[y](two)'), [(1, 'one'), (1, 'two')])

    def test_angle_placeholders_and_comparisons_are_not_local_links(self):
        text = '替换 <YOUR_MODEL> 为实际值，--plan <实际摘要>，格式 <provider/model>，if a < b and c > d，<...>'
        self.assertEqual(self.pairs(text), [])
        for text, target in [('<./guide>', './guide'), ('<docs/guide/>', 'docs/guide/'), ('<docs/file.md#part>', 'docs/file.md#part')]:
            with self.subTest(text=text):
                self.assertEqual(self.pairs(text), [(1, target)])

    def test_tags_and_html_comments_are_not_links(self):
        self.assertEqual(self.pairs('<div>\n<br>\n<!-- [x](no) <img src="no"> -->\n<docs/a.md>'), [(4, 'docs/a.md')])
        self.assertEqual(self.pairs('<!-- unclosed\n[x](no)'), [])

    def test_comment_delimiters_inside_code_do_not_mask_following_links(self):
        self.assertEqual(self.pairs('```html\n<!--\n```\n[x](real.md)'), [(4, 'real.md')])
        self.assertEqual(self.pairs('`<!--` [x](real.md)'), [(1, 'real.md')])
        self.assertEqual(self.pairs('<!--\n```\n-->\n[x](real.md)'), [(4, 'real.md')])

    def test_schemes_protocol_relative_anchor_and_empty_targets_are_skipped(self):
        for target in ['', '#anchor', '//example.invalid/a', 'https://example.invalid', 'MAILTO:x', 'custom+v1.2:x', 'C:/path']:
            with self.subTest(target=target):
                self.assertIsNone(resolve_target('docs/a.md', target, []))
        self.assertEqual(resolve_target('docs/a.md', '../', []), '.')
        self.assertEqual(resolve_target('docs/a.md', '/assets/a.png', []), 'assets/a.png')
        with self.assertRaises(OutsideRoot):
            resolve_target('docs/a.md', '../../outside.md', [])

    def test_query_fragment_then_single_percent_decode(self):
        cases = [('/assets/a%23b.png?raw=1#x', 'assets/a#b.png'), ('a%3Fb.md#x?q', 'docs/a?b.md'),
                 ('%2523.md', 'docs/%23.md'), ('%E4%B8%AD%E6%96%87.md', 'docs/中文.md'),
                 ('?query', None), ('a.md?x#y', 'docs/a.md')]
        for target, expected in cases:
            self.assertEqual(resolve_target('docs/a.md', target, []), expected)
        with self.assertRaises(OutsideRoot):
            resolve_target('docs/a.md', '%2e%2e/%2e%2e/out', [])

    def test_ignore_matches_before_decode_and_suffix_removal(self):
        self.assertIsNone(resolve_target('docs/a.md', 'generated/x.md#part', ['generated/*']))
        self.assertIsNone(resolve_target('docs/a.md', 'a%23b?x', ['a%23b?x']))
        self.assertEqual(resolve_target('docs/a.md', 'a%23b?x', ['a#b']), 'docs/a#b')

    def test_display_escapes_controls_without_escaping_chinese(self):
        self.assertEqual(escape_display('中文\n\r\t\x1b\x00\x7f'), r'中文\n\r\t\x1b\x00\x7f')
