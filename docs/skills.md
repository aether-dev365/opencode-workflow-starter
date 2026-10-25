# 技能依赖与可选来源

## 结论

**基础模式没有必须额外安装的第三方技能；完整引导模式把 Superpowers 作为设计和计划的前置。** 基础工作流插件、守卫和 `/review` 仍独立可用。使用 `/workflow-setup` 明确选择模式：完整模式先核对安装来源和当前会话可加载性，再实际读取 brainstorming/writing-plans；缺失时停止在安装/重载阶段，不模拟技能。

`template/opencode.jsonc` 不预先登记外部技能包，也不替用户批准安装。通过向导选择项目级或个人全局范围后才生成安装计划。未选择完整模式时，按照模板的 AGENTS.md 和开发、测试、审核文档即可工作。

需要增强模型的工作方法时，可以按下表选用。这里的“官方”指对应项目或厂商维护，不代表都是 OpenCode 官方组件。

| 来源 | 维护方与性质 | 相关技能 | 是否需要额外安装 |
| --- | --- | --- | --- |
| [anomalyco/opencode](https://github.com/anomalyco/opencode) | OpenCode 官方 | `opencode`、`report` | 由 OpenCode 内置提供，以当前版本实际可用列表为准 |
| [obra/superpowers](https://github.com/obra/superpowers) | 第三方开发工作流套件 | 需求澄清、计划、调试、TDD、验证、协作等 | 完整模式必需；基础模式可不安装 |
| [anthropics/skills](https://github.com/anthropics/skills) | Anthropic 官方技能仓库 | `frontend-design`、`webapp-testing` | 对应任务按需安装；已有同 ID 技能时先核对来源 |

OpenCode、Node.js、Python、Git、Gitleaks 及 npm 依赖属于运行环境或工具依赖，安装入口见 [README](../README.md)。CodeGraph 和 Playwright MCP 属于工具集成，不是技能；配置了这些工具也不等于安装了同用途技能。

## OpenCode 官方技能

| 技能 ID | 用途 | 来源 |
| --- | --- | --- |
| `opencode` | 查询 OpenCode V2 的配置、插件、MCP、API 和使用方式 | [官方源码](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/skill/opencode.md) |
| `report` | 用户要求报告 OpenCode 问题时收集诊断并提交 issue | [官方源码](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/skill/report.md) |

这两项是 OpenCode 自身的辅助技能，不是本模板提供的技能，也无需为了接入模板单独克隆 OpenCode 源码。

## Superpowers 技能清单

来源：[obra/superpowers/skills](https://github.com/obra/superpowers/tree/main/skills)。基础模式可按需选用；完整模式先核验设计/计划所需技能，之后仍按实际任务选择方法，不强制每次修改运行所有技能。

| 技能 ID | 适用任务 |
| --- | --- |
| `using-superpowers` | Superpowers 技能使用规则和宿主工具映射 |
| `brainstorming` | 澄清需求、比较方案、确定设计 |
| `writing-plans` | 将已明确的设计拆成实施任务 |
| `executing-plans` | 主代理按照计划顺序实施 |
| `subagent-driven-development` | 按计划委派相对独立的实现任务 |
| `dispatching-parallel-agents` | 并行处理互不依赖的任务 |
| `systematic-debugging` | 复现问题、定位原因、验证修复 |
| `test-driven-development` | 使用 TDD 实现功能或修复缺陷 |
| `verification-before-completion` | 在宣称完成前收集实际验证证据 |
| `using-git-worktrees` | 需要隔离检出时使用 Git worktree |
| `requesting-code-review` | 请求模型代码审核 |
| `receiving-code-review` | 核实审核意见并实施必要修正 |
| `finishing-a-development-branch` | 完成开发分支并处理集成收尾 |
| `writing-skills` | 编写和验证新的技能 |
| `diagnosing-superpowers` | 分析 Superpowers 使用过程中的问题 |

完整插件会注册整套技能并注入使用规则，不能把它理解为只增加几个手动命令。启用前应明确与项目流程的衔接：本模板的普通实现不自动派 reviewer；需要正式审核时，由用户触发 `/review`。Superpowers 的审核技能本身不会生成本模板所要求的结构化审核结论，也不能替代该入口。

工作树的使用还需遵守 [开发协作说明](../template/docs/workflow/development.md) 中的插件发现约束。

### OpenCode V2 安装方式

上游入口：[安装指南](https://github.com/obra/superpowers/blob/main/.opencode/INSTALL.md)、[OpenCode 使用说明](https://github.com/obra/superpowers/blob/main/docs/README.opencode.md)。

如选择完整 Superpowers 插件，将以下条目合并到项目 `opencode.jsonc`；个人跨项目使用则合并到 `~/.config/opencode/opencode.jsonc`。保留已有配置和插件条目。

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "superpowers@git+https://github.com/obra/superpowers.git#2ce8aa15d05bd57213e6f746f953aafb7ded7a8b"
  ]
}
```

向导固定到 `v7.0.1` 对应的完整 commit SHA，并核对插件入口和关键技能正文摘要。上游说明 OpenCode V2 插件支持要求为 OpenCode 2.0.4+、Superpowers v6.4.1+；本模板自身的验收基线仍为 OpenCode 2.1.4。已有其他版本不会静默覆盖；未在向导核验范围的版本保持未验证，需明确选择兼容验收或固定版本，不自动降级。

重新加载配置后，确认实际 Superpowers 插件 active 且来源正确，再通过原生 skill 工具读取对应技能。`workflow_setup` 核对当前 Location 的真实正文和本会话成功读取结果；仅列出技能、配置写入、其他会话读取或模型声明都不能替代。`workflow.starter` 已通过模板目录自动发现，无需因安装 Superpowers 而重复登记。

## Anthropic 官方的任务型技能

| 技能 ID | 适用任务 | 来源与额外要求 |
| --- | --- | --- |
| `frontend-design` | 新建或调整 UI 时确定视觉方向、排版和布局 | [技能目录](https://github.com/anthropics/skills/tree/main/skills/frontend-design)；按项目实际前端技术栈实施 |
| `webapp-testing` | 验证本地 Web 应用的交互、截图和浏览器日志 | [技能目录](https://github.com/anthropics/skills/tree/main/skills/webapp-testing)；其脚本方案需要 Python Playwright 和浏览器运行环境 |

服务端、CLI 或没有 Web UI 的项目无需为了模板安装这两项。`webapp-testing` 的 Python Playwright 脚本与 Playwright MCP 是不同接入方式。

按选定的上游 tag 或 commit 获取技能，将目标技能的完整目录放入项目 `.opencode/skills/`，或个人目录 `~/.config/opencode/skills/`。保留其支持脚本、参考文件和许可证，不要只复制 SKILL.md 后遗漏引用文件。

```text
.opencode/skills/
├── frontend-design/
│   └── SKILL.md
└── webapp-testing/
    ├── SKILL.md
    ├── scripts/
    └── examples/
```

上图只展示主要结构；实际以所选版本目录为准。OpenCode 会自动发现这些技能。`skills` 配置中的 HTTP URL 必须是包含 `index.json` 的技能目录服务，不能直接把 GitHub 仓库网页地址填进去。安装前检查同 ID 技能，避免后加载的定义覆盖原有来源。

## 接入记录与验证

在 [接入报告](../examples/adoption-report.md) 中记录选用的仓库、tag 或 commit SHA、技能 ID、安装范围，以及实际加载验证结果。需要随项目分发技能时，将完整技能目录和来源记录一并纳入版本管理。

本清单核对上游仓库、技能名称和 OpenCode V2 的加载方式。套件原生验收覆盖固定 Superpowers 版本的关键技能加载与向导门槛，不代表所有第三方技能组合、模型实际调用或新项目业务都已验收。目标项目仍应确认实际可见、可加载，并验证任务所需的工具和脚本。

参考：[OpenCode V2 Skills](https://opencode.ai/v2/docs/skills/)、[配置](https://opencode.ai/v2/docs/config/)、[插件加载](https://opencode.ai/v2/docs/plugins/)。
