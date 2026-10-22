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
语义按 bash：赋值只对其后的段生效，命令前的环境前缀 `X=1 cmd` 不是 shell 变量；解不开的变量原样保留、
整条退回逐 token 判。

相对路径按中性事件的 directory 和原生 input.workdir 解析；workdir 相对会话 Location。
没有 workdir 时使用 directory。命令里的 `cd X` 会把
后续各段的相对路径挂到 X 下，覆盖 `cd vendor && sed -i … src/file.js`。

多跑一轮的代价是两秒静默；漏跑一次的代价是一个不生效的护栏静默留在仓库里。
只读白名单只此一份：inspect-paths.py 与各 pre-* 守卫都 import 这里。
inspect-paths.py 传 include_readonly=True，由原生插件发现 scope 并补充 context；规则加载的口径是
「读到就该加载」，不是护栏，只读命令的 token 也要。
"""
import os
import re
import shlex

# 命令串里的候选 token：空白 / 引号 / 重定向 / 分隔符 / 等号 / 括号 / 反引号之外的连续串。
# 排掉 = 是为了 `f=src/x.java; printf … > $f` 这种赋值形态。
TOKEN = re.compile(r"[^\s'\"<>|;&=()`]+")

# 确认只读的段首词。找不到写入形态的才进这张表：tee / python3 -c / node -e / npx / eslint 一类都不在——它们能写、
# 或能带 --fix。find / sort / awk / sed / xargs / git 另有写形态，见下面几条。
# git 只收不碰工作区文件的子命令：add / commit / tag / branch / fetch 只动 .git（索引、对象、引用），而守卫护的是工作区里的
# vendor / 协议产物 / env——`git add` 生成的协议产物曾被 pre-guard-legal 当成直改产物拦下，实现者只能按目录 add。
# checkout / restore / reset / stash / merge / rebase / apply / clean / rm / mv 会改工作区，不在表里；`-c k=v` / `-C 目录`
# 这类全局选项可以夹在 git 与子命令之间（`git -c core.quotepath=off grep` 是本仓库的常见写法）。
READONLY_CMD = re.compile(
    r"^(?:cat|head|tail|less|more|wc|file|stat|ls|tree|du|df|pwd|date|type|which|command|read"
    r"|grep|rg|egrep|fgrep|diff|cmp|comm|sort|uniq|cut|tr|nl|od|xxd|strings|column"
    r"|md5sum|sha1sum|sha256sum|sha512sum|cksum|jq|echo|printf|test|\[|true|false"
    r"|readlink|realpath|basename|dirname|sed|awk|find|xargs"
    r"|ss|ps|pgrep|lsof|id|uname|hostname|whoami|nproc|free|uptime|sleep"
    r"|docker\s+(?:ps|logs|inspect|images|port|version|info)"
    r"|git(?:\s+(?:-c\s+\S+|-C\s+\S+|--no-pager|-P|--no-optional-locks))*\s+(?:diff|log|show|status|blame|grep"
    r"|ls-files|ls-tree|rev-parse|describe|cat-file|check-ignore|add|commit|merge-base|tag|branch|rev-list"
    r"|reflog|shortlog|show-ref|for-each-ref|name-rev|count-objects|range-diff|cherry|remote|config|fetch"
    r"|worktree\s+list|stash\s+(?:list|show))"
    r")(?=\s|$)")
FIND_WRITE = re.compile(r"\s-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)(?=\s|$)")
SORT_WRITE = re.compile(r"\s(?:-o|--output)(?=\s|=)")
AWK_WRITE = re.compile(r"\bsystem\s*\(")
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
    if tok.startswith("/") or DRIVE_ABSOLUTE.match(tok):
        return os.path.normpath(tok)
    if not cur:
        return tok
    return os.path.normpath(os.path.join(cur, tok))


def _cd(cur, target):
    target = os.path.expanduser(windows_path(_dequote(target.replace("\\", "/"))))
    if target.startswith("/") or DRIVE_ABSOLUTE.match(target) or not cur:
        return target
    return os.path.normpath(os.path.join(cur, target))


def split_segments(text):
    """按 ; | || && & 与换行切段，引号内不切；`2>&1` / `&>` 里的 & 不是分隔符；反斜杠续行接回上一行。"""
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
        if c == "&" and ((buf and buf[-1] in "<>") or (i + 1 < n and text[i + 1] == ">")):
            buf.append(c)
            i += 1
            continue
        if c in ";|&\n":
            segs.append("".join(buf))
            buf = []
            i += 1
            while i < n and text[i] in ";|&":
                i += 1
            continue
        buf.append(c)
        i += 1
    segs.append("".join(buf))
    return [s.strip() for s in segs if s.strip()]


def _owner_takes_data(line, pos):
    """`<<` 所在那一段是不是把正文当数据：首词是 cat，或者是 `git commit -F -`（正文是提交信息）。
    取运算符之前的文本按分隔符切段取最后一段，剥掉 time / env / if 之类包装再看。"""
    segs = split_segments(line[:pos])
    core = segs[-1] if segs else ""
    core = PREFIX.sub("", core).strip()
    core = PREFIX.sub("", core).strip()
    if not core:
        return False
    return core.split(None, 1)[0] == "cat" or bool(GIT_COMMIT_STDIN.match(core))


def _command_lines(lines):
    """把 heredoc 折成可按普通命令判定的行序列：头行去掉 `<<分隔符` 后保留（`cat > 目标` 的重定向目标、前面的
    cd / 赋值 / 其他段照常判），正文由 cat 或 `git commit -F -` 承接、且承接者的输出没有经管道交出去时整段跳过
    （是数据），否则（`python3 - <<EOF`、`cat <<EOF | bash` 等）按命令行保留。没找到结束分隔符的不算 heredoc，
    那一行照常判。"""
    out, i = [], 0
    while i < len(lines):
        line = lines[i]
        m = HEREDOC_OP.search(line)
        if m:
            delim, j = m.group(2), i + 1
            while j < len(lines) and lines[j].strip() != delim:
                j += 1
            if j < len(lines):
                out.append(line[:m.start()] + " " + line[m.end():])
                body = lines[i + 1:j]
                # 分隔符不带引号时 bash 会展开正文：里面的 $( ) 与反引号照样执行，正文就不再是纯数据
                expands = not m.group(1) and any(HEREDOC_EXPANDS.search(b) for b in body)
                if expands or not _owner_takes_data(line, m.start()) or PIPE.search(_mask_quotes(line[m.end():])):
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


def _readonly_segment(core, raw=None):
    """raw 是按引号剥掉重定向的同一段：WRITE_REDIRECT 不认引号，`sed -n '/<a>/,/<\\/a>/p'` 里的 > 会被削掉半截，
    sed 的脚本要从 raw 里解析；raw 也去掉了输入重定向，`sed <in 's/…/w 文件'` 的 `<in` 不会顶替脚本的位置。"""
    core = SYS_BIN.sub("", core, count=1)
    if not READONLY_CMD.match(core):
        return False
    head = core.split(None, 1)[0]
    if head == "find" and FIND_WRITE.search(core):
        return False
    if head == "sort" and SORT_WRITE.search(core):
        return False
    if head == "awk" and AWK_WRITE.search(core):
        return False
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


def _analyze(command, cwd, env):
    """返回 (重定向目标, 其余 token, 是否确认只读)。`$( )` 的内层用外层走到那一段时的 cwd 与变量递归判定：
    内层的重定向目标照样是候选，内层不只读整条就不只读；命令替换的结果当重定向目标时解不开，按不只读处理。"""
    text = "\n".join(_command_lines(command.split("\n")))
    inners = []
    text, bad = _lift_substitutions(text, inners)
    readonly = "`" not in text and not bad
    cur = cwd or ""
    targets, tokens = [], []
    for seg in split_segments(text):
        seg = _expand(_strip_comment(seg), env)
        for k in SUBST_REF.findall(seg):
            sub_targets, sub_tokens, sub_ro = _analyze(inners[int(k)], cur, dict(env))
            targets += sub_targets
            tokens += sub_tokens
            readonly = readonly and sub_ro
        seg = HARMLESS_REDIRECT.sub(" ", seg)
        raw = PREFIX.sub("", PREFIX.sub("", _strip_redirects(SUBST_REF.sub("()", seg))).strip()).strip()
        for m in WRITE_REDIRECT.finditer(seg):
            if "$" in m.group(1) or SUBST_REF.search(m.group(1)):
                readonly = False  # 目标是解不开的变量或命令替换，退回逐 token 判
            targets.append(_resolve(cur, SUBST_REF.sub("()", m.group(1))))
        seg = WRITE_REDIRECT.sub(" ", seg)
        # 命令本身（剥掉 env 前缀之后）的参数里有没有替换：替换出来的可能是写选项或脚本，见 ARG_SAFE_CMD
        had_subst = bool(SUBST_REF.search(PREFIX.sub("", PREFIX.sub("", seg).strip()).strip()))
        # sed 的 w 文件名常紧贴在脚本里（`s/a/b/w文件`），TOKEN 抠不出来，解析出来单独当写候选
        sed_core = SYS_BIN.sub("", raw, count=1)
        if sed_core.split(None, 1)[:1] == ["sed"]:
            targets += [_resolve(cur, f) for f in _sed_effects(sed_core)[1]]
        # 占位换成 TOKEN 抠不出的 `()`：既不冒充路径，当首词时也不在只读白名单里（跑的是替换出来的命令，说不清）
        seg = SUBST_REF.sub("()", seg)
        if ">" in seg:
            readonly = False
        am = ASSIGN.match(seg.strip())
        core = PREFIX.sub("", seg).strip()
        core = PREFIX.sub("", core).strip()
        m = CD_CMD.match(core)
        if m:
            tokens.append(_resolve(cur, m.group(1)))
            cur = _cd(cur, m.group(1))
        elif am:
            for pm in ASSIGN_PAIR.finditer(am.group(1)):
                _assign(env, pm.group(1), pm.group(2))
        elif core and not NEUTRAL_CMD.match(core) and not (
                _readonly_segment(core, raw) and (not had_subst or _subst_args_safe(core))):
            readonly = False
        for tok in TOKEN.findall(_dequote(seg)):
            tokens.append(_resolve(cur, tok))
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
        cwd = _resolve(cwd, tool_input['workdir'])
    explicit = [_resolve(cwd, path) for path in data['paths']]
    inferred, via_command = candidates(tool_input, cwd, include_readonly)
    return list(dict.fromkeys(explicit + inferred)), via_command
