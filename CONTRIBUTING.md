# 参与贡献

欢迎提交缺陷报告、建议和改进。参与前请阅读 [行为准则](CODE_OF_CONDUCT.md)。

## 报告问题

- 缺陷和功能建议请用 issue 模板提交，写明套件版本、OpenCode 版本、平台和最小复现步骤。复现只使用合成数据。
- 能绕过路径保护、凭据扫描、发布核查或 reviewer 限制的问题属于安全问题，按 [SECURITY.md](SECURITY.md) 私下报告，不要开公开 issue。

## 环境

Node.js 24+、Python 3.10+、Git 和 Bash，在 Linux、macOS 或 WSL2 上开发（macOS 需另装 Python 3.10+，系统自带的是 3.9）。OpenCode 的验收基线与 `template/.opencode/plugins/workflow/package.json` 中 `@opencode/plugin` 的版本一致。

## 本地验证

```bash
npm --prefix template/.opencode/plugins/workflow ci --ignore-scripts
python3 template/.opencode/secret-scan/install.py
node scripts/fetch-opencode.mjs
node scripts/fetch-superpowers.mjs
node scripts/verify.mjs
```

`verify.mjs` 依次运行类型检查、插件测试、守卫测试、质量扩展测试、分发测试、独立接入测试、原生测试和关联检查，各阶段日志写入被忽略的 `.verification/`。任一阶段失败、没有实际执行测试或出现非预期的跳过，都算验证失败。独立接入包括引导 CLI；原生阶段包含固定 Superpowers 的真实加载、技能读取与接入门槛，不使用真实模型账号。

关联检查读取 `scripts/quality/quality.json` 的登记：先校验全部登记，失效时验证失败；再对上游分支（`@{upstream}`，没有时用 `origin/main`）到 HEAD 的已提交改动报告同步提醒。提醒只报告，不影响验证结果；上游引用存在却解析不到提交、Git 无法运行或查询出错时报告未完成，验证失败。未提交的改动不在其中，所以先提交、再验证。没有上游分支时（如 CI 的浅检出）只校验登记。

`fetch-superpowers.mjs` 只为套件验收准备固定提交的源码，先核对归档 SHA-256，再核对完整源码树；缓存位于 `.verification/runtime/superpowers`，不写个人 OpenCode 配置、不复制进接入方模板。可用 `--archive` 提供离线归档；缓存被修改时拒绝覆盖。固定来源与关键技能摘要在插件的 `onboarding-source.ts`，升级时须同步核对并完成原生验收。Windows 子集不运行该原生组合测试，无需准备此缓存。

在 Windows 上（PowerShell，需要 Git for Windows 和 Python 启动器 `py`）运行 Windows 子集：类型检查、插件测试、守卫测试、质量扩展测试、独立接入测试和关联检查。依赖 bash 逻辑目录与目录符号链接的 3 个守卫用例，以及需要符号链接权限的质量扩展用例在 Windows 上允许跳过。质量扩展阶段以 `-v` 运行，只接受原因为“需要创建符号链接的权限”的跳过，其他原因的跳过照常判失败；原生测试和分发测试在 Linux、macOS 上运行。

```powershell
npm --prefix template/.opencode/plugins/workflow ci --ignore-scripts
py -3 template/.opencode/secret-scan/install.py   # 把输出的目录加入 PATH
npm install -g @opencode/cli@<基线版本>
node scripts/verify.mjs --windows
```

`WORKFLOW_PYTHON` 可指定守卫使用的解释器，插件与 `verify.mjs` 都遵循它。CI（`.github/workflows/ci.yml`）在 Linux（Python 3.10）和 macOS（Apple Silicon，CLI 经 npm 安装）上跑全量验收，含原生运行测试；在 Windows 上跑同一子集。失败时验证日志作为 artifact 上传。

## 改动要求

- 修复行为问题时先写能重现问题的测试；守卫出错时必须拒绝执行。
- 新增或调整文件之间的关联时，同步 `scripts/quality/quality.json` 的登记；verify 末尾的关联提醒逐条核对，确认不需要同步时在提交说明里写明原因。
- 测试只使用运行时拼接的合成凭据，不提交真实秘密，也不通过放宽 Gitleaks 规则让测试通过。
- 路径配置沿用原生语义：`*` 匹配任意字符（含 `/`），`?` 匹配一个字符，不支持花括号。
- 面向用户的文字使用简体中文，标识符使用英文。
- 操作系统差异集中处理：插件侧在 `platform.ts`，守卫侧在 `hooklib.windows_path` 与 `protocol.utf8_stdio`。Windows 行为通过注入 `path.win32`、`platform: 'win32'` 或 `os_name='nt'` 编写测试，在 Linux 上也能运行。
- 升级 OpenCode 基线时，同步 `@opencode/plugin`、`@opencode/client`、`scripts/fetch-opencode.mjs` 中的校验值和文档，并完成原生验收。

## 提交 Pull Request

1. Fork 本仓库，从 `main` 新建分支。
2. 行为修复先写能复现问题的测试，确认它在修复前失败，再改实现。
3. 运行 `node scripts/verify.mjs`；只能在 Windows 上开发时运行 `--windows` 子集，并在 PR 中说明。
4. 面向用户的变化写进 `CHANGELOG.md` 的「未发布」；修复尚未发布的功能时不单列修复条目。
5. 按 PR 模板说明改动和实际验证结果。CI 在 Linux、macOS 上跑全量验收，在 Windows 上跑子集。

提交的贡献按本仓库的 [MIT 许可证](LICENSE) 授权。

## 本地禁用词

如果要防止私有项目名、内部地址等进入仓库，把它们逐行写进被忽略的 `.verification/forbidden-patterns.txt`（大小写不敏感，`#` 开头为注释）。分发测试会用它检查全部已跟踪文件。不要把这份清单提交到仓库。

## 提交与发布

- 一个提交只做一件事，提交说明用中文概括改动。
- 发布前把 `CHANGELOG.md` 的「未发布」整理为新版本并注明日期，文末「未发布」的链接改为 `compare/v<新版本>...HEAD`，并新增指向 `releases/tag/v<新版本>` 的链接；同步插件 `package.json` 和 `package-lock.json` 中的 `version`，以及 README 中的版本号，这几处由分发测试核对。然后创建 annotated tag，再按 README「发布与分发」一节生成分发包和 SHA-256，随 GitHub Release 发布。
