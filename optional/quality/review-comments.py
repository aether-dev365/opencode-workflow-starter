"""Report formal issues in changed comments and literal test titles."""

import sys
sys.dont_write_bytecode = True

from pathlib import Path
import re
from quality_lexer import scan, test_titles
from quality_lib import Finding, main


DATE = r'(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{4}年\d{1,2}月(?:\d{1,2}日)?)'
ACTION = (r'(?:修复|修改|改为|改成|新增|增加|删除|移除|更新|调整|重构|评审|审核|审查|复审|复核|发现|决定|确认|反馈|热修|'
          r'\b(?:fixed|changed|added|removed|updated|refactored|reviewed|decided|reported|hotfix|as of)\b)')
MODEL = r'(?:AI|ChatGPT|GPT(?:[- ]?\d+(?:\.\d+)*)?|Claude|Copilot|Gemini|Codex|OpenCode|LLM)'
RULES = [
    ('document', re.compile(
        r'(?<!\S)\S+\.(?:mdx?|rst|adoc)\b(?!\.[^\W_])(?:#[^\s]*)?|\bREADME\b|'
        r'(?:详见|参见|参考)\s*(?:[:：]\s*)?(?:docs/|doc/|spec|wiki|设计|文档|手册)|'
        r'\b(?:see|refer to)\s+(?:the\s+)?(?:docs|documentation|spec|design doc|wiki)\b|\[\[[^\n]{0,200}?\]\]', re.I),
     '文档引用：改为直接写出规则和原因'),
    ('tracking', re.compile(
        r'\b(?:Task|Phase|Sprint|Milestone|Iteration)\s*(?:#\s*)?\d+|(?:任务|阶段)\s*\d+|'
        r'\b(?:FR|NFR|SC|US|AC|REQ)-\d+|'
        r'(?:\b(?:bug|issue|ticket|defect|feedback)\b|缺陷|问题单|反馈|工单)\s*(?:(?:编号|号|id|no\.)\s*)?(?:[:：#]\s*)?\d+|'
        r'\b(?:Critical|Important|Minor)\s*#\s*\d+|(?:评审|审核|审查|复审)(?:意见|发现)?\s*(?:#\s*)?\d+|'
        + DATE + r'.{0,12}' + ACTION + '|' + ACTION + r'.{0,12}' + DATE, re.I),
     '追踪编号或日期：写进提交说明，注释只写现行规则和原因'),
    ('process', re.compile(
        r'(?:本次|本轮|此次|这次)(?:修复|修改|改动|改造|重构|新增|调整|提交|评审|审核)|'
        r'(?:评审|审核|审查|复审|代码审查)(?:发现|指出|要求|建议|意见)|用户(?:要求|批准|确认|决定|反馈)|'
        r'按(?:照)?.{0,4}(?:意见|要求)(?:修改|调整|改为)|(?:原来|之前|旧)的?(?:实现|写法|逻辑|方案)|'
        r'\bper\s+(?:the\s+)?(?:review|reviewer|feedback|request)\b|\bas requested\b|'
        r'\b(?:reviewer|code review)\s+(?:asked|requested|found|suggested|flagged)\b|'
        r'\bin this\s+(?:PR|commit|change|patch|fix)\b|\bthis\s+(?:PR|commit)\s+(?:adds|fixes|changes|removes)\b|'
        r'\b(?:previous|old)\s+(?:implementation|approach)\b', re.I),
     '开发过程叙述：改写成当前规则和原因，过程写进提交说明'),
    ('generator', re.compile(
        r'\b(?:generated|written|created|authored)\s+(?:by|with|using)\s+' + MODEL + r'\b|'
        r'(?:由|用|使用)\s*(?:' + MODEL + r'|人工智能|大模型)\s*(?:生成|编写|辅助编写|写成)|'
        r'@author\s+' + MODEL + r'\b|\bas an AI\b', re.I),
     '生成工具署名或模型自述：删除'),
]


def review(path: str, text: str, added: frozenset[int] | None, config: dict) -> list[Finding]:
    rules = [(rule, regex, message) for rule, regex, message in RULES if rule not in config['comments']['disable']]
    rules.extend((item['id'], item['regex'], item['message']) for item in config['comments']['extraRules'])
    findings = {}
    for comment in scan(path, text).comments + test_titles(path, text):
        if added is not None and comment.line not in added:
            continue
        if re.search(r'SPDX-License-Identifier|Copyright|©|Licensed under', comment.text, re.I):
            continue
        content = re.sub(r'https?://\S+', '', comment.text, flags=re.I)
        for rule, regex, message in rules:
            if regex.search(content):
                findings[(comment.line, rule)] = Finding(path, comment.line, rule, message)
    return sorted(findings.values(), key=lambda f: (f.line, f.rule))


if __name__ == '__main__':
    sys.exit(main('注释审核', '需复核', review, sys.argv[1:], Path(__file__).resolve().parent))
