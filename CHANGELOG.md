# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。模板版本以 `template/.opencode/plugins/workflow/package.json` 中的 `version` 为准。

## [未发布]

**升级须知：** 质量扩展新增关联检查，已安装的项目用新版本覆盖 `scripts/quality/` 下全部 `.py`（新增 `check-sync.py`、`quality_sync.py`、`test_check_sync.py`，`quality_snapshot.py`、`run-hook.py` 等共用模块也有改动），在此之前接入向导显示质量扩展未就绪；接入方 CI 的 `scripts/ci/run-quality.py` 必须同时更新，只更新 CI 脚本时关联检查报缺少入口、CI 失败。基础模板的审核目录新增 `sync` 单元：合并 `catalog.json`、`routing.json` 并复制 `checklists/sync.md`，不需要时删除这两处条目；启用发布扩展的项目要为 `sync` 补一条证据，否则正式审核报“存在没有关联证据的审核任务”。

### 新增

- 质量扩展新增关联检查（第五项）：在 `quality.json` 的 `sync` 登记触发路径和关联目标，改动命中触发路径而关联目标没有改动时，在提交后和 CI 中报告；改名或删除使登记匹配不到文件时报告登记失效。只报告、不拦截；CI 中同步提醒不使 CI 失败，登记失效和未完成使 CI 失败，汇总变为五项。
- 基础模板的 `/review` 默认增加文档与约束同步审核单元 `sync`：覆盖全部改动路径，核对行为、接口、配置与权限的变化是否同步到文档、变更记录、示例配置和其他约束文件，并对照质量扩展的关联登记；遗漏类问题以不阻断的发现提交。

### 变更

- `/workflow-setup` 为 implementer、reviewer 选择固定模型时，如果该模型提供可选的思考强度（variant），会询问选择；没有选择就使用模型默认，不跟随主会话。选择继承时，说明子代理跟随主会话的模型和思考强度。预览计划新增 `effort`，列出每个角色的思考强度。
- 验收基线从 OpenCode 2.1.2 升级到 2.1.4（CLI、`@opencode/plugin`、`@opencode/client`）。插件代码不需要改动；已接入的项目更新插件依赖（`npm --prefix .opencode/plugins/workflow ci --ignore-scripts`）后，仍在用 2.1.2 CLI 时 doctor 的 `opencode-version` 由 pass 改报 warn，运行 `npm install -g @opencode/cli@2.1.4` 后恢复 pass。

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

[未发布]: https://github.com/aether-dev365/opencode-workflow-starter/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/aether-dev365/opencode-workflow-starter/releases/tag/v1.1.0
