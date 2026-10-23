# 参与贡献

## 环境

Node.js 24+、Python 3.10+、Git 和 Bash，在 Linux、macOS 或 WSL2 上开发（macOS 需另装 Python 3.10+，系统自带的是 3.9）。OpenCode 的验收基线与 `template/.opencode/plugins/workflow/package.json` 中 `@opencode/plugin` 的版本一致。

## 本地验证

```bash
npm --prefix template/.opencode/plugins/workflow ci --ignore-scripts
python3 template/.opencode/secret-scan/install.py
node scripts/fetch-opencode.mjs
node scripts/verify.mjs
```

`verify.mjs` 依次运行类型检查、插件测试、守卫测试、质量扩展测试、分发测试、独立接入测试和原生测试，各阶段日志写入被忽略的 `.verification/`。任一阶段失败、没有实际执行测试或出现非预期的跳过，都算验证失败。

在 Windows 上（PowerShell，需要 Git for Windows 和 Python 启动器 `py`）运行 Windows 子集：类型检查、插件测试、守卫测试、质量扩展测试和独立接入测试。依赖 bash 逻辑目录与目录符号链接的 3 个守卫用例，以及需要符号链接权限的质量扩展用例在 Windows 上允许跳过。质量扩展阶段以 `-v` 运行，只接受原因为“需要创建符号链接的权限”的跳过，其他原因的跳过照常判失败；原生测试和分发测试在 Linux、macOS 上运行。

```powershell
npm --prefix template/.opencode/plugins/workflow ci --ignore-scripts
py -3 template/.opencode/secret-scan/install.py   # 把输出的目录加入 PATH
npm install -g @opencode/cli@<基线版本>
node scripts/verify.mjs --windows
```

`WORKFLOW_PYTHON` 可指定守卫使用的解释器，插件与 `verify.mjs` 都遵循它。CI（`.github/workflows/ci.yml`）在 Linux（Python 3.10）和 macOS（Apple Silicon，CLI 经 npm 安装）上跑全量验收，含原生运行测试；在 Windows 上跑同一子集。失败时验证日志作为 artifact 上传。

## 改动要求

- 修复行为问题时先写能重现问题的测试；守卫出错时必须拒绝执行。
- 测试只使用运行时拼接的合成凭据，不提交真实秘密，也不通过放宽 Gitleaks 规则让测试通过。
- 路径配置沿用原生语义：`*` 匹配任意字符（含 `/`），`?` 匹配一个字符，不支持花括号。
- 面向用户的文字使用简体中文，标识符使用英文。
- 操作系统差异集中处理：插件侧在 `platform.ts`，守卫侧在 `hooklib.windows_path` 与 `protocol.utf8_stdio`。Windows 行为通过注入 `path.win32`、`platform: 'win32'` 或 `os_name='nt'` 编写测试，在 Linux 上也能运行。
- 升级 OpenCode 基线时，同步 `@opencode/plugin`、`@opencode/client`、`scripts/fetch-opencode.mjs` 中的校验值和文档，并完成原生验收。

## 本地禁用词

如果要防止私有项目名、内部地址等进入仓库，把它们逐行写进被忽略的 `.verification/forbidden-patterns.txt`（大小写不敏感，`#` 开头为注释）。分发测试会用它检查全部已跟踪文件。不要把这份清单提交到仓库。

## 提交与发布

- 一个提交只做一件事，提交说明用中文概括改动。
- 发布前更新 `CHANGELOG.md`，同步插件 `package.json` 的 `version`，创建 annotated tag，再按 README「发布与分发」一节生成分发包和 SHA-256。
