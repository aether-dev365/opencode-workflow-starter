"""Separate source comments and literals while preserving physical positions."""

from bisect import bisect_left
from dataclasses import dataclass
from pathlib import PurePosixPath
import re


JS = set('.js .mjs .cjs .jsx .ts .tsx .mts .cts'.split())
C = set(('.java .kt .kts .groovy .gradle .scala .go .rs .c .h .cc .cpp .cxx .hpp .hh '
         '.cs .swift .dart .php .proto .jsonc .json5 .scss .less').split()) | JS
HASH = set(('.py .pyi .sh .bash .zsh .bats .rb .pl .pm .r .yaml .yml .toml .tf .hcl '
            '.conf .cfg .ini .properties .ps1 .psm1 .mk').split())
MARKUP = set('.html .htm .xml .xsd .xsl .vue .svelte'.split())
CHARS = set('.c .h .cc .cpp .cxx .hpp .hh .cs .java .kt .kts .scala .go .rs'.split())


@dataclass(frozen=True)
class Comment:
    line: int
    text: str


@dataclass(frozen=True)
class Scan:
    comments: list[Comment]
    code: str


def family(path: str) -> str | None:
    name = PurePosixPath(path).name
    if name in ('Dockerfile', 'Makefile', '.env.example') or name.startswith('Dockerfile.') or name.endswith('.dockerfile'):
        return 'hash'
    ext = PurePosixPath(path).suffix.lower()
    return 'c' if ext in C else 'hash' if ext in HASH else 'markup' if ext in MARKUP else 'css' if ext == '.css' else 'sql' if ext == '.sql' else None


def _literal_end(text, start, quote, escape=True, multiline=False, doubled=False):
    i = start + len(quote)
    while i < len(text):
        if not multiline and text[i] in '\r\n':
            return i, i
        if text.startswith(quote, i):
            if doubled and text.startswith(quote * 2, i):
                i += len(quote) * 2
                continue
            return i, i + len(quote)
        if escape and text[i] == ('`' if escape == 'backtick' else '\\'):
            i += 2
        else:
            i += 1
    return len(text), len(text)


def scan(path: str, text: str) -> Scan:
    kind = family(path)
    if kind is None:
        return Scan([], text)
    ext = PurePosixPath(path).suffix.lower()
    code = list(text)
    found = []
    newlines = [i for i, ch in enumerate(text) if ch == '\n']

    def blank(start, end):
        for pos in range(start, end):
            if text[pos] not in '\r\n':
                code[pos] = ' '

    def comment(start, body, end, stop):
        line = bisect_left(newlines, body) + 1
        for offset, value in enumerate(text[body:end].split('\n')):
            value = re.sub(r'^\s*\* ?', '', value).strip()
            if value:
                found.append(Comment(line + offset, value))
        blank(start, stop)
        return stop

    i = 0
    while i < len(text):
        if kind == 'markup':
            if text.startswith('<!--', i):
                end = text.find('-->', i + 4)
                end = len(text) if end < 0 else end
                i = comment(i, i + 4, end, min(end + 3, len(text)))
                continue
            block = re.match(r'<(script|style)\b[^>]*>', text[i:], re.I) if text[i] == '<' and ext in {'.html', '.htm', '.vue', '.svelte'} else None
            if block:
                start = i + block.end()
                closing = re.search(r'</' + block[1] + r'\s*>', text[start:], re.I)
                end = start + closing.start() if closing else len(text)
                nested_ext = '.js' if block[1].lower() == 'script' else '.css'
                if nested_ext == '.css' and re.search(r'lang\s*=\s*[\"\'](?:scss|less)[\"\']', block[0], re.I):
                    nested_ext = '.scss'
                nested = scan('embedded' + nested_ext, text[start:end])
                blank(i, start)
                code[start:end] = nested.code
                offset = bisect_left(newlines, start)
                found.extend(Comment(c.line + offset, c.text) for c in nested.comments)
                i = end
                continue
            blank(i, i + 1)
            i += 1
            continue

        block_end = None
        if text.startswith('/*', i) and kind in {'c', 'css', 'sql'}:
            block_end = '*/'
        if block_end:
            end = text.find(block_end, i + 2)
            end = len(text) if end < 0 else end
            i = comment(i, i + 2, end, min(end + 2, len(text)))
            continue
        line_size = 0
        if kind == 'c' and text.startswith('//', i) and not (ext in {'.scss', '.less'} and i > 0 and text[i - 1] == ':'):
            line_size = 2
        elif kind == 'sql' and text.startswith('--', i) and (i + 2 == len(text) or text[i + 2].isspace()):
            line_size = 2
        elif ext == '.php' and text[i] == '#' and not text.startswith('#[', i):
            line_size = 1
        if line_size:
            end = text.find('\n', i)
            end = len(text) if end < 0 else end
            i = comment(i, i + line_size, end, end)
            continue

        if ext == '.rs' and text[i] == 'r':
            raw = re.match(r'r(\#*)"', text[i:])
            if raw:
                start = i + raw.end()
                ending = '"' + raw[1]
                end = text.find(ending, start)
                end = len(text) if end < 0 else end
                blank(start, end)
                i = min(end + len(ending), len(text))
                continue
        if ext == '.cs' and text.startswith('@"', i):
            end, stop = _literal_end(text, i + 1, '"', False, True, True)
            blank(i + 2, end)
            i = stop
            continue
        if ext in JS and text[i] == '/':
            before = text[:i].rstrip()
            if not before or before[-1] in '(,=:[!&|?{};' or re.search(r'\breturn$', before):
                j, bracket = i + 1, False
                while j < len(text) and text[j] not in '\r\n':
                    if text[j] == '\\':
                        j += 2
                        continue
                    if text[j] == '[':
                        bracket = True
                    elif text[j] == ']':
                        bracket = False
                    elif text[j] == '/' and not bracket:
                        j += 1
                        break
                    j += 1
                blank(i, min(j, len(text)))
                i = j
                continue
        quote = text[i]
        if quote in '\"\'' or (quote == '`' and ext in JS | {'.go'}):
            if quote == "'" and ext in CHARS and not re.match(r"'(?:[^'\\\r\n]|\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|.))'", text[i:]):
                i += 1
                continue
            triple = ext in {'.kt', '.kts', '.java', '.swift', '.dart', '.scala'} and text.startswith(quote * 3, i)
            quote = quote * 3 if triple else quote
            raw = ext == '.go' or (ext == '.dart' and i > 0 and text[i - 1] == 'r')
            end, stop = _literal_end(text, i, quote, not raw, triple or quote == '`' or kind == 'sql', kind == 'sql')
            blank(i + len(quote), end)
            i = stop
            continue
        i += 1
    return Scan(sorted(found, key=lambda c: c.line), ''.join(code))
