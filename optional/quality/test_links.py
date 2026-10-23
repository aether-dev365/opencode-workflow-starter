import unittest
from quality_links import extract_links, resolve_target, OutsideRoot, escape_display


class Links(unittest.TestCase):
    def pairs(self, text):
        return [(x.line, x.target) for x in extract_links(text)]

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

    def test_tags_and_html_comments_are_not_links(self):
        self.assertEqual(self.pairs('<div>\n<br>\n<!-- [x](no) <img src="no"> -->\n<docs/a.md>'), [(4, 'docs/a.md')])
        self.assertEqual(self.pairs('<!-- unclosed\n[x](no)'), [])

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
