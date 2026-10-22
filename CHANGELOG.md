# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。模板版本以 `template/.opencode/plugins/workflow/package.json` 中的 `version` 为准。

## [未发布]

### 新增

- MIT 许可证（仓库根目录与 `template/.opencode/LICENSE`）、安全策略、贡献指南和本变更记录。
- 接入准备脚本 `scripts/workflow/setup.mjs`：检查前置工具，安装插件依赖和固定版 Gitleaks，检测 OpenCode 并运行 doctor。OpenCode 缺失时可选择经 npm 安装 CLI 验收版本或查看 Desktop 下载入口（交互输入，或 `--opencode cli|desktop|skip`）；已有的 V1 或其他 V2 版本不会被替换。
- GitHub Actions CI：Linux 以 Python 3.10 跑全量验收（含 OpenCode 原生测试），Windows 在 PowerShell 中跑 `node scripts/verify.mjs --windows` 子集；action 固定到提交 SHA，权限为只读。
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
- Windows 上能找到 Microsoft Store 与 Python 安装管理器以应用执行别名（`WindowsApps\py.exe`、`python.exe`）提供的解释器。
- 在 POSIX 上，`C:/x` 这类路径按相对路径检查（目录名可以是 `C:`），只有 Windows 把它当作盘符绝对路径。
- 配置引用的文件缺失时，报错显示配置中写的相对路径，不再显示各平台格式不同的系统错误。
- 规则文件为空或超过 40000 字符时，上下文组装不再抛错导致整个会话不可用，改为提示并拒绝修改该领域（规则文件本身仍可修复）；看门狗释放已删除会话的记录；`/review` 默认基线先使用远端默认分支（`origin/HEAD`）。

## [1.0.0] - 2026-10-22

- 首个公开版本：领域规则加载、路径保护、提交前凭据扫描、手动 `/review`、可选发布核查和原生验收。
