"""Static local links: deliberately not a complete Markdown/MDX renderer."""

from dataclasses import dataclass
from bisect import bisect_right
import html
import posixpath
import re
import string
import unicodedata
from urllib.parse import unquote
from quality_lib import Incomplete, glob_match


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
    chars = list(text)
    ticks, following = {}, {}
    for run in reversed(list(re.finditer(r'`+', text))):
        size = run.end() - run.start()
        following[run.start()] = ticks.get(size)
        ticks[size] = run.end()
    i = 0
    opening = re.compile(r' {0,3}(`{3,}|~{3,})([^\n]*)')
    while i < len(text):
        if not i or text[i - 1] == '\n':
            match = opening.match(text, i)
            if match and (match[1][0] != '`' or '`' not in match[2]):
                closing = re.compile(r'^ {0,3}' + re.escape(match[1][0]) + '{' + str(len(match[1])) + r',}[ \t\r]*$', re.M)
                close = closing.search(text, match.end())
                stop = close.end() if close else len(text)
                chars[i:stop] = _blank(text[i:stop])
                i = stop
                continue
        if text.startswith('<!--', i):
            end = text.find('-->', i + 4)
            stop = end + 3 if end >= 0 else len(text)
            chars[i:stop] = _blank(text[i:stop])
            i = stop
            continue
        if text[i] != '`' or _escaped(text, i):
            i += 1
            continue
        end = i
        while end < len(text) and text[end] == '`':
            end += 1
        stop = following.get(i)
        if stop is not None:
            chars[i:stop] = _blank(text[i:stop])
            i = stop
        else:
            i = end
    return ''.join(chars)


def _unescape(value):
    # 同一个源 token 只解释一次，新产生的反斜线和 & 不再进入解析器。
    pattern = r'\\[' + re.escape(string.punctuation) + r']|&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);'
    def decode(match):
        token = match[0]
        if token.startswith('\\'):
            return token[1:]
        if token.startswith('&#') or token[1:] in html.entities.html5:
            return html.unescape(token)
        return token
    return re.sub(pattern, decode, value)


class _Scan:
    def __init__(self, text):
        self.remaining = 32 * len(text) + 1024
        self.escaped = bytearray(len(text))
        self.parens = {}
        stack = []
        escaped = False
        for i, ch in enumerate(text):
            self.escaped[i] = escaped
            if not escaped:
                if ch == '(':
                    stack.append(i)
                elif ch == ')' and stack:
                    self.parens[stack.pop()] = i
            escaped = ch == '\\' and not escaped

    def step(self, count=1):
        self.remaining -= count
        if self.remaining < 0:
            raise Incomplete('链接分析预算用尽')


def _destination(text, start, scan):
    i = start
    while i < len(text) and text[i].isspace():
        scan.step()
        i += 1
    if i < len(text) and text[i] == '<':
        begin = i + 1
        i += 1
        while i < len(text):
            scan.step()
            if text[i] == '>' and not scan.escaped[i]:
                scan.step(i - begin)
                return _unescape(text[begin:i]), i + 1
            if text[i] == '\n' or (text[i] == '<' and not scan.escaped[i]):
                return None
            i += 1
        return None
    begin = i
    while i < len(text):
        scan.step()
        ch = text[i]
        if ch == '\\' and i + 1 < len(text) and text[i + 1] in string.punctuation:
            i += 2
            continue
        if ch.isspace() or ch == ')':
            break
        if ch == '(':
            end = scan.parens.get(i)
            if end is None:
                return None
            i = end
        i += 1
    scan.step(i - begin)
    return _unescape(text[begin:i]), i


def _tail(text, start, scan):
    i = start
    while i < len(text) and text[i].isspace():
        scan.step()
        i += 1
    if i < len(text) and text[i] in '\"\'(':
        close = ')' if text[i] == '(' else text[i]
        i += 1
        while i < len(text) and (text[i] != close or scan.escaped[i]):
            scan.step()
            i += 1
        if i == len(text):
            return None
        i += 1
        while i < len(text) and text[i].isspace():
            scan.step()
            i += 1
    return i + 1 if i < len(text) and text[i] == ')' else None


def _tag_end(text, start, scan):
    quote, depth = None, 0
    i = start
    while i < len(text):
        scan.step()
        ch = text[i]
        if quote:
            if ch == quote and (not depth or not scan.escaped[i]):
                quote = None
        elif ch in '\"\'':
            quote = ch
        elif ch == '{':
            depth += 1
        elif ch == '}' and depth:
            depth -= 1
        elif ch == '>' and not depth:
            return i + 1
        elif ch == '<' and not depth:
            return None
        i += 1
    return None


def _attributes(inner, scan):
    pattern = re.compile(r'[\w:-]+')
    i = 0
    while i < len(inner):
        scan.step()
        attr = pattern.match(inner, i)
        if not attr:
            i += 1
            continue
        i = attr.end()
        while i < len(inner) and inner[i].isspace():
            scan.step()
            i += 1
        if i == len(inner) or inner[i] != '=':
            continue
        i += 1
        while i < len(inner) and inner[i].isspace():
            scan.step()
            i += 1
        if i == len(inner):
            break
        value = None
        if inner[i] in '\"\'':
            quote, begin = inner[i], i + 1
            i = inner.find(quote, begin)
            if i < 0:
                break
            value = inner[begin:i]
            i += 1
        elif inner[i] == '{':
            depth, quote = 1, None
            i += 1
            while i < len(inner) and depth:
                scan.step()
                ch = inner[i]
                if quote:
                    if ch == '\\':
                        i += 2
                        continue
                    if ch == quote:
                        quote = None
                elif ch in '\"\'`':
                    quote = ch
                elif ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                i += 1
        else:
            begin = i
            while i < len(inner) and not inner[i].isspace() and inner[i] not in '\"\'=<>`{}':
                scan.step()
                i += 1
            value = inner[begin:i] or None
        if attr[0].lower() in ('href', 'src') and value is not None:
            yield attr.start(), html.unescape(value)


def extract_links(text: str) -> list[Link]:
    masked = _mask(text)
    scan = _Scan(masked)
    links = []
    occupied = bytearray(len(text))
    newlines = [i for i, ch in enumerate(text) if ch == '\n']

    def add(offset, target):
        links.append(Link(offset, bisect_right(newlines, offset) + 1, target))

    for match in re.finditer(r'^ {0,3}\[([^\]\n]+)\]:[ \t]*', masked, re.M):
        dest = _destination(masked, match.end(), scan)
        if dest:
            target, end = dest
            add(match.start() + len(match[0]) - len(match[0].lstrip()), target)
            occupied[match.start():end] = b'\1' * (end - match.start())
    # 标签栈保留外层链接；失败目的地借助括号索引跳过无闭合后缀。
    labels = []
    i = 0
    while i < len(masked):
        scan.step()
        if occupied[i] or scan.escaped[i]:
            i += 1
            continue
        ch = masked[i]
        if ch == '[':
            labels.append(i - 1 if i and masked[i - 1] == '!' and not scan.escaped[i - 1] else i)
        elif ch == ']' and labels:
            start = labels.pop()
            if i + 1 < len(masked) and masked[i + 1] == '(':
                begin = i + 2
                nonspace = begin
                while nonspace < len(masked) and masked[nonspace].isspace():
                    scan.step()
                    nonspace += 1
                empty_title = nonspace > begin and nonspace < len(masked) and masked[nonspace] in '\"\''
                dest = ('', begin) if empty_title else _destination(masked, begin, scan)
                if dest:
                    target, end = dest
                    stop = _tail(masked, end, scan)
                    if stop:
                        add(start, target)
                        i = stop
                        continue
        if ch != '<':
            i += 1
            continue
        end = _tag_end(masked, i + 1, scan)
        if end is None:
            i += 1
            continue
        inner = masked[i + 1:end - 1]
        tag = re.match(r'/?[A-Za-z][A-Za-z0-9:-]*(?=\s|/?$)', inner)
        if tag:
            for offset, value in _attributes(inner, scan):
                add(i + 1 + offset, value)
        elif inner and '\n' not in inner:
            email = re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", inner)
            if not email:
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
