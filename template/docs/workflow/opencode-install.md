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

## 3. Linux / WSL 安装步骤

本模板的运行要求为 Node.js 24+、Python 3.10+、Git 和 Bash；当前验证环境为 Linux。Windows 用户使用 WSL 中的 Linux 环境，后续安装和项目自检均在同一个 WSL 终端完成。

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

使用这些方式后仍需运行 `opencode --version`，按第 1 节判断兼容性。OpenCode 本身提供多个平台的版本，但本模板的扫描器安装脚本目前仅支持 Linux x64/arm64；不能把 OpenCode 安装成功等同于本模板已经在 macOS 或 Windows 原生环境验收。

## 4. Windows 用户使用 WSL

尚未安装 WSL 时，参考 [Microsoft 官方 WSL 安装指南](https://learn.microsoft.com/zh-cn/windows/wsl/install)，在管理员 PowerShell 中运行：

```powershell
wsl --install -d Ubuntu
```

按提示完成系统重启和 Ubuntu 用户设置，进入 Ubuntu 终端，再执行第 3 节。项目检出、Node.js、Python、Git、OpenCode 和工作流自检均放在 WSL 的同一环境中。

需要 Windows 原生 OpenCode CLI 或 Desktop 时，从第 2 节官方 V2 入口选择对应架构的下载；本模板当前的 Bash 检查和 Linux 扫描器安装步骤不能直接照搬到 PowerShell。

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

完成模板合并后，在目标项目根目录运行：

```bash
npm --prefix .opencode/plugins/workflow ci --ignore-scripts
python3 .opencode/secret-scan/install.py
node scripts/workflow/doctor.mjs --root .
```

doctor 的 `opencode-version` 通过只证明 CLI 版本符合基线；`native-runtime: unverified` 仍需在实际 Location 验证 `workflow.starter` 已加载，并完成领域规则加载、路径保护、提交扫描和手动 `/review` 的原生冒烟。验证方式及证据要求见 [测试说明](testing.md) 和 [开发协作说明](development.md)。
