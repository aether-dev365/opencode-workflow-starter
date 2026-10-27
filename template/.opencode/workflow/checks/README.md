# 检查协议与回归

宿主 shell 采用明确支持集：仅接受 Bash（Windows 上接受 Git Bash 的 bash.exe），fish、nu、zsh、sh 等其他解释器以及缺失/空 shell 均拒绝；Windows 的 WSL bash.exe 启动器也拒绝。请在 opencode.jsonc 中设置 `"shell": "bash"`。shell 创建前总会核对解释器，工具调用的审批缓存不豁免这项检查；doctor 使用同一支持边界。

首命令采用明确支持集（hooklib.py 的 DIRECT_COMMANDS），未知 CLI、未知包装和含有后续命令的前置重定向结构默认拒绝，不靠不断扩充包装黑名单。单独重定向仍按目标路径检查。保留列明的文件命令，以及 Node/Python/npm、Git、常见构建工具和 shell 等开发入口；未登记的自定义 CLI 需要先审计其执行形态。`eval` 与 bash/sh/dash/zsh/ksh 的 `-c` 字符串执行模式（含 `-lc` 等组合）直接拒绝，字面字符串也不例外；shell 参数含动态变量或命令替换时同样拒绝，请改写成直接命令。shell 必须指定明确的脚本入口（或仅查询 `--help`、`--version`），不允许通过管道、here-string、重定向、`-s`、`-` 或 stdin/fd 路径把字符串当作脚本执行。`bash scripts/check.sh` 这样的脚本入口保留，但脚本或程序自身的逻辑仍不是系统沙盒。

从项目根执行 `bash .opencode/workflow/checks/run-tests.sh`。Windows 的 PowerShell 中执行 `py -3 -m unittest discover -s .opencode/workflow/checks -t .opencode/workflow/checks -p "test_*.py"`，依赖 bash 逻辑目录与目录符号链接的 3 个用例会跳过。测试使用临时 Git 仓库和合成凭据，凭据测试必须安装固定版 Gitleaks，缺失不会算作跳过通过。

输入为 stdin JSON：`version:1`，phase 为 before/inspect/after，绝对 directory、sessionId、callId、tool、input、paths 必填。输出为 JSON 的 allow/deny/ask、可选 reason/input 和 reminders。拒绝退出 2，正常退出 0。插件将无效输出、超时和非预期退出视为失败。

插件每次只启动一个检查进程：`run-checks.py` 的输入为上述事件加 `checks` 名称列表，inspect-paths 的结果放在输出的 `inspect` 中；守卫按 pre-guard-paths、pre-secret-scan、pre-bash-pipefail 的顺序运行，前一个改写的 input 交给下一个，遇到第一个拒绝即停止。各脚本仍可单独运行，协议不变。

守卫和插件启动 Git、Gitleaks 和 Python 启动器时，只在 PATH 的绝对目录中查找，不查当前目录、PATH 的空项和 `.` 一类相对项：Windows 默认会先查当前目录，macOS 和 Linux 在 PATH 有空项时也会查，项目根里放置的同名程序因此不会被执行。`taskkill.exe`、`cmd.exe` 固定取自 `%SystemRoot%\System32`，经 `cmd.exe` 启动的 `.cmd` 启动器也不再先查当前目录。这些工具要以绝对路径登记在 PATH 中。PATH 里本身位于项目内的目录（例如激活的 `.venv`、经 npm 脚本启动时的 `node_modules/.bin`）仍会被查找，其中的同名程序不在这项保护范围内。

保护规则来自 `protection.json`，按顺序最后命中生效，路径中只有 `*`、`?` 为通配符。插件还在原生权限边界检查规范化后的路径。shell 解析覆盖字面路径、cd、常见写命令、数据 heredoc 和部分命令替换；不是执行任意程序的系统沙盒。

命令参数按候选路径检查：守卫和插件会查询它是否存在、是否目录、是否保护配置的硬链接，查询出错时拒绝。参数中有一段超过文件名上限（如长提交说明、长 `python3 -c`）时，只要整条路径短于系统上限或该段超过 255 个字符，就按不存在处理，字面路径的保护规则照常生效；整条路径超过系统上限（Linux 4096、macOS 1024 字节）而无法确定时拒绝，长文本改用文件或标准输入传入，例如 `git commit -F -`。拒绝原因中的超长路径只显示首尾。

`.opencode/workflow/protection.json` 另由守卫和插件内置为代理只读，不依赖该文件自己的规则；修复模式也不例外，没有询问放行入口。修改、合并或修复保护配置需由用户在 OpenCode 之外完成。替换父目录、补丁删除或重命名、通过链接编辑同样拒绝；不锁定插件和守卫代码，仍可按升级流程更新它们。

路径守卫对所有代理拒绝可识别的隐藏命令替换与运行时求值组合，分析出错时拒绝，并提示改写成直接的命令。仅含命令替换字样的普通文本或普通算术不会因此被拒绝。运行时才构造出来的命令（例如先写进文件再执行）无法静态分析，守卫只拒绝能识别的形式；原生 shell 规则只检查解析器识别出的命令，不是可靠的权限边界。

静态分析不支持子 shell、命令分组、循环、动态删除目标及 sudo/nohup/xargs/command 等包装，遇到这些写法直接拒绝；请拆成直接命令并写明字面目标。所有写入候选（包括原生文件工具）都检查目录子项保护，不依赖命令是否以 rm/find/git clean 开头。原生 grep 在执行与权限边界检查实际搜索路径。grep 的 path、shell 的 workdir 和原生工具的路径与 OpenCode 的解析方式相同：恰为 `~` 或以 `~/` 开头时换成主目录，`..` 按字面合并；目录中存在不可读文件、范围无法确认或检查失败时拒绝，改为指定允许读取的子目录。

活动的 shell 通配符与路径展开不做猜测，直接拒绝；路径请逐个写明。传给 rg 的正则、find -name 的匹配模式和普通文本应加引号，避免它们成为 shell 展开。

find 清理会检查全部字面起点；没有起点时检查当前目录。支持默认不跟随链接的行为及显式 -P；-H/-L、外部起点清单 -files0-from 和无法确认的起点选项直接拒绝。

工作目录只允许通过工具 workdir 或直接的 `cd 字面目录` 指定。pushd/popd、git -C/--git-dir/--work-tree、env -C/--chdir/-S 和未支持的包装选项拒绝；不要用它们隐式改变后续命令的目标目录。只有 `cd 目录 && 命令` 确定在新目录执行；cd 之后用 `;`、换行或 `||` 连接的命令，以及 `!`、if、time、env 等开头的 cd 之后的命令，按原目录和新目录各检查一次。管道各段和 `&` 后台命令在子 shell 中执行，其中的 cd 和变量赋值不影响之后的命令。一条命令中 cd 与赋值的组合超过 64 种时拒绝，请拆成多条命令。

不支持在命令中设置非空 CDPATH；继承的 CDPATH 非空时，相对 cd 必须使用 ./ 或 ../ 开头，或改用绝对目录，避免 shell 搜索到另一目录。

`source` 和 `.` 的参数按读取保护规则检查：单独的 `source .env`、`. ./.env` 也会拒绝，不再豁免环境加载；规则允许读取的 `.env.example` 等文件仍可加载。无法确定的动态加载路径会拒绝。删除受保护目录，或目标下有凭据文件的递归清理（`rm -r`、`git clean`、`find -delete`）会被拒绝，清理时指定不含凭据的子目录。git clean 不论是否带 `-x` 都检查目标内容，`-n`/`--dry-run` 只列出清单而不检查；它的路径只支持已存在的字面文件或目录，按 git 的方式字面合并 `..`，以 `:` 开头的 pathspec 写法、含 `* ? [ \` 的路径、git 与 clean 之间的全局选项以及 `GIT_ICASE_PATHSPECS` 都会拒绝。`-e`/`--exclude` 的值是排除规则而不是清理路径，没有写路径时清理当前目录；项目根含保护配置，在项目根直接运行 `git clean -f` 会被拒绝。

测试管道自动补 pipefail；grep 提前退出的消费模式除外，head 导致的 SIGPIPE 如实保留。自定义测试命令可添加 `.opencode/workflow/pipefail.json`：

```json
{"version":1,"commandPrefixes":[["cargo","test"],["go","test"]]}
```

规则是 token 前缀，不执行配置，不使用配置正则。
