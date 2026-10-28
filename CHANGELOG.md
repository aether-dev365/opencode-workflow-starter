# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。模板版本以 `template/.opencode/plugins/workflow/package.json` 中的 `version` 为准。

## [未发布]

**升级须知：** 插件目录需整体更新（`onboarding-runtime.ts`、`onboarding.ts`、`onboarding-files.ts` 有改动），并同时覆盖 `.opencode/skills/workflow-onboarding/SKILL.md` 和 `docs/workflow/onboarding.md`：只更新插件时，向导不知道何时记 `existing`；只更新技能时，`status` 没有它引用的 `installed`、`pinned`。已保存为 `existing` 的接入档案升级后同样接受其他版本的 Superpowers，列为未经套件验收；要继续只接受固定版本，把它改为 `project` 或 `global`。`status` 中 `superpowers.available` 现在只表示来源结构通过，是否为固定版本看新增的 `pinned`。

### 变更

- 完整模式可以沿用已经安装的其他版本 Superpowers，包括个人全局安装：在接入选择中把 `superpowers` 明确设为 `existing` 后，`/workflow-setup` 核对插件来源结构和本会话的真实读取，不再要求与固定的 v7.0.1 一致，并在 `verify`、`finish` 中把该版本列为未经套件验收。`superpowers` 为 `project` 或 `global` 时仍只接受固定版本，并提示可以改选 `existing`。`status` 的 `superpowers` 新增 `pinned`、`installed` 和 `pinIssues`。`bootstrap` 遇到其他来源或版本的 Superpowers 不再报错，改为返回不修改文件的计划并提示改选；宿主已登记 Superpowers（包括加载失败的）时不再登记第二份。

### 修复

- `bootstrap` 不再把名称中只是含有 superpowers 的无关插件（如 `superpowers-chrome`）当作已安装的 Superpowers；此前遇到这类插件会报“已有不同来源或版本的 Superpowers”，并拒绝生成安装计划。

## [1.2.1] - 2026-10-28

修复路径守卫可被同一命令中新建的符号链接绕过的问题，以及 Windows 上 Python 3.13 及更高版本对根路径的判断；`ln` 的支持写法随之收紧。

**升级须知：** 整体更新 `.opencode/workflow/checks/`。`ln` 现在只接受 `-s/-f/-n`（及对应长选项）和字面操作数，符号链接须恰好给出两个字面路径且链接位置的父目录已存在；此前放行的其他写法会被拒绝，按拒绝原因改写或拆成多条工具调用，支持边界见守卫说明。

### 修复

- 路径守卫按符号链接所在的实际目录解析 `ln -s` 的相对目标，并检查同一命令经新链接访问的具体子路径；此前只按执行前的文件系统和 cwd 检查，可以先创建链接再经它修改保护配置或规则单独保护的子文件。`ln` 的支持选项收紧为 `-s/-f/-n`、对应完整长选项和 `--`；符号链接须给出两个字面路径和已存在的父目录，不接受目录操作数、动态参数、通过已有链接隐藏的依赖、链式或冲突链接及无法确定的路径变动。硬链接与符号链接的操作数均拒绝以 `~` 开头；复制符号链接的硬链接同样拒绝，普通文件硬链接保留。链接查询出错时拒绝，Windows 8.3 短名前缀逐段规范化后匹配映射；Windows 上同一命令含新符号链接时，新链接名含 `~` 后接数字（`0–9`），或路径分量逐段解析后仍含这种形态的拒绝，请改用长文件名；`proj~v2` 等普通名称不受此限制。复杂操作请拆成多条工具调用。具体支持边界见守卫 README；升级时整体更新 `.opencode/workflow/checks/`。
- Windows 上没有创建符号链接的权限时（如未开启开发者模式），守卫测试中用到符号链接的路径用例跳过并说明原因，不再报错。
- Windows 上的单分隔符根路径（如 `/repo`、`\repo`）在 Python 3.13 及更高版本仍检查含 `..` 的物理落点，并按路径所在的检出选择保护规则；此前两处沿用 `isabs`，这些版本会把根路径判作相对路径，漏掉物理候选或错误沿用会话检出的规则。升级时整体更新 `.opencode/workflow/checks/`。

## [1.2.0] - 2026-10-28

新增新项目流程 `/workflow-new`、接入向导的既有 AI 配置检测与子代理规划、质量扩展的关联检查和 `/review` 的同步审核单元，验收基线升到 OpenCode 2.2.0，并修复路径守卫的多处绕过以及插件、守卫、质量扩展和接入方 CI 执行项目目录中同名程序的问题。

**升级须知：** 质量扩展新增关联检查，已安装的项目用新版本覆盖 `scripts/quality/` 下全部 `.py`（新增 `check-sync.py`、`quality_sync.py`、`test_check_sync.py`，`quality_snapshot.py`、`run-hook.py` 等共用模块也有改动），在此之前接入向导显示质量扩展未就绪，并把根 AGENTS.md 中的质量规则替换为质量扩展 README 启用第 3 步的新文字（五项报告及关联提醒的处理）；接入方 CI 的 `scripts/ci/run-quality.py` 必须同时更新，只更新 CI 脚本时关联检查报缺少入口、CI 失败。基础模板的审核目录新增 `sync` 单元：合并 `catalog.json`、`routing.json` 并复制 `checklists/sync.md`，不需要时删除这两处条目；启用发布扩展的项目要为 `sync` 补一条证据，否则正式审核报“存在没有关联证据的审核任务”。接入选择 `onboarding.json` 升为 version 2，新增 `agents` 与 `existing`；1.1.0 的档案照常读取，用 CLI 生成计划的 `answers.json` 需补充这两项；升级前预览但未应用的计划视为过期，需要重新预览。项目中有其他 AI 工具的配置，或有本模板以外的 OpenCode 配置（包括自行添加的代理、命令、技能、插件和子目录中的 `opencode.json(c)`）时，升级后需重新运行 `/workflow-setup` 逐项记录迁移或保留，在此之前 `verify`/`finish` 不就绪。插件目录需整体更新（新增了 `onboarding-existing.ts`、`onboarding-agents.ts`），并同时覆盖 `.opencode/skills/workflow-onboarding/SKILL.md`、`.opencode/commands/workflow-setup.md`、`docs/workflow/onboarding.md`、`docs/workflow/development.md`、`scripts/workflow/doctor.mjs`、`scripts/workflow/onboarding.mjs`：只更新插件时，向导缺少评估、迁移和子代理规划步骤，主代理也不会把任务派给生成的子代理；doctor 与插件版本不配套时 `onboarding` 检查出错。不再执行项目目录中同名程序的修复分布在插件目录、`scripts/workflow/doctor.mjs`、`scripts/workflow/setup.mjs`、`.opencode/workflow/checks/`、`scripts/quality/` 和 `scripts/ci/` 中，需要一起更新；只更新 doctor 或 setup 而不更新插件时它们无法启动，只更新插件时 setup 仍会按名字启动 `WORKFLOW_OPENCODE_BIN`。已接入的项目用不到 `/workflow-new`；覆盖 `docs/workflow/onboarding.md` 时一并复制 `docs/workflow/new-project.md`（前者链接到它，缺少时启用质量扩展的项目报断链、接入方 CI 失败），命令 `workflow-new.md` 和技能目录 `workflow-new-project/` 可以不复制。OpenCode 验收基线升到 2.2.0：更新插件依赖后同时把 CLI 升到 2.2.0，仍用 2.1.x 时 doctor 的 `opencode-version` 报 fail。

### 新增

- `/workflow-setup` 检测项目中其他 AI 工具的配置（Claude Code、Cursor、Codex、GitHub Copilot、Gemini CLI 等，以及本模板以外的 OpenCode 配置），列出每一处及其在 OpenCode 中是否生效；AI 阅读评估后给出迁移或保留建议，由用户逐项决定并记录在 `onboarding.json`，有未决定的项时不生成配置计划。迁移由 AI 展示差异、经确认后完成，原文件保留，能共用的改为引用；迁移项在 `verify` 中列为待你核对。检测只看文件清单和标记，不输出文件内容和凭据；个人 `opencode.json(c)` 只统计登记的插件数。
- `/workflow-setup` 新增子代理规划：AI 按项目领域和结构建议新增的实现类子代理，由用户勾选；向导按与 implementer 相同的权限边界生成代理文件并预览全文，为其选择继承或固定模型，并在宿主中核对实际加载与有效模型。人工修改过的生成文件、手写的同名代理不会被覆盖，人工修改过的生成文件在 `verify` 中列为待你核对；去掉某个子代理时不删除文件。已接入的项目升级后，`onboarding.json` 记录的子代理缺少代理文件时，doctor 的 `onboarding` 由 unverified 改报 warn。
- 质量扩展新增关联检查（第五项）：在 `quality.json` 的 `sync` 登记触发路径和关联目标，改动命中触发路径而关联目标没有改动时，在提交后和 CI 中报告；改名或删除使登记匹配不到文件时报告登记失效。只报告、不拦截；CI 中同步提醒不使 CI 失败，登记失效和未完成使 CI 失败，汇总变为五项。
- 基础模板的 `/review` 默认增加文档与约束同步审核单元 `sync`：覆盖全部改动路径，核对行为、接口、配置与权限的变化是否同步到文档、变更记录、示例配置和其他约束文件，并对照质量扩展的关联登记；遗漏类问题定为不阻断的 P2/P3，结论仍为 pass。reviewer 说明同时写明 pass 可以附带 `blocking: false` 的发现。
- 新项目流程 `/workflow-new`：从空目录开始，依次完成最小接入、设计、搭骨架、补齐项目规则、第二轮 `/workflow-setup` 和基线验收，每个需要你决定的地方先询问；中断后重新运行，会按项目现状判断进行到哪一步。基础和完整模式都适用，完整模式的设计使用 Superpowers。说明见 `docs/workflow/new-project.md`。

### 变更

- `/workflow-setup` 为 implementer、reviewer 选择固定模型时，如果该模型提供可选的思考强度（variant），会询问选择；没有选择就使用模型默认，不跟随主会话。选择继承时，说明子代理跟随主会话的模型和思考强度。预览计划新增 `effort`，列出每个角色的思考强度。
- 验收基线从 OpenCode 2.1.2 升级到 2.2.0（CLI、`@opencode/plugin`、`@opencode/client`）。插件代码不需要改动；doctor 对 2.2.0 报 pass，对其他 2.2.x 报 warn，2.1.x 不再属于验收系列而报 fail。已接入的项目更新插件依赖（`npm --prefix .opencode/plugins/workflow ci --ignore-scripts`）后，运行 `npm install -g @opencode/cli@2.2.0` 把 CLI 升到同一版本。
- 根 AGENTS.md 模板新增“项目概要”一节，集中填写用途、技术栈、目录与领域、验证命令入口和设计记录位置；已有项目接入时同样填写，已接入的项目不需要修改。

### 修复

- 插件、doctor、提交前凭据扫描、质量扩展的各项检查和接入方 CI 的范围解析、凭据扫描、质量检查脚本不再执行项目目录里与 Git、Gitleaks、Python 启动器同名的程序（质量扩展的 post-commit hook 本身仍由 sh 按 PATH 启动 Python）：这些程序只在 PATH 的绝对目录中查找，`cmd.exe`、`taskkill.exe` 固定取自 `%SystemRoot%\System32`，找不到时按缺少命令处理。此前 Windows 的进程创建总会先查当前目录，macOS 和 Linux 在 PATH 有空项时也会查；代理在项目根写入 `py.exe` 就能替换守卫的解释器，写入假的 `git` 能让带凭据的提交通过扫描。经 `cmd.exe` 启动的 `.cmd` 启动器也不再先查当前目录。发布入口的第一项不再在项目目录中查找，项目内的程序要写成带路径的形式（例如 `./scripts/publish`）。
- 质量扩展的注释审核、跳过测试检查、链接检查和格式检查在共用模块缺失或版本不配套时报告“未完成：质量扩展文件不完整（异常类型）”并以 2 退出，提交后报告给出重跑提示；此前未捕获的导入错误以 1 退出，共用模块版本不配套时 CI 汇总把注释审核记为提醒并放行，其余三项误报为有发现。用低于 3.10 的 Python 直接运行这些检查时，报告“未完成：需要 Python 3.10 或更高版本”并以 2 退出，不再显示 traceback。
- 链接检查和格式检查的 `--help` 改为说明各自的用途，格式检查同时说明 `--fix` 与 `--hook`；此前显示的是行级检查的描述。
- 链接检查和格式检查的 `--range` 两端找不到共同历史时，提示没有共同历史并说明浅克隆需先补全历史，不再只说“git 命令失败”。
- 质量扩展的格式检查在 Windows 上不再选中没有扩展名的文件：命令（包括 `node_modules/.bin/prettier` 这类带路径的）不带 PATHEXT 中的扩展名时，只查找补上扩展名的文件。此前 npm 放在 `.cmd` 旁的无扩展名 sh 启动脚本先被选中，启动时报“不是有效的 Win32 应用程序”；现在找到的是 `.cmd`，按原有规则提示改为直接调用解释器及其脚本入口。
- 质量扩展的格式配置在 Python 3.13 及更高版本上同样拒绝以 `/` 或 `\` 开头的 `cwd`，报 `formats[i].cwd` 配置错误。此前这些版本不再把不带盘符的根路径视为绝对路径，指向检出目录内的绝对路径能通过校验；指向检出目录外的仍会被拒绝。
- `/workflow-setup` 读取项目文件出错时只报告相对路径和错误码，不再回显含绝对路径的原始错误；文件不是 UTF-8 时说明是哪个文件，不再只显示英文的解码错误。
- 在已接入的项目中运行插件测试（`npm --prefix .opencode/plugins/workflow test`）时，依赖套件源码的用例跳过并写明原因；此前它们到项目的上一级目录读取套件文件而失败。
- ADOPT 第 3 节的同名冲突清单补上 `review` 命令：项目已有同名命令时先确定升级或保留方式；此前清单没有列出，照清单合并可能直接覆盖。
- 根 AGENTS.md、接入和安装说明、ADOPT 第 4 节以及接入方 CI 的本地验收命令中，doctor 命令去掉 `--root .`（doctor 默认检查当前目录）：插件把指向项目根的修改类命令参数按保护配置处理，模型在 OpenCode 中照这些文档运行 `doctor.mjs --root .` 会被拒绝。已接入的项目可同步更新根 AGENTS.md 中的这一行。
- 路径守卫和插件不再拒绝带超长参数的命令：长 `git commit -m` 正文、长 `python3 -c` 等参数会被当作候选路径查询，其中一段超过文件名上限时，此前按查询出错拒绝，并在拒绝原因中原样回显整段参数。现在能确定路径不可能存在时（整条路径短于系统上限，或某一段超过 255 个字符）按不存在处理，字面路径的保护规则照常生效；整条路径超过系统上限而无法确定时仍然拒绝，并提示把长文本改用文件或标准输入传入（例如 `git commit -F -`）。拒绝原因中的超长路径只显示首尾。Python 3.14 起 `Path.exists` 把查询出错当作路径不存在，守卫对候选路径改为自行判断，各版本上查询出错都拒绝；Windows 的应用执行别名（WindowsApps 下的 `python.exe` 等）下面不可能有子项，按不存在处理。`.opencode/workflow/checks/` 与插件目录需一起更新。
- 路径守卫和插件按 shell 的执行方式确定后续命令的工作目录：此前遇到 `cd` 就认为之后的命令都在新目录执行，cd 失败后用 `;`、换行或 `||` 连接的命令，管道和 `&` 后台中的 cd 之后的命令，`!` 开头的 cd 之后的命令，以及 macOS 上 `env cd 其他目录 && …`（`/usr/bin/cd` 不改变目录且返回 0）之后的命令，都按错误的目录检查，写入保护配置、删除 `.opencode` 等操作会被放行；管道中的变量赋值同样被当作对后续命令生效。现在 `cd 目录 && …` 按新目录检查，`cd 目录 || …`、`;`、换行之后以及带前缀的 cd 之后在原目录和新目录各检查一次（PWD 或 OLDPWD 只读时，cd 会先切换目录再返回失败），管道各段和后台命令中的 cd 与赋值不影响之后的命令；一条命令中 cd 与赋值的组合超过 64 种时拒绝并提示拆成多条命令。`!` 开头的命令（如 `! rm -rf src`）此前跳过递归删除和动态目标的检查，现在与不带 `!` 时相同。`.opencode/workflow/checks/` 需整体更新。
- 路径守卫按 git 的规则解析 `git clean` 的路径：此前把参数当作普通文件路径，`git clean -fdx src/nonexistent/..`、`:/`、`':(top)src'` 和引号里的通配（如 `'s*'`）不遍历目标而放行，`-e foo` 的值被当作清理路径而漏掉默认的当前目录，会删除被忽略的凭据文件；不带 `-x` 的 `git clean -fd 目录` 不检查目录内容，会删除未被忽略的凭据文件。现在 `-e`/`--exclude` 的值不再当作路径，路径按 git 的方式字面合并 `..` 后检查和遍历，不论是否带 `-x`；以 `:` 开头的写法、含 `* ? [ \` 的路径、不存在的路径、git 与 clean 之间的全局选项以及 `GIT_ICASE_PATHSPECS` 都会拒绝，`-n`/`--dry-run` 不遍历。在项目根直接运行 `git clean -f`、`git clean -fd` 现在与 `git clean -fdx` 一样被拒绝，清理时指定子目录。`.opencode/workflow/checks/` 需整体更新。
- 路径守卫和插件按 OpenCode 的方式解析 grep 的 path、shell 的 workdir 和原生工具的路径：OpenCode 把恰为 `~` 或以 `~/` 开头的路径换成主目录，再按字面合并 `..`；此前守卫和插件不展开 `~`，grep 还在未合并的路径上判断目录，`src/nonexistent/..`、`nonexistent/../src`、`~/项目/src` 这类搜索路径不检查目录内容而放行，workdir 为 `~/项目` 时写入保护配置、`rm -rf .opencode` 也会放行。原生 read、write、edit 的 `~/` 路径此前由权限检查拦下；提交前凭据扫描在这种 workdir 下扫描失败而拒绝提交，现在照常扫描。插件目录与 `.opencode/workflow/checks/` 需一起更新。
- 路径守卫和插件检查 shell 命令中含 `..` 的路径时，另按内核的方式解析：内核先跟随符号链接再回到上一级，此前只按字面合并。项目里有指向受保护目录内部的符号链接时（例如 `mkdir -p .opencode/workflow/sub && ln -s .opencode/workflow/sub L`，这两步本身照常放行），`echo x > L/../protection.json` 按项目根下的 protection.json 检查而放行，实际覆盖的是保护配置；`set -P` 之后的 `cd 链接/..` 同理。同一条命令里新建链接再经它的 `..`（检查时链接还不存在）无法确认落点，拒绝。原生工具不受影响，OpenCode 先按字面合并再访问。`.opencode/workflow/checks/` 需整体更新。

## [1.1.0] - 2026-10-25

新增 AI 引导式接入 `/workflow-setup`、可选的质量扩展和接入方 CI 模板，并加固路径保护与提交前凭据扫描。

**升级须知：** 守卫比 1.0.0 严格：shell 命令须能静态分析，`protection.json` 改为代理只读，reviewer.md 中额外放开的工具不再生效，详见下方「变更」与「新增」。配置文件格式没有变化。升级后命令被拒绝时，按提示改写成直接命令；支持的写法见 [守卫说明](template/.opencode/workflow/checks/README.md)。

### 新增

- 新增 `/workflow-setup` 引导式接入：AI 逐项询问完整或基础模式、Superpowers 安装范围、implementer 与 reviewer 继承还是固定模型，以及质量、CI、发布和 MCP 组件，不代用户作答。应用前预览绑定内容摘要的计划，列出项目与个人全局配置的改动；经原生 `workflow_setup` 权限批准后原子写入，预览后输入变化即要求重新确认。完整模式核对 Superpowers 固定来源和当前会话真实读取 brainstorming、writing-plans 的证据；verify 与 finish 核对有效模型和技能、运行 doctor，并分别列出已配置、已验证和未验证事项。非交互脚本 `scripts/workflow/onboarding.mjs` 供单独授权的手动执行与恢复，在 OpenCode 的 shell 中运行其 apply 同样需要确认。
- 新增可选的质量扩展 optional/quality：提交后由 post-commit hook 报告新增注释里的文档引用、追踪编号和日期、开发过程叙述与生成工具署名，以及新增的跳过、只运行部分测试和预期失败标记；只报告、不拦截，安装器不覆盖已有 hook。
- 质量扩展增加登记式格式检查和文档本地链接检查：格式工具由接入方提供，按 Git 差异选文件、读取工作区，支持只手动执行的修复命令；链接内容与存在性使用指定快照，删除或改名资源也检查未改动文档的新断链。post-commit 顺序报告四项结果，含有界输出和两层超时清理；保持配置 version 1，无新增运行时依赖。
- 行级质量检查增加可选 `--fail-on-incomplete`，供 CI 将非 UTF-8、过大或无法分析的候选视为未完成；本地命令与 post-commit 默认行为不变。共享执行器支持新 CI 格式外层的可选协作终止。
- 新增可选接入方 CI 模板 optional/ci：在 GitHub Actions 中扫描候选完整历史的凭据、运行 doctor 并汇总四项质量检查；注释发现只提醒，其他质量发现或未完成使 CI 失败。支持 PR、默认分支 push 和手动全量，使用只读权限、固定工具和脱敏报告，不执行自动修复；凭据扫描不采用候选检出自带的 `.gitleaksignore`，候选提交不能借它豁免历史中的凭据。
- 插件强制 reviewer 只读：工具调用前和权限判定时各拦截一次，reviewer 会话只允许 read、glob、grep 和 workflow_review_submit，不依赖 reviewer.md 是否被加载；在 reviewer.md 中额外放开的工具从此不再生效。
- `workflow_review` 的 run 与 `workflow_review_submit` 在 reviewer 定义缺失或没有审核说明时拒绝，提示检查 `.opencode/agents/reviewer.md`。
- doctor 新增 `reviewer-model` 检查：reviewer 未在 `opencode.jsonc` 的 `agents.reviewer.model` 或代理文件中指定模型时给出 warn；代理文件的 frontmatter 中 model 为空时也给出 warn，因为 OpenCode 会忽略整个代理文件，包括其中的只读权限。已接入的项目升级后，显式指定前会看到这条提示。
- doctor 新增 `rule-size` 检查：`scopes.json` 引用的规则文件超过 20000 个字符（插件上限的一半）时给出 warn。

### 变更

- 路径守卫只放行能静态分析的 shell 命令。首命令须在支持清单内（常见文件命令、Git、Node/Python/npm 与常见构建工具等），未知 CLI 和未支持的包装默认拒绝；子 shell、命令分组、循环、sudo/nohup/xargs 等包装，pushd/popd、`git -C`、`env -C` 等隐式切换目录，活动的路径通配符，以及 `eval`、`bash -c` 等字符串执行一律拒绝，并提示改写成直接命令。此前这些写法里的目标可能不受检查。
- `source` 与 `.` 的参数按读取保护检查：`source .env` 不再豁免，规则允许读取的 `.env.example` 等文件仍可加载。
- `.opencode/workflow/protection.json` 由守卫和插件内置为代理只读，正常与修复模式都不能编辑，也没有询问放行入口；创建、修改、升级合并和修复改由用户在 OpenCode 之外完成。插件和守卫代码不受此限制，仍可按 ADOPT.md 升级。
- 宿主 shell 改为明确支持集：只接受 Bash（Windows 上为 Git Bash），其他解释器、缺失或空的 shell 以及 WSL 启动器均拒绝；此前只拒绝 PowerShell、cmd 和 WSL 启动器。doctor 使用同一边界。
- 模板补充代理模型的配置说明：根 `model` 是默认值，`agents.<名称>.model` 为单个代理指定，子代理未指定时继承发起它的会话的模型。
- 领域规则范本新增「写法」一节；根 `AGENTS.md` 的「按需阅读」改为写明何时阅读。

### 修复

- 修改另一个没有 `scopes.json` 的检出里的文件时，插件不再报“范围映射缺失”并拒绝，而是与路径守卫一致，不加载该检出的领域规则；映射存在但无法读取时仍拒绝。
- 暂存区有文件与符号链接互换的类型变更时，提交前凭据扫描不再出错，照常扫描并报告位置。
- `/review` 按路径分批生成审核材料的单元差异，改动文件很多时不再因 Windows 命令行超长而失败。
- 测试命令里出现 `pipefail` 字样（如测试名或参数）时，测试管道照样补上 pipefail；此前会被误认为已经设置。
- 只用重定向或 heredoc 写文件的 shell 命令（如 `echo x > src/a.ts`、`cat > src/a.ts <<'EOF'`）不再被当作只读：和其他修改一样，先加载领域规则；工作流配置无效时拒绝执行。
- PR、issue 和 release 正文写作 `gh … --body "$(cat <<'EOF' … EOF)"` 时，路径守卫不再把正文里提到的受保护路径与写入字样当作命令拒绝；正文交给 shell 执行或经管道交出时照常检查。
- 文档改正规则文件超过上限的后果：插件拒绝本检出内除各目录 `AGENTS.md` 和工作流配置以外的全部修改，不只是该规则所在的领域。

### 安全

- 路径守卫对命令替换、进程替换和反引号里的递归删除（`rm -r`、`find -delete/-exec`、`git clean -x`）同样检查目标；此前 `echo "$(rm -rf vendor)"` 一类写法会被放行。
- 路径守卫对所有代理拒绝可识别的隐藏命令替换与运行时求值组合，分析出错时拒绝；保留普通文本和算术命令，并补充原生发布回归测试及静态分析局限说明。heredoc 正文按 bash 语义分析：`gh pr create --body "$(cat <<'EOF' … EOF)"` 这类写法的正文，以及由 tee、Python、Node 等不执行 shell 的程序读取的正文，按字面量检查，其中的撇号、括号不会导致拒绝；字面正文里的命令替换交给运行时求值时同样拒绝。
- 引号、转义或注释中形似 heredoc 的分隔符不再让守卫把后续命令当作正文跳过，后续行照常接受路径检查和提交识别。
- shell 命令解析失败时路径守卫一律拒绝；此前个别引号写法会让解析失败的命令被当作空命令放行。`$'…'` 形式的 ANSI-C 引号先按字面量解码再检查。
- 原生 grep 工具在执行前和权限判定时按读取保护检查实际搜索路径，reviewer 同样适用；此前把受保护文件指定为搜索路径即可读到其内容。
- 只读命令白名单不再信任可能执行其他程序或隐式写出文件的命令和选项（如 `sort -o`、`tree -o`），这些写法按写入检查。
- 所有写入候选（包括原生文件工具）都检查目录子项保护；此前只有以 rm、find 或 git clean 开头的命令才检查目录规则。
- find 清理检查全部起点，并拒绝 -H、-L、-files0-from 等无法确认范围的选项；此前只检查第一个参数。
- 经 sudo、nohup、xargs 等包装发起的 `git commit` 现在能被识别并拒绝，不再跳过提交前凭据扫描。
- 原生补丁的路径头按 OpenCode 接受的缩进、CRLF 与路径空白解析，这类补丁头不再绕过执行前的路径保护。

## 1.0.0 - 2026-10-22

2026-10-25 起仓库历史重新初始化，`v1.0.0` 标签与对应的 GitHub Release 不再提供；以下保留当时的变更记录。

首个正式版本：领域规则加载、路径保护、提交前凭据扫描、手动 `/review`、可选发布核查、接入准备脚本，以及 Linux、WSL2、macOS（Apple Silicon）的含原生运行验收和 Windows 原生（Git Bash）的子集验收。

以下变更相对当天早些时候公开过、未打标签的预览状态。

### 新增

- MIT 许可证（仓库根目录与 `template/.opencode/LICENSE`）、安全策略、贡献指南和本变更记录。
- 维护本套件的协作约定 `AGENTS.md`；`CLAUDE.md` 只引用它，供 Claude Code 读取同一份规则。
- 接入准备脚本 `scripts/workflow/setup.mjs`：检查前置工具，安装插件依赖和固定版 Gitleaks，检测 OpenCode 并运行 doctor。OpenCode 缺失时可选择经 npm 安装 CLI 验收版本或查看 Desktop 下载入口（交互输入，或 `--opencode cli|desktop|skip`）；已有的 V1 或其他 V2 版本不会被替换。
- GitHub Actions CI：Linux（Python 3.10）与 macOS（Apple Silicon）跑全量验收，含 OpenCode 原生测试；Windows 在 PowerShell 中跑 `node scripts/verify.mjs --windows` 子集；action 固定到提交 SHA，权限为只读，失败时上传验证日志。
- macOS（Apple Silicon）完成原生验收。
- 可选扩展 `optional/protection/`：私钥、SSH 私钥、常见凭据文件和 Terraform 状态的保护规则，附启用步骤与回归测试。
- README 重写：解决的问题、原理图、平台支持表、按平台的快速开始、常见问题和英文摘要；安装指南补充原生 Windows（Git Bash）路线与常见问题。

### 变更

- 守卫合并为一个检查进程（`run-checks.py`），工具钩子已检查过的同一条 shell 命令在 `shell.create.before` 中不再重复检查：普通 shell 调用的 Python 进程数由 7 个降为 1 个（OpenCode 2.1.2 原生实测）。结论依赖仓库内容的命令（`git commit` 的凭据扫描、递归删除）不复用这一结论，shell 创建时按当时的暂存区和目录重新检查。
- doctor 支持 Windows：按 PATH/PATHEXT 查找 `opencode`、`gitleaks.exe`，经 `cmd.exe` 执行 npm 安装的 `.cmd` 启动器，Python 按 `WORKFLOW_PYTHON`、`py -3`、`python`、`python3` 解析，Git 根目录比较不区分大小写；新增 `--print-permissions`，输出与 `protection.json` 对应的原生权限块。
- 验收基线从 OpenCode 2.1.1 升级到 2.1.2（CLI、`@opencode/plugin`、`@opencode/client`）；doctor、CLI 获取脚本和测试统一从插件 `package.json` 读取基线版本，文档版本由分发测试核对。

### 新增（Windows）

- Gitleaks 安装脚本支持 macOS 与 Windows（x64/arm64），固定校验值与官方 `checksums.txt` 核对一致；Windows 解包 zip 中的 `gitleaks.exe`，提示使用 `py -3`。
- `scripts/verify.mjs --windows` 运行 Windows 子集（类型检查、插件、守卫、独立接入）；守卫阶段改为直接运行 `python -m unittest`，遵循 `WORKFLOW_PYTHON`。凭据扫描测试可在 Windows 原生运行，依赖 bash 逻辑目录与目录符号链接的 3 个用例在 Windows 上跳过。
- 模板 `opencode.jsonc` 固定 `"shell": "bash"`（Windows 上解析为 Git Bash）；shell 为 PowerShell、cmd 或 WSL 启动器时插件拒绝执行并说明原因，避免测试失败被当成通过；doctor 新增 `shell` 检查。

### 修复

- 补全 `.gitignore`：仓库根目录此前没有忽略 `.env` 等凭据文件，现补充凭据、缓存、日志、`npm pack` 产物、CodeGraph 索引、Claude Code 个人设置及系统/编辑器文件；模板额外忽略 `*.env`，与保护规则一致。分发测试屏蔽全局 excludes 后核对。
- 分发测试不再在源码里写入私有项目名、本机路径和服务器地址；改为通用检查加被忽略的本地禁用词文件。
- 新增 `.gitattributes`（仓库与模板各一份）：Windows 上以 `core.autocrlf=true` 检出时，工作流脚本仍保持 LF，`run-tests.sh` 不再因 CRLF 报错。
- doctor 在插件依赖缺失时不再崩溃，改为输出结构化报告并给出 `npm ci` 命令。
- 插件测试不再依赖预先存在的 `/tmp/opencode`，全新的 CI 机器上也能运行。
- Python 守卫在非 UTF-8 环境（Windows 的 cp936/cp1252 代码页）下按 UTF-8 读取配置、收发 JSON，不再因中文配置或路径拒绝所有操作；识别 Git Bash 风格的 `/c/...` 路径；跨盘符路径仍按规则检查；超时在 Windows 上用 `taskkill /T` 终止扫描器进程树；缺少扫描器的提示加入 `opencode service restart`。
- 插件新增 `platform.ts` 集中处理平台差异：Windows 上依次探测 `py -3`、`python`、`python3`（可用 `WORKFLOW_PYTHON` 指定），子进程隐藏窗口且超时用 `taskkill /T` 终止，路径匹配前统一为 `/`，Git Bash 风格路径按 OpenCode 规则换算；检查器无法启动时，错误信息会给出命令、原因和处理办法。
- 模型给 shell 传相对 `workdir`（如 `src`）时不再被误拒：OpenCode 在插件钩子之后才把它解析为绝对路径，插件现在按 Location 解析。
- Gitleaks 安装脚本的输出接管道时（如 GitHub Windows runner 的 cp1252 代码页）不再因中文提示编码失败、在安装成功后仍以 1 退出。
- macOS 与 Linux 上也检查 `python3` 是否为 3.10+（macOS 自带的是 3.9），不够新时依次尝试 `python3.14` 到 `python3.10`，找不到时给出安装提示；此前检查进程会直接崩溃，所有受保护操作被拒且原因不明。
- `/review` 的快照凭据扫描单独计时 60 秒（提交扫描仍为 8 秒）：快照最多 128 MB，在较慢的机器上原先会因超时被拒。
- 递归删除（`rm -r`、`git clean -x`、`find -delete`）的检查不再逐个解析普通文件的真实路径：Windows 上 2 万个文件由约 7 秒降到约 2 秒，结论不变。
- Windows 上能找到 Microsoft Store 与 Python 安装管理器以应用执行别名（`WindowsApps\py.exe`、`python.exe`）提供的解释器。
- 在 POSIX 上，`C:/x` 这类路径按相对路径检查（目录名可以是 `C:`），只有 Windows 把它当作盘符绝对路径。
- 配置引用的文件缺失时，报错显示配置中写的相对路径，不再显示各平台格式不同的系统错误。
- 规则文件为空或超过 40000 字符时，上下文组装不再抛错导致整个会话不可用，改为提示并拒绝修改该领域（规则文件本身仍可修复）；看门狗释放已删除会话的记录；`/review` 默认基线先使用远端默认分支（`origin/HEAD`）。

[未发布]: https://github.com/aether-dev365/opencode-workflow-starter/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/aether-dev365/opencode-workflow-starter/releases/tag/v1.2.1
[1.2.0]: https://github.com/aether-dev365/opencode-workflow-starter/releases/tag/v1.2.0
[1.1.0]: https://github.com/aether-dev365/opencode-workflow-starter/releases/tag/v1.1.0
