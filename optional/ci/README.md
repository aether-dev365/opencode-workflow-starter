# 可选接入方 CI

为已经接入基础工作流和[质量扩展](../quality/README.md)的项目提供 GitHub Actions 检查。覆盖 PR、默认分支 push 和手动运行，不要求安装本地 post-commit hook。首版使用 GitHub 托管的 `ubuntu-24.04`，不是套件自身的三平台开发测试 CI，也不替代业务构建和测试。

## 复制接入

先按 [ADOPT.md](../../ADOPT.md) 接入基础模板，并将质量扩展的全部 `.py` 和 `quality.example.json` 复制到 `scripts/quality/`。使用本 CI 需要同时更新质量扩展：两个行级入口须支持 `--fail-on-incomplete`，`quality_process.py` 须支持可选协作终止。

| 本目录文件 | 接入方位置 |
| --- | --- |
| [workflow-checks.yml](workflow-checks.yml) | `.github/workflows/workflow-checks.yml` |
| [resolve-scope.py](resolve-scope.py) | `scripts/ci/resolve-scope.py` |
| [scan-secrets.py](scan-secrets.py) | `scripts/ci/scan-secrets.py` |
| [run-quality.py](run-quality.py) | `scripts/ci/run-quality.py` |

已有同名文件时先审阅、逐项合并，不直接覆盖已有 CI。只复制上表文件，不复制套件 `scripts/verify.mjs`、`tests/` 或本地验证产物。标准路径是固定契约；若项目已调整目录，需同步改工作流和脚本并重新验收，不能只改一个路径变量。路径含空格和中文可以使用。

工作流准备 Node.js 24 和 Python 3.10，安装锁定插件依赖、固定 Gitleaks，以及与插件 manifest 的 `@opencode/plugin` 版本匹配的 CLI。CLI 安装在 runner 临时目录，用 `WORKFLOW_OPENCODE_BIN` 指定，不替换全局软件。三个辅助脚本只用 Python 标准库和质量扩展共用模块，Git 查询兼容 Git 2.5+。

无需模型账号或模型 API key。CLI 只用于版本查询，不启动 OpenCode 服务、不调用模型。doctor 的 `native-runtime: unverified` 保留，静态自检不证明插件原生加载。

## 范围

| 触发方式 | 质量检查 |
| --- | --- |
| PR | 检出 PR head，检查 base/head 合并基点到 head 的差异 |
| 默认分支普通 push | 检查 before 到 after 的整个 push，包括合并引入的变化 |
| 首次推送 | 全量检查 |
| force push 或旧 tip 已不可用 | 确认无法可靠增量后，全量检查并说明原因 |
| 手动运行 | 检查所选 ref 的完整工作区 |

PR 基线缺失、非法事件、没有共同祖先、浅历史或检出不匹配均失败，不默默比较空范围。格式工具读取实际检出，与质量快照的右端一致；不检查 GitHub 默认的 PR merge ref，因此不证明合并到最新目标分支后业务仍能运行。

同一 PR 的新提交会取消旧运行，新运行仍检查整个 PR 范围；默认分支 push 与手动运行互不取消、互不替换，每次 push 的范围都会检查。

push 事件不包含 tag，job 只对仓库实际默认分支运行，不写死 main；非默认分支 push 和删除 push 会跳过 job，它们不是“检查通过”。PR 的目标分支不受该条件限制。手动按钮需工作流已存在于默认分支。未提供合并队列 `merge_group` 支持。

### 凭据扫描是历史扫描

每次 Gitleaks 都扫描候选 HEAD 可达的完整提交历史，包含根提交、侧分支、中间提交里出现后删除的凭据及合并解决新增内容。不扫描其他分支独有提交、未跟踪文件、runner 安装目录、LFS 对象或子模块内部；不保证解析任意归档。

使用 `.opencode/secret-scan/gitleaks.toml`，不生成 baseline、不自动添加白名单；忽略内联 `gitleaks:allow` 注释。扫描进程在独立临时目录创建空忽略文件，并通过 `--gitleaks-ignore-path` 显式指定；同时从当前检出的 Git 元数据目录扫描同一候选历史，避开固定版额外加载源目录忽略文件的行为。不采用候选检出自带的 `.gitleaksignore`，也不创建或改写项目的忽略文件。项目规则仍需审阅维护，“完整历史”指提交范围，不代表能命中已被扫描规则豁免的内容。

首次接入可能发现历史凭据。真实泄露应先撤销/轮换，再按项目流程处理历史；不要为了让 CI 变绿对整个目录放宽规则。删除当前文件不等于清除了历史中的泄露。

报告只显示经校验的路径、行号、规则和提交标识，不转发原始 scanner 输出、Secret、Match 或提交消息。不上传原始 JSON；临时报告最终清理。没有合法报告、报告与退出状态不符也属于失败，而非“没有发现”。

## 分层失败策略

| 项目 | 普通发现 | 报错或未完成 |
| --- | --- | --- |
| Gitleaks | CI 失败 | CI 失败 |
| doctor | fail 使 CI 失败，warn/unverified 保留 | CI 失败 |
| 注释审核 | 提醒，单独出现不使 CI 失败 | CI 失败 |
| 跳过测试检查 | CI 失败 | CI 失败 |
| 文档链接检查 | CI 失败 | CI 失败 |
| 格式检查 | CI 失败 | CI 失败 |

CI 直接调用四项入口，不使用始终退出 0 的 `run-hook.py`。注释和跳过测试检查追加 `--fail-on-incomplete`：非 UTF-8、超过 1 MiB 或分析异常不能被当作通过；已发现的问题仍保留。语言不支持、配置排除、生成标记、二进制、符号链接和子模块等既有明确不扫描范围保持不变。不改变本地手动命令和 hook 的默认行为。

某项失败后，具备前置依赖的其他检查继续执行；整体取消后不启动新项。质量汇总展示四项状态及是否启动，整体退出码为 0（无阻断项，可能有注释提醒）、1（阻断发现）、2（未完成）。空差异是合法的零候选，不是没有执行程序。

### 格式工具与时间预算

格式器由项目自行按锁文件和已有工具链安装，模板不猜测技术栈、不自动下载格式器。需要准备步骤时放在质量检查之前，并将其 outcome 加入质量步骤的条件，避免安装失败后仍运行。CI 不传 `--hook`，所以 `hook: false` 的格式项也执行；不传 `--fix`，不暂存或提交。check 是项目信任的程序，必须使用只读参数，模板不是沙箱。

没有登记格式命令时会明确显示这一事实，不能据此声称项目格式已验证。已有命令缺失、不合格或超时都会失败。

- Gitleaks 单次预算 600 秒，JSON 报告上限 16 MiB，最多显示 40 个位置；超限为未完成。
- 每项质量检查外层 300 秒，独立于本地 hook 的 `timeoutSeconds`。格式器仍有各自内部预算，外层先到期就报告未完成。
- 质量每项最多转发 40 行、每行最多 4096 字符，超出注明截断；仍持续排空，并暂停 GitHub workflow-command 解析后再输出子进程文本。
- POSIX 格式外层超时/取消先给入口最多 5 秒清理独立工具进程组，再按需强杀；输出收尾另有最多 5 秒。Windows 共用模块保持 Job Object 行为，但不代表本工作流已支持 Windows runner。
- doctor 步骤 5 分钟；整个 job 30 分钟。这些都是上限，不保证每项同时用尽预算后还可完成全部步骤。runner 超时或取消属于未完成。

## 权限与升级

工作流只有 `contents: read`，checkout 不保留凭据，不使用依赖缓存，不读取仓库 secrets、不发布评论或扫描 artifact。使用普通 `pull_request`；外部贡献者仍可能需要维护者按 GitHub 策略批准运行。不要为绕过审批改成 `pull_request_target` 执行候选代码，也不要把不受信任 PR 放到带秘密的持久自托管 runner。

工作流、脚本、pin 和规则本身可随 PR 修改；本模板不是独立于候选内容的信任根。需要时用 CODEOWNERS/ruleset 要求维护者审阅这些文件。已获授权执行的格式命令和安装程序也不是沙箱内代码。

在仓库分支保护/ruleset 中将 job `workflow-checks` 设置为 required check，才会阻止不合格的 PR 合并。模板不修改这些设置，也不能约束管理员或未受保护分支。已有业务 CI 保持独立。

升级 Actions 时更新完整 commit SHA 并验证参数；Gitleaks 升级需同步 pin、摘要和真实工具测试；插件/CLI 的基线跟随插件 manifest。升级 CI 辅助脚本时同时核对质量模块兼容性，不把新入口与旧共用模块混用。

## 本地复现与验收

在接入方检出根、已安装所需工具的环境中：

```bash
python3 scripts/ci/scan-secrets.py --head "$(git rev-parse HEAD)"
node scripts/workflow/doctor.mjs --root .
python3 scripts/ci/run-quality.py --all
```

`run-quality.py --range` 要求完整 base/head OID，head 必须等于当前检出。`resolve-scope.py` 读取 `GITHUB_EVENT_NAME`、`GITHUB_EVENT_PATH`、`GITHUB_SHA`、`GITHUB_REF`，成功向 stdout 输出 JSON；存在 `GITHUB_OUTPUT` 时追加已校验的 mode/base/head。事件字符串不拼入 shell。

套件全量 verify 会在隔离复制项目中实际运行范围、扫描、doctor 和质量脚本，并执行 YAML 中的脚本块。这不是 GitHub runner 或真实 fork PR 的验收结果。接入后还应在获准的分支/测试仓库确认 PR head、默认分支 push、手动全量和预期失败，再配置 required check；未做的环境在接入报告中列为未验证。
