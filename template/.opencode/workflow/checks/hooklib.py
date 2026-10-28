"""各 hook 共用的「从工具输入里拿出可能被改的文件路径」逻辑。

两条编辑路径都要认。调用方规范化补丁的全部路径和 shell 的实际 command；只认文件路径、不认 command 的守卫，在用 shell 改文件
（heredoc / sed -i / python 改写）时不会触发。

命令串判定是白名单式的：提到路径就算候选，只有整条命令「确认只读」才跳过。确认只读的定义：
按 ; | || && 与换行切段（引号内不切），每一段的首词都在只读白名单里（cd / export / 赋值 / set /
控制流关键字这类不碰文件的段算中性），$( ) / <( ) / >( ) 的内层按同一套规则递归判（内层不只读整条就
不只读；参数里带替换时，只有参数怎么写都写不了文件的命令还算只读，见 ARG_SAFE_CMD），反引号子命令一律不算只读
（子命令里能藏任何写操作），也没有落盘的重定向——2>&1、>/dev/null 这类不算；落盘的重定向只把目标当候选，
`cat vendor > /tmp/x` 于是只看 /tmp/x。
写入意图无法从命令串推断（`python3 - <<'EOF'` 里一句 open(...,"w") 就是反例），所以不做
「它到底写不写」的猜测。唯一的数据例外是 `cat > 目标 <<分隔符 … 分隔符`：只有 cat 在写、
正文是数据，正文里提到别的路径不算（分隔符不带引号、正文里有会执行的 $( ) / 反引号时不算数据）；分隔符之后的尾命令照常判定。heredoc 按 `<<分隔符` 词法识别：正文是不是数据只看承接 `<<` 的那一段
首词是不是 cat，同一行其他段（`mkdir -p … &&`、cd、赋值、尾命令）与去掉运算符的头行一起照常判定——
逐段识别语法，避免复杂前缀和长赋值链导致正则回溯或遗漏命令。
`$VAR` / `${VAR}` 按本条命令里出现过的纯赋值（`A=x`、`A=x B=y`、export / declare / local / readonly）展开——否则
`D=vendor/src && cat > $D/file.js <<'EOF'` 的目标需要展开后检查。
语义按 bash：赋值只对其后的段生效，管道各段与 `&` 后台中的赋值不外溢（见 command_states），命令前的环境前缀
`X=1 cmd` 不是 shell 变量；解不开的变量原样保留、整条退回逐 token 判。

相对路径按中性事件的 directory 和原生 input.workdir 解析；workdir 与原生工具的路径参数按 OpenCode 的方式
解析（见 tool_path），相对会话 Location。没有 workdir 时使用 directory。命令里的 `cd X` 按列表语义推进目录
（见 command_states）：`cd vendor && sed -i … src/file.js` 的路径挂到 vendor 下，cd 之后的 `;` 两种目录都可能。

多跑一轮的代价是两秒静默；漏跑一次的代价是一个不生效的护栏静默留在仓库里。
只读白名单只此一份：inspect-paths.py 与各 pre-* 守卫都 import 这里。
inspect-paths.py 传 include_readonly=True，由原生插件发现 scope 并补充 context；规则加载的口径是
「读到就该加载」，不是护栏，只读命令的 token 也要。
"""
import errno
import ntpath
import os
import posixpath
import re
import shlex
import stat
import sys

# 命令串里的候选 token：空白 / 引号 / 重定向 / 分隔符 / 等号 / 括号 / 反引号之外的连续串。
# 排掉 = 是为了 `f=src/x.java; printf … > $f` 这种赋值形态。
TOKEN = re.compile(r"[^\s'\"<>|;&=()`]+")

# 确认只读的段首词。找不到写入形态的才进这张表：tee / python3 -c / node -e / npx / eslint 一类都不在——它们能写、
# 或能带 --fix。执行参数或有隐式输出的 command / awk / uniq / xxd / tree / less 不视为只读；
# find / sort / sed / xargs / git 另有写形态，见下面几条。
# git 只收不碰工作区文件的子命令：add / commit / tag / branch / fetch 只动 .git（索引、对象、引用），而守卫护的是工作区里的
# vendor / 协议产物 / env——`git add` 生成的协议产物曾被 pre-guard-legal 当成直改产物拦下，实现者只能按目录 add。
# checkout / restore / reset / stash / merge / rebase / apply / clean / rm / mv 会改工作区，不在表里；`-c k=v` / `-C 目录`
# 这类全局选项可以夹在 git 与子命令之间（`git -c core.quotepath=off grep` 是本仓库的常见写法）。
READONLY_CMD = re.compile(
    r"^(?:cat|head|tail|more|wc|file|stat|ls|du|df|pwd|date|type|which|read|source|\."
    r"|grep|rg|egrep|fgrep|diff|cmp|comm|sort|cut|tr|nl|od|strings|column"
    r"|md5sum|sha1sum|sha256sum|sha512sum|cksum|jq|echo|printf|test|\[|true|false"
    r"|readlink|realpath|basename|dirname|sed|find|xargs"
    r"|ss|ps|pgrep|lsof|id|uname|hostname|whoami|nproc|free|uptime|sleep"
    r"|docker\s+(?:ps|logs|inspect|images|port|version|info)"
    r"|git(?:\s+(?:-c\s+\S+|-C\s+\S+|--no-pager|-P|--no-optional-locks))*\s+(?:diff|log|show|status|blame|grep"
    r"|ls-files|ls-tree|rev-parse|describe|cat-file|check-ignore|add|commit|merge-base|tag|branch|rev-list"
    r"|reflog|shortlog|show-ref|for-each-ref|name-rev|count-objects|range-diff|cherry|remote|config|fetch"
    r"|worktree\s+list|stash\s+(?:list|show))"
    r")(?=\s|$)")
FIND_WRITE = re.compile(r"\s-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)(?=\s|$)")
# git diff / log / show 的 --output 会写文件，不能作为只读命令放行。
GIT_OUTPUT = re.compile(r"\s--output(?:=|\s)")
# 标准系统目录下的命令按 basename 认：`/usr/bin/grep -a` 可用于检查二进制内容，
# 之前首词对不上白名单、整条被当写。别的目录下的同名脚本不认——那是谁都说不清会做什么的脚本。
SYS_BIN = re.compile(r"^/(?:usr/(?:local/)?)?s?bin/(?=[^/\s]+(?:\s|$))")
# xargs 自身的选项（带参的 -n/-L/-P/-s/-I/-d/-E/-a 可紧贴也可分开）；剥掉后看它要跑的命令本身是不是只读。
XARGS_OPTS = re.compile(r"^(?:\s*(?:-[0rtxp]+|-[nLPsIdEa]\s*\S+|-[ie]\S*|--[\w-]+(?:=\S+)?))*")
# sed 的 w 写到这两个特殊文件不落盘（GNU sed 认它们）。
SED_SPECIAL_FILES = {"/dev/stdout", "/dev/stderr"}
# 参数里有命令替换时还算只读的命令：参数怎么写都写不了文件、也不会拿参数去执行命令。find / sort / awk / git / xargs /
# uniq / xxd / tree / less / rg（--pre 会执行命令）都不在表里——替换出来的可能正是 -delete、-o、--output 或程序本身
# 例如 find 的命令替换可以生成 -delete。sed 另由脚本解析判。
ARG_SAFE_CMD = re.compile(
    r"^(?:cat|head|tail|wc|stat|ls|du|df|pwd|date|type|which|grep|egrep|fgrep|diff|cmp|comm|cut|tr|nl|od"
    r"|strings|column|md5sum|sha1sum|sha256sum|sha512sum|cksum|jq|echo|printf|test|\[|true|false"
    r"|readlink|realpath|basename|dirname|sleep)(?=\s|$)")
# git config 带 -f / --file 就是往那个文件里写（config 本身只动 .git/config，才进了只读子命令表）。
GIT_CONFIG_FILE = re.compile(r"\sconfig\s(?:.*\s)?(?:-f|--file(?==|\s|$))")
# 引号外的任一重定向连同目标（输入 / 输出 / 追加 / here-string / fd 复制）；只在引号掩码上匹配，见 _strip_redirects。
ANY_REDIRECT = re.compile(r"\d*&?[<>]+[&|]?\s*\S*")
# `$( )` 抽走后的占位；内层按同一套规则递归判定。
SUBST_REF = re.compile(r"__SUBST(\d+)__")
# 不碰文件的段：cd / export / set / 纯赋值 / 控制流的收尾词。cd 另外参与 cwd 推进。
NEUTRAL_CMD = re.compile(r"^(?:cd|export|unset|set|shift|fi|done|esac|for|select|:)(?=\s|$)|^\w+=")
# 段首可剥掉的包装：time / env A=b / A=b / timeout N / nice / 控制流开头词。可叠两层（time env A=b cmd）。
PREFIX = re.compile(
    r"^(?:time|nice(?:\s+-n\s+\S+)?|timeout\s+\S+|env(?:\s+\w+=(?:'[^']*'|\"[^\"]*\"|\S*))*"
    r"|if|then|else|elif|do|while|until|!)\s+|^(?:\w+=(?:'[^']*'|\"[^\"]*\"|\S*)\s+)+")
# 路径守卫和提交识别共用这份包装列表；后者识别后仍拒绝不支持的提交形态。
SHELL_WRAPPERS = frozenset({'env', 'time', 'timeout', 'nice', 'command', 'builtin', 'exec',
                            'sudo', 'doas', 'nohup', 'xargs', 'setsid', 'stdbuf'})
STATIC_WRAPPERS = frozenset({'env', 'time', 'timeout', 'nice'})
STATIC_SHELL_ERROR = '无法静态检查这条 shell 命令，请改写成直接的命令'
# 仅支持明确列出的首命令。开发入口的脚本内容不是本静态守卫的沙盒边界，未知 CLI 不默认放行。
DIRECT_COMMANDS = frozenset('''
    cat head tail more wc file stat ls du df pwd date type which read source .
    grep rg egrep fgrep diff cmp comm sort cut tr nl od strings column
    md5sum sha1sum sha256sum sha512sum cksum jq echo printf test [ [[ true false
    readlink realpath basename dirname sed awk find uniq xxd tree less
    ss ps pgrep lsof id uname hostname whoami nproc free uptime sleep
    cd export unset set shift : if then else elif fi ! declare typeset readonly local let eval
    rm mv cp mkdir rmdir touch tee ln chmod chown chgrp install truncate tar unzip zip patch
    git docker gh npm npx node python python3 pytest make gmake cargo go
    bash sh zsh dash ksh yarn pnpm bun deno uv pip pip3
    javac java mvn gradle dotnet ruby bundle rake php composer
'''.split())


def supported_shell_command(name):
    name = SYS_BIN.sub('', name, count=1)
    return name in DIRECT_COMMANDS or name in SHELL_WRAPPERS
# 不落盘的重定向：2>&1、>&2、>/dev/null、&>/dev/null。剩下的 > 才是写。
HARMLESS_REDIRECT = re.compile(r"&?\d*>\s*/dev/null|\d*>&\s*\d+")
# 落盘的重定向：目标是写候选。
WRITE_REDIRECT = re.compile(r"(?<![<>&])\d?>>?\s*(\S+)")
CD_CMD = re.compile(r"^cd\s+(\S+)")
# heredoc 运算符 `<<` / `<<-`（分隔符可带引号）；排除 here-string `<<<` 与 `<<` 前紧贴的重定向符。
# 正文是不是数据看「承接 `<<` 的那一段是不是 cat」——只有 cat 在写、正文才是数据；tee / python3 - / sudo cat
# 承接的正文照常按命令判。另一个数据承接者是 `git commit -F -`：正文是提交信息，git 只读它不执行它（提交信息里
# 常写到协议产物路径与 sed -i 之类字样，之前整条被当命令拦下）。头行去掉运算符后与其他行一起走普通段判定，
# 所以 `cat > 目标` 的目标、前面的 cd / 赋值、藏在前缀赋值里的 `$( )` 与裸重定向 `X=1>文件`、尾命令都照常可见。
# cat 的输出在头行上又经管道交出去时（`cat <<EOF | bash`）正文照常按命令判：管道那头可能是解释器。
HEREDOC_OP = re.compile(r"(?<![<>])<<(?!<)-?\s*(['\"]?)(\w+)\1")
PIPE = re.compile(r"(?<!\|)\|(?!\|)")
# 不带引号的 heredoc 正文里会执行的 `$(` 与反引号：前面是偶数个反斜杠（含 0 个）才算，`\`` / `\$(` 是字面字符
# （回放历史命令时，一条写进度笔记的 `cat >> … <<EOF` 正文里全是 \`deploy/.env\` 这种转义反引号）。
HEREDOC_EXPANDS = re.compile(r"(?:^|[^\\])(?:\\\\)*(?:\$\(|`)")
GIT_COMMIT_STDIN = re.compile(
    r"^git(?:\s+(?:-c\s+\S+|-C\s+\S+|--no-pager))*\s+commit\b.*?\s(?:-F\s*-|--file(?:=|\s+)-)(?=\s|$)")
# 正文经 `"$(cat <<'EOF' … EOF)"` 直接成为提交信息或 PR、issue、release 正文参数时，与 `git commit -F -` 一样只是数据。
MESSAGE_SUBST = re.compile(
    r"^(?:git(?:\s+(?:-c\s+\S+|-C\s+\S+|--no-pager))*\s+commit\b.*\s(?:-[a-zA-Z]*m|--message=?)"
    r"|gh\s+(?:pr|issue|release)\s+(?:create|edit|comment)\b.*\s(?:-[btn]|--body=?|--title=?|--notes=?))"
    r'\s*"\$\(\s*cat$')
# 隐藏求值检查另认的正文读取者：只把正文当数据或其他语言的程序读，不交给 shell 执行，正文按字面量检查。
# 不在名单里的（bash、sudo bash、ssh 等可能执行正文的）照常按脚本行检查。
DATA_READER = re.compile(
    r"^(?:sudo\s+)?(?:tee|git|gh|python(?:\d+(?:\.\d+)*)?|node|deno|bun|ruby|perl|php|psql|mysql|sqlite3|jq)(?=\s|$)")
# $VAR / ${VAR} 引用；只展开本条命令里出现过的纯赋值，未知变量原样保留。
VAR_REF = re.compile(r"\$\{(\w+)\}|\$(\w+)")
# 纯赋值段：`A=x`、`A=x B=y`、`export A=x B=y`、`declare -x A=x`、`local` / `readonly`。值是引号片段与裸片段的拼接
# （`D="$B"/src` 也要认），裸片段不含 `=`——含了就有多种切分方式，长链会指数回溯。裸片段按单字符匹配：写成 `[^…]+`
# 放进外层 `(…)*` 就是 `(x+)*`，同一串有指数多种切法，「VAR=<长值> 命令」这种 env 前缀让纯赋值匹配失败时回溯撑爆
# 避免长变量值导致检查器超时。`X=1 cmd` 那种
# 命令前的环境前缀不算纯赋值：bash 只把它给那条命令，后面的 $X 仍是空。
ASSIGN_VALUE = r"(?:'[^']*'|\"[^\"]*\"|[^\s'\"=])*"
ASSIGN = re.compile(
    r"^(?:export\s+|declare\s+(?:-\w+\s+)*|local\s+(?:-\w+\s+)*|readonly\s+)?"
    r"((?:\w+=" + ASSIGN_VALUE + r"\s*)+)$")
ASSIGN_PAIR = re.compile(r"(\w+)=(" + ASSIGN_VALUE + ")")
# 段尾的 bash 注释：`D=vendor/src  # vendor root`。只在 `#` 前引号成对、`#` 后不含引号时才剥——
# `python3 -c "x='#'; open(...)"` 的 `#` 在引号里，剥了就把后面的写入藏起来。
COMMENT_TAIL = re.compile(r"(^|\s)#[^'\"]*$")


# Windows 盘符的绝对路径（规范化为正斜杠后）：`C:/repo`。
DRIVE_ABSOLUTE = re.compile(r"^[A-Za-z]:/")
# 与 OpenCode FSUtil.windowsPath 相同：Git Bash、Cygwin、WSL 风格的盘符路径在 Windows 上指向 `X:/`。
WINDOWS_DRIVE_FORMS = (re.compile(r"^/([a-zA-Z]):(?:[\\/]|$)"), re.compile(r"^/([a-zA-Z])(?:/|$)"),
                       re.compile(r"^/cygdrive/([a-zA-Z])(?:/|$)"), re.compile(r"^/mnt/([a-zA-Z])(?:/|$)"))


def windows_path(value, os_name=None):
    """Windows 上把 `/c/...`、`/C:/...`、`/cygdrive/c/...`、`/mnt/c/...` 换成 `C:/...`；其他系统原样返回。"""
    if (os_name or os.name) != 'nt':
        return value
    for form in WINDOWS_DRIVE_FORMS:
        value = form.sub(lambda m: m.group(1).upper() + ':/', value, count=1)
    return value


def opencode_home(env=None):
    """OpenCode 展开 `~` 用的主目录：OPENCODE_TEST_HOME，没有时取系统主目录（与 Node 的 os.homedir() 一致）。"""
    home = (os.environ if env is None else env).get('OPENCODE_TEST_HOME')
    return home if home is not None else os.path.expanduser('~')


def tool_path(directory, value, os_name=None):
    """与 OpenCode FileAccess.resolve 相同：先转换盘符写法，恰为 `~` 或以 `~/` 开头时换成主目录，再相对 directory
    按字面合并 `..`。grep 的 path、shell 的 workdir 和原生工具的路径参数都这样解析，不去引号，`~user` 不展开。"""
    module = ntpath if (os_name or os.name) == 'nt' else posixpath
    value = windows_path(value, os_name)
    if value == '~':
        value = opencode_home()
    elif value.startswith('~/'):
        # Node 的 path.join 把 `~/` 之后的部分当相对片段拼接；posixpath.join 遇到以分隔符开头的片段会丢掉主目录，先去掉它。
        value = module.join(opencode_home(), value[2:].lstrip('\\/' if module is ntpath else '/'))
    return module.normpath(module.join(directory, value))


def _env_value(env, name):
    return next((value for key, value in env.items() if key.upper() == name), None)


def find_program(name, os_name=None, env=None, exists=None, pathext=None):
    """在 PATH 的绝对目录中查找程序并返回绝对路径，找不到时返回 None；Windows 按 PATHEXT 补扩展名。
    不查当前目录：Windows 的 CreateProcess 和 shutil.which 会先查它，PATH 的空项和相对项也指向它。
    Windows 的 PATH 项可以带一对引号，与系统一样去掉；没有 PATH 时与 shutil.which 一样用默认路径。"""
    windows = (os_name or os.name) == 'nt'
    module = ntpath if windows else posixpath
    env = os.environ if env is None else env
    if exists is None:
        exists = os.path.isfile if windows else (lambda file: os.path.isfile(file) and os.access(file, os.X_OK))
    names = [name]
    if windows:
        extensions = [ext for ext in (pathext or _env_value(env, 'PATHEXT') or '.COM;.EXE;.BAT;.CMD').split(';') if ext]
        if not any(name.lower().endswith(ext.lower()) for ext in extensions):
            names = [name + ext for ext in extensions]
    value = _env_value(env, 'PATH')
    if value is None:
        value = '' if windows else posixpath.defpath
    for directory in value.split(';' if windows else ':'):
        if windows and len(directory) > 1 and directory[0] == directory[-1] == '"':
            directory = directory[1:-1]
        if module.isabs(directory):
            found = next((module.join(directory, item) for item in names if exists(module.join(directory, item))), None)
            if found:
                return found
    return None


def program(name, os_name=None, env=None, exists=None):
    """启动外部程序用的绝对路径，找不到时返回 None：进程创建会在当前目录查找不带路径的命令，Windows 总是先查，
    macOS 和 Linux 在 PATH 有空项时也查。Windows 上只认 .com/.exe：经 cmd.exe 执行时，参数会被 cmd 解释。"""
    return find_program(name, os_name, env, exists, pathext='.com;.exe' if (os_name or os.name) == 'nt' else None)


def system_command(name, env=None):
    """taskkill.exe 等 Windows 系统程序固定取自 %SystemRoot%\\System32，没有 SystemRoot 时依次用 windir、C:\\Windows。"""
    env = os.environ if env is None else env
    return ntpath.join(_env_value(env, 'SYSTEMROOT') or _env_value(env, 'WINDIR') or 'C:\\Windows', 'System32', name)


def is_absolute(path, os_name=None):
    """`/` 开头总是绝对路径；`C:/` 只在 Windows 上是盘符绝对路径，POSIX 上它是名为 `C:` 的相对目录。"""
    return path.startswith('/') or ((os_name or os.name) == 'nt' and DRIVE_ABSOLUTE.match(path) is not None)


# 整条路径的长度上限：Linux、macOS 按 UTF-8 字节（含结尾 NUL），Windows 按 UTF-16 码元。
PATH_LIMITS = {'linux': 4096, 'darwin': 1024, 'win32': 32767}
# ext4 等按字节、APFS 和 NTFS 等按 UTF-16 码元限制名字，常见文件系统都放不下超过 255 个码元的名字。
NAME_LIMIT = 255


def brief(path):
    """拒绝原因中的路径：超长参数只保留首尾，不整段回显（与插件 platform.ts 的 briefPath 相同）。"""
    text = str(path)
    return text if len(text) <= 160 else f'{text[:60]}…{text[-60:]}（共 {len(text)} 个字符）'


def missing_long_name(error, platform=None):
    """查询路径报名字过长时，能否确定这个路径不存在。

    整条路径短于上限时，报错只能来自某一段名字超过文件系统上限，任何方式都打不开；某段超过 NAME_LIMIT 时同样如此。
    其余情况（整条路径超长而每段正常）可能真实存在，例如经相对路径访问的深层目录，由调用方拒绝。"""
    if getattr(error, 'errno', None) != errno.ENAMETOOLONG:
        return False
    try:
        path = os.fsdecode(os.fspath(error.filename))
    except TypeError:
        return False
    platform = platform or sys.platform
    windows = platform == 'win32'
    units = lambda text: len(text.encode('utf-16-le', 'surrogatepass')) // 2
    length = units(path) if windows else len(path.encode('utf-8', 'surrogatepass'))
    return length < PATH_LIMITS.get(platform, 0) or any(units(part) > NAME_LIMIT for part in re.split(r'[\\/]' if windows else '/', path))


# Python 3.12 的 Path.exists 把这些错误当作路径不存在（Windows 的 21、123、1921 是设备未就绪、名称无效、无法解析链接）；
# 1920 是无法访问的重解析点，例如 WindowsApps 下的应用执行别名，它下面不可能有子项，与 ntpath.realpath 的非严格模式一致。
MISSING_ERRNOS = (errno.ENOENT, errno.ENOTDIR, errno.EBADF, errno.ELOOP)
MISSING_WINERRORS = (21, 123, 1920, 1921)


def _stat(path):
    """按 Python 3.12 的 Path.exists 口径查询，能确定不存在的超长名字也按不存在处理，其余错误照常抛出。
    Python 3.14 起 Path.exists、Path.is_dir 把所有 OSError 都当作不存在，守卫不能依赖它们拒绝查询出错的路径。"""
    try:
        return os.stat(path)
    except OSError as error:
        if error.errno in MISSING_ERRNOS or getattr(error, 'winerror', None) in MISSING_WINERRORS or missing_long_name(error):
            return None
        raise
    except ValueError:
        # 含 NUL 或超过 Windows 上限的路径无法传给系统调用，命令同样打不开。
        return None


def path_exists(path):
    return _stat(path) is not None


def path_is_dir(path):
    info = _stat(path)
    return info is not None and stat.S_ISDIR(info.st_mode)


def _dequote(s):
    return s.replace('"', "").replace("'", "")


def _expand(tok, env):
    if "$" not in tok or not env:
        return tok
    return VAR_REF.sub(lambda m: env.get(m.group(1) or m.group(2), m.group(0)), tok)


def _assign(env, name, value):
    """值先按已有变量展开再记下；未知变量保留，调用方按候选路径判定。"""
    env[name] = _expand(_dequote(value), env)


def _strip_comment(seg):
    m = COMMENT_TAIL.search(seg)
    if not m:
        return seg
    head = seg[:m.start()]
    if head.count('"') % 2 or head.count("'") % 2:
        return seg
    return head


def _resolve(cur, tok):
    """相对路径挂到当前目录下；选项 / 变量 / ~ 原样；绝对路径也规范化（`$D/src` 在 D 带尾斜杠时拼出 `//`，
    否则目录模式无法匹配）；引号全部去掉。没有 cwd 时相对路径原样。"""
    tok = windows_path(_dequote(tok.replace("\\", "/")))
    if not tok or tok.startswith(("-", "$", "~")):
        return tok
    if is_absolute(tok):
        return os.path.normpath(tok)
    if not cur:
        return tok
    return os.path.normpath(os.path.join(cur, tok))


def git_clean_pathspec_problem(path, os_name=None):
    """git clean 的路径里无法静态确认清理范围的写法：引号里的通配由 git 展开，`:` 开头是 pathspec 写法
    （:/、:(top)、:(icase)、:!排除）。POSIX 上 `\\` 是 pathspec 的转义字符，也拒绝；Windows 上 `\\` 是目录分隔符，不算通配。"""
    if path.startswith(':'):
        return 'git clean 的路径不支持以 : 开头的 pathspec 写法，请写明字面目录'
    wildcards = '*?[' if (os_name or os.name) == 'nt' else '*?[\\'
    if any(c in path for c in wildcards):
        return 'git clean 的路径不支持通配，请写明字面文件或目录'
    return None


def physical_path(path, os_name=None):
    """按 POSIX 内核的方式解析绝对路径中的 `..`：先跟随前面各段的符号链接，再回到上一级；最后一段不跟随，由
    check_path 的真实路径检查覆盖。字面合并会把 `LINK/../x` 当作与 LINK 同级的 x，内核打开的却是链接目标上一级里的 x。
    不含 `..` 段或不是绝对路径时原样返回。Windows 按字面合并 `..`，这里同样计算，只是多检查一个候选。
    `..` 之前的某一段在真机上不存在时（可能是同一命令里新建的链接），无法确认内核落点，返回 None 由调用方拒绝；
    os_name 注入（跨平台测试）时只算字面与链接解析，不查存在性。非严格的 realpath 查询出错时当作不是链接继续；
    得到的候选仍要经过 check_path 的查询，出错同样拒绝。"""
    module = ntpath if (os_name or os.name) == 'nt' else posixpath
    drive, rest = module.splitdrive(path)
    parts = re.split(r'[\\/]', rest) if module is ntpath else rest.split('/')
    if '..' not in parts or not module.isabs(path):
        return path
    current = drive + module.sep
    for index, part in enumerate(parts[:-1]):
        if part in ('', '.'):
            continue
        if part == '..':
            current = module.dirname(current)
            continue
        target = module.join(current, part)
        if os_name is None and '..' in parts[index + 1:] and not os.path.lexists(target):
            return None
        current = module.realpath(target)
    return module.join(current, parts[-1])


def _shell_paths(cur, tok):
    """shell 命令中的路径候选：字面合并的路径；含 `..` 段时另加按内核方式解析的路径（见 physical_path）。
    `..` 之前的段在检查时不存在时无法确认落点，拒绝。"""
    lexical = _resolve(cur, tok)
    raw = windows_path(_dequote(tok.replace("\\", "/")))
    if not raw or raw.startswith(("-", "$", "~")) or not (is_absolute(raw) or cur):
        return [lexical]
    physical = physical_path(raw if is_absolute(raw) else os.path.join(cur, raw))
    if physical is None:
        raise ValueError('无法确认 `..` 之前的路径（可能是同一命令里新建的链接），请改写为不经过 `..` 的直接路径')
    return list(dict.fromkeys([lexical, os.path.normpath(physical)]))


def _cd(cur, target):
    target = os.path.expanduser(windows_path(_dequote(target.replace("\\", "/"))))
    if os.environ.get('CDPATH') and not is_absolute(target) and target.split('/')[0] not in {'.', '..'}:
        raise ValueError('非空 CDPATH 使相对 cd 目标不确定，请使用 ./ 开头或绝对目录')
    if is_absolute(target) or not cur:
        return target
    return os.path.normpath(os.path.join(cur, target))


def shell_literal_text(text):
    """将 ANSI-C 字面量转成 shlex 可解析的等价引号，不执行任何展开。"""
    out, i, quote = [], 0, None
    while i < len(text):
        c = text[i]
        if quote is None and text.startswith("$'", i):
            value, i = _ansi_c_string(text, i)
            out.append(shlex.quote(value))
            continue
        if c == '\\' and quote != "'" and i + 1 < len(text):
            out.append(text[i:i + 2])
            i += 2
            continue
        if c == quote:
            quote = None
        elif quote is None and c in "\"'":
            quote = c
        out.append(c)
        i += 1
    return ''.join(out)


def split_segments(text):
    """按 ; | || && & 与换行切段，引号内不切；`2>&1` / `&>` 里的 & 不是分隔符；反斜杠续行接回上一行。"""
    return [segment for segment, _ in split_commands(text)]


# 段之后的分隔符：`&&`、`||` 之后的段按上一条的结果执行，`|` 连成管道，`&` 把之前的整条列表放到后台；其余（`;`、换行）按 `;`。
LIST_OPERATORS = {'&&': '&&', '||': '||', '|': '|', '|&': '|', '&': '&'}


def split_commands(text):
    """与 split_segments 相同的切分，另给出每段之后的分隔符；`&&`、`||`、`|` 之后的换行仍属于同一条列表。"""
    text = shell_literal_text(text)
    segs, buf, quote = [], [], None
    i, n = 0, len(text)
    while i < n:
        c = text[i]
        if quote:
            if c == "\\" and quote == '"' and i + 1 < n:
                buf.append(c)
                buf.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            buf.append(c)
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            buf.append(c)
            i += 1
            continue
        if c == "\\" and i + 1 < n and text[i + 1] == "\n":
            buf.append(" ")
            i += 2
            continue
        if c == "\\" and i + 1 < n:
            buf.append(text[i:i + 2])
            i += 2
            continue
        if c == "&" and ((buf and buf[-1] in "<>") or (i + 1 < n and text[i + 1] == ">")):
            buf.append(c)
            i += 1
            continue
        if c in ";|&\n":
            start = i
            i += 1
            while i < n and text[i] in ";|&":
                i += 1
            op = LIST_OPERATORS.get(text[start:i], ';')
            if op in ('&&', '||', '|'):
                while i < n and text[i] in " \t\n":
                    i += 1
            segs.append(("".join(buf), op))
            buf = []
            continue
        buf.append(c)
        i += 1
    segs.append(("".join(buf), ';'))
    return [(s.strip(), op) for s, op in segs if s.strip()]


# 一条命令里可能的目录与变量组合上限；cd 后接 `;` 时组合翻倍，超过就无法在检查时限内逐一判定。
STATE_LIMIT = 64


def _frozen(env):
    return tuple(sorted(env.items()))


def _assigned_env(segment, env):
    """纯赋值段执行之后的变量，不是纯赋值段时返回 None；与 _analyze 判定只读时的口径相同，值先按已有变量展开。"""
    text = SUBST_REF.sub("()", _strip_redirects(HARMLESS_REDIRECT.sub(" ", _expand(_strip_comment(segment), env))))
    match = ASSIGN.match(text.strip())
    if not match:
        return None
    env = dict(env)
    for pair in ASSIGN_PAIR.finditer(match.group(1)):
        _assign(env, pair.group(1), pair.group(2))
    return env


def _bare_cd(segment):
    """段首（赋值前缀之后）就是 cd：在当前 shell 执行，成功时一定已进入目标。`!`、if、time、env、/usr/bin/cd 等前缀不算。"""
    words = shlex.split(segment, comments=True)
    while words and re.match(r'^[A-Za-z_]\w*=', words[0]):
        words.pop(0)
    return words[:1] == ['cd']


def command_states(text, cwd, env):
    """按 bash 的列表语义给出每段命令可能在其中执行的 (段, 目录, 变量)，同一段可能对应多个组合。
    只有不带前缀的 `cd 目标` 分得清成功：成功进入目标，失败留在原处或已进入目标；带 `!`、if、time、env 等前缀的 cd 结果未知。
    `&&`、`||` 之后的段只在对应结果下执行，`;` 与换行之后不论结果；管道各段和 `&` 之前的整条列表在子 shell 中执行，
    其中的 cd 与赋值不影响之后的命令。不静态的段照常抛出 ValueError。"""
    lists, pipelines, pipeline, connector = [], [], [], None
    for segment, op in split_commands(text):
        pipeline.append(segment)
        if op == '|':
            continue
        pipelines.append((connector, pipeline))
        pipeline = []
        if op in ('&&', '||'):
            connector = op
            continue
        lists.append((pipelines, op == '&'))
        pipelines, connector = [], None
    if pipeline:
        pipelines.append((connector, pipeline))
    if pipelines:
        lists.append((pipelines, False))

    results = []

    def step(segment, words, state):
        """执行一段：记下它所在的组合，返回 {(之后的组合, 结果)}。"""
        cwd, frozen = state
        results.append((segment, cwd, dict(frozen)))
        if words[:1] == ['cd']:
            target = _cd(cwd, words[1])
            moved = [(target, frozen)]
            literal = os.path.expanduser(windows_path(_dequote(words[1].replace("\\", "/"))))
            if '..' in literal.split('/') and (is_absolute(literal) or cwd):
                # 默认的逻辑 cd 按字面合并 `..`；`set -P` 之后按真实路径切换，两种都可能。cd 目标无法确认落点时
                # bash 的 cd 本身会失败（留在原目录，已由 fail 分支覆盖），不另加真实目录状态。
                resolved = physical_path(literal if is_absolute(literal) else os.path.join(cwd, literal))
                physical = os.path.realpath(resolved) if resolved is not None else target
                # 与字面目标的真实路径比较：没有经过符号链接的 `..` 时两者相同，不额外增加状态（macOS 的 /var、
                # Windows 的 8.3 短名会让字面目标与其真实路径不同，不能据此翻倍状态数）。
                moved += [(physical, frozen)] if physical != os.path.realpath(target) else []
            if _bare_cd(segment):
                # PWD 或 OLDPWD 只读时，bash 先切换目录，再因无法更新变量返回失败，失败的 cd 也可能已在目标中。
                return {**{(state, result): None for state in moved for result in ('ok', 'fail')}, (state, 'fail'): None}
            return {**{(state, 'any'): None for state in moved}, (state, 'any'): None}
        # export 等给只读变量赋值会失败而 shell 继续执行，之后的 `||` 仍会执行。
        assigned = _assigned_env(segment, dict(frozen))
        if assigned is not None:
            return {((cwd, _frozen(assigned)), 'any'): None}
        return {(state, 'any'): None}

    states = {(cwd or "", _frozen(env)): None}
    for pipelines, background in lists:
        current = {(state, 'any'): None for state in states}
        for connector, pipeline in pipelines:
            words = [static_command_words(segment) for segment in pipeline]
            wanted = 'fail' if connector == '||' else 'ok'
            following = {}
            for state, status in current:
                if connector and status not in (wanted, 'any'):
                    following[(state, status)] = None
                    continue
                if connector and status == 'any':
                    # 结果未知：这一段可能被跳过，跳过时上一条的结果原样传下去。
                    following[(state, 'ok' if wanted == 'fail' else 'fail')] = None
                if len(pipeline) == 1:
                    following.update(step(pipeline[0], words[0], state))
                    continue
                for segment, parsed in zip(pipeline, words):
                    step(segment, parsed, state)
                following[(state, 'any')] = None
            current = following
            if len({state for state, _ in current}) > STATE_LIMIT:
                raise ValueError('命令中的 cd 与赋值组合过多，无法静态确认工作目录，请拆成多条命令')
        if not background:
            states = {state: None for state, _ in current}
    return results


def _owner_takes_data(prefix, readers=False):
    """`<<` 所在那一段是不是把正文当数据：首词是 cat，或者是 `git commit -F -`、MESSAGE_SUBST（正文是提交信息
    或 PR 正文）；readers 时另认 DATA_READER。取运算符之前的文本按分隔符切段取最后一段，剥掉 time / env / if
    之类包装再看。"""
    segs = split_segments(prefix)
    core = segs[-1] if segs else ""
    core = PREFIX.sub("", core).strip()
    core = PREFIX.sub("", core).strip()
    if not core:
        return False
    if readers and DATA_READER.match(SYS_BIN.sub("", core, count=1)):
        return True
    return core.split(None, 1)[0] == "cat" or bool(GIT_COMMIT_STDIN.match(core) or MESSAGE_SUBST.match(core))


def _innermost_command(text):
    """text 末尾所处的最内层命令：`(`、`$(`、`<(`、`>(` 与反引号各开一层，引号状态随层保存；返回这一层的文本。"""
    stack, start, quote, i = [], 0, None, 0
    while i < len(text):
        c = text[i]
        if quote == "'":
            if c == "'":
                quote = None
        elif c == "\\":
            i += 1
        elif c == '"':
            quote = None if quote else c
        elif c == "'" and quote is None:
            quote = c
        elif c == "`" and stack and stack[-1][2] == "`":
            start, quote = stack.pop()[:2]
        elif c == "`" or (c == "(" and (quote is None or text[i - 1:i] == "$")):
            stack.append((start, quote, c))
            start, quote = i + 1, None
        elif c == ")" and quote is None and stack and stack[-1][2] == "(":
            start, quote = stack.pop()[:2]
        i += 1
    return text[start:]


def _here_string(body, quoted):
    """heredoc 正文写成等价的 here-string 单词。带引号分隔符的正文是字面量；不带引号的正文按双引号串写，
    其中只有 `$`、反引号与对它们的 `\\` 转义起作用，`"` 和别的反斜杠是普通字符，要补转义。"""
    if quoted:
        return shlex.quote(body)
    out, i = ['"'], 0
    while i < len(body):
        c = body[i]
        if c == "\\" and body[i + 1:i + 2] in ("$", "`", "\\", "\n"):
            out.append(body[i:i + 2])
            i += 2
            continue
        if body.startswith("$(", i) or c == "`":
            # 展开内部是新的一层，引号照常是语法，原样保留
            if c == "$":
                end = _close_paren(body, i + 1)
            else:
                end = i + 1
                while end < len(body) and body[end] != "`":
                    end += 2 if body[end] == "\\" else 1
                end = end if end < len(body) else -1
            if end < 0:
                raise ValueError("命令展开未闭合")
            out.append(body[i:end + 1])
            i = end + 1
            continue
        out.append("\\" + c if c in '\\"' else c)
        i += 1
    return "".join(out) + '"'


def _heredoc_match(text, start):
    """只在活动 shell 语法中识别 heredoc，命令替换有独立的引号上下文。"""
    i, quote, stack = 0, None, []
    while i < len(text):
        c = text[i]
        if c == '\\' and quote != "'":
            i += 2
            continue
        if quote is None and text.startswith("$'", i):
            _, i = _ansi_c_string(text, i)
            continue
        if quote != "'" and (text.startswith('$((', i) or (quote is None and text.startswith('((', i))):
            end = _close_paren(text, i + (1 if c == '$' else 0))
            if end < 0:
                raise ValueError('算术展开未闭合')
            i = end + 1
            continue
        if quote != "'" and text.startswith('$(', i):
            stack.append(quote)
            quote = None
            i += 2
            continue
        if quote:
            if c == quote:
                quote = None
        elif c in "\"'":
            quote = c
        elif c == '#' and (i == 0 or text[i - 1] in ' \t\n;|&()'):
            end = text.find('\n', i)
            i = len(text) if end < 0 else end
            continue
        elif c == '(':
            stack.append(None)
        elif c == ')' and stack:
            quote = stack.pop()
        elif text.startswith('<<<', i):
            i += 3
            continue
        elif i >= start and text.startswith('<<', i) and not text.startswith('<<<', i):
            match = HEREDOC_OP.match(text, i)
            if not match or (match.end() < len(text) and text[match.end()] not in ' \t\r\n;|&<>()'):
                raise ValueError('无法完整解析 heredoc 分隔词，请使用独立的字面分隔词')
            return match
        i += 1
    return None


def _command_lines(lines, literal=False):
    """把 heredoc 折成可按普通命令判定的行序列：头行去掉 `<<分隔符` 后保留（`cat > 目标` 的重定向目标、前面的
    cd / 赋值 / 其他段照常判），正文由 cat 或 `git commit -F -` 承接、且承接者的输出没有经管道交出去时整段跳过
    （是数据），否则（`python3 - <<EOF`、`cat <<EOF | bash` 等）按命令行保留。没找到结束分隔符的不算 heredoc，
    那一行照常判。literal 供隐藏求值检查用：本要按命令行保留的正文，若 `<<` 所在最内层命令其实是 cat
    （`"$(cat <<'EOF' … EOF)"`）或 DATA_READER，或正文只因展开而保留，就按 bash 语义折成头行上的 here-string——
    bash 不把这种正文当脚本解析，撇号、括号只是字符；字面正文作为替换结果交给外层命令照常判。"""
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        prefix = '\n'.join(out) + ('\n' if out else '')
        active = _heredoc_match(prefix + line, len(prefix))
        m = HEREDOC_OP.match(line, active.start() - len(prefix)) if active else None
        if m:
            delim, j = m.group(2), i + 1
            while j < len(lines) and lines[j].strip() != delim:
                j += 1
            if j < len(lines):
                head, rest, body = line[:m.start()], line[m.end():], lines[i + 1:j]
                # 分隔符不带引号时 bash 会展开正文：里面的 $( ) 与反引号照样执行，正文就不再是纯数据
                expands = not m.group(1) and any(HEREDOC_EXPANDS.search(b) for b in body)
                piped = PIPE.search(_mask_quotes(rest))
                keep = expands or piped or not _owner_takes_data(head)
                if keep and literal and not piped and _owner_takes_data(_innermost_command(head), readers=True):
                    out.append(head + " <<<" + _here_string("\n".join(body), m.group(1)) + " " + rest)
                else:
                    out.append(head + " " + rest)
                    if keep:
                        out.extend(body)
                i = j + 1
                continue
        out.append(line)
        i += 1
    return out


def _mask_quotes(text):
    """引号里的字符与反斜杠转义换成 x、长度不变：在掩码上找引号外的结构，再按下标回原文取。"""
    out, i, n, quote = [], 0, len(text), None
    while i < n:
        c = text[i]
        if c == "\\" and quote != "'" and i + 1 < n:
            out.append("xx")
            i += 2
            continue
        if quote:
            out.append(c if c == quote else "x")
            if c == quote:
                quote = None
        else:
            if c in ("'", '"'):
                quote = c
            out.append(c)
        i += 1
    return "".join(out)


def _strip_redirects(seg):
    """去掉引号外的重定向与目标，引号里的 > < 原样保留。"""
    masked, out, last = _mask_quotes(seg), [], 0
    for m in ANY_REDIRECT.finditer(masked):
        out.append(seg[last:m.start()] + " ")
        last = m.end()
    return "".join(out) + seg[last:]


def _sed_script(script):
    """解析一段 sed 脚本，返回 (是否执行命令, w / W 写到的文件名)；看不懂的语法抛 ValueError，调用方按写处理。
    认 GNU sed 的紧贴写法：`s/a/b/w文件`、`1w文件`、`1e命令` 不要求空白；替换文本、正则里的 w / e 不算。
    `()` 是命令替换的占位，只认它整个当一个地址
    （`sed -n "$(grep -n … | cut …),+18p"` 这类排查）；落在命令位置就看不懂，按写。"""
    n, i, execs, files = len(script), 0, False, []

    def ws(k):
        while k < n and script[k] in " \t":
            k += 1
        return k

    def eol(k):
        e = script.find("\n", k)
        return n if e < 0 else e

    def past(k, d):
        """从 k 起跳到分隔符 d 之后（反斜杠转义连同下一个字符跳过）。"""
        while k < n:
            if script[k] == "\\":
                k += 2
            elif script[k] == d:
                return k + 1
            else:
                k += 1
        raise ValueError("分隔符没闭合")

    def address(k):
        if script.startswith("()", k):
            return k + 2
        if k < n and script[k].isdigit():
            while k < n and (script[k].isdigit() or script[k] == "~"):
                k += 1
            return k
        if k < n and script[k] == "$":
            return k + 1
        if k < n and script[k] == "/":
            k = past(k + 1, "/")
        elif k + 1 < n and script[k] == "\\":
            k = past(k + 2, script[k + 1])
        else:
            return None
        while k < n and script[k] in "IM":
            k += 1
        return k

    while True:
        while i < n and script[i] in " \t\n;":
            i += 1
        if i >= n:
            return execs, files
        a = address(i)
        if a is not None:
            i = ws(a)
            if i < n and script[i] == ",":
                i = ws(i + 1)
                if i < n and script[i] in "+~":
                    i += 1
                    while i < n and script[i].isdigit():
                        i += 1
                else:
                    a = address(i)
                    if a is None:
                        raise ValueError("缺第二个地址")
                    i = a
            i = ws(i)
            while i < n and script[i] == "!":
                i = ws(i + 1)
            if i >= n:
                raise ValueError("地址后面没有命令")
        c = script[i]
        i += 1
        if c in "{}=dDgGhHnNpPxzF":
            continue
        if c in "wW":
            e = eol(i)
            files.append(script[i:e].strip())
            i = e
        elif c == "e":
            execs = True
            i = eol(i)
        elif c in "aic":
            e = eol(i)
            while e < n and script[i:e].rstrip().endswith("\\"):  # `a\` 续行：下一行仍是文本
                i = e + 1
                e = eol(i)
            i = e
        elif c in "rR#":
            i = eol(i)
        elif c in "btT:v":  # GNU：标签到 ; 或换行为止
            while i < n and script[i] not in ";\n":
                i += 1
        elif c in "lLqQ":
            i = ws(i)
            while i < n and script[i].isdigit():
                i += 1
        elif c in "sy":
            if i >= n or script[i] in "\n\\":
                raise ValueError("s / y 缺分隔符")
            i = past(past(i + 1, script[i]), script[i])
            if c == "s":
                while i < n and script[i] in "gpiImMe0123456789":
                    execs = execs or script[i] == "e"
                    i += 1
                if i < n and script[i] == "w":
                    e = eol(i + 1)
                    files.append(script[i + 1:e].strip())
                    i = e
        else:
            raise ValueError("看不懂的 sed 命令 " + c)


def _sed_effects(core):
    """sed 这一段：返回 (是否只读, w / W 写到的文件)。带 -i / --in-place / -f、脚本里有 w / W / e、脚本看不懂、
    命令替换的占位落在脚本之外（`sed -e 1p $(echo -i) 文件`：替换出来的可能是选项）都不算只读；w 到 /dev/stdout、
    /dev/stderr 不落盘。旧白名单只认 `sed -n` 开头：不带 -n 的过滤（`| sed 's/^/  /'`）被当写，`sed -n -i …` 却被当只读放行。"""
    try:
        args = shlex.split(core)[1:]
    except ValueError:
        return False, []
    scripts, positional, expr, i = [], [], False, 0
    while i < len(args):
        a = args[i]
        if a == "--":
            positional += args[i + 1:]
            break
        if a.startswith("--"):
            name, eq, val = a[2:].partition("=")
            # getopt 认无歧义的长选项前缀：--in 就是 --in-place
            if name and ("in-place".startswith(name) or "file".startswith(name)):
                return False, []
            if name and "expression".startswith(name):
                expr = True
                if eq:
                    scripts.append(val)
                elif i + 1 < len(args):
                    i += 1
                    scripts.append(args[i])
            i += 1
            continue
        if a.startswith("-") and len(a) > 1:
            for j, ch in enumerate(a[1:], 1):
                if ch in "if":
                    return False, []
                if ch == "e":
                    expr = True
                    if a[j + 1:]:
                        scripts.append(a[j + 1:])
                    elif i + 1 < len(args):
                        i += 1
                        scripts.append(args[i])
                    break
                if ch == "l":
                    if not a[j + 1:]:
                        i += 1
                    break
                if ch not in "nErsuz":
                    return False, []
            i += 1
            continue
        positional.append(a)
        i += 1
    if not expr and positional:
        scripts.append(positional.pop(0))
    if any("()" in p for p in positional):
        return False, []
    execs, files = False, []
    for s in scripts:
        try:
            e, f = _sed_script(s)
        except ValueError:
            return False, files
        execs = execs or e
        files += f
    files = [f for f in files if f not in SED_SPECIAL_FILES]
    return not execs and not files, files


def _sort_outputs(core):
    """解析有界的 sort 选项语法；附着值、短选项组合与分离值使用同一条路径。"""
    args = shlex.split(core)[1:]
    files, i = [], 0
    no_value = {'ignore-leading-blanks', 'dictionary-order', 'ignore-case', 'general-numeric-sort',
                'ignore-nonprinting', 'month-sort', 'human-numeric-sort', 'numeric-sort', 'random-sort',
                'reverse', 'version-sort', 'stable', 'unique', 'zero-terminated', 'merge', 'debug',
                'help', 'version'}
    with_value = {'output', 'temporary-directory', 'key', 'field-separator', 'buffer-size',
                  'sort', 'parallel', 'batch-size', 'random-source'}
    while i < len(args):
        word = args[i]
        i += 1
        if word == '--':
            break
        if word.startswith('--'):
            name, eq, value = word[2:].partition('=')
            if name in no_value or (name == 'check' and (not eq or value in {'quiet', 'silent', 'diagnose-first'})):
                continue
            if name not in with_value:
                raise ValueError('无法静态检查 sort 选项')
            if not eq:
                if i == len(args):
                    raise ValueError('sort 选项缺少参数')
                value, i = args[i], i + 1
            if name in {'output', 'temporary-directory'}:
                files.append(value)
        elif word.startswith('-') and word != '-':
            flags = word[1:]
            while flags:
                flag, flags = flags[0], flags[1:]
                if flag in 'otkST':
                    if flags:
                        value, flags = flags, ''
                    else:
                        if i == len(args):
                            raise ValueError('sort 选项缺少参数')
                        value, i = args[i], i + 1
                    if flag in 'oT':
                        files.append(value)
                elif flag not in 'bdfgiMhnRrVsucCmz':
                    raise ValueError('无法静态检查 sort 选项')
    return files


def _readonly_segment(core, raw=None):
    """raw 是按引号剥掉重定向的同一段：WRITE_REDIRECT 不认引号，`sed -n '/<a>/,/<\\/a>/p'` 里的 > 会被削掉半截，
    sed 的脚本要从 raw 里解析；raw 也去掉了输入重定向，`sed <in 's/…/w 文件'` 的 `<in` 不会顶替脚本的位置。"""
    core = SYS_BIN.sub("", core, count=1)
    if not READONLY_CMD.match(core):
        return False
    head = core.split(None, 1)[0]
    if head == "find" and FIND_WRITE.search(core):
        return False
    if head == "sort":
        return not _sort_outputs(raw or core)
    if head == "sed":
        return _sed_effects(SYS_BIN.sub("", raw, count=1) if raw else core)[0]
    if head == "xargs":
        rest = XARGS_OPTS.sub("", core[len("xargs"):], count=1).strip()
        return not rest or _readonly_segment(rest)
    if head == "git" and (GIT_OUTPUT.search(core) or GIT_CONFIG_FILE.search(core)):
        return False
    return True


def _subst_args_safe(core):
    """参数里有命令替换的占位时，这一段还算不算只读（前提是 _readonly_segment 已判只读）：见 ARG_SAFE_CMD；
    sed 的占位由 _sed_effects 按位置判过了。"""
    core = SYS_BIN.sub("", core, count=1)
    return bool(ARG_SAFE_CMD.match(core)) or core.split(None, 1)[:1] == ["sed"]


def _close_paren(text, j):
    """text[j] 是 '('：返回与之配对的 ')' 下标，找不到返回 -1。引号里的括号不算，反斜杠转义跳过。"""
    depth, i, n, quote = 0, j, len(text), None
    while i < n:
        c = text[i]
        if quote:
            if c == "\\" and quote == '"' and i + 1 < n:
                i += 2
                continue
            if c == quote:
                quote = None
        elif c == "\\" and i + 1 < n:
            i += 2
            continue
        elif c in ("'", '"'):
            quote = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def _lift_substitutions(text, inners):
    """把 `$( )` 命令替换抽进 inners、原位换成占位 __SUBSTk__，内层交给调用方按同一套规则递归判——之前 `$(` 一出现
    整条就不算只读，`sed -n "$(grep -n … | cut …),+18p" 文件` 这类纯读排查也被硬拦。`$(( ))` 算术整体换成 0，
    里面的 `$( )` 照样抽出来、占位跟在 0 后面（bash 只执行算术里的命令替换）。单引号里不是替换（bash 语义），原样保留。
    进程替换 `<( )` / `>( )` 同样抽出来判（只在引号外，双引号里它不展开）：之前从没被判过，`diff a <(sed -i … 文件)`
    按 diff 放行。返回 (新文本, 是否可疑)：有未闭合的 `$( )` 或引号没配对就算可疑——整条不算只读。"""
    out, i, n, quote = [], 0, len(text), None
    bad = False
    while i < n:
        c = text[i]
        if quote == "'":
            out.append(c)
            if c == "'":
                quote = None
            i += 1
            continue
        if c == "\\" and i + 1 < n:
            out.append(text[i:i + 2])
            i += 2
            continue
        if c == "'" and quote is None:
            quote = "'"
        elif c == '"':
            quote = None if quote == '"' else '"'
        elif c == "$" and i + 1 < n and text[i + 1] == "(":
            end = _close_paren(text, i + 1)
            if end < 0:
                out.append(text[i:])
                return "".join(out), True
            if text.startswith("((", i + 1) and text[end - 1] == ")":
                first = len(inners)
                _, sub_bad = _lift_substitutions(text[i + 3:end - 1], inners)
                bad = bad or sub_bad
                out.append("0" + "".join(f"__SUBST{k}__" for k in range(first, len(inners))))
            else:
                inners.append(text[i + 2:end])
                out.append(f"__SUBST{len(inners) - 1}__")
            i = end + 1
            continue
        elif quote is None and c in "<>" and i + 1 < n and text[i + 1] == "(":
            end = _close_paren(text, i + 1)
            if end < 0:
                out.append(text[i:])
                return "".join(out), True
            inners.append(text[i + 2:end])
            out.append(f"__SUBST{len(inners) - 1}__")
            i = end + 1
            continue
        out.append(c)
        i += 1
    return "".join(out), bad or quote is not None


def _backtick_commands(text):
    """引号外与双引号里的反引号命令替换的内层文本；单引号里的反引号是字面字符，反斜杠转义跳过。"""
    out, i, quote = [], 0, None
    while i < len(text):
        c = text[i]
        if quote == "'":
            if c == "'":
                quote = None
        elif c == "\\":
            i += 1
        elif c == "'" and quote is None:
            quote = c
        elif c == '"':
            quote = None if quote else c
        elif c == "`":
            end = i + 1
            while end < len(text) and text[end] != "`":
                end += 2 if text[end] == "\\" else 1
            if end >= len(text):
                break
            out.append(text[i + 1:end])
            i = end
        i += 1
    return out


def _ansi_c_string(text, start):
    """解码从 $' 开始的字面量并返回结束位置；NUL 截断值，但不截断引号边界扫描。"""
    escapes = {'a': '\a', 'b': '\b', 'e': '\x1b', 'E': '\x1b', 'f': '\f',
               'n': '\n', 'r': '\r', 't': '\t', 'v': '\v', '\\': '\\', "'": "'", '"': '"'}
    out, i = [], start + 2
    while i < len(text):
        c = text[i]
        if c == "'":
            return ''.join(out).split('\0', 1)[0], i + 1
        if c != '\\':
            out.append(c)
            i += 1
            continue
        i += 1
        if i >= len(text):
            break
        c = text[i]
        if c in escapes:
            out.append(escapes[c])
        elif c in '01234567':
            digits = re.match(r'[0-7]{1,3}', text[i:i + 3])[0]
            out.append(chr(int(digits, 8) & 255))
            i += len(digits) - 1
        elif c in 'xuU':
            width = {'x': 2, 'u': 4, 'U': 8}[c]
            digits = re.match(r'[0-9a-fA-F]+', text[i + 1:i + 1 + width])
            if digits:
                value = int(digits[0], 16)
                if value > 0x10ffff or 0xd800 <= value <= 0xdfff:
                    raise ValueError('无法解析 ANSI-C Unicode 字符')
                out.append(chr(value))
                i += len(digits[0])
            else:
                out.append('\\' + c)
        elif c == 'c':
            if i + 1 >= len(text) or text[i + 1] == "'":
                out.append('\\c')
            else:
                i += 1
                if not text[i].isascii():
                    raise ValueError('无法解析 ANSI-C 控制字符')
                out.append(chr(127 if text[i] == '?' else ord(text[i].upper()) & 31))
                if text[i:i + 2] == '\\\\':
                    i += 1
                elif text[i] == '\\' and i + 1 < len(text) and text[i + 1] in "\"'":
                    out.append(text[i + 1])
                    i += 1
        else:
            out.append('\\' + c)
        i += 1
    raise ValueError('ANSI-C 引号未闭合')


def _shell_eval_features(text):
    """返回隐藏命令替换与运行时求值特征；引号内的普通文字不充当语法，活动子命令递归检查。"""
    hidden, runtime = False, False
    code, i, quote = [], 0, None
    while i < len(text):
        c = text[i]
        if quote == "'":
            hidden = hidden or c == '`' or (text.startswith('$(', i) and not text.startswith('$((', i))
            if c == "'":
                quote = None
            code.append(c)
            i += 1
            continue
        if c == '\\' and i + 1 < len(text):
            hidden = hidden or text[i + 1] == '`' or bool(re.match(r'\$\\?\(', text[i + 1:]))
            # 引号外的转义字符等价地加引号，避免切段器把字面分隔符当作语法。
            if text[i + 1] != '\n':
                code.append(shlex.quote(text[i + 1]) if quote is None else text[i:i + 2])
            i += 2
            continue
        if quote is None and text.startswith("$'", i):
            value, i = _ansi_c_string(text, i)
            hidden = hidden or '`' in value or bool(re.search(r'\$\((?!\()', value))
            code.append(shlex.quote(value))
            continue
        if c == "'" and quote is None:
            quote = c
        elif c == '"':
            quote = None if quote else c
        elif c == '#' and quote is None and (i == 0 or text[i - 1] in ' \t\n;|&'):
            end = text.find('\n', i)
            i = len(text) if end < 0 else end
            continue
        elif text.startswith('$(', i) or (quote is None and text[i:i + 2] in ('<(', '>(')):
            end = _close_paren(text, i + 1)
            if end < 0:
                raise ValueError('命令展开未闭合')
            arithmetic = text.startswith('$((', i)
            if arithmetic and text[end - 1] != ')':
                raise ValueError('算术展开未闭合')
            sub_hidden, sub_runtime = _shell_eval_features(text[i + (3 if arithmetic else 2):end - (1 if arithmetic else 0)])
            hidden = hidden or sub_hidden
            runtime = runtime or arithmetic or sub_runtime
            code.append('x')
            i = end + 1
            continue
        elif c == '`':
            end = i + 1
            while end < len(text) and text[end] != '`':
                end += 2 if text[end] == '\\' else 1
            if end >= len(text):
                raise ValueError('命令展开未闭合')
            sub_hidden, sub_runtime = _shell_eval_features(text[i + 1:end])
            hidden = hidden or sub_hidden
            runtime = runtime or sub_runtime
            code.append('x')
            i = end + 1
            continue
        elif text.startswith('$[', i):
            runtime = True
        elif text.startswith('${', i):
            end = text.find('}', i + 2)
            if end < 0:
                raise ValueError('参数展开未闭合')
            # 普通变量的默认值运算符不做算术求值；默认值中的其他结构仍继续检查。
            parameter = re.sub(r'^[A-Za-z_]\w*:-', '', text[i + 2:end], count=1)
            runtime = runtime or any(ch in parameter for ch in '[:!')
        code.append(c)
        i += 1
    if quote is not None:
        raise ValueError('引号未闭合')
    outer = ''.join(code)
    hidden = hidden or any('`' in word or re.search(r'\$\((?!\()', word) for word in shlex.split(outer))
    visible = _mask_quotes(outer)
    runtime = runtime or bool(re.search(r'\(\(|\b\w+\[', visible))
    for segment in split_segments(outer):
        core = segment.lstrip('({ \t')
        if re.match(r'^\w+=', core) and ASSIGN.fullmatch(core):
            continue
        while True:
            stripped = PREFIX.sub('', core, count=1).strip()
            stripped = stripped.lstrip('({ \t')
            if stripped == core:
                break
            core = stripped
        words = shlex.split(core)
        while words and words[0] in ('command', 'builtin', 'exec'):
            words.pop(0)
        if not words:
            continue
        head = SYS_BIN.sub('', words[0], count=1)
        if head in ('eval', 'let', 'bash', 'sh', 'dash', 'zsh', 'ksh'):
            runtime = True
        elif head == 'unset':
            runtime = runtime or not words[1:] or any(not re.fullmatch(r'[A-Za-z_]\w*', word) for word in words[1:])
        elif head == '[[':
            runtime = runtime or any(word in ('-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-v', '-R') for word in words[1:])
        elif head in ('declare', 'typeset', 'local', 'readonly'):
            runtime = runtime or any(re.fullmatch(r'-[a-zA-Z]*[iaAn][a-zA-Z]*', word) for word in words[1:])
    return hidden, bool(runtime)


def has_hidden_shell_eval(command):
    """仅识别同一命令中的危险组合，不推断完整数据流，也不改变路径与只读分析。"""
    text = '\n'.join(_command_lines(command.splitlines(), literal=True))
    hidden, runtime = _shell_eval_features(text)
    return hidden and runtime


def find_roots(words):
    """只接受字面起点和不跟随链接的 -P；外部起点清单与跟随链接无法静态穷尽。"""
    if any(w in {'-H', '-L'} or w.split('=', 1)[0] == '-files0-from' for w in words[1:]):
        raise ValueError(STATIC_SHELL_ERROR)
    index = 1
    while index < len(words) and words[index] in {'-P', '--'}:
        index += 1
    if index < len(words) and words[index].startswith(('-O', '-D')):
        raise ValueError(STATIC_SHELL_ERROR)
    roots = []
    for word in words[index:]:
        if word.startswith('-') or word in {'(', ')', '!', ','}:
            break
        roots.append(word)
    return roots or ['.']


def _check_shell_assignments(words):
    assignments = words[1:] if words[:1] and words[0] in {'export', 'declare', 'typeset', 'readonly', 'local', 'env'} else words
    for word in assignments:
        if not re.match(r'^[A-Za-z_]\w*=', word):
            break
        if word.startswith('CDPATH=') and word != 'CDPATH=':
            raise ValueError('不支持在命令中设置非空 CDPATH，请使用明确目录')


def _check_shell_entry(words):
    if any((word.startswith(('-', '+')) and not word.startswith('--') and 'c' in word[1:])
           or '$' in word or '`' in word or SUBST_REF.search(word) for word in words[1:]):
        raise ValueError(STATIC_SHELL_ERROR)
    args = words[1:]
    if args in (['--help'], ['--version']):
        return
    while args and args[0].startswith(('-', '+')):
        option, args = args[0], args[1:]
        if option == '--':
            break
        if not option.startswith('--') and 's' in option[1:]:
            raise ValueError(STATIC_SHELL_ERROR)
        if option in {'-o', '+o', '-O', '+O', '--rcfile', '--init-file'}:
            args = args[1:]
    # 无明确脚本时 shell 会执行 stdin；重定向目标和 fd 路径也不能冒充脚本入口。
    if not args or re.match(r'^(?:\d*[<>]|-+$)', args[0]):
        raise ValueError(STATIC_SHELL_ERROR)
    script = os.path.normpath(args[0]).replace('\\', '/')
    if re.fullmatch(r'/(?:dev/(?:stdin|fd/\d+)|proc/(?:self|thread-self|\d+)/fd/\d+)', script):
        raise ValueError(STATIC_SHELL_ERROR)


def static_command_words(segment):
    """共享的保守语法边界：仅支持直接命令与已有可剥离包装，不推断循环和动态删除目标。"""
    segment, bad = _lift_substitutions(shell_literal_text(segment), [])
    if bad:
        raise ValueError(STATIC_SHELL_ERROR)
    visible = re.sub(r'\$\{[^}]*\}', 'x', _mask_quotes(_strip_comment(segment)))
    if re.search(r'[(){}]', visible):
        raise ValueError(STATIC_SHELL_ERROR)
    # 引号里的正则、find -name 模式与普通文本不做 shell 路径展开；test 的独立括号是语法。
    glob_text = re.sub(r'(?<!\S)\[\[?(?=\s)|(?<=\s)\]\]?(?!\S)', ' ', visible)
    if re.search(r'[*?\[]', glob_text):
        raise ValueError(STATIC_SHELL_ERROR)
    if not _strip_redirects(segment).strip():
        return []
    words = shlex.split(segment, comments=True)
    _check_shell_assignments(words)
    while words and re.match(r'^[A-Za-z_]\w*=', words[0]):
        words.pop(0)
    core = shlex.join(words)
    while words:
        if words[0] == '!':
            # `!` 只取反退出码，后面的命令照常在当前 shell 执行，cd、删除和变量规则同样适用。
            words = words[1:]
            continue
        name = SYS_BIN.sub('', words[0], count=1)
        _check_shell_assignments([name, *words[1:]])
        if not supported_shell_command(name):
            raise ValueError(STATIC_SHELL_ERROR)
        if name == 'eval':
            raise ValueError(STATIC_SHELL_ERROR)
        if name in {'bash', 'sh', 'dash', 'zsh', 'ksh'}:
            _check_shell_entry(words)
        if name in {'for', 'select', 'while', 'until', 'do', 'done', 'case', 'esac'}:
            raise ValueError(STATIC_SHELL_ERROR)
        if name in SHELL_WRAPPERS and name not in STATIC_WRAPPERS:
            raise ValueError(STATIC_SHELL_ERROR)
        if name in {'pushd', 'popd'}:
            raise ValueError(STATIC_SHELL_ERROR)
        if name == 'git' and any(w.startswith('-C') or w.split('=', 1)[0] in {'--git-dir', '--work-tree'} for w in words[1:]):
            raise ValueError(STATIC_SHELL_ERROR)
        if name == 'env':
            args = words[1:]
            while args and re.match(r'^[A-Za-z_]\w*=', args[0]):
                args = args[1:]
            if args and args[0].startswith('-'):
                raise ValueError(STATIC_SHELL_ERROR)
        if name in {'time', 'timeout'} and len(words) > 1 and words[1].startswith('-'):
            raise ValueError(STATIC_SHELL_ERROR)
        if name == 'nice' and len(words) > 1 and words[1].startswith('-') and not (
                words[1] == '-n' and len(words) > 3 and re.fullmatch(r'-?\d+', words[2])):
            raise ValueError(STATIC_SHELL_ERROR)
        if '$' in name or '`' in name or SUBST_REF.search(name):
            raise ValueError(STATIC_SHELL_ERROR)
        core = shlex.join([name, *words[1:]])
        stripped = PREFIX.sub('', core, count=1).strip()
        if stripped == core:
            break
        core = stripped
        words = shlex.split(core, comments=True)
    if words:
        words[0] = SYS_BIN.sub('', words[0], count=1)
        if words[0] == 'find':
            find_roots(words)
        if words[0] == 'cd' and (len(words) != 2 or words[1].startswith('-') or any(
                c in words[1] for c in ('$', '`', '__SUBST'))):
            raise ValueError(STATIC_SHELL_ERROR)
        deleting = words[0] in {'rm', 'find'} or (words[0] == 'git' and any(w in {'rm', 'clean'} for w in words[1:]))
        if (deleting or words[0] in {'source', '.'}) and any('$' in w or '`' in w or SUBST_REF.search(w) for w in words[1:]):
            raise ValueError(STATIC_SHELL_ERROR)
    return words


def _symlink_pairs(words, cwd):
    """只支持两个字面操作数和不改变落点语义的 ln 选项；链接位置以实际父目录为准。不带 -s 时是硬链接：
    源是已有的符号链接时拒绝（复制到别处后相对目标换了基准），否则不返回映射，按普通参数检查。"""
    reason = '无法静态检查 ln，请使用 -s/-f/-n、两个字面路径和已存在的父目录，复杂链接操作请拆成多条工具调用'
    flags, operands, options = set(), [], True
    names = {'--symbolic': 's', '--force': 'f', '--no-dereference': 'n'}
    for word in words[1:]:
        if not word or any(c in word for c in ('$', '`', '\\', "'", '"')) or SUBST_REF.search(word):
            raise ValueError(reason)
        if options and word == '--':
            options = False
        elif options and word.startswith('--'):
            if word not in names:
                raise ValueError(reason)
            flags.add(names[word])
        elif options and word.startswith('-') and word != '-':
            if any(c not in 'sfn' for c in word[1:]):
                raise ValueError(reason)
            flags.update(word[1:])
        else:
            operands.append(word)
    if 's' not in flags:
        if any(os.path.islink(os.path.join(cwd or os.getcwd(), windows_path(p)))
               for p in (operands[:-1] if len(operands) > 1 else operands)):
            raise ValueError('无法确认硬链接复制符号链接后的落点，请直接创建字面目标的符号链接')
        return []
    if len(operands) != 2 or any(p.startswith('~') for p in operands):
        raise ValueError(reason)
    target, name = map(windows_path, operands)
    raw = os.path.join(cwd or os.getcwd(), name)
    parent, leaf = os.path.split(raw)
    if not leaf or leaf in ('.', '..') or not path_is_dir(parent):
        raise ValueError(reason)
    if path_is_dir(raw) and not ('n' in flags and os.path.islink(raw)):
        raise ValueError(reason)
    parent = os.path.realpath(parent)
    # 先挂到父目录，避免以 '-' 开头的字面目标被当成选项；目标的 .. 仍按内核语义解析。
    # 保留原始链接位置，不能因提前解析旧父链接而抹掉它对本命令其他链接的依赖。
    return [(raw, os.path.join(parent, target))]


def _linked_paths(paths, links, changes=(), os_name=None):
    """对本命令的新链接补入具体子路径；只处理互不依赖的映射，不模拟链接链或命令执行顺序。"""
    if not links:
        return []
    module = ntpath if (os_name or os.name) == 'nt' else posixpath
    reason = '同一命令中的链接相互依赖、被重复改写或落点无法确定，请拆成多条工具调用'
    if None in changes or None in paths:
        raise ValueError(reason)
    mapping, spellings = {}, {}
    for source, target in links:
        source = module.normcase(module.join(module.realpath(module.dirname(source)), module.basename(source)))
        spellings.setdefault(source, set()).add(module.normpath(target))
        # 字面与物理路径是两个策略候选，不是两次改写；映射只有一个实际目标。
        target = module.realpath(target)
        if source in mapping and mapping[source] != target:
            raise ValueError(reason)
        mapping[source] = target
    if len(mapping) > STATE_LIMIT:
        raise ValueError('同一命令中的链接过多，请拆成多条工具调用')

    def inside(path, parent):
        path, parent = module.normcase(path), module.normcase(parent)
        return path == parent or path.startswith(parent.rstrip(module.sep) + module.sep)

    def follow(path, forbid=False, depth=0):
        if depth > STATE_LIMIT:
            raise ValueError(reason)
        drive, rest = module.splitdrive(path)
        if module.altsep:
            rest = rest.replace(module.altsep, module.sep)
        parts = [part for part in rest.split(module.sep) if part not in ('', '.')]
        prefix = drive + module.sep
        for index, part in enumerate(parts):
            prefix = module.normpath(module.join(prefix, part))
            source = module.normcase(prefix)
            if source in mapping:
                suffix = parts[index + 1:]
                if forbid or '..' in suffix:
                    raise ValueError(reason)
                return module.normpath(module.join(mapping[source], *suffix)), (source, suffix)
            # 逐个跟随已有链接：一次 realpath 会跳过中途经过、但即将被改写的链接。
            if module.islink(prefix) or (getattr(module, 'isjunction', lambda p: False)(prefix)):
                target = os.readlink(prefix)
                if module is ntpath and target.startswith('\\\\?\\'):
                    target = '\\\\' + target[8:] if target[4:8] == 'UNC\\' else target[4:]
                prefix, _ = follow(module.join(module.dirname(prefix), target), forbid=True, depth=depth + 1)
        return prefix, None

    for source, target in links:
        follow(module.dirname(source), forbid=True)
        follow(target, forbid=True)

    for source, target in mapping.items():
        for other in mapping:
            if (source != other and (inside(source, other) or inside(other, source))) or any(
                    inside(path, other) or inside(other, path) for path in (target, module.realpath(target))):
                raise ValueError(reason)
        for change in changes:
            physical = module.join(module.realpath(module.dirname(change)), module.basename(change))
            resolved, _ = follow(change, forbid=True)
            if any(inside(path, place) or inside(place, path)
                   for path in (change, physical, resolved) for place in (source, target)):
                raise ValueError(reason)

    found = []
    for path in dict.fromkeys(paths):
        resolved, mapped = follow(path)
        if mapped:
            found.append(resolved)
            source, suffix = mapped
            found += [module.normpath(module.join(target, *suffix)) for target in sorted(spellings[source])]
    return list(dict.fromkeys(found))


def _analyze(command, cwd, env, link_state=None):
    """返回 (写目标, 其余 token, 是否确认只读)。写目标包括重定向目标、sed/sort 的输出文件、`ln -s` 的链接目标，
    以及同一命令经新链接访问的具体子路径，整条命令只读时也保留、按编辑检查。每段在它可能所在的每个目录与变量组合下各取一次候选（见
    command_states）。`$( )` 的内层用外层走到那一段时的 cwd 与变量递归判定：
    内层的重定向目标照样是候选，内层不只读整条就不只读；命令替换的结果当重定向目标时解不开，按不只读处理。"""
    outer = link_state is None
    links, accesses, changes = link_state if link_state is not None else ([], [], [])

    def paths(cur, tok):
        # 保留尚未合并 .. 的访问路径，供最外层统一匹配新链接；命令替换与管道也共享这份保守候选。
        raw = windows_path(tok)
        if '$' in raw or '`' in raw or SUBST_REF.search(raw) or raw.startswith('~'):
            accesses.append(None)
        elif raw:
            accesses.append(raw if is_absolute(raw) else os.path.join(cur or os.getcwd(), raw))
        return _shell_paths(cur, tok)

    text = "\n".join(_command_lines(command.split("\n"), literal=True))
    inners = []
    text, bad = _lift_substitutions(text, inners)
    readonly = not _backtick_commands(text) and not bad
    targets, tokens = [], []
    for seg, cur, env in command_states(text, cwd, env):
        parsed = static_command_words(seg)
        changes_kind = parsed[:1] in (['mkdir'], ['rmdir'], ['mv'], ['rm'], ['cp'], ['install'])
        if parsed[:1] == ['ln']:
            pairs = _symlink_pairs(static_command_words(_strip_redirects(seg)), cur)
            links += pairs
            targets += [p for _, target in pairs for p in paths('', target)]
            changes_kind = not pairs
        if changes_kind and any('$' in w or '`' in w or SUBST_REF.search(w) for w in parsed[1:]):
            changes.append(None)
        seg = _expand(_strip_comment(seg), env)
        for k in SUBST_REF.findall(seg):
            sub_targets, sub_tokens, sub_ro = _analyze(inners[int(k)], cur, dict(env), (links, accesses, changes))
            targets += sub_targets
            tokens += sub_tokens
            readonly = readonly and sub_ro
        for inner in _backtick_commands(seg):
            sub_targets, sub_tokens, sub_ro = _analyze(inner, cur, dict(env), (links, accesses, changes))
            targets += sub_targets
            tokens += sub_tokens
            readonly = readonly and sub_ro
        seg = HARMLESS_REDIRECT.sub(" ", seg)
        raw = shlex.join(static_command_words(_strip_redirects(seg)))
        raw = SUBST_REF.sub("()", raw)
        for m in WRITE_REDIRECT.finditer(_mask_quotes(seg)):
            parser = shlex.shlex(seg[m.start(1):], posix=True, punctuation_chars='<>')
            parser.whitespace_split = True
            target = parser.get_token()
            if not target:
                raise ValueError(STATIC_SHELL_ERROR)
            if "$" in target or SUBST_REF.search(target):
                raise ValueError(STATIC_SHELL_ERROR)
            targets += paths(cur, SUBST_REF.sub("()", target))
        decoded = shlex.split(seg, comments=True)
        seg = _strip_redirects(seg)
        # 命令本身（剥掉 env 前缀之后）的参数里有没有替换：替换出来的可能是写选项或脚本，见 ARG_SAFE_CMD
        had_subst = bool(SUBST_REF.search(PREFIX.sub("", PREFIX.sub("", seg).strip()).strip()))
        # sed 的 w 文件名常紧贴在脚本里（`s/a/b/w文件`），TOKEN 抠不出来，解析出来单独当写候选
        sed_core = SYS_BIN.sub("", raw, count=1)
        if sed_core.split(None, 1)[:1] == ["sed"]:
            targets += [p for f in _sed_effects(sed_core)[1] for p in paths(cur, f)]
        elif sed_core.split(None, 1)[:1] == ["sort"]:
            targets += [p for f in _sort_outputs(sed_core) for p in paths(cur, f)]
        # 占位换成 TOKEN 抠不出的 `()`：既不冒充路径，当首词时也不在只读白名单里（跑的是替换出来的命令，说不清）
        seg = SUBST_REF.sub("()", seg)
        if ">" in _mask_quotes(seg):
            readonly = False
        am = ASSIGN.match(seg.strip())
        core = raw
        if parsed[:1] == ['cd']:
            tokens += paths(cur, parsed[1])
        elif not am and core and not NEUTRAL_CMD.match(core) and not (
                _readonly_segment(core, raw) and (not had_subst or _subst_args_safe(core))):
            readonly = False
        # 先做 shell 引号去除和反斜杠解码，再取候选；不能把 shell 转义误当路径分隔符。
        for word in ([] if parsed[:1] in (['echo'], ['printf']) else decoded):
            for tok in dict.fromkeys([word, *TOKEN.findall(_dequote(word))]):
                found = paths(cur, tok)
                tokens += found
                if changes_kind:
                    changes += [p for p in found if os.path.isabs(p)]
    if outer:
        targets += _linked_paths(accesses, links, changes)
    return targets, tokens, readonly


def command_paths(command, cwd="", include_readonly=False):
    """命令串里可能被写的路径候选（去重、保序）；整条命令确认只读时只剩重定向的目标（含 cat heredoc 的目标），
    include_readonly=True 则只读命令的 token 也保留（给规则加载用，不给护栏用）。"""
    targets, tokens, readonly = _analyze(command, cwd, {})
    found = targets if (readonly and not include_readonly) else targets + tokens
    return list(dict.fromkeys(t for t in found if t))


def candidates(tool_input, cwd="", include_readonly=False):
    """返回 (候选路径列表, 是否来自命令串)。Edit/Write 的 file_path 直接就是候选。"""
    if "file_paths" in tool_input:
        return [_resolve(cwd, path) for path in tool_input["file_paths"]], False
    path = str(tool_input.get("file_path", "") or "")
    if path:
        return [_resolve(cwd, path)], False
    command = str(tool_input.get("command", "") or "")
    if command:
        return command_paths(command, cwd, include_readonly), True
    return [], False


def candidates_from(data, include_readonly=False):
    """Resolve native paths from the operation's Location and actual workdir."""
    tool_input = data['input']
    cwd = data['directory']
    if tool_input.get('workdir'):
        cwd = tool_path(cwd, tool_input['workdir'])
    explicit = [_resolve(cwd, path) for path in data['paths']]
    inferred, via_command = candidates(tool_input, cwd, include_readonly)
    return list(dict.fromkeys(explicit + inferred)), via_command
