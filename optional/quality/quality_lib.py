"""Shared configuration, file selection and command-line support."""

import json
from pathlib import Path, PurePosixPath
import re
import sys
from quality_lexer import family


COMMENT_RULE_IDS = ('document', 'tracking', 'process', 'generator')
SKIP_CATEGORIES = ('skip', 'focus', 'expected-failure')
EXCLUDED = set(('node_modules vendor third_party dist build out target coverage __pycache__ '
                '.venv venv .next .nuxt generated').split())


class ConfigError(Exception):
    pass


def default_config() -> dict:
    return {'version': 1, 'include': ['*'], 'exclude': [], 'timeoutSeconds': 30,
            'comments': {'disable': [], 'extraRules': []}, 'skips': {'disable': [], 'extraMarkers': []}}


def _object(value, allowed, field):
    if not isinstance(value, dict):
        raise ConfigError(field or 'quality.json')
    for key in value:
        if key not in allowed:
            raise ConfigError(f'{field}.{key}' if field else key)


def _strings(value, field, allowed=None):
    if not isinstance(value, list):
        raise ConfigError(field)
    for n, item in enumerate(value):
        if not isinstance(item, str) or not item or (allowed is not None and item not in allowed):
            raise ConfigError(f'{field}[{n}]')
    return value


def load_config(directory: Path) -> dict:
    file = directory / 'quality.json'
    config = default_config()
    if not file.exists():
        return config
    try:
        data = json.loads(file.read_text(encoding='utf-8'))
    except (ValueError, UnicodeError):
        raise ConfigError('quality.json') from None
    _object(data, config, '')
    if type(data.get('version')) is not int or data['version'] != 1:
        raise ConfigError('version')
    for key in ('include', 'exclude'):
        if key in data:
            config[key] = _strings(data[key], key)
    timeout = data.get('timeoutSeconds', 30)
    if type(timeout) is not int or not 1 <= timeout <= 600:
        raise ConfigError('timeoutSeconds')
    config['timeoutSeconds'] = timeout
    used = set(COMMENT_RULE_IDS + SKIP_CATEGORIES)
    for section, extra, ids in [('comments', 'extraRules', COMMENT_RULE_IDS), ('skips', 'extraMarkers', SKIP_CATEGORIES)]:
        if section not in data:
            continue
        value = data[section]
        _object(value, ('disable', extra), section)
        config[section]['disable'] = _strings(value.get('disable', []), section + '.disable', ids)
        entries = value.get(extra, [])
        if not isinstance(entries, list):
            raise ConfigError(section + '.' + extra)
        for n, entry in enumerate(entries):
            field = f'{section}.{extra}[{n}]'
            _object(entry, ('id', 'pattern', 'message') if section == 'comments' else ('id', 'pattern', 'paths', 'category'), field)
            ident = entry.get('id')
            if not isinstance(ident, str) or not re.fullmatch('[a-z][a-z0-9-]*', ident) or ident in used:
                raise ConfigError(field + '.id')
            used.add(ident)
            pattern = entry.get('pattern')
            if not isinstance(pattern, str):
                raise ConfigError(field + '.pattern')
            try:
                regex = re.compile(pattern)
            except re.error:
                raise ConfigError(field + '.pattern') from None
            result = {**entry, 'regex': regex}
            if section == 'comments':
                if not isinstance(entry.get('message'), str) or not entry['message']:
                    raise ConfigError(field + '.message')
            else:
                result['paths'] = _strings(entry.get('paths', ['*']), field + '.paths')
                result['category'] = entry.get('category', 'skip')
                if result['category'] not in SKIP_CATEGORIES:
                    raise ConfigError(field + '.category')
            config[section][extra].append(result)
    return config


def glob_match(pattern: str, path: str) -> bool:
    regex = ''.join('.*' if ch == '*' else '.' if ch == '?' else re.escape(ch) for ch in pattern)
    return re.fullmatch(regex, path, re.DOTALL) is not None


def selected(path: str, config: dict) -> bool:
    file = PurePosixPath(path)
    return (family(path) is not None and not EXCLUDED.intersection(file.parts)
            and not file.name.lower().endswith(('.min.js', '.min.css', '.bundle.js'))
            and any(glob_match(p, path) for p in config['include'])
            and not any(glob_match(p, path) for p in config['exclude']))


def utf8_stdio() -> None:
    for stream, errors in ((sys.stdin, 'strict'), (sys.stdout, 'replace'), (sys.stderr, 'backslashreplace')):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure:
            reconfigure(encoding='utf-8', errors=errors)
