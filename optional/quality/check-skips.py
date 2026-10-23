"""Report newly added skip, focus and expected-failure markers in code."""

import sys
sys.dont_write_bytecode = True

from pathlib import Path, PurePosixPath
import re
from quality_lexer import JS, scan
from quality_lib import Finding, glob_match, main


MESSAGES = {
    'skip': '新增跳过测试：修好后移除；确需保留时在提交说明里写明原因',
    'focus': '新增只运行部分测试的标记：提交后其他测试不会运行，提交前移除',
    'expected-failure': '新增预期失败标记：失败会被当成通过；修好后移除，确需保留时在提交说明里写明原因',
}
CALL = r'(?<![\w.$])'


def is_test_file(path: str) -> bool:
    file = PurePosixPath(path)
    return (bool({'test', 'tests', '__tests__', 'spec', 'e2e', 'cypress'}.intersection(file.parts[:-1]))
            or any(glob_match(pattern, file.name) for pattern in
                   ('*.test.*', '*.spec.*', '*_test.*', 'test_*.py', '*_spec.rb', '*Test.*', '*Tests.*')))


MARKERS = [
    (JS | {'.vue', '.svelte'}, False, 'skip', CALL + r'(?:(?:describe|it|test|context|suite|test\.describe)\.skip|(?:describe|it|test)\.skipIf|test\.fixme)\s*\('),
    (JS | {'.vue', '.svelte'}, True, 'skip', CALL + r'(?:xdescribe|xit|xtest|xcontext)\s*\('),
    (JS | {'.vue', '.svelte'}, False, 'focus', CALL + r'(?:describe|it|test|context|suite|test\.describe)\.only\s*\('),
    (JS | {'.vue', '.svelte'}, True, 'focus', CALL + r'(?:fdescribe|fit)\s*\('),
    ({'.py'}, False, 'skip', r'@(?:pytest\.mark\.(?:skip|skipif)|unittest\.(?:skip|skipIf|skipUnless))\b|'
     + CALL + r'pytest\.skip\s*\(|\.skipTest\s*\(|\braise\s+(?:unittest\.)?SkipTest\b'),
    ({'.py'}, False, 'expected-failure', r'@(?:pytest\.mark\.xfail|unittest\.expectedFailure)\b|' + CALL + r'pytest\.xfail\s*\('),
    ({'.java', '.kt', '.kts', '.groovy'}, False, 'skip', r'@(?:Disabled\w*|Ignore)\b|@Test\s*\([^\n)]*\benabled\s*=\s*false\b'),
    ({'.go'}, False, 'skip', CALL + r'[tbf]\.(?:Skip|Skipf|SkipNow)\s*\('),
    ({'.rs'}, False, 'skip', r'#\s*\[\s*ignore\s*(?:\]|=)'),
    ({'.cs'}, False, 'skip', r'\[\s*Ignore\b|\[\s*(?:Fact|Theory)\s*\([^\n)]*\bSkip\s*=|'
     + CALL + r'Assert\.(?:Ignore|Inconclusive)\s*\('),
    ({'.php'}, False, 'skip', CALL + r'(?:markTestSkipped|markTestIncomplete)\s*\('),
    ({'.swift'}, False, 'skip', CALL + r'(?:XCTSkip|XCTSkipIf|XCTSkipUnless)\s*\('),
    ({'.dart'}, True, 'skip', r'\bskip\s*:\s*(?!\s|false\b|null\b)\S'),
    ({'.rb'}, True, 'skip', r'^\s*(?:xit|xdescribe|xcontext|skip|pending)\b'),
    ({'.bats'}, False, 'skip', r'^\s*skip\b'),
]
MARKERS = [(extensions, test_only, category, re.compile(pattern)) for extensions, test_only, category, pattern in MARKERS]


def find_skips(path: str, text: str, added: frozenset[int] | None, config: dict) -> list[Finding]:
    ext = PurePosixPath(path).suffix.lower()
    testing = is_test_file(path)
    rules = [(category, regex) for extensions, test_only, category, regex in MARKERS
             if ext in extensions and (not test_only or testing)]
    rules.extend((item['category'], item['regex']) for item in config['skips']['extraMarkers']
                 if any(glob_match(pattern, path) for pattern in item['paths']))
    rules = [(category, regex) for category, regex in rules if category not in config['skips']['disable']]
    findings = []
    for number, line in enumerate(scan(path, text, docstrings=False).code.split('\n'), 1):
        if added is not None and number not in added:
            continue
        categories = {category for category, regex in rules if regex.search(line)}
        findings.extend(Finding(path, number, category, MESSAGES[category]) for category in sorted(categories))
    return findings


if __name__ == '__main__':
    sys.exit(main('跳过测试检查', '新增标记', find_skips, sys.argv[1:], Path(__file__).resolve().parent))
