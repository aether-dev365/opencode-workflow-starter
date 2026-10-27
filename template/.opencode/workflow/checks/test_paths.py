import errno
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
from policy import policy_root

HERE = Path(__file__).resolve().parent
POLICY = HERE / 'fixtures/protection.json'


class PathGuards(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='workflow-guard-')
        self.root = Path(self.temp.name)
        (self.root / '.git').mkdir()
        config = self.root / '.opencode/workflow'
        config.mkdir(parents=True)
        (config / 'protection.json').write_bytes(POLICY.read_bytes())
        (self.root / '.env').write_text('synthetic-value')

    def tearDown(self):
        self.temp.cleanup()

    def result(self, tool='shell', paths=None, cwd=None, **tool_input):
        event = dict(version=1, phase='before', sessionId='s', callId='c',
                     directory=str(self.root), tool=tool, paths=paths or [], input=tool_input)
        run = subprocess.run([sys.executable, str(HERE / 'pre-guard-paths.py')],
                             input=json.dumps(event), encoding='utf-8', capture_output=True, cwd=cwd)
        self.assertIn(run.returncode, [0, 2], run.stderr)
        return json.loads(run.stdout)

    def guard(self, tool='shell', paths=None, **tool_input):
        return self.result(tool=tool, paths=paths, **tool_input)['decision']

    def test_checker_process_directory_does_not_change_decisions(self):
        with tempfile.TemporaryDirectory() as elsewhere:
            (Path(elsewhere) / '.git').mkdir()
            for command, decision in [('ls -la', 'allow'), ('git status --short', 'allow'), ('grep -r value .', 'allow'),
                                      ('cat .env', 'deny'), ('cat ~/.env', 'deny'), ('cat $HOME/.env', 'deny')]:
                with self.subTest(command=command):
                    self.assertEqual(self.result(command=command, cwd=elsewhere)['decision'], decision)

    def test_foreign_checkout_without_policy_uses_session_rules(self):
        with tempfile.TemporaryDirectory() as other:
            (Path(other) / '.git').mkdir()
            (Path(other) / 'README.md').write_text('public')
            (Path(other) / '.env').write_text('synthetic-value')
            self.assertEqual(self.guard(tool='write', paths=[f'{other}/README.md'], action='read'), 'allow')
            self.assertEqual(self.guard(tool='write', paths=[f'{other}/.env'], action='read'), 'deny')

    def test_opencode_config_files_do_not_mark_a_checkout_root(self):
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / '.opencode').mkdir()
            (Path(home) / '.opencode/opencode.json').write_text('{}')
            (Path(home) / 'opencode.jsonc').write_text('{}')
            self.assertIsNone(policy_root(Path(home) / 'notes.md'))

    def test_arguments_with_overlong_names_are_not_existing_paths(self):
        # 名字超过文件系统上限的参数不可能是已有文件或链接，长提交说明和内联脚本照常放行。
        for command in [f'git commit -m title -m {"x" * 300}', f'git commit -m title -m {"提交说明" * 25}',
                        f'python3 -c "print(\'{"x" * 300}\')"']:
            with self.subTest(command=command[:30]):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_overlong_names_still_follow_literal_rules_without_echoing_them(self):
        name = 'x' * 300
        for command, reason in [(f'echo x > {name}.env', 'Synthetic credential protection'),
                                (f'cat {name}.env', 'Synthetic credential protection'), (f'echo x > vendor/{name}', '第三方 fixture')]:
            with self.subTest(command=command[:30]):
                denied = self.result(command=command)
                self.assertEqual(denied['decision'], 'deny')
                self.assertIn(reason, denied['reason'])
                self.assertNotIn(name, denied['reason'])

    def test_paths_beyond_the_system_limit_are_denied_without_echoing_them(self):
        # 整条路径超过上限而每段名字正常时，路径可能真实存在（经相对路径访问的深层目录），无法检查就拒绝。
        argument = '/'.join(['a' * 200] * 30)
        result = self.result(command=f'git commit -m title -m {argument}')
        if os.name == 'nt':
            # Windows 对不存在的超长路径报 ENOENT，按不存在放行。
            self.assertEqual(result['decision'], 'allow')
            return
        self.assertEqual(result['decision'], 'deny')
        self.assertIn('超过系统长度上限', result['reason'])
        self.assertIn('git commit -F -', result['reason'])
        self.assertNotIn(argument, result['reason'])
        self.assertLess(len(result['reason']), 400)

    def test_other_errors_still_deny_and_shorten_long_paths(self):
        spec = importlib.util.spec_from_file_location('pre_guard_paths', HERE / 'pre-guard-paths.py')
        guard = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(guard)
        path = '/repo/' + 'y' * 300
        with mock.patch.object(guard, 'check_event', side_effect=PermissionError(errno.EACCES, 'Permission denied', path)):
            result = guard.check({})
        self.assertEqual(result['decision'], 'deny')
        self.assertIn('Permission denied', result['reason'])
        self.assertNotIn(path, result['reason'])
        self.assertLess(len(result['reason']), 400)

    def test_sensitive_reads_and_recursive_deletion_are_denied(self):
        for command in ['cat .env', 'rm -rf .', 'grep value .env', 'git clean -fdx']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_literal_shell_strings_cannot_hide_protected_operations(self):
        for prefix in ['bash -c', '/bin/bash -lc', 'sh -c', 'dash -c', 'zsh -c', 'ksh -c',
                       'eval', 'env bash -c', 'timeout 5 bash -c', 'nice -n 1 eval']:
            for inner in ['cat .env; printf done', 'rm -rf vendor', 'echo x > vendor/file.js']:
                command = f"{prefix} '{inner}'"
                with self.subTest(command=command):
                    self.assertEqual(self.guard(command=command), 'deny')

    def test_literal_shell_strings_cannot_hide_recursive_secret_deletion(self):
        (self.root / 'build').mkdir()
        (self.root / 'build/.env').write_text('synthetic-value')
        self.assertEqual(self.guard(command='rm -rf build'), 'deny')
        for prefix in ['bash -c', '/bin/bash -lc', 'sh -c', 'dash -c', 'zsh -c', 'ksh -c',
                       'eval', 'env bash -c', 'timeout 5 bash -c', 'nice -n 1 eval']:
            with self.subTest(prefix=prefix):
                self.assertEqual(self.guard(command=f"{prefix} 'rm -rf build'"), 'deny')

    def test_stdin_shell_strings_cannot_hide_recursive_secret_deletion(self):
        (self.root / 'build').mkdir()
        (self.root / 'build/.env').write_text('synthetic-value')
        self.assertEqual(self.guard(command='rm -rf build'), 'deny')
        for command in [
            "bash <<< 'rm -rf build'", "printf '%s\\n' 'rm -rf build' | bash",
            "printf '%s\\n' 'rm -rf build' | env bash -e",
            "printf '%s\\n' 'rm -rf build' | bash -o pipefail",
            "bash -s ignored <<< 'rm -rf build'", "bash -- - <<< 'rm -rf build'",
            "bash /dev/stdin <<< 'rm -rf build'", "bash /dev/fd/0 <<< 'rm -rf build'",
            "bash /proc/self/fd/0 <<< 'rm -rf build'",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_string_execution_requires_direct_commands_but_scripts_and_text_remain_available(self):
        for command in ["bash -c 'printf safe'", "bash -lc 'printf safe'", "bash -ec 'printf safe'",
                        "bash --noprofile --norc -o pipefail -c 'printf safe'",
                        "FLAGS=-c; bash \"$FLAGS\" 'printf safe'", "eval 'printf safe'",
                        r"eval $'printf safe'", r"eval $'printf safe\0\x24(printf marker)'"]:
            with self.subTest(command=command):
                denied = self.result(command=command)
                self.assertEqual(denied['decision'], 'deny')
                self.assertIn('改写成直接的命令', denied['reason'])
        for command in ['bash scripts/check.sh', 'bash -e scripts/check.sh', 'bash -o pipefail scripts/check.sh',
                        'bash --noprofile --norc scripts/check.sh', 'bash --help', 'bash --version', "echo 'bash -c eval'",
                        "printf '%s' 'rm -rf build'"]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_protection_rules_cannot_be_removed_to_unlock_secret_reads(self):
        path = self.root / '.opencode/workflow/protection.json'
        original = (HERE.parent / 'protection.json').read_bytes()
        for tool in ['patch', 'edit', 'write']:
            with self.subTest(tool=tool):
                path.write_bytes(original)
                self.assertEqual(self.guard(command='cat .env'), 'deny')
                decision = self.guard(tool=tool, paths=[str(path)])
                if decision == 'allow':
                    policy = json.loads(original)
                    policy['rules'] = [rule for rule in policy['rules'] if rule['id'] != 'secrets']
                    path.write_text(json.dumps(policy), encoding='utf-8')
                self.assertEqual((decision, self.guard(command='cat .env')), ('deny', 'deny'))

    def test_protection_config_has_builtin_edit_protection_but_is_readable(self):
        path = self.root / '.opencode/workflow/protection.json'
        path.write_text(json.dumps({'version': 1, 'rules': [
            {'id': 'allow-all', 'actions': ['read', 'edit'], 'paths': ['*'],
             'effect': 'allow', 'reason': '测试允许规则不能覆盖内置保护。'}]}), encoding='utf-8')
        self.assertEqual(self.guard(command='cat .opencode/workflow/protection.json'), 'allow')
        self.assertEqual(self.guard(tool='read', paths=[str(path)]), 'allow')
        for target in [path, path.parent, path.parent.parent, self.root]:
            with self.subTest(target=target):
                denied = self.result(tool='write', paths=[str(target)])
                self.assertEqual(denied['decision'], 'deny')
                self.assertIn('OpenCode 之外', denied['reason'])
        for command in ['rm .opencode/workflow/protection.json', 'rm -rf .opencode/workflow',
                        'mv .opencode/workflow backup', 'echo x > .opencode/workflow/protection.json']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_protection_config_cannot_be_edited_through_a_link(self):
        path = self.root / '.opencode/workflow/protection.json'
        (self.root / 'policy-link.json').symlink_to(path)
        self.assertEqual(self.guard(tool='write', paths=[str(self.root / 'policy-link.json')]), 'deny')

    def test_protection_config_cannot_be_edited_through_a_hardlink(self):
        alias = self.root / 'policy-hardlink.json'
        os.link(self.root / '.opencode/workflow/protection.json', alias)
        self.assertEqual(self.guard(tool='write', paths=[str(alias)]), 'deny')

    def test_recursive_delete_checks_only_unreadable_files_below_target(self):
        for path in ['node_modules/pkg/generated/x.js', 'node_modules/pkg/vendor/y.js', 'vendor/lib.js', 'build/.env.local', 'dist/app.js']:
            (self.root / path).parent.mkdir(parents=True, exist_ok=True)
            (self.root / path).write_text('x')
        self.assertEqual(self.guard(command='rm -rf node_modules dist'), 'allow')
        self.assertEqual(self.guard(command="find node_modules -name '*.map' -delete"), 'allow')
        self.assertEqual(self.guard(command='rm -rf vendor'), 'deny')
        denied = self.result(command='rm -rf build')
        self.assertEqual(denied['decision'], 'deny')
        self.assertIn(str(Path('build/.env.local')), denied['reason'])

    def test_recursive_delete_of_a_large_dependency_tree_stays_within_budget(self):
        for index in range(20000):
            path = self.root / f'node_modules/pkg{index % 200}/lib/file{index}.js'
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('x')
        start = time.monotonic()
        self.assertEqual(self.guard(command='rm -rf node_modules'), 'allow')
        self.assertLess(time.monotonic() - start, 5)

    def test_recursive_delete_checks_links_inside_the_target_by_their_real_path(self):
        # 目标内的链接按真实路径检查；通过链接的目录进入的内容同样按真实路径检查。
        build = self.root / 'build'
        (build / 'lib').mkdir(parents=True)
        (build / 'lib/link.txt').symlink_to(self.root / '.env')
        self.assertEqual(self.guard(command='rm -rf build'), 'deny')
        (build / 'lib/link.txt').unlink()
        self.assertEqual(self.guard(command='rm -rf build'), 'allow')
        real = self.root / 'real'
        real.mkdir()
        (real / 'app.env').write_text('synthetic')
        (self.root / 'alias').symlink_to(real, target_is_directory=True)
        self.assertEqual(self.guard(command='rm -rf alias'), 'deny')

    def test_recursive_delete_skips_nested_git_directories(self):
        (self.root / 'build/.git').mkdir(parents=True)
        (self.root / 'build/.git/config.env').write_text('synthetic')
        self.assertEqual(self.guard(command='rm -rf build'), 'allow')
        (self.root / 'build/.git/config.env').unlink()
        (self.root / 'build/sub').mkdir()
        (self.root / 'build/sub/.env').write_text('synthetic')
        self.assertEqual(self.guard(command='rm -rf build'), 'deny')

    def test_recursive_delete_reports_target_instead_of_internal_probe(self):
        target = self.root / 'vendor'
        target.mkdir()
        denied = self.result(command='rm -rf vendor')
        self.assertEqual(denied['decision'], 'deny')
        self.assertTrue(denied['reason'].endswith(f'路径：{target}'), denied['reason'])

    def test_recursive_deletes_inside_substitutions_are_checked(self):
        for command in [
            'echo "$(rm -rf vendor)"',
            'echo `rm -rf vendor`',
            'cat <(rm -rf vendor)',
            'x=$(find vendor -delete)',
            'echo "$(echo "$(git clean -fdx vendor)")"',
            'echo "$(cd vendor && rm -rf .)"',
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        for command in ['echo "$(rm -rf build)"', "echo '$(rm -rf vendor)'", "echo '`rm -rf vendor`'"]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_examples_and_data_heredocs_are_allowed(self):
        for command in ['cat .env.example', "cat > notes.txt <<'EOF'\nrm -rf vendor\nEOF"]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_fake_heredocs_do_not_hide_following_commands(self):
        for header in ["cat '<<EOF'", 'cat "<<EOF"', r'cat \<\<EOF', 'cat # <<EOF',
                       "printf '%s' 'text\n<<EOF'"]:
            for command in ['rm -rf vendor', 'cat .env']:
                with self.subTest(header=header, command=command):
                    self.assertEqual(self.guard(command=f'{header}\n{command}\nEOF'), 'deny')

    def test_parse_errors_and_ansi_c_quotes_cannot_skip_deletion_checks(self):
        for command in [r"echo $'\''; rm -rf vendor", r"echo $'\''; cat .env",
                        "echo 'unterminated", 'echo "unterminated', 'cat "$(pwd"']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_commands_with_implicit_outputs_are_not_trusted_as_readonly(self):
        for command in [
            'command rm -rf vendor/lib/a.js',
            'uniq src/b.js vendor/lib/a.js',
            'xxd -r src/b.js vendor/lib/a.js',
            'tree -o vendor/lib/a.js',
            'less -o vendor/lib/a.js src/b.js',
            '''awk 'BEGIN { print "x" > "vendor/lib/a.js" }' ''',
            '''awk 'BEGIN { print "x" | "tee vendor/lib/a.js" }' ''',
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        for command in ['cat vendor/lib/a.js', 'head -n1 vendor/lib/a.js', 'rg value src']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_unanalyzable_structures_and_wrappers_are_rejected(self):
        (self.root / 'build').mkdir()
        for command in [
            '(rm -rf vendor)', '{ rm -rf vendor; }', 'sudo rm -rf vendor',
            'nohup rm -rf build', 'echo vendor | xargs rm -rf',
            'D=build; rm -rf $D', 'rm -rf "$(printf build)"',
            'for D in build; do rm -rf "$D"; done',
            'doas rm -rf build', 'exec rm -rf build', 'sudo tee notes.txt',
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_all_write_candidates_probe_protected_directory_contents(self):
        for command in [
            'git rm -rq vendor', 'mv vendor backup', 'cp src/b.js vendor/',
            'git checkout -- vendor', 'tar -xf x.tar -C vendor',
            'command rm -rf vendor', 'uniq src/b.js vendor',
        ]:
            with self.subTest(command=command):
                denied = self.result(command=command)
                self.assertEqual(denied['decision'], 'deny')
                self.assertNotIn('vendor/_', denied['reason'])
        self.assertEqual(self.guard(tool='write', paths=[str(self.root / 'vendor')]), 'deny')
        for command in ['mv build backup', 'cp src/b.js build/', 'cd build && rm -rf lib']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_live_path_globs_are_rejected_without_guessing_expansion(self):
        for command in ['cat .en?', 'cat ./.[e]nv', 'head -n1 *env',
                        'echo hi > vend*/lib/a.js', 'rm -rf buil?',
                        'echo "$(cat .en?)"', 'cat .env*']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        for command in ["printf '%s' 'literal *?[]'", "rg 'value.*' src",
                        "find build -name '*.map' -delete", 'cat .env.example']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_source_arguments_follow_read_protection_rules(self):
        for command in ['source .env', '. ./.env', 'source .env && env', '. ./.env; echo $KEY',
                        'cd src && source ../.env', 'source "$CONFIG"']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        for command in ['source .env.example', '. ./.env.example', 'source vendor/public.sh',
                        'source .env.example && printf done']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_find_checks_every_starting_point_and_rejects_unknown_roots(self):
        (self.root / '.env').unlink()
        for name in ['src', 'build', 'clean']:
            (self.root / name).mkdir()
        (self.root / 'build/.env').write_text('synthetic')
        for command in ['find src build -delete', 'find src build -depth -delete',
                        'find -L vendor -delete', 'find -H clean -delete',
                        'find -files0-from list.txt -delete', 'find -delete']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

        for command in ['find src clean -delete', 'find -P src clean -delete',
                        "find src clean -name '*.map' -delete"]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')
        (self.root / 'build/.env').unlink()
        for command in ['find -L clean -delete', 'find -H clean -delete', 'find -files0-from list.txt -delete']:
            with self.subTest(command=command, credentials=False):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_parent_segments_after_symlinks_follow_the_kernel(self):
        # 内核先跟随符号链接再处理 `..`：LINK/../x 指向链接目标的上一级里的 x，而不是按字面合并后的 x。
        from hooklib import command_paths
        policy = json.loads(POLICY.read_text(encoding='utf-8'))
        policy['rules'].append({'id': 'private', 'actions': ['read', 'edit'], 'paths': ['private/*'], 'effect': 'deny', 'reason': 'Synthetic private files'})
        (self.root / '.opencode/workflow/protection.json').write_text(json.dumps(policy), encoding='utf-8')
        (self.root / 'private/sub').mkdir(parents=True)
        (self.root / 'private/key').write_text('synthetic')
        (self.root / 'a').mkdir()
        (self.root / 'a/note.txt').write_text('public')
        (self.root / 'a/PL').symlink_to(self.root / 'private/sub', target_is_directory=True)
        (self.root / '.opencode/workflow/sub').mkdir()
        (self.root / 'L').symlink_to(self.root / '.opencode/workflow/sub', target_is_directory=True)
        for command in ['echo x > L/../protection.json', 'cat a/PL/../key', 'echo x > a/PL/../key', 'rm -rf a/PL/../key',
                        'sed -i s/a/b/ a/PL/../key', 'set -P; cd a/PL/..; cat key',
                        # 同一条命令里新建链接再经它的 `..`：检查时链接还不存在，无法确认落点，拒绝。
                        'ln -s .opencode/workflow/sub K && echo x > K/../protection.json',
                        'mkdir -p fresh && echo x > fresh/../.opencode/workflow/protection.json']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        for command in ['cat a/note.txt', 'cd a && cat note.txt', 'cat a/../a/note.txt', 'echo x > a/new.txt']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')
        # 插件按同一份候选路径检查保护配置。
        written = [os.path.realpath(path) for path in command_paths('echo x > L/../protection.json', str(self.root))]
        self.assertIn(os.path.realpath(self.root / '.opencode/workflow/protection.json'), written)

    def test_tool_paths_resolve_like_opencode(self):
        # OpenCode 解析 grep 的 path、shell 的 workdir 和原生工具路径时，把 `~`、`~/` 换成主目录，再按字面合并 `..`。
        from unittest.mock import patch
        for name in ['src', 'build']:
            (self.root / name).mkdir()
        (self.root / 'src/.env').write_text('synthetic')
        environment = {key: value for key, value in os.environ.items() if key != 'OPENCODE_TEST_HOME'}
        for variables in [{'OPENCODE_TEST_HOME': str(self.root)}, {'HOME': str(self.root), 'USERPROFILE': str(self.root)}]:
            with patch.dict('os.environ', {**environment, **variables}, clear=True):
                for path in ['src/missing/..', 'missing/../src', f'{self.root}/src/missing/..', '~/src', '~']:
                    with self.subTest(variables=variables, grep=path):
                        self.assertEqual(self.guard(tool='grep', pattern='x', path=path), 'deny')
                for command in ['echo x > .opencode/workflow/protection.json', 'rm -rf .opencode']:
                    for workdir in ['~', 'missing/..']:
                        with self.subTest(variables=variables, workdir=workdir, command=command):
                            self.assertEqual(self.guard(command=command, workdir=workdir), 'deny')
                for path in ['build', '~/build', 'missing/../build']:
                    with self.subTest(variables=variables, grep=path):
                        self.assertEqual(self.guard(tool='grep', pattern='x', path=path), 'allow')
                self.assertEqual(self.guard(command='echo x > notes.txt', workdir='~/build'), 'allow')
        # 只有恰为 `~` 或以 `~/` 开头才展开；`~user` 与其他位置的 `~` 是普通名字。
        (self.root / '~user').mkdir()
        self.assertEqual(self.guard(tool='grep', pattern='x', path='~user'), 'allow')

    def test_git_clean_paths_follow_git_pathspec_rules(self):
        # git 按字面合并 ..，自己展开引号里的通配，并支持 :/、:(top)、:(icase)、:! 等 pathspec 写法；
        # -e 的值是排除规则而不是路径；不带 -x 时同样删除未被忽略的未跟踪文件。
        from unittest.mock import patch
        for name in ['src', 'lib', 'build']:
            (self.root / name).mkdir()
        (self.root / 'src/.env').write_text('synthetic')
        (self.root / 'lib/prod.env.local').write_text('synthetic')
        for command in [
            'git clean -fdx src/missing/..', 'git clean -fdx :/', "git clean -fdx ':(top)src'",
            "git clean -fdx ':(icase)SRC'", "git clean -fdx ':!README.md'", "git clean -fdx 's*'",
            "git clean -fdx 'sr?'", "git clean -fdx 'sr[c]'", 'git clean -fdx -e foo', 'git clean -fdx --exclude foo',
            'git clean -fdx --exc foo', 'git clean -fdxe foo', 'git clean -fd lib', 'git clean -f lib',
            'git clean -fdx SRC', 'git clean -fdx build missing', 'git --icase-pathspecs clean -fdx build',
            'git -c core.quotepath=off clean -fd build', 'GIT_ICASE_PATHSPECS=1 git clean -fdx build',
            'export GIT_ICASE_PATHSPECS=1; git clean -fdx build',
            # 试运行可以被后面的 --no-dry-run（含缩写）取反，--end-of-options 之后的 -n 只是路径。
            'git clean -fdx -n --no-dry-run src', 'git clean -fdx -n --no-dry src',
            'git clean -fdx --end-of-options -n src', 'git clean -fdx --end-of-options src',
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        with patch.dict('os.environ', {'GIT_ICASE_PATHSPECS': '1'}):
            self.assertEqual(self.guard(command='git clean -fdx build'), 'deny')
        for command in ['git clean -fdx build', 'git clean -fd build', 'git clean -fdx -- build',
                        'git clean -fdx -e keep build', 'git clean -fdx build -e keep.txt', 'git clean -fdx build/../build',
                        'git clean -n', 'git clean -ndx', 'git clean --dry-run -d src', 'git clean -fn lib',
                        # --no-dry-run 之后的 -n 重新开启试运行（最后一个生效）。
                        'git clean -fdx --no-dry-run -n src',
                        # clean 只是别的子命令的参数，不是 git clean。
                        'git commit -m clean', 'git log --grep clean',
                        'git --no-pager log --grep clean', 'git -c core.quotepath=off grep clean']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_directory_switching_requires_a_direct_literal_cd(self):
        (self.root / '.env').unlink()
        (self.root / 'build/lib').mkdir(parents=True)
        (self.root / 'build/lib/.env').write_text('synthetic')
        for command in [
            'pushd build && rm -rf lib', 'popd && rm -rf lib',
            'git -C build rm -r lib', 'git -Cbuild rm -r lib',
            'env -C build rm -rf lib', 'env -Cbuild rm -rf lib',
            'env --chdir=build rm -rf lib', 'env --chdir build rm -rf lib',
            'env -S "rm -rf build"', 'git --work-tree=build rm -r lib',
            'cd "$DIR" && rm -rf lib', 'cd -- build && rm -rf lib',
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        for command in ['cd build && rm -rf empty', 'env MODE=test cat README.md',
                        'time env MODE=test cat README.md', 'nice -n 5 cat README.md',
                        'timeout 5 cat README.md']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_directory_changes_follow_shell_list_semantics(self):
        # cd 失败时 `;`、换行与 `||` 之后的命令仍在原目录执行；管道各段和 & 后台命令在子 shell 中，cd 与赋值不影响后续命令。
        from hooklib import command_paths
        for name in ['src', 'build']:
            (self.root / name).mkdir()
        (self.root / 'src/.env').write_text('synthetic')
        with tempfile.TemporaryDirectory() as outside:
            for command in [
                'cd missing; echo x > .opencode/workflow/protection.json',
                'cd missing\necho x > .opencode/workflow/protection.json',
                'cd missing || echo x > .opencode/workflow/protection.json',
                'cd src | echo x > .opencode/workflow/protection.json',
                'cd src & echo x > .opencode/workflow/protection.json',
                'cd missing; rm -rf .opencode',
                'cd src && cd missing; echo x > ../.opencode/workflow/protection.json',
                '! cd src; echo x > ../.opencode/workflow/protection.json',
                # `!` 只取反退出码，后面的命令照常执行。
                '! rm -rf src', '! find src -delete', '! rm -rf "$X"',
                # export 给只读变量赋值失败时 shell 继续执行，`||` 之后的命令照常执行。
                'readonly X=a; export X=b || rm -rf src',
                # macOS 的 /usr/bin/cd 不改变调用方的目录且返回 0。
                f'env cd {outside} && rm -rf .opencode',
                f'timeout 5 cd {outside} && rm -rf .opencode',
                'X=.opencode/workflow; X=src | echo x > $X/protection.json',
            ]:
                with self.subTest(command=command):
                    self.assertEqual(self.guard(command=command), 'deny')
        # 插件按同一份候选路径检查保护配置。
        written = command_paths('cd missing; echo x > notes.txt', str(self.root))
        self.assertIn(str(self.root / 'notes.txt'), written)
        self.assertIn(str(self.root / 'missing/notes.txt'), written)
        self.assertNotIn(str(self.root / 'notes.txt'), command_paths('cd src && echo x > notes.txt', str(self.root)))
        for command in ['cd src && echo x > a.ts', 'cd build && rm -rf .', 'cd build && rm -rf . && ls',
                        'cd src || echo x > notes.txt', 'DEST=notes.txt; echo hi > "$DEST"',
                        '; '.join(f'cd d{index}' for index in range(6)) + '; ls']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')
        denied = self.result(command='; '.join(f'cd d{index}' for index in range(7)) + '; ls')
        self.assertEqual(denied['decision'], 'deny')
        self.assertIn('拆成多条命令', denied['reason'])

    def test_hidden_command_substitutions_with_runtime_evaluation_are_denied(self):
        for command in [
            "x='a[$(printf marker)]'; y=$((x))",
            'x="a[\\$(printf marker)]"; y=$((x))',
            r'x=a[\$\(printf\ marker\)]; y=$((x))',
            "x='a[`printf marker`]'; y=$((x))",
            'x="a[\\`printf marker\\`]"; y=$((x))',
            "x='a[$(printf marker)]'; ((x))",
            "x='a[$(printf marker)]'; y=$[x]",
            "x='a[$(printf marker)]'; echo \"${value:x}\"",
            "x='$(printf marker)'; a[x]=0",
            "x='$(printf marker)'; echo \"${a[x]}\"",
            "x='a[$(printf marker)]'; let y=x",
            "x='a[$(printf marker)]'; declare -i y=x",
            "x='$(printf marker)'; eval \"$x\"",
            "bash -c 'echo $(printf marker)'",
            "x='a[$(printf marker)]'; [[ \"$x\" -eq 0 ]]",
            "x='a[$(printf marker)]'; [[ 0 -lt x ]]",
            "x='a[$(printf marker)]'; [[ -v $x ]]",
            "x='$(printf marker)'; unset 'a[x]'",
            "\"eval\" 'printf \"%s\" \"$(printf marker)\"'",
            "e'va'l 'printf \"%s\" \"$(printf marker)\"'",
            r"e\val 'printf \"%s\" \"$(printf marker)\"'",
            "(eval 'printf \"%s\" \"$(printf marker)\"')",
            "{ eval 'printf \"%s\" \"$(printf marker)\"'; }",
            "echo \"$(x='a[$(printf marker)]'; y=$((x)))\"",
            "x='$(printf marker)",
            "x='$(printf marker)'; echo $((x)",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_ansi_c_encoded_substitutions_with_runtime_evaluation_are_denied(self):
        payloads = [
            r'\x24(echo x > .env)',
            r'\044(echo x > .env)',
            r'\u' '0024(echo x > .env)',
            r'\U00000024(echo x > .env)',
            r'\x24\x28echo x > .env\x29',
            r'\x60echo x > .env\x60',
            r'\140echo x > .env\140',
            r'printf \'%s\' \x24(echo x > .env)',
        ]
        for evaluator in ['eval', 'bash -c', 'sh -c']:
            for payload in payloads:
                with self.subTest(evaluator=evaluator, payload=payload):
                    denied = self.result(command=f"{evaluator} $'{payload}'")
                    self.assertEqual(denied['decision'], 'deny')
                    self.assertIn('无法静态检查', denied['reason'])
        for command in [
            r"x=$'a[\x24(printf marker)]'; y=$((x))",
            r"$'\x65val' $'\x24(printf marker)'",
            r"e$'\x76'al $'\x24(printf marker)'",
            r"eval $'\x24''(printf marker)'",
            r'''x=$'\x24''(printf marker)'; eval "$x"''',
            r"eval $'\x24(printf marker)",
            r"eval $'\Uffffffff'",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_ansi_c_text_without_hidden_runtime_evaluation_is_allowed(self):
        for command in [
            r"echo $'\x24(echo x > .env)'",
            r"echo $'\044(printf marker)'",
            r"echo $'\u" "0024(printf marker)'",
            r"echo $'\x60printf marker\x60'",
            r"echo $'it\'s ordinary text'",
            r"printf '%s' $'一行\n\t另一行\\结尾'",
            r"printf '%s' $'\a\b\e\E\f\r\v\cA\q'",
            r"printf '%s' $'\c\a'",
            r"echo $'\c\n'",
            r"printf '%s' $'\c'",
            r"printf '%s' $'\c\''",
            r'''printf '%s' $'\c\"' ''',
            r'''printf '%s' "$'\x24(marker)' eval"''',
            r"printf '%s' '\x24(marker)' eval",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_literal_substitutions_and_ordinary_expansions_are_allowed(self):
        for command in [
            "if [ -f Makefile ]; then sed -i 's/$(CC)/clang/' Makefile; fi",
            "sed -i 's/$(CC)/clang/' Makefile && echo ${CC:-cc}",
            "if [ -f a.log ]; then awk '{print $(NF)}' a.log; fi",
            "unset CI; git commit -m 'docs: explain $(nproc) usage'",
            "sed -i 's/$(CC)/clang/' Makefile",
            'echo $((1+2))',
            'echo "$((1+2))"',
            "git commit -m '保留 $(CC) 字样以及 $((1+2)) 示例'",
            "git commit -m '说明 `marker`、eval 和 a[index] 字样'",
            "echo '$(printf marker)'",
            r'echo "\$(printf marker)"',
            r'echo \$\(marker\)',
            "x='$(printf marker)'; printf '%s' \"$x\"",
            "echo '$(marker)' eval let 'a[index]'",
            "echo '$(marker)' '[[' -eq ']]'",
            "git commit -m '说明 [[ x -eq 0 ]] 和 eval 字样'",
            r"printf '%s\n' foo\;bar",
            r"printf '%s\n' '$(marker)' foo\&bar",
            'echo "${value}"',
            'echo "$(printf marker)"',
            "cat > notes.txt <<'EOF'\n$(marker)\n$((1+2))\nEOF",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_data_heredoc_bodies_are_not_parsed_as_shell_syntax(self):
        # 正文里的撇号、括号与双引号在 bash 里只是字符；`$( )` 里由 cat 承接的正文是替换结果，不是脚本。
        for command in [
            "git commit -m \"$(cat <<'EOF'\nfix: don't break\nEOF\n)\"",
            "gh pr create --title t --body \"$(cat <<'EOF'\n## Summary\n- step (1 of 2\nEOF\n)\"",
            "git commit -m \"$(cat <<EOF\nfix: don't break \"quoted\" text\nEOF\n)\"",
            "git commit -m \"$(cat <<'EOF'\nmention $(pwd), `id` and a[0]\nEOF\n)\"",
            "x=\"$(cat <<'EOF'\nit's\nEOF\n)\"; printf '%s' \"$x\"",
            "cat > notes.txt <<EOF\nBuilt $(date +%F), don't edit \"by hand\"\nEOF",
            "git commit -m \"$(\ncat <<'EOF'\nfix: don't break\nEOF\n)\"",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_message_heredocs_are_data_but_executed_bodies_are_checked(self):
        # 正文直接作为提交信息或 PR 正文时只是数据，与 `git commit -F -` 一样不按命令判。
        for command in [
            "git commit -m \"$(cat <<'EOF'\nfix: sed -i 's/a/b/' generated/x\nEOF\n)\"",
            "git commit -am \"title\" -m \"$(cat <<'EOF'\nmention echo x > vendor/a\nEOF\n)\"",
            "gh pr create --title t --body \"$(cat <<'EOF'\nRun: echo x > vendor/a\nEOF\n)\"",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')
        for command in [
            "bash -c \"$(cat <<'EOF'\nsed -i 's/a/b/' generated/x\nEOF\n)\"",
            "git commit -m \"$(cat <<'EOF' | sh\nsed -i 's/a/b/' generated/x\nEOF\n)\"",
            "git commit -m \"$(cat <<EOF\n$(sed -i 's/a/b/' generated/x)\nEOF\n)\"",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_heredoc_bodies_read_by_non_shell_programs_are_literal(self):
        for command in [
            "tee notes.txt <<'EOF'\ndon't\nEOF",
            "python3 - <<'EOF'\nprint('can\\'t')\nEOF",
            "node - <<'EOF'\nconst a = [1]; console.log('run `npm test`', a[0])\nEOF",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_heredoc_literals_reaching_runtime_evaluation_are_denied(self):
        for command in [
            "bash <<'EOF'\neval 'printf \"%s\" \"$(printf marker)\"'\nEOF",
            "sudo bash <<'EOF'\neval 'printf \"%s\" \"$(printf marker)\"'\nEOF",
            "ssh host <<'EOF'\neval 'printf \"%s\" \"$(printf marker)\"'\nEOF",
            "x=\"$(cat <<'EOF'\na[$(printf marker)]\nEOF\n)\"; y=$((x))",
            "x=\"$(cat <<EOF\na[\\$(printf marker)]\nEOF\n)\"; y=$((x))",
            "bash -c \"$(cat <<'EOF'\necho $(printf marker)\nEOF\n)\"",
            "eval \"$(cat <<'EOF'\nprintf '%s' `printf marker`\nEOF\n)\"",
            "cat <<'EOF' | bash\neval 'printf \"%s\" \"$(printf marker)\"'\nEOF",
        ]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')

    def test_all_patch_paths_and_symlink_targets_are_checked(self):
        self.assertEqual(self.guard(tool='patch', paths=[str(self.root / 'safe.txt'), str(self.root / 'vendor/new.txt')]), 'deny')
        (self.root / 'vendor').mkdir()
        (self.root / 'alias').symlink_to(self.root / 'vendor', target_is_directory=True)
        self.assertEqual(self.guard(tool='write', paths=[str(self.root / 'alias/new.txt')]), 'deny')

    def test_nested_location_and_workdir_use_repository_policy(self):
        (self.root / 'src').mkdir()
        self.assertEqual(self.guard(command='cat ../.env', workdir='src'), 'deny')
        self.assertEqual(self.guard(command='echo x > ../vendor/file', workdir='src'), 'deny')

    def test_missing_policy_fails_closed(self):
        (self.root / '.opencode/workflow/protection.json').unlink()
        self.assertEqual(self.guard(tool='write', paths=[str(self.root / 'file')]), 'deny')


    def test_arithmetic_shifts_and_partial_delimiters_are_not_data_heredocs(self):
        for command in ['cat $((1 <<EOF))\nrm -rf vendor\nEOF',
                        'cat <<EO"F"\nEOF\nrm -rf vendor\nEO',
                        "cat <<'EO'F\nEOF\ncat .env\nEO"]:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')


    def test_sort_output_options_are_writes_even_when_attached(self):
        from hooklib import _analyze
        for command in ['sort -ovendor/a public.txt', 'sort -rovendor/a public.txt',
                        r's\ort -ovendor/a public.txt',
                        'sort --output=vendor/a public.txt', 'sort -t: -o vendor/a public.txt']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        self.assertFalse(_analyze('sort -oresult.txt public.txt', str(self.root), {})[2])
        for command in ['sort -oresult.txt public.txt', 'sort -k1 -t: -r public.txt', 'sort --reverse public.txt']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')


    def test_directory_probes_preserve_explicit_file_allow_rules(self):
        for exists in [False, True]:
            if exists:
                (self.root / '.env.example').write_text('public')
            with self.subTest(exists=exists):
                self.assertEqual(self.guard(command='echo ok > .env.example'), 'allow')
                self.assertEqual(self.guard(tool='write', paths=[str(self.root / '.env.example')]), 'allow')
                self.assertEqual(self.guard(command='echo ok > vendor/a'), 'deny')
                self.assertEqual(self.guard(tool='write', paths=[str(self.root / 'vendor')]), 'deny')
        (self.root / '.env.example').unlink()
        (self.root / '.env.example').mkdir()
        self.assertEqual(self.guard(command='rm -rf .env.example'), 'deny')


    def test_only_supported_direct_command_shapes_are_accepted(self):
        (self.root / 'build').mkdir()
        (self.root / 'build/.env').write_text('synthetic')
        for command in ['flock lock rm -rf build', 'unreviewed-runner rm -rf build',
                        './unreviewed-runner cat README.md', '>out rm -rf build',
                        '2>out rm -rf build', '<input rm -rf build',
                        'MODE=test >out rm -rf build', '>out nohup git commit -m x']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        for command in ['npm test', 'node -e "console.log(1)"', 'python3 -m unittest',
                        'bash scripts/check.sh', 'git status --short', 'echo hi > notes.txt']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')

    def test_unresolved_redirect_targets_fail_closed(self):
        for command in ['echo hi > "$DEST"', '> "$DEST"', 'echo hi > "$(printf notes.txt)"']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        self.assertEqual(self.guard(command='DEST=notes.txt; echo hi > "$DEST"'), 'allow')


    def test_shell_path_candidates_use_decoded_words(self):
        for command in [r'source .e\nv; printf "%s" "$KEY"', r'. .e\nv',
                        r'cat .e\nv', r'cp public.txt vend\or/a',
                        r'echo hi > vend\or/a', r'echo hi > .e\nv',
                        '''cp public.txt 'ven'"dor"/a''']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        for command in [r'source .e\nv.example', r'cat public\ file.txt',
                        '''printf '%s' 'ordinary quoted text' ''']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'allow')


    def test_cdpath_cannot_redirect_a_checked_relative_cd(self):
        from unittest.mock import patch
        (self.root / 'build/lib/cache').mkdir(parents=True)
        (self.root / 'build/lib/cache/.env').write_text('synthetic')
        for command in ['CDPATH=build; cd lib && rm -rf cache',
                        'export CDPATH=build; cd lib && rm -rf cache',
                        'time env CDPATH=build sh -c "cd lib && rm -rf cache"',
                        'env CDPATH=build sh -c "cd lib && rm -rf cache"']:
            with self.subTest(command=command):
                self.assertEqual(self.guard(command=command), 'deny')
        with patch.dict('os.environ', {'CDPATH': str(self.root / 'build')}):
            self.assertEqual(self.guard(command='cd lib && rm -rf cache'), 'deny')
            self.assertEqual(self.guard(command='cd ./build/lib && rm -rf empty'), 'allow')
            self.assertEqual(self.guard(command=f'cd "{self.root}/build/lib" && rm -rf empty'), 'allow')


if __name__ == '__main__':
    unittest.main()
