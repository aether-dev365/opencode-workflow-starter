# 给接入模型的操作指南

目标是把 `template/` 的工作流融入当前项目，不是把当前项目改成模板示例的目录或技术栈。此文件只在首次接入和升级时阅读；日常入口是目标项目根 AGENTS.md。

## 1. 调查真实项目

记录绝对目标目录和 Git 状态。先读现有 AGENTS.md、OpenCode 配置、包元信息和开发手册，保留未提交工作。

查明实际源码目录、第三方目录、生成文件及其生成入口、凭据文件的路径（不读其内容）、验证命令、运行平台及资源约束。通过文件和命令自行确定；仅对影响流程或权限而无法确定的决定提问。

查明当前 OpenCode、Node、Python 和 Git 版本。基础包使用 OpenCode 2.1.2 验收；若目标版本不同，先验证兼容或提出升级计划，不悄悄替换依赖。

先执行 `opencode --version`；设置了 `WORKFLOW_OPENCODE_BIN` 时，同时核对该路径的版本。未安装、不是 V2 或无法识别时，向用户展示检测结果，提供 [OpenCode V2 安装指南](template/docs/workflow/opencode-install.md)、[官方安装入口](https://opencode.ai/v2/docs/) 和 `npm install -g @opencode/cli@2.1.2`，完成安装或修正命令路径并复查后再接入。已有 V1 按指南保留配置并处理迁移，不在 V1 宿主中加载本模板的 V2 插件。

## 2. 给出接入清单

列出拟新增、合并及保持现有的文件。明确目录映射、保护路径与允许例外、实际命令、审核分区、角色、所需扩展及尚未确定项。

- 根规则保持简短，领域正文只写一份。跨目录路径通过 scopes.json 引用正文。写法见 [领域规则范本](examples/domain-AGENTS.md)：只写现行规则和原因，指向手册时写明何时阅读。每个规则文件（含根 AGENTS.md）超过 20000 个字符时 doctor 提示精简；超过 40000 个字符时插件拒绝本检出内的全部修改，只允许修改各目录 AGENTS.md、.opencode/workflow/** 和 opencode.jsonc。
- 默认 implementer 可先保留一个，确有独立领域时才拆角色。使用操作者可用模型，不复制他人供应商名称或账号配置。reviewer 在 opencode.jsonc 的 agents.reviewer.model 显式指定；未指定时 doctor 给出提示，在接入报告中说明原因。
- 保护规则采用顺序最后命中；原生权限末尾必须与保护规则生成的块一致。检查真实凭据仍拒绝，示例例外不过宽。
- opencode.jsonc 保留 `"shell": "bash"`：守卫只解析 bash 语法；Windows 上它解析为 Git Bash。shell 为 PowerShell、cmd 或 WSL 启动器时，插件拒绝执行 shell 命令并给出提示。
- 所有路径配置统一使用原生 `*`/`?` 语义：`*` 含 `/` 和点开头目录，`?` 匹配一个字符，其余按字面；花括号模式须拆成多条。
- core/tests 始终覆盖全部变更，按风险新增专项检查单。未知路径保守进入 common。
- 通用技能可选。先查阅 [技能依赖清单](docs/skills.md)，按任务选择来源并核实实际可用性；未安装的技能不能成为硬性操作入口。在接入报告中记录选用的仓库、版本或 commit SHA、技能 ID 和安装范围。
- 可选的质量扩展（optional/quality）在提交后报告新增注释和跳过测试的问题，只报告不拦截；由用户决定是否启用，启用后按其 README 安装 hook。

## 3. 合并模板

空项目可以复制 template 全部内容；已有项目逐项合并 AGENTS.md、opencode.jsonc、.gitignore 和 .gitattributes，保留注释、无关 MCP、已有模型与用户改动。.gitattributes 的两条规则让工作流脚本在 Windows（core.autocrlf=true）检出时保持 LF，不改动项目其他文件的换行约定。遇到同名 workflow.starter 或同名代理先确定升级/保留方式，不能重复加载。

可执行插件放 `.opencode/plugins/workflow/`，依赖锁文件一起复制。其他目录内容不是活动配置，不自动复制可选扩展到启用位置。

维护 `.opencode/workflow/scopes.json`、`protection.json`、`watchdog.json`、`review/catalog.json` 和 `review/routing.json`。填写真实验证命令及所需资源，不把示例命令报告为已验证命令。

## 4. 安装和检查

在目标根执行接入准备脚本，再运行检查和测试：

```bash
node scripts/workflow/setup.mjs
node scripts/workflow/doctor.mjs --root . --json
bash .opencode/workflow/checks/run-tests.sh
npm --prefix .opencode/plugins/workflow run typecheck
npm --prefix .opencode/plugins/workflow test
```

`setup.mjs` 安装插件依赖和固定版 Gitleaks、检测 OpenCode 并运行 doctor。模型代为执行时保持非交互，不要加 `--opencode cli`：OpenCode 缺失或版本不符时，把脚本给出的安装或迁移命令交给用户确认，由用户决定是否安装全局软件。

Windows 原生环境在 PowerShell 中执行时，把 `python3` 换成 `py -3`，守卫测试改为 `py -3 -m unittest discover -s .opencode/workflow/checks -t .opencode/workflow/checks -p "test_*.py"`。不要在 PowerShell 中调用 `bash`：那里的 `bash` 通常是 WSL 启动器。

doctor 不修改项目文件；失败需处理，不能通过删除保护配置消除错误。没有实际执行的项目构建、平台验收和原生插件运行标为未验证。

doctor 的 warn 项（版本未验收、已跟踪文件命中凭据规则）要在接入报告中逐项处理或说明。2.1.x 补丁版本告警不等于已通过原生验收；suite 的固定 CLI 可在套件目录运行 `node scripts/fetch-opencode.mjs` 获取。

## 5. 原生冒烟

在当前目标 Location 核插件实际来源，尤其关注嵌套 worktree 的祖先插件发现。文件存在不证明当前检出插件已加载。

使用合成临时文件验证普通编辑、受保护路径拒绝、未知领域规则加载和测试管道失败保留。用临时分支验证 `/review` 生成材料、只读 reviewer 提交和批次关闭。测试不能读取或复制真实秘密；涉及发布的演示使用无远程副作用的假入口。

套件的原生隔离测试证明套件机制，不证明新项目自己的构建或业务已通过。项目接入后仍按自身验收要求验证。

## 6. 交付接入报告

采用 [examples/adoption-report.md](examples/adoption-report.md)，记录实际修改、启用能力、命令/工作目录/退出码和必要证据，以及未验证项。保留当前 Git diff 给维护者核对。不要自动推送、发布或创建生产凭据。
