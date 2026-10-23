"""Separate source comments and literals while preserving physical positions."""

from bisect import bisect_left
import ast
from dataclasses import dataclass
from pathlib import PurePosixPath
import re
import shlex
import warnings


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


def _regex_start(text, start):
    i = start - 1
    while i >= 0 and text[i].isspace():
        if text[i] == '\n':
            return True
        i -= 1
    return i < 0 or text[i] in '(,=:[!&|?{};' or (text[max(0, i - 5):i + 1] == 'return'
                                                and (i < 6 or not (text[i - 6].isalnum() or text[i - 6] in '_$')))


def _regex_end(text, start):
    i, bracket = start + 1, False
    while i < len(text) and text[i] not in '\r\n':
        if text[i] == '\\':
            i += 2
            continue
        if text[i] == '[':
            bracket = True
        elif text[i] == ']':
            bracket = False
        elif text[i] == '/' and not bracket:
            return i + 1
        i += 1
    return min(i, len(text))


def _template_end(text, start):
    stack = [0]
    i = start + 1
    while i < len(text):
        if stack[-1] == 0:
            if text[i] == '\\':
                i += 2
                continue
            if text[i] == '`':
                stack.pop()
                if not stack:
                    return i, i + 1
            elif text.startswith('${', i):
                stack.append(1)
                i += 2
                continue
        else:
            if text[i] == '`':
                stack.append(0)
            elif text[i] in '\"\'':
                _, i = _literal_end(text, i, text[i])
                continue
            elif text.startswith('//', i):
                end = text.find('\n', i + 2)
                i = len(text) if end < 0 else end
                continue
            elif text.startswith('/*', i):
                end = text.find('*/', i + 2)
                i = len(text) if end < 0 else end + 2
                continue
            elif text[i] == '/' and _regex_start(text, i):
                i = _regex_end(text, i)
                continue
            elif text[i] == '{':
                stack[-1] += 1
            elif text[i] == '}':
                stack[-1] -= 1
                if stack[-1] == 0:
                    stack.pop()
        i += 1
    return len(text), len(text)


def _yaml_data(text):
    parts = text.split('\n')
    lines = [part + '\n' for part in parts[:-1]] + [parts[-1]]
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    spans = {}
    i = 0
    while i < len(lines):
        header = re.fullmatch(r'( *)(?:-\s+)?(?:[^#\r\n]+?:[ \t]+)?[|>]([1-9+-]{0,2})[ \t]*(?:#[^\r\n]*)?\r?\n?', lines[i])
        if not header:
            i += 1
            continue
        base = len(header[1])
        indicator = re.search('[1-9]', header[2])
        minimum = base + int(indicator[0]) if indicator else None
        j = i + 1
        while j < len(lines):
            line = lines[j]
            if line.strip():
                indent = len(line) - len(line.lstrip(' '))
                if minimum is None:
                    if indent <= base:
                        break
                    minimum = indent
                if indent < minimum:
                    break
            j += 1
        if j > i + 1:
            spans[offsets[i + 1]] = offsets[j]
        i = j
    return spans


# PHP 只在标签内是代码：<?php、<?= 或后接空白的短标签；<?xml 这类处理指令仍是 HTML。
PHP_OPEN = re.compile(r'<\?(?:php\b|=|(?=\s))')


def _scan_php(text: str, docstrings: bool) -> Scan:
    """标签外的 HTML 按标记语言扫描，标签内按 PHP 代码扫描；标签本身在 code 中置空。"""
    code, found = [], []
    pos, html = 0, True
    while pos < len(text):
        if html:
            match = PHP_OPEN.search(text, pos)
            end = match.start() if match else len(text)
            stop = match.end() if match else end
            part = scan('embedded.html', text[pos:end])
        else:
            close = text.find('?>', pos)
            end = len(text) if close < 0 else close
            stop = end if close < 0 else end + 2
            part = scan('embedded.php', text[pos:end], docstrings=docstrings, php_code=True)
        offset = text.count('\n', 0, pos)
        found.extend(Comment(c.line + offset, c.text) for c in part.comments)
        code.append(part.code)
        code.append(''.join(ch if ch in '\r\n' else ' ' for ch in text[end:stop]))
        pos, html = stop, not html
    return Scan(found, ''.join(code))


def scan(path: str, text: str, *, docstrings: bool = True, php_code: bool = False) -> Scan:
    """php_code 只供内部使用：表示文本已经是 PHP 标签内的代码。"""
    kind = family(path)
    if kind is None:
        return Scan([], text)
    ext = PurePosixPath(path).suffix.lower()
    if ext == '.php' and not php_code:
        return _scan_php(text, docstrings)
    code = list(text)
    found = []
    shell = ext in {'.sh', '.bash', '.zsh', '.bats', '.mk'} or PurePosixPath(path).name == 'Makefile'
    heredocs = []
    data = _yaml_data(text) if ext in {'.yaml', '.yml'} else {}
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
        if i in data:
            end = data[i]
            blank(i, end)
            i = end
            continue
        if shell and text[i] == '\n' and heredocs:
            i += 1
            for delimiter, tabs in heredocs:
                start = i
                while i < len(text):
                    end = text.find('\n', i)
                    end = len(text) if end < 0 else end
                    line = text[i:end].rstrip('\r')
                    i = min(end + 1, len(text))
                    if (line.lstrip('\t') if tabs else line) == delimiter:
                        break
                blank(start, i)
            heredocs.clear()
            continue
        if shell and text.startswith('<<<', i):
            i += 3
            continue
        if shell and text.startswith('<<', i):
            doc = re.match(r'''<<(-?)[ \t]*((?:'[^'\n]*'|"[^"\n]*"|\\[^\n]|[^\s<>|;&()\\'"])+)''', text[i:])
            if doc:
                heredocs.append((shlex.split(doc[2])[0], bool(doc[1])))
                blank(i, i + doc.end())
                i += doc.end()
                continue
        if ext in {'.ps1', '.psm1'} and text[i:i + 2] in {"@'", '@"'}:
            quote = text[i + 1]
            ending = re.search(r'(?m)^' + re.escape(quote) + r'@', text[i + 2:])
            stop = i + 2 + ending.end() if ending else len(text)
            blank(i, stop)
            i = stop
            continue
        if ext == '.rb' and (i == 0 or text[i - 1] == '\n') and re.match(r'=begin\b', text[i:]):
            end = re.search(r'(?m)^=end\b[^\n]*', text[i + 6:])
            body_end = i + 6 + end.start() if end else len(text)
            stop = i + 6 + end.end() if end else len(text)
            i = comment(i, i + 6, body_end, stop)
            continue
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
        if text.startswith('/*', i) and (kind in {'c', 'css', 'sql'} or ext in {'.tf', '.hcl'}):
            block_end = '*/'
        elif text.startswith('<#', i) and ext in {'.ps1', '.psm1'}:
            block_end = '#>'
        if block_end:
            end = text.find(block_end, i + 2)
            end = len(text) if end < 0 else end
            i = comment(i, i + 2, end, min(end + 2, len(text)))
            continue
        line_size = 0
        if (kind == 'c' or ext in {'.tf', '.hcl'}) and text.startswith('//', i) and not (i >= 2 and text[i - 1] == ':' and text[i - 2].isalpha()):
            line_size = 2
        elif kind == 'sql' and text.startswith('--', i) and (i + 2 == len(text) or text[i + 2].isspace()):
            line_size = 2
        elif ext == '.php' and text[i] == '#' and not text.startswith('#[', i):
            line_size = 1
        elif kind == 'hash' and text[i] in '#;!':
            name = PurePosixPath(path).name
            head_only = ext in {'.ini', '.properties', '.conf', '.cfg', '.dockerfile'} or name == '.env.example' or name == 'Dockerfile' or name.startswith('Dockerfile.')
            token_only = shell or ext in {'.yaml', '.yml'} or name == '.env.example'
            valid_symbol = text[i] == '#' or (ext == '.ini' and text[i] == ';') or (ext == '.properties' and text[i] == '!')
            line_start = text.rfind('\n', 0, i) + 1
            if valid_symbol and (not head_only or not text[line_start:i].strip()) and (not token_only or i == 0 or text[i - 1].isspace() or text[i - 1] in ';|&('):
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
        if ext in JS and text[i] == '/' and _regex_start(text, i):
            end = _regex_end(text, i)
            blank(i, end)
            i = end
            continue
        quote = text[i]
        if quote == '`' and ext in JS:
            end, stop = _template_end(text, i)
            blank(i + 1, end)
            i = stop
            continue
        if quote in '\"\'' or (quote == '`' and ext in JS | {'.go'}):
            if quote == "'" and ext in CHARS and not re.match(r"'(?:[^'\\\r\n]|\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|.))'", text[i:]):
                i += 1
                continue
            triple = ext in {'.kt', '.kts', '.java', '.swift', '.dart', '.scala', '.py', '.pyi', '.toml'} and text.startswith(quote * 3, i)
            quote = quote * 3 if triple else quote
            raw = ext == '.go' or (ext == '.toml' and quote.startswith("'")) or (ext == '.dart' and i > 0 and text[i - 1] == 'r')
            escape = not raw
            if shell and quote == "'" and not (i > 0 and text[i - 1] == '$'):
                escape = False
            if ext in {'.ps1', '.psm1'}:
                escape = 'backtick' if quote == '"' else False
            end, stop = _literal_end(text, i, quote, escape, triple or quote == '`' or kind == 'sql' or shell or ext in {'.rb', '.php'},
                                     kind == 'sql' or (ext in {'.ps1', '.psm1'} and quote == "'"))
            if ext == '.toml' and triple:
                for _ in range(2):
                    if stop < len(text) and text[stop] == quote[0]:
                        end += 1
                        stop += 1
                    else:
                        break
            blank(i + len(quote), end)
            i = stop
            continue
        i += 1
    if docstrings and ext in {'.py', '.pyi'}:
        try:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore')
                tree = ast.parse(text)
        except (SyntaxError, ValueError):
            tree = None
        if tree:
            for node in ast.walk(tree):
                if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)) or not node.body:
                    continue
                first = node.body[0]
                if not isinstance(first, ast.Expr) or not isinstance(first.value, ast.Constant) or not isinstance(first.value.value, str):
                    continue
                source = ast.get_source_segment(text, first.value)
                opening = re.match(r'''(?i)[rubf]*("""|''' + "'''" + r'''|"|')''', source)
                if opening:
                    body = source[opening.end():-len(opening[1])]
                    for n, value in enumerate(body.split('\n'), first.lineno):
                        if value.strip():
                            found.append(Comment(n, value.strip()))
    return Scan(sorted(found, key=lambda c: c.line), ''.join(code))


def test_titles(path: str, text: str) -> list[Comment]:
    ext = PurePosixPath(path).suffix.lower()
    if ext in JS | {'.dart'}:
        pattern = r'(?<![\w.$])(?:describe|it|test|context|suite|specify|group|testWidgets)(?:\.(?:only|skip))?\s*\(\s*'
    elif ext in {'.java', '.kt', '.kts'}:
        pattern = r'@DisplayName\(\s*'
    elif ext == '.go':
        pattern = r'\bt\.Run\(\s*'
    else:
        return []
    code = scan(path, text).code
    titles = []
    for match in re.finditer(pattern, code):
        start = match.end()
        raw = ext == '.dart' and text[start:start + 1] == 'r'
        if raw:
            start += 1
        if start >= len(text) or text[start] not in '\"\'`':
            continue
        quote = text[start]
        triple = ext in {'.dart', '.java', '.kt', '.kts'} and text.startswith(quote * 3, start)
        quote = quote * 3 if triple else quote
        if quote == '`' and ext in JS:
            end, stop = _template_end(text, start)
        else:
            end, stop = _literal_end(text, start, quote, not raw and ext != '.go', triple or quote == '`')
        if stop == end or (quote == '`' and '${' in text[start:end]):
            continue
        if not re.match(r'\s*[,)]', code[stop:]):
            continue
        first = text.count('\n', 0, start) + 1
        for offset, value in enumerate(text[start + len(quote):end].split('\n')):
            value = value.rstrip('\r')
            if value.strip():
                titles.append(Comment(first + offset, value))
    return titles
