# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。模板版本以 `template/.opencode/plugins/workflow/package.json` 中的 `version` 为准。

## [未发布]

### 新增

- MIT 许可证（仓库根目录与 `template/.opencode/LICENSE`）、安全策略、贡献指南和本变更记录。

### 变更

- doctor 支持 Windows：按 PATH/PATHEXT 查找 `opencode`、`gitleaks.exe`，经 `cmd.exe` 执行 npm 安装的 `.cmd` 启动器，Python 按 `WORKFLOW_PYTHON`、`py -3`、`python`、`python3` 解析，Git 根目录比较不区分大小写；新增 `--print-permissions`，输出与 `protection.json` 对应的原生权限块。
- 验收基线从 OpenCode 2.1.1 升级到 2.1.2（CLI、`@opencode/plugin`、`@opencode/client`）；doctor、CLI 获取脚本和测试统一从插件 `package.json` 读取基线版本，文档版本由分发测试核对。

### 新增（Windows）

- Gitleaks 安装脚本支持 macOS 与 Windows（x64/arm64），固定校验值与官方 `checksums.txt` 核对一致；Windows 解包 zip 中的 `gitleaks.exe`，提示使用 `py -3`。
- 模板 `opencode.jsonc` 固定 `"shell": "bash"`（Windows 上解析为 Git Bash）；shell 为 PowerShell、cmd 或 WSL 启动器时插件拒绝执行并说明原因，避免测试失败被当成通过；doctor 新增 `shell` 检查。

### 修复

- 分发测试不再在源码里写入私有项目名、本机路径和服务器地址；改为通用检查加被忽略的本地禁用词文件。
- 新增 `.gitattributes`（仓库与模板各一份）：Windows 上以 `core.autocrlf=true` 检出时，工作流脚本仍保持 LF，`run-tests.sh` 不再因 CRLF 报错。
- doctor 在插件依赖缺失时不再崩溃，改为输出结构化报告并给出 `npm ci` 命令。
- 插件测试不再依赖预先存在的 `/tmp/opencode`，全新的 CI 机器上也能运行。
- Python 守卫在非 UTF-8 环境（Windows 的 cp936/cp1252 代码页）下按 UTF-8 读取配置、收发 JSON，不再因中文配置或路径拒绝所有操作；识别 Git Bash 风格的 `/c/...` 路径；跨盘符路径仍按规则检查；超时在 Windows 上用 `taskkill /T` 终止扫描器进程树；缺少扫描器的提示加入 `opencode service restart`。
- 插件新增 `platform.ts` 集中处理平台差异：Windows 上依次探测 `py -3`、`python`、`python3`（可用 `WORKFLOW_PYTHON` 指定），子进程隐藏窗口且超时用 `taskkill /T` 终止，路径匹配前统一为 `/`，Git Bash 风格路径按 OpenCode 规则换算；检查器无法启动时，错误信息会给出命令、原因和处理办法。
- 模型给 shell 传相对 `workdir`（如 `src`）时不再被误拒：OpenCode 在插件钩子之后才把它解析为绝对路径，插件现在按 Location 解析。

## [1.0.0] - 2026-10-22

- 首个公开版本：领域规则加载、路径保护、提交前凭据扫描、手动 `/review`、可选发布核查和原生验收。
