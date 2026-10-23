"""Static local links: deliberately not a complete Markdown/MDX renderer."""

from dataclasses import dataclass
import html
import posixpath
import re
import string
import unicodedata
from urllib.parse import unquote
from quality_lib import glob_match


@dataclass(frozen=True)
class Link:
    offset: int
    line: int
    target: str


class OutsideRoot(ValueError):
    pass


def _blank(text):
    return ''.join('\n' if ch == '\n' else ' ' for ch in text)


def _escaped(text, index):
    start = index
    while start and text[start - 1] == '\\':
        start -= 1
    return (index - start) % 2 == 1


def _mask(text):
    text = re.sub(r'<!--[\s\S]*?(?:-->|\Z)', lambda m: _blank(m[0]), text)
    # 源行只按换行计算，其他 Unicode 行分隔符仍是普通字符。
    lines = text.split('\n')
    fence = None
    for n, line in enumerate(lines):
        match = re.match(r' {0,3}(`{3,}|~{3,})(.*)$', line)
        if fence:
            lines[n] = _blank(line)
            if match and match[1][0] == fence[0] and len(match[1]) >= fence[1] and not match[2].strip():
                fence = None
        elif match and (match[1][0] != '`' or '`' not in match[2]):
            fence = match[1][0], len(match[1])
            lines[n] = _blank(line)
    text = '\n'.join(lines)
    chars = list(text)
    i = 0
    while i < len(text):
        if text[i] != '`' or _escaped(text, i):
            i += 1
            continue
        end = i
        while end < len(text) and text[end] == '`':
            end += 1
        close = re.search(r'(?<!`)`{' + str(end - i) + r'}(?!`)', text[end:])
        if close:
            stop = end + close.end()
            chars[i:stop] = _blank(text[i:stop])
            i = stop
        else:
            i = end
    return ''.join(chars)


def _unescape(value):
    return re.sub(r'\\([' + re.escape(string.punctuation) + r'])', r'\1', value)


def _destination(text, start):
    i = start
    while i < len(text) and text[i].isspace():
        i += 1
    if i < len(text) and text[i] == '<':
        begin = i + 1
        i += 1
        while i < len(text):
            if text[i] == '>' and not _escaped(text, i):
                return _unescape(text[begin:i]), i + 1
            if text[i] == '\n':
                return None
            i += 1
        return None
    begin, depth = i, 0
    while i < len(text):
        ch = text[i]
        if ch == '\\' and i + 1 < len(text) and text[i + 1] in string.punctuation:
            i += 2
            continue
        if ch.isspace() and depth == 0:
            break
        if ch == '(':
            depth += 1
        elif ch == ')':
            if not depth:
                break
            depth -= 1
        i += 1
    if depth:
        return None
    return _unescape(text[begin:i]), i


def _tag_end(text, start):
    quote, depth = None, 0
    i = start
    while i < len(text):
        ch = text[i]
        if quote:
            if ch == quote and (not depth or not _escaped(text, i)):
                quote = None
        elif ch in '\"\'':
            quote = ch
        elif ch == '{':
            depth += 1
        elif ch == '}' and depth:
            depth -= 1
        elif ch == '>' and not depth:
            return i + 1
        i += 1
    return None


def extract_links(text: str) -> list[Link]:
    masked = _mask(text)
    links, occupied = [], []

    def add(offset, target):
        links.append(Link(offset, text.count('\n', 0, offset) + 1, target))

    for match in re.finditer(r'^ {0,3}\[([^\]\n]+)\]:[ \t]*', masked, re.M):
        dest = _destination(masked, match.end())
        if dest:
            target, end = dest
            add(match.start() + len(match[0]) - len(match[0].lstrip()), target)
            occupied.append((match.start(), end))
    # Markdown 目的地逐字符平衡括号；标题属于语法而不是文件名。
    for match in re.finditer(r'!?\[(?:\\.|[^\]\n])*\]\(', masked):
        start = match.start()
        if _escaped(masked, start) or any(a <= start < b for a, b in occupied):
            continue
        dest = _destination(masked, match.end())
        if not dest:
            continue
        target, end = dest
        rest = re.match(r'''\s*(?:"[^"\n]*"|'[^'\n]*'|\([^\n]*?\))?\s*\)''', masked[end:])
        if rest:
            add(start, target)
            occupied.append((start, end + rest.end()))
    i = 0
    while i < len(masked):
        if masked[i] != '<' or any(a <= i < b for a, b in occupied) or _escaped(masked, i):
            i += 1
            continue
        end = _tag_end(masked, i + 1)
        if end is None:
            i += 1
            continue
        inner = masked[i + 1:end - 1]
        tag = re.match(r'/?[A-Za-z][A-Za-z0-9:-]*(?=\s|/?$)', inner)
        if tag:
            # 屏蔽表达式整个值，不能把表达式内字符串当成静态属性。
            attrs = re.sub(r'\{(?:[^{}]|\{[^{}]*\})*\}', lambda m: '{' + _blank(m[0][1:-1]) + '}', inner)
            pattern = r'''([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`{}]+)))?'''
            for attr in re.finditer(pattern, attrs, re.I):
                value = next((v for v in attr.groups()[1:] if v is not None), None)
                if attr[1].lower() in ('href', 'src') and value is not None:
                    add(i + 1 + attr.start(), html.unescape(value))
        elif inner and '\n' not in inner:
            add(i, _unescape(inner))
        i = end
    return sorted(set(links), key=lambda link: (link.offset, link.target))


def resolve_target(document: str, target: str, ignore_targets: list[str]) -> str | None:
    if not target or target.startswith(('#', '//')) or re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', target):
        return None
    if any(glob_match(pattern, target) for pattern in ignore_targets):
        return None
    path = re.split(r'[?#]', target, maxsplit=1)[0]
    if not path:
        return None
    path = unquote(path)
    path = path.lstrip('/') if path.startswith('/') else posixpath.join(posixpath.dirname(document), path)
    path = posixpath.normpath(path)
    if path == '..' or path.startswith('../'):
        raise OutsideRoot(target)
    return path


def escape_display(value: str) -> str:
    result = []
    for ch in value:
        if ch in '\n\r\t':
            result.append({'\n': r'\n', '\r': r'\r', '\t': r'\t'}[ch])
        elif unicodedata.category(ch).startswith('C'):
            result.append(f'\\x{ord(ch):02x}' if ord(ch) < 256 else f'\\u{ord(ch):04x}')
        else:
            result.append(ch)
    return ''.join(result)
