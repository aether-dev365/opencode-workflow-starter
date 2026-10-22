# OpenCode Workflow Starter

一套可复制到新项目的 OpenCode V2 工作流：领域规则、文件保护、提交凭据扫描、任务协作、手动审核及可选发布核查。业务目录、框架、模型供应商和生产地址由目标项目自行配置。

**给新项目模型的入口：[ADOPT.md](ADOPT.md)。** 可以直接告诉模型：

> 请阅读工作流套件的 ADOPT.md，根据本项目实际结构接入模板，保留现有约定，完成自检和验收，并报告未验证项。

## 目录

| 目录 | 用途 |
| --- | --- |
| [template/](template/) | 复制到目标项目的实际文件，包含插件、规则和测试 |
| [examples/](examples/) | 领域规则、任务卡、证据和接入报告范本 |
| [optional/release/](optional/release/) | 显式启用的发布审核和固定入口 |
| [optional/production/](optional/production/) | 默认禁用的只读 MCP 配置示例 |
| [optional/stacks/](optional/stacks/) | 按技术栈核实命令的接入指引 |
| [scripts/](scripts/) | 固定版本 CLI 获取与套件验证入口 |
| [tests/](tests/) | 分发、自检、独立接入和原生运行测试 |

## 空项目快速开始

1. 从干净分发包解压，在独立 Git 项目根目录复制其中 `template/` 的内容，包括隐藏文件。已有项目按 ADOPT.md 合并，避免覆盖已有配置。开发检出内的 node_modules、__pycache__ 和运行状态不要复制；分发包已排除这些文件。
2. 运行下列命令。Node.js 24、Python 3.10+、Git、Linux/WSL；OpenCode 与插件验收基线均为 **2.1.1**。

```bash
npm --prefix .opencode/plugins/workflow ci --ignore-scripts
python3 .opencode/secret-scan/install.py
node scripts/workflow/doctor.mjs --root .
```

3. 在目标 Location 启动 OpenCode，核 `workflow.starter` 的实际加载来源和 active 状态。插件目录自动发现，**不要再在 plugins 配置中重复登记**。
4. 补充项目概要、真实验证命令和领域规范；维护 scopes、protection 和 review 路由。模型沿根 AGENTS.md 按需阅读，不一次灌入所有文档。

doctor 的 `native-runtime: unverified` 是正常的静态检查边界，不是原生运行通过。OpenCode 2.1.1 为 pass，其他 2.1.x 为 warn，需在该版本做原生冒烟并记录；其余版本为 fail。warn 不导致非零退出，但要逐项处理或说明。无效配置和缺依赖仍为 fail。可以通过 `WORKFLOW_OPENCODE_BIN` 指定独立版本的 CLI，不需要替换机器默认安装。

doctor 也会检查 pipefail.json 和已跟踪文件的读取保护命中。`*.env.*` 可能覆盖 `src/app.env.ts` 等源码：确认误伤后追加精确 allow；若是真实凭据，须移出仓库并轮换。

## 默认行为

- 日常修改由主代理完成；契约明确、文件范围独立时才委派实现者。
- 未加载领域规则时首次修改拒绝，下一轮加载正文后重试；压缩和切换检出重新确认规则。
- 凭据、第三方和生成路径由声明式规则保护。所有路径配置（保护、范围映射、审核路由、发布范围）统一采用原生语义：`*` 匹配任意字符（含 `/` 和点开头的目录），`?` 匹配一个字符，其余按字面；不支持花括号。
- 提交前扫描新增内容，暂存与提交分两次调用。扫描器缺失或失败不能通过。
- `/review` 由用户触发，只读 reviewer 提交结构化结论；普通提交不自动产生模型审核。
- 看门狗只提醒，不承诺自动中止或接管。
- 配置无效时（映射指向缺失文件、JSON 错误、发布配置无效），插件仍为 active：拒绝写入并给出原因；读取，以及对 `.opencode/workflow/**`、`opencode.jsonc`、各目录 `AGENTS.md` 的修复编辑仍可用。`protection.json` 本身无效时所有读写都拒绝，需要在 OpenCode 之外修复（例如在终端 `git checkout -- .opencode/workflow/protection.json`）。
- 不在 Git 检出内时读写和 shell 都会被拒绝，先 `git init`。

插件和 shell 解析不构成操作系统沙盒，任意外部脚本与终端不在自动拦截承诺内。生产能力默认不启用。外部通用技能和 CodeGraph 都可选，不是运行依赖。

## 套件开发验证

```bash
npm --prefix template/.opencode/plugins/workflow ci --ignore-scripts
python3 template/.opencode/secret-scan/install.py
node scripts/fetch-opencode.mjs
node scripts/verify.mjs
```

原生测试使用独立 HOME/XDG、临时 Git 仓库、loopback 假模型和假 MCP，不调用真实模型或生产服务。需要 OpenCode 2.1.1；版本不符明确失败。完整接入测试会在临时项目重新 `npm ci`，需访问 npm registry 或准备 npm 缓存。

获取脚本仅支持 linux-x64，固定官方 npm 发布包的 SHA-256，安装到忽略目录 `.verification/runtime/`；已有正确版本时直接复用。其他平台通过 `WORKFLOW_OPENCODE_BIN` 指定 CLI，平台验收另行记录。

插件升级时同步 @opencode/plugin、@opencode/client 与 CLI 基线，运行类型检查、守卫和原生验收；版本号一致本身不证明兼容。

## 版本管理

提交模板源码、依赖锁文件、接入指南、示例、可选扩展及验证脚本。开发计划 `docs/superpowers/`、单次验收记录 `docs/verification.md`、技能辅助目录 `.superpowers/`、验证产物 `.verification/`、分发包 `artifacts/`、依赖安装目录、缓存和工作流运行状态留在本地，由 `.gitignore` 排除。

接入业务项目时，按 ADOPT.md 合并 `template/` 内容；套件根目录的开发和维护文件无需一并复制。

## 本地交付

在套件根目录从已提交的版本生成干净分发包：

```bash
mkdir -p artifacts
git archive --format=tar.gz --output=artifacts/opencode-workflow-starter.tar.gz HEAD
sha256sum artifacts/opencode-workflow-starter.tar.gz > artifacts/opencode-workflow-starter.tar.gz.sha256
```

分发包仅包含已提交的模板、指南、扩展和验收脚本。开发依赖和完整验收日志留在当前检出的忽略目录，便于复验。
