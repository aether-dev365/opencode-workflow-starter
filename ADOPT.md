# 给接入模型的操作指南

目标是把 `template/` 的工作流融入当前项目，不是把当前项目改成模板示例的目录或技术栈。此文件只在首次接入和升级时阅读；日常入口是目标项目根 AGENTS.md。

## 0. 从引导开始

目标目录还没有项目代码（空目录，或只有 README、LICENSE 等说明文件）时按新项目流程：在该目录 `git init`，复制 `template/` 的全部内容（空目录不需要合并；已有 `.gitignore` 等同名文件时按流程文档的第 0 阶段处理），运行 `node scripts/workflow/setup.mjs`，确认插件已加载后运行 `/workflow-new`。之后的接入、设计、搭骨架和项目规则由它按 [新项目流程](template/docs/workflow/new-project.md) 分阶段引导，本文件以下内容针对已有项目。已经用脚手架生成过代码的项目按已有项目接入。

不要一开始就复制所有可选扩展。先说明基础保护模式与推荐的完整模式，并使用 OpenCode 原生 question 工具逐个询问；当前客户端没有该工具时用普通对话等待答复。取消、无答复或不能交互不等于选择默认值，也不等于批准安装。能通过项目文件查明的事实由模型自行调查。

首次接入时，向导命令可能尚未存在。先给出最小基础接入清单，取得用户确认，合并基础插件、根规则、路径映射和配置并准备依赖，确认实际 Location 的插件已加载后进入 `/workflow-setup`。这段 bootstrap 不依赖 Superpowers，也不能被描述为已执行它的设计或计划。已有项目按下文逐项合并，不覆盖现有 AGENTS.md、配置或未提交工作。

`/workflow-setup` 使用 [接入向导](template/docs/workflow/onboarding.md) 和 `workflow-onboarding` 技能。完整模式必须先处理 Superpowers 来源、安装范围和当前会话可加载性，再实际加载 brainstorming/writing-plans，进行接入设计与计划；缺失时不得模拟技能。基础模式不要求第三方技能。设置子代理模型不等于授权额外模型调用或自动多代理审核。

确认后的模式、既有 AI 配置的决定、子代理、模型策略和组件记录在 `.opencode/workflow/onboarding.json`；待应用计划在被忽略的 `.opencode/workflow/.state/onboarding/`。显示选择、文件、冲突和全局影响后再应用具体摘要计划，输入改变就重新确认。CLI 不证明当前宿主技能已读；完成验收需原生 `workflow_setup verify/finish`。

## 1. 调查真实项目

记录绝对目标目录和 Git 状态。先读现有 AGENTS.md、OpenCode 配置、包元信息和开发手册，保留未提交工作。

查明实际源码目录、第三方目录、生成文件及其生成入口、凭据文件的路径（不读其内容）、验证命令、运行平台及资源约束。通过文件和命令自行确定；仅对影响流程或权限而无法确定的决定提问。

检查其他 AI 工具的配置和工作流（标记清单见 [接入向导](template/docs/workflow/onboarding.md) 的“既有 AI 配置”），列入接入清单。OpenCode V2 不读取 `CLAUDE.md`，但会加载 `.claude/skills` 与 `.agents/skills`。bootstrap 只合并模板与现有 AGENTS.md，不迁移其他工具的内容；迁移或保留在 `/workflow-setup` 中逐项决定和记录。

查明当前 OpenCode、Node、Python 和 Git 版本。基础包使用 OpenCode 2.1.4 验收；若目标版本不同，先验证兼容或提出升级计划，不悄悄替换依赖。

先执行 `opencode --version`；设置了 `WORKFLOW_OPENCODE_BIN` 时，同时核对该路径的版本。未安装、不是 V2 或无法识别时，向用户展示检测结果，提供 [OpenCode V2 安装指南](template/docs/workflow/opencode-install.md)、[官方安装入口](https://opencode.ai/v2/docs/) 和 `npm install -g @opencode/cli@2.1.4`，完成安装或修正命令路径并复查后再接入。已有 V1 按指南保留配置并处理迁移，不在 V1 宿主中加载本模板的 V2 插件。

## 2. 给出接入清单

列出拟新增、合并及保持现有的文件。明确目录映射、保护路径与允许例外、实际命令、审核分区、角色、所需扩展及尚未确定项。

- 根规则保持简短，领域正文只写一份。跨目录路径通过 scopes.json 引用正文。写法见 [领域规则范本](examples/domain-AGENTS.md)：只写现行规则和原因，指向手册时写明何时阅读。每个规则文件（含根 AGENTS.md）超过 20000 个字符时 doctor 提示精简；超过 40000 个字符时插件拒绝本检出内的全部修改，只允许修改各目录 AGENTS.md、.opencode/workflow/**（不含 protection.json）和 opencode.jsonc。
- 新增的实现类子代理由 `/workflow-setup` 的子代理规划按项目建议、由用户选择；reviewer 唯一。使用操作者可用模型，不复制他人供应商名称或账号配置。通过向导为 implementer、reviewer 和新增子代理明确选择动态继承或固定模型，解释切换主模型后的差别和费用；核对最终有效配置，不写空 model、不删除代理权限。明确继承会记录选择；没有选择记录时 reviewer 未指定仍由 doctor 提示。
- 保护规则采用顺序最后命中；原生权限末尾必须与保护规则生成的块一致。检查真实凭据仍拒绝，示例例外不过宽。合并时保留模板中 `workflow_setup`、`workflow_release` 和 shell 运行接入 CLI apply 的 ask 规则。
- opencode.jsonc 保留 `"shell": "bash"`：守卫只解析 bash 语法；Windows 上它解析为 Git Bash。shell 不是 Bash（如 PowerShell、cmd、WSL 启动器）时，插件拒绝执行 shell 命令并给出提示。
- 核对项目实际的验证和构建命令能否在守卫下直接运行：守卫只放行支持清单内的首命令和能静态分析的写法，规则见 [守卫说明](template/.opencode/workflow/checks/README.md)。被拒绝的命令在接入报告中列明，由用户决定处理方式。
- 所有路径配置统一使用原生 `*`/`?` 语义：`*` 含 `/` 和点开头目录，`?` 匹配一个字符，其余按字面；花括号模式须拆成多条。
- core、tests 与 sync（文档与约束同步）始终覆盖全部变更，按风险新增专项检查单；不需要同步审核时删除 catalog 与 routing 中的 sync 条目。未知路径保守进入 common。
- 外部技能按模式选择。基础模式不依赖 Superpowers；完整模式将已核对来源的 Superpowers 作为设计和计划的前置，先安装、等待重载并核实实际技能正文和本会话读取证据。先查阅 [技能依赖清单](docs/skills.md)，不静默替换既有版本或修改全局范围。其他任务型技能按需选择；记录仓库、固定版本/commit SHA、技能 ID、范围和真实加载结果。
- 可选的质量扩展（optional/quality）在提交后依次报告注释、跳过测试、文档本地链接、已登记的格式检查和已登记的关联同步，只报告不拦截；格式工具读取工作区，修复仅手动运行。由用户决定是否启用，按其 README 复制脚本、登记已有本地工具和文件关联并安装 hook，不自动安装格式器。

- 可选的接入方 CI（[optional/ci](optional/ci/README.md)）依赖基础模板与完整质量扩展，按说明合并工作流和三个辅助脚本，不复制套件自身的开发 CI。确认历史凭据扫描、注释只提醒/其他问题阻断的策略，准备项目已有格式器；不要求安装本地 hook。实际 GitHub 运行与 required check 配置需由用户授权，未执行的 PR/fork 场景在接入报告中列明。

## 3. 合并模板

新项目（空目录）复制 template 全部内容后按新项目流程继续；已有项目逐项合并 AGENTS.md、opencode.jsonc、.gitignore 和 .gitattributes，保留注释、无关 MCP、已有模型与用户改动。.gitattributes 的两条规则让工作流脚本在 Windows（core.autocrlf=true）检出时保持 LF，不改动项目其他文件的换行约定。遇到同名 workflow.starter、代理、workflow-setup 或 workflow-new 命令、workflow-onboarding 或 workflow-new-project 技能时先确定升级/保留方式，不能重复加载或直接覆盖。根 AGENTS.md 的“项目概要”一节写明用途、技术栈、目录与领域和验证命令入口。

可执行插件放 `.opencode/plugins/workflow/`，依赖锁文件一起复制。其他目录内容不是活动配置，不自动复制可选扩展到启用位置。

维护 `.opencode/workflow/scopes.json`、`watchdog.json`、`review/catalog.json` 和 `review/routing.json`。启用质量扩展时，同时维护 `scripts/quality/quality.json` 的 sync 关联登记。`.opencode/workflow/protection.json` 由守卫和插件内置为代理只读，修复模式也不例外，没有询问放行入口；其创建、修改、升级合并及修复需交给用户在 OpenCode 之外完成，代理只提供拟议规则与差异。此限制不锁定插件或守卫代码，仍可按既有流程升级它们；守卫不是系统沙盒。填写真实验证命令及所需资源，不把示例命令报告为已验证命令。

## 4. 安装和检查

在目标根执行接入准备脚本，再运行检查和测试：

```bash
node scripts/workflow/setup.mjs
node scripts/workflow/doctor.mjs --root . --json
bash .opencode/workflow/checks/run-tests.sh
npm --prefix .opencode/plugins/workflow run typecheck
npm --prefix .opencode/plugins/workflow test
```

`setup.mjs` 安装插件依赖和固定版 Gitleaks、检测 OpenCode 并运行 doctor，然后指向 `/workflow-setup`。模型代为执行时保持非交互，不要加 `--opencode cli`：OpenCode 缺失或版本不符时，把脚本给出的安装或迁移命令交给用户确认，由用户决定是否安装全局软件。可选组件与模型选择由聊天向导收集，不把脚本 stdin 当作用户确认。

Windows 原生环境在 PowerShell 中执行时，把 `python3` 换成 `py -3`，守卫测试改为 `py -3 -m unittest discover -s .opencode/workflow/checks -t .opencode/workflow/checks -p "test_*.py"`。不要在 PowerShell 中调用 `bash`：那里的 `bash` 通常是 WSL 启动器。

doctor 不修改项目文件；失败需处理，不能通过删除保护配置消除错误。没有实际执行的项目构建、平台验收和原生插件运行标为未验证。

doctor 的 warn 项要在接入报告中逐项处理或说明：版本未验收、已跟踪文件命中凭据规则、已跟踪文件过多而未完成凭据扫描、未设置 shell、没有明确选择记录的 reviewer 未指定模型、继承策略冲突或代理文件中 model 为空、规则文件过长、接入档案记录的子代理缺少代理文件。状态为 unverified 的项（如当前会话技能/模型、原生运行、插件早于 doctor 时的规则大小）在报告中标为未验证；配置写入不等于真实加载。2.1.x 补丁版本告警不等于已通过原生验收；suite 的固定 CLI 可在套件目录运行 `node scripts/fetch-opencode.mjs` 获取。

## 5. 原生冒烟

在当前目标 Location 核插件实际来源，尤其关注嵌套 worktree 的祖先插件发现。文件存在不证明当前检出插件已加载。

使用合成临时文件验证普通编辑、受保护路径拒绝、未知领域规则加载和测试管道失败保留。用临时分支验证 `/review` 生成材料、只读 reviewer 提交和批次关闭。测试不能读取或复制真实秘密；涉及发布的演示使用无远程副作用的假入口。

套件的原生隔离测试证明套件机制，不证明新项目自己的构建或业务已通过。项目接入后仍按自身验收要求验证。

## 6. 交付接入报告

采用 [examples/adoption-report.md](examples/adoption-report.md)，记录实际修改、既有 AI 配置的决定与迁移结果、启用能力、命令/工作目录/退出码和必要证据，以及未验证项。保留当前 Git diff 给维护者核对。不要自动推送、发布或创建生产凭据。
