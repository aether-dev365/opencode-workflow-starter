# OpenCode V2 安装与版本检查

本工作流使用 OpenCode V2 插件 API，接入前必须确认实际运行的是 V2。当前已验收的 CLI、`@opencode/plugin` 和 `@opencode/client` 基线均为 **2.1.2**。

## 1. 先检查当前版本

在准备使用工作流的终端中运行：

```bash
opencode --version
```

| 检测结果 | 处理方式 |
| --- | --- |
| 找不到命令 | 按下文安装 OpenCode V2，再重新检查 |
| `1.x` 或其他非 V2 版本 | 当前不适用于本模板；先完成迁移或安装 V2 |
| `2.1.2` | 符合本模板的 CLI 验收基线，继续接入和自检 |
| 其他 `2.1.x` | doctor 给出 warn；在该版本完成原生冒烟并记录结果 |
| 其他 `2.x` 系列 | 已是 V2，但不属于当前验收系列；选用 2.1.2，或同步适配插件依赖并完成验收 |
| 命令执行失败、输出无法识别 | 检查可执行文件、PATH 和版本覆盖变量，不能据此认定已安装兼容版本 |

`opencode` 这个命令名不能区分 V1 和 V2，两者使用相同命令。doctor 优先检查 `WORKFLOW_OPENCODE_BIN` 指向的 CLI；设置过该变量时，也要对它指向的可执行文件运行 `--version`。

## 2. 官方安装来源

| 来源 | 地址与用途 |
| --- | --- |
| OpenCode V2 官方入口 | [opencode.ai/v2/docs](https://opencode.ai/v2/docs/)：安装方式及各平台 CLI、Desktop 下载 |
| 官方 npm 包 | [@opencode/cli](https://www.npmjs.com/package/@opencode/cli)：可以指定版本安装 CLI |
| 官方 V1 迁移指南 | [Migrate from V1](https://opencode.ai/v2/docs/migrate-v1/)：安装替换、配置保留及插件/API 迁移 |
| 官方 CLI 指南 | [CLI](https://opencode.ai/v2/docs/cli/)：启动、后台服务和终端使用 |
| 官方源码 | [anomalyco/opencode](https://github.com/anomalyco/opencode) |

本模板需要可在终端运行的 CLI；安装 Desktop 后仍需确认该终端中的 `opencode --version`。

## 3. Linux、macOS、WSL 安装步骤

本模板的运行要求为 Node.js 24+、Python 3.10+、Git 和 Bash。Linux 与 WSL2 已验收；macOS 按本节操作，但尚未做原生验收。Windows 的两条路线见第 4 节。

### 准备环境

```bash
node --version
npm --version
python3 --version
git --version
```

缺少工具时，从 [Node.js 官方下载页](https://nodejs.org/en/download)、[Python 官方下载页](https://www.python.org/downloads/)、[Git 官方安装页](https://git-scm.com/install/) 或所用 Linux 发行版的软件源安装对应版本。

### 已有 V1 时先处理迁移

保留现有 OpenCode 配置的备份。V1 与 V2 共用配置位置，原有支持的配置、agents、commands 和 skills 通常无需全部重写；V1 插件和调用旧 server API 的集成则需要迁移。

如果 V1 是通过包管理器安装的，先用原包管理器确认并卸载对应的 V1 安装，再安装 V2。例如 npm 用户先运行 `npm ls -g --depth=0` 确认实际包名。不要以删除配置目录或会话数据代替卸载程序。官方 V2 curl 安装器会替换 V1 二进制。

### 安装本模板的验收版本

推荐通过官方 npm 包固定到 2.1.2：

```bash
npm install -g @opencode/cli@2.1.2
hash -r
opencode --version
```

期望输出的版本为 `2.1.2`。CLI 包通过安装脚本选择平台二进制，因此这里不要添加 `--ignore-scripts`；模板插件的 `npm ci --ignore-scripts` 是后续不同的安装步骤。

若 npm 报全局安装目录无写入权限，先按所用 Node.js 安装方式配置用户可写的 npm 全局目录，并将该目录的 `bin` 加入 PATH，再重试。

### 其他官方安装方式

官方安装器获取当前发布版本，不保证仍为本模板的 2.1.2 基线：

```bash
curl -fsSL https://opencode.ai/v2/install | bash
```

macOS / Homebrew 用户的官方 V2 包为：

```bash
brew install anomalyco/tap/opencode-v2
```

使用这些方式后仍需运行 `opencode --version`，按第 1 节判断兼容性。扫描器安装脚本支持 Linux、macOS 和 Windows 的 x64/arm64，但本模板只在 Linux 上做过原生验收；不能把 OpenCode 安装成功等同于本模板已经在 macOS 或 Windows 原生环境验收。

## 4. Windows

| 路线 | 适用 | 状态 |
| --- | --- | --- |
| WSL2（推荐） | 希望与 Linux 环境一致 | 已验收，与 Linux 相同 |
| 原生 Windows（Git Bash） | 不使用 WSL 的团队 | 插件测试、守卫、doctor、接入脚本已在 Windows 实机通过；OpenCode 原生加载插件尚未验收 |

### 路线一：WSL2（推荐）

尚未安装 WSL 时，参考 [Microsoft 官方 WSL 安装指南](https://learn.microsoft.com/zh-cn/windows/wsl/install)，在管理员 PowerShell 中运行：

```powershell
wsl --install -d Ubuntu
```

按提示完成系统重启和 Ubuntu 用户设置，进入 Ubuntu 终端，再执行第 3 节。项目检出、Node.js、Python、Git、OpenCode 和工作流自检都放在 WSL 的同一环境中；不要让 Windows 侧的 OpenCode 打开 WSL 里的项目，反之亦然。

### 路线二：原生 Windows（Git Bash）

在 PowerShell 中安装前置工具，装完重新打开终端：

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Python.Python.3.12 -e
winget install --id Git.Git -e
npm install -g @opencode/cli@2.1.2
opencode --version
```

必须安装完整的 Git for Windows：OpenCode 把 `opencode.jsonc` 中的 `"shell": "bash"` 解析为 Git 安装目录下的 `bin\bash.exe`，MinGit 不含它。在项目根目录运行 `node scripts\workflow\setup.mjs` 完成其余步骤；手动执行时：

```powershell
npm --prefix .opencode\plugins\workflow ci --ignore-scripts
py -3 .opencode\secret-scan\install.py
node scripts\workflow\doctor.mjs --root .
```

常见问题：

- **PowerShell 里的 `bash` 不是 Git Bash。** 它通常是 WSL 启动器（`System32\bash.exe` 或 `WindowsApps\bash.exe`），会在 WSL 里执行命令。不要用它运行工作流脚本；`"shell"` 也不能指向它，插件会拒绝。在 PowerShell 中运行守卫测试：`py -3 -m unittest discover -s .opencode/workflow/checks -t .opencode/workflow/checks -p "test_*.py"`，依赖 bash 逻辑目录与目录符号链接的 3 个用例会跳过。
- **`npm` 被执行策略拦截**（提示禁止运行 `npm.ps1`）：改用 `npm.cmd`，或执行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 后重开终端。
- **Gitleaks 的位置。** 默认装到 `%USERPROFILE%\.local\bin\gitleaks.exe`；提交扫描和 doctor 在 PATH 中找不到 `gitleaks` 时会回退到这里。需要加入用户 PATH 时：

  ```powershell
  [Environment]::SetEnvironmentVariable('Path', "$env:USERPROFILE\.local\bin;" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')
  ```

- **改动后重启后台服务。** 安装插件依赖、扫描器或修改 PATH 后执行 `opencode service restart`；后台服务的 PATH 在启动时确定。
- **Python 的选择。** 插件依次尝试 `py -3`、`python`、`python3`，要求 3.10+；也可设置 `WORKFLOW_PYTHON` 指向解释器。Microsoft Store 或 Python 安装管理器提供的 `WindowsApps` 别名可以正常使用。
- **中文 Windows 的 GBK 代码页**无需修改：守卫进程统一使用 UTF-8 读写。
- **换行符。** Git for Windows 默认 `core.autocrlf=true`；模板的 `.gitattributes` 让工作流脚本保持 LF，已有项目合并 `.gitattributes` 时保留这两条规则。

Desktop 从第 2 节官方入口下载。本模板只在 CLI 上做过原生验收；使用 Desktop 时，终端中仍需要可运行的 `opencode` CLI 供 doctor 检查版本。

## 5. 安装后的确认

### 排除旧命令路径或版本覆盖

Linux / WSL 中运行：

```bash
command -v opencode
type -a opencode
opencode --version
```

如果仍显示旧版本，检查 PATH 顺序、shell alias 和旧安装位置，重新打开终端再确认。若设置了 `WORKFLOW_OPENCODE_BIN`，doctor 会优先使用它；该覆盖不再需要时可以执行 `unset WORKFLOW_OPENCODE_BIN`，需要保留时则将它指向选定的 V2 CLI。

使用独立 CLI 进行验证不必替换系统默认命令。套件开发检出中的 `node scripts/fetch-opencode.mjs` 可为 Linux x64 下载并校验 2.1.2，输出位于套件的 `.verification/runtime/package/bin/opencode`。将该输出的绝对路径设置为 `WORKFLOW_OPENCODE_BIN`；实际启动 OpenCode 时也应使用同一个 CLI。此获取脚本位于套件根目录，不属于复制到业务项目的 `template/` 内容。

### 启动 V2

升级安装后重启并检查 V2 后台服务：

```bash
opencode service restart
opencode service status
```

在目标 Git 项目根目录运行 `opencode`，按 CLI 引导完成可用模型和供应商配置。需要独立服务验证时可以使用 `opencode --standalone`。

### 继续工作流接入

完成模板合并后，在目标项目根目录运行接入准备脚本：它安装插件依赖和固定版 Gitleaks、检测 OpenCode，最后运行 doctor。

```bash
node scripts/workflow/setup.mjs
```

也可以手动执行（Windows 把 `python3` 换成 `py -3`）：

```bash
npm --prefix .opencode/plugins/workflow ci --ignore-scripts
python3 .opencode/secret-scan/install.py
node scripts/workflow/doctor.mjs --root .
```

doctor 的 `opencode-version` 通过只证明 CLI 版本符合基线；`native-runtime: unverified` 仍需在实际 Location 验证 `workflow.starter` 已加载，并完成领域规则加载、路径保护、提交扫描和手动 `/review` 的原生冒烟。验证方式及证据要求见 [测试说明](testing.md) 和 [开发协作说明](development.md)。
