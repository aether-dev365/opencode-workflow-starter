"""Isolated temporary repositories for the portable quality tests."""

import importlib.util
from functools import wraps
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import ModuleType
import unittest
from quality_lib import load_config

HERE = Path(__file__).resolve().parent
SCRIPTS = ('quality_lexer.py', 'quality_lib.py', 'quality_snapshot.py', 'review-comments.py', 'check-skips.py', 'run-hook.py', 'install-hooks.py')


def needs_symlink(function, *, os_name=None):
    @wraps(function)
    def wrapped(*args, **kwargs):
        try:
            return function(*args, **kwargs)
        except OSError as error:
            if (os_name or os.name) == 'nt' and getattr(error, 'winerror', None) == 1314:
                raise unittest.SkipTest('需要创建符号链接的权限') from None
            raise
    return wrapped


NEEDS_SYMLINK = needs_symlink


class TempRepo:
    def __init__(self) -> None:
        self.temp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        directory = Path(self.temp.name).resolve()
        self.root = directory / 'repo'
        self.root.mkdir()
        config = directory / 'empty-gitconfig'
        config.write_bytes(b'')
        self.env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        self.env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=str(config),
                        GIT_AUTHOR_NAME='example', GIT_COMMITTER_NAME='example',
                        GIT_AUTHOR_EMAIL='example@example.invalid', GIT_COMMITTER_EMAIL='example@example.invalid',
                        WORKFLOW_PYTHON=sys.executable, PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1')
        self.git('init', '-q')
        self.git('symbolic-ref', 'HEAD', 'refs/heads/main')

    def write(self, path: str, content: str | bytes) -> Path:
        file = self.root / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content.encode('utf-8') if isinstance(content, str) else content)
        return file

    def git(self, *args: str, check: bool = True, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(['git', *args], cwd=cwd or self.root, env=self.env,
                              encoding='utf-8', errors='replace', capture_output=True, check=check, timeout=60)

    def commit(self, message: str = 'change', add: bool = True) -> str:
        if add:
            self.git('add', '-A')
        self.git('commit', '-q', '-m', message)
        return self.git('rev-parse', 'HEAD').stdout.strip()

    def install_scripts(self, directory: str = 'scripts/quality') -> Path:
        target = self.root / directory
        target.mkdir(parents=True, exist_ok=True)
        for name in SCRIPTS:
            if (HERE / name).exists():
                shutil.copyfile(HERE / name, target / name)
        return target

    def run(self, script: Path, *args: str, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(script), *args], cwd=cwd or self.root, env=self.env,
                              encoding='utf-8', errors='replace', capture_output=True, timeout=60)

    def close(self) -> None:
        self.temp.cleanup()


def load_script(name: str) -> ModuleType:
    spec = importlib.util.spec_from_file_location(name.replace('-', '_').removesuffix('.py'), HERE / name)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def config_from(data: dict) -> dict:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory)
        (path / 'quality.json').write_text(json.dumps(data), encoding='utf-8')
        return load_config(path)
