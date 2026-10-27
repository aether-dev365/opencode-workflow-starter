# 引导式接入与使用

`/workflow-setup` 让主会话先解释、再询问、最后应用可审阅的配置。它不是“全部安装”的快捷命令，也不会自动提交、推送或发布。

## 首次接入

从空目录开始的新项目改用 `/workflow-new`：它在最小接入时和项目规则完成后各调用一次本向导，两轮之间完成设计、搭骨架和项目规则，见 [新项目流程](new-project.md)。

已有项目先保留 Git 工作区，逐项合并基础模板和已有规则、OpenCode 配置、忽略文件。不要直接覆盖已有项目。运行 `node scripts/workflow/setup.mjs` 准备依赖，确认 OpenCode 中 `workflow.starter` 已加载，再输入：

```text
/workflow-setup
```

向导本身不依赖 Superpowers，避免“先有技能才能安装技能”的循环。它会读取实际项目和宿主状态，对不能自动确定的决定提问。提问取消、无法交互或缺少明确批准时不安装。

已经接入的项目也使用同一个入口；先展示之前的选择，只处理新增问题或冲突。命令或工具不可见时先检查实际 Location 和插件加载，不把磁盘上有文件当成已经加载。

## 既有 AI 配置

向导先检查项目里是否已有其他 AI 工具的配置和工作流。检测只看 Git 文件清单（已跟踪和未被忽略的文件，被忽略的个人文件不算）中的标记和文件数，不解析各工具的格式；除判断 `CLAUDE.md`、`GEMINI.md` 是否只引用 `AGENTS.md` 外，不读取文件内容。

| 工具 | 标记 | OpenCode V2 |
| --- | --- | --- |
| Claude Code | `CLAUDE.md`、`.claude/`、`.mcp.json` | `.claude/skills` 作为技能加载；其余不读取 |
| Cursor | `.cursor/`、`.cursorrules`、`.cursorignore` | 不读取 |
| Codex | `.codex/`、`AGENTS.override.md` | 不读取；`AGENTS.md` 本来共用 |
| Agent Skills（Codex 等） | `.agents/` | `.agents/skills` 作为技能加载 |
| GitHub Copilot | `.github/copilot-instructions.md`、`.github/instructions/`、`.github/prompts/`、`.github/agents/`、`.github/chatmodes/`、`.vscode/mcp.json` | 不读取 |
| Gemini CLI | `GEMINI.md`、`.gemini/` | 不读取 |
| Windsurf | `.windsurfrules`、`.windsurf/` | 不读取 |
| Cline、Roo Code | `.clinerules`、`.roo/`、`.roomodes` | 不读取 |
| Aider | `.aider.conf.yml` | 不读取 |
| Kiro、Continue、Zed、Junie、Amazon Q、Trae、Augment | `.kiro/`、`.continue/`、`.rules`、`.junie/`、`.amazonq/`、`.trae/`、`.augment/`、`.augment-guidelines` | 不读取 |
| OpenCode（本模板以外） | 根 `.opencode/` 下模板与向导以外的代理、命令、技能、插件等；子目录中的 `.opencode/`、`opencode.json`、`opencode.jsonc` | 加载 |

目录标记和 `CLAUDE.md`、`GEMINI.md`、`AGENTS.override.md` 在任意子目录中识别，其余标记只认项目根。`.claude/skills`、`.agents/skills` 单独列出，目录标记本身是符号链接时整体列为一项；子目录中的技能和 OpenCode 配置只在工作目录位于其下时生效。`.opencode/opencode.json(c)` 会覆盖根目录 `opencode.jsonc` 的同名设置，可能改变 shell、权限和代理模型。模板文件、领域规则 `AGENTS.md` 和向导生成的子代理不算既有配置；但 `.opencode/` 下 `agents`、`agent`、`commands`、`command` 目录（含子目录）和 `modes`、`mode` 目录本身中的 `AGENTS.md` 会被 OpenCode 加载为代理或命令，照常列出。

同目录有 `AGENTS.md`，并且 `CLAUDE.md` 或 `GEMINI.md` 只写一行 `@AGENTS.md`、是指向它的符号链接，或是 Git 在不支持符号链接的检出中写出的占位文件（内容为 `AGENTS.md`）时，列为共用单一来源，不需要决定。

个人目录中会被 OpenCode 加载进本项目的位置（`~/.claude/skills`、`~/.agents/skills`，以及 OpenCode 个人目录下的规则、代理、命令、技能和插件）只报告条目数，不要求决定，也不写入共享配置；个人 `opencode.json(c)` 会被读取解析，只统计其中登记的插件数，不输出其他内容。

### 决定与门槛

每个检测项都由用户决定迁移（`migrate`）或保留（`keep`），记录在 `onboarding.json` 的 `existing` 中，键是检测结果里的 path 原样。还有未决定的项时不生成配置计划；已接入的项目出现新的配置，或 version 1 档案的项目中检测到既有配置时，`verify`、`finish` 不就绪；迁移项在 `verify` 中列为未验证，由用户核对迁移是否完整、等价。取消或没有答复的项保持未决定，不由 AI 代填；已记录的决定只展示，不重复询问。

检测未完成时同样不生成计划，`verify` 不就绪，提示里给出处理方法：Git 无法列出文件、超时或清单过大，超过 100 处既有配置，或检测项的路径不是有效 UTF-8、含 `\` 或控制字符、以 `~` 开头、超过 512 个字符而无法记录决定。与检测项无关的文件名不影响检测。

AI 逐项阅读后说明：用途，以及 OpenCode 是否加载；与本工作流的重叠，例如拦截读取 `.env` 的钩子对应路径保护、提交前扫描对应 Gitleaks、格式化钩子对应质量扩展；冲突，例如要求自动提交或推送、跳过测试或 `--no-verify`、指定 PowerShell、`bash -c` 一类写法、写受保护路径、与 Superpowers 或向导技能同 ID 的技能、带写权限或能访问生产的 MCP、向 OpenCode 注入整套工作流的其他插件；最后建议迁移还是保留，并说明理由和迁移去向。可能含凭据的文件（各类 MCP 配置、`.claude/settings*.json`、`.codex/config.toml`、`.gemini/settings.json`、`.aider.conf.yml`）只看结构，不复述凭据值，也不写进被跟踪的文件。

### 迁移

应用配置后，AI 按决定逐项迁移：每项先展示差异或新文件全文，确认后用普通编辑写入，同样受守卫和领域规则约束。原文件默认保留；原工具支持引用或本身读取 `AGENTS.md` 的改为引用，例如 `CLAUDE.md` 只留 `@AGENTS.md`；只有用户逐项明确要求时才删除原文件。

| 原内容 | 迁到哪里 |
| --- | --- |
| 规则 | 全局、简短的放根 `AGENTS.md`，其余放领域 `AGENTS.md` 并经 `scopes.json` 映射；去掉工具专属说法，与守卫冲突的条目不迁，列给用户 |
| 子代理 | 子代理规划中的受管子代理；只读审核类改为审核检查单 |
| 命令、提示 | `.opencode/commands/<name>.md`，`$ARGUMENTS` 照用；涉及发布或生产的不迁，改为使用受控发布 |
| 技能 | OpenCode 已加载，通常保留；需要 OpenCode 专用版本时复制到 `.opencode/skills`，其优先级更高 |
| MCP | `opencode.jsonc` 的 `mcp.servers`（V2 格式），凭据用环境变量引用；有写权限或能访问生产的按只读 MCP 扩展处理 |
| 钩子、权限 | 工作流已覆盖的不迁；禁止读写一类的规则整理成 `protection.json` 的拟议差异，由用户在 OpenCode 之外修改；其他列为待决定 |

迁到 `.opencode/commands`、`.opencode/skills` 的文件不受向导管理，迁移后同样会被检测：在作出迁移决定的同一次选择中，把计划的目标路径（`.opencode/commands/<name>.md`、`.opencode/skills/<id>`）记为保留，迁移后就不会再要求决定。不通过 `instructions` 配置引入其他工具的规则：这些文件不经过领域规则加载和大小检查。迁移后重新运行 `verify`，确认没有未决定的项，并复查保留项是否仍有冲突。

## 模式

| 选择 | 能力 | 前置条件 |
| --- | --- | --- |
| 完整流程，推荐 | 使用 Superpowers 进行需求澄清、设计、计划、调试和验证；保留本工作流守卫与正式审核 | 已核对的 Superpowers 实际加载，当前会话读取所需技能 |
| 基础保护 | 路径保护、提交前凭据扫描、领域规则、手动审核等基础能力 | 不要求外部技能 |

完整模式缺少技能时，先解释来源和行为，再选择项目级安装、个人全局安装、基础模式或取消。项目级是推荐范围；个人全局配置会影响其他项目，需要单独确认。Superpowers 会注入工作方法规则，不只是增加手动命令。

安装使用已核对的固定来源。已有不同版本不静默替换；兼容性未验证时可以保留并改用基础模式，或在明确批准后人工处理旧来源，再安装固定版本。基础模式不会卸载已有 Superpowers，也不保证其他全局插件不再注入自己的规则。

安装与生效是两步：OpenCode 可能需要等待后台安装、配置重载或重启。向导会在当前宿主核对插件来源和技能正文，并要求实际读取 `brainstorming`、`writing-plans`。只是列出技能、读取其他同名文件、模型口头声称已读，均不算通过。重载、切换 Location 或上下文压缩后可能需要重新读取技能，已保存的选择不需要重填。

## 子代理规划

implementer 和 reviewer 始终保留。AI 根据项目实际情况建议是否新增实现类子代理、新增几个，依据包括：`scopes.json` 的领域与领域规则、目录结构、monorepo 工作区声明（`package.json` 的 workspaces、`pnpm-workspace.yaml`、`go.work`、Cargo workspace 等）、技术栈、成规模的测试/文档/基础设施工作，以及决定迁移的其他工具子代理。每个有独立规则和独立验证命令的领域可以对应一个子代理；同一领域内不按文件类型拆分；项目小或只有一个领域时建议不新增。新项目第一轮还没有领域时建议不新增，骨架和领域规则完成后的第二轮再规划。固定模型按角色计费，每个子代理都有新的上下文；默认并行上限仍为两个。

AI 先说明“建议新增 N 个”，用表格列出名称、职责、依据和建议的模型策略，再多选；用户可以改名或改职责。明确不需要时记录为空数组，取消则停留在本阶段。

只能新增实现类子代理。名称以小写字母开头，只用小写字母、数字和连字符，长度 2–40，不能与内置代理、implementer、reviewer 同名，不能包含 review、reviewer 段，也不能是 Windows 保留的设备名（如 `con`、`nul`、`com1`）或 `constructor`；需要更多审核视角时增加检查单。向导按固定模板生成 `.opencode/agents/<名称>.md`：权限与 implementer 相同，禁止再派代理、访问生产和发布；正文由 AI 写的职责重点加上 implementer 的协作边界组成，预览中展示全文。frontmatter 中的注释带生成摘要，用来识别文件是否被人工修改；被修改过的文件、手写的同名文件或同名代理配置都报冲突并保留原文件。新的选择中去掉某个子代理时，不删除文件和模型配置，它会作为既有 OpenCode 配置，要求决定保留或迁移。

`verify`、`finish` 逐个核对受管子代理在宿主中的实际加载和有效模型，代理文件被人工修改过时列为待你核对；doctor 在接入档案记录的子代理缺少代理文件时报 warn。

## 模型选择

向导展示宿主模型目录和当前会话模型，再询问 implementer、reviewer 与向导生成的子代理的策略。它管理 implementer、reviewer 和向导生成的子代理，不重写 build、general、explore 或项目其他已有代理的模型；独立实现任务按领域派给对应的实现类子代理或 implementer，正式审核由 `/review` 使用 reviewer。

两种策略分别是：

- **继承**：跟随发起该子代理的会话模型及其思考强度；以后切换主会话模型，后续子代理也随之变化。
- **固定**：绑定某个具体模型及可选 variant；即使主会话换模型，它仍保持指定值。

思考强度即模型的 variant。选固定时，若该模型提供可选的思考强度，向导会再问一次，列出可选值和“默认（不指定）”；没有选择就使用模型默认，不跟随主会话当前的思考强度。继承时子代理跟随主会话的模型和思考强度，OpenCode 不支持只继承模型、单独指定思考强度，需要单独指定时改选固定。预览计划会列出每个角色的思考强度。

“固定为当前模型”仍属于固定，不等于继承。只从实际目录中选择 ID，不复制别人的供应商名称或账号。本向导的角色模型写入项目配置，固定 ID 会随项目共享；选择个人全局安装 Superpowers 不会把模型配置范围也改成全局。模型可见、已启用和实际认证调用成功是不同事实；向导不会为了探测模型而自动产生付费调用，也不要求把 API key 粘贴到聊天中。

继承不会写入空 model。上级、个人配置或代理文件覆盖选择时，向导会报告冲突，而不是只删除一个项目字段就宣称生效。reviewer 的只读权限独立于模型策略，始终保留。

没有接入选择记录时，doctor 继续提示 reviewer 未指定模型。明确选择继承后不再作为漏配警告，但有效配置仍由宿主核对。

## 可选能力

| 组件 | 选择说明 | 不会自动做的事 |
| --- | --- | --- |
| 质量扩展 | 不新增、仅检查工具、检查工具加提交后提醒 | 不下载格式器，不自动修复/暂存；本地提醒不拦截提交 |
| GitHub Actions | 依赖完整质量扩展，不依赖本地 hook | 不覆盖已有同名 CI，不自动推送或配置 required check |
| 受控发布 | 需要真实固定 argv、范围、产物和正式审核配置 | 不启用示例入口，不执行真实发布 |
| 只读 MCP | 需要实际服务、认证和权限范围 | 不生成凭据，不把连接成功当成只读权限证明 |

新项目第一轮可以先都不选：格式工具、验证命令和 CI 都依赖技术栈，骨架和项目规则完成后的第二轮再选。

“不新增”不等于卸载。已有能力会显示为保留，配置不会被悄悄删除。已有 hook/hooksPath 或同名不同内容的文件会提示合并，不能用覆盖消除冲突。

质量与 CI 的标准文件可以从完整套件目录复制。发布和 MCP 需要项目实际信息，向导会列出人工待配置事项，由 AI 根据扩展说明协助完成；没有配置时不能报告已启用。即使已配置，远端 CI、真实发布和 MCP 服务端权限仍需要各自的验收。

## 预览与批准

应用前应看到：模式、安装范围、既有 AI 配置的决定及其影响、生成的子代理全文、模型策略、所有组件、拟修改文件、保留项和待处理项。安装器保存不含既有配置正文的内容摘要计划，用户确认的 id 绑定该计划。

若预览后文件、来源或目标发生变化，应用会拒绝，需重新预览确认。重复应用已完成且未变化的计划不会再次添加插件。状态目录必须被 Git 忽略且不能被跟踪；不能通过符号链接把计划写入其他目录。

原生应用使用 `workflow_setup` 权限。默认需要确认；用户保存的 always 许可可能使后续符合规则的请求直接放行，这不等于每次都重新点击了批准。拒绝后不得改用 shell 绕过：模板的原生权限对 shell 中运行 `onboarding.mjs apply` 同样要求确认。原生 shell 规则只检查解析器识别出的命令，不是可靠的权限边界。

## 非交互脚本与恢复

脚本供明确选择后的执行与排错使用，不承担聊天提问。所有命令输出 JSON；错误退出 2。它不声称当前 OpenCode 会话已经读取技能。

```bash
node scripts/workflow/onboarding.mjs status
node scripts/workflow/onboarding.mjs bootstrap --scope project
```

bootstrap 只生成 Superpowers 计划，不立即安装。全局范围必须显式使用 `--scope global`；它尊重个人配置目录，不会自动修改系统管理配置。

完整选择文件示例（用户确实选择基础模式时）：

```json
{
  "version": 2,
  "mode": "basic",
  "superpowers": "none",
  "models": {
    "implementer": { "mode": "inherit" },
    "reviewer": { "mode": "inherit" }
  },
  "agents": [],
  "existing": {},
  "components": {
    "quality": "off",
    "ci": false,
    "release": false,
    "mcp": false
  }
}
```

version 1 的旧档案照常读取；生成计划必须使用 version 2，没有新增子代理和既有 AI 配置时分别写 `[]` 与 `{}`。

把实际答案保存到被忽略的 `.opencode/workflow/.state/onboarding/answers.json`，文件必须是独立的 UTF-8 JSON 常规文件，最多 64 KiB；无效内容不会在错误信息中回显。然后预览；选择质量/CI 时增加 `--source`，指向完整套件目录，而不是只复制后的模板目录。

```bash
node scripts/workflow/onboarding.mjs plan --answers .opencode/workflow/.state/onboarding/answers.json
```

看过输出并批准后，将同一个实际摘要分别传给 `--plan` 与 `--confirm`：

```bash
node scripts/workflow/onboarding.mjs apply --plan <实际摘要> --confirm <实际摘要>
```

不要照抄占位摘要，也不要把确认参数当成绕过用户决定的办法。完成配置后回到 OpenCode 运行 `/workflow-setup`，由实际宿主验证当前模型、技能和 doctor。状态目录是恢复记录，不是可编辑的批准凭证。

## 安装后怎么用

- **提出新需求**：完整模式先核对技能，再澄清需求、确认设计和实施计划；基础模式遵循项目现行开发约定。小修改与架构工作应按所选技能区分，不机械生成文档。
- **处理问题**：复现、定位原因、补失败测试，再修复和验证。不要把所有问题都直接改成“重装”。
- **正式审核**：由用户触发 `/review`。Superpowers 的阶段自检不替代结构化审核结论，不授予发布许可。
- **调整安装或模型**：再次运行 `/workflow-setup`，查看既有选择与真实生效状态。
- **排查守卫或依赖**：运行 `node scripts/workflow/doctor.mjs --root . --json`。静态 pass 不证明当前宿主已加载；unverified 应有对应的后续验收。

最终交付应分别列出“已配置、已加载、已验证、未验证”。项目构建和业务测试、远端 CI、模型实际调用、发布和服务端权限，没有真实证据就不能填通过。向导的入口检查不是模型思维或任意外部脚本的沙箱。
