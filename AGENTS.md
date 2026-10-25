# 维护本套件的协作约定

本仓库是 OpenCode V2 工作流模板套件。完整的贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，这里只列最容易做错的规则。

## 交付物边界

- `template/` 会被复制到别人的项目：不写本仓库特有的内容，不新增运行时依赖。
- `template/AGENTS.md` 是接入方的入口模板，不是本仓库的规则：不要按它在本仓库工作，也不要改成描述本仓库。
- `scripts/`、`tests/` 是套件自身的验证入口，不复制给接入方。

## 修改要求

- 先写能复现问题的测试，看它失败再改实现。守卫出错、超时或输出无效时必须拒绝（fail-closed）。
- 面向用户的变化同步写入 `CHANGELOG.md` 的「未发布」；修复尚未发布的功能时不单列修复条目。
- 面向用户的文字用简体中文，标识符用英文；注释的密度和写法跟随周围代码。
- 平台差异集中在插件的 `platform.ts` 与守卫的 `hooklib.py`、`protocol.py`。Windows 行为可注入 `platform: 'win32'` 或 `os_name='nt'` 在 Linux 上测试；子进程输出按 UTF-8 解码。
- OpenCode 基线以 `template/.opencode/plugins/workflow/package.json` 中 `@opencode/plugin` 的版本为准，文档中的版本号由分发测试核对。
- 文件之间的关联登记在 `scripts/quality/quality.json`；verify 末尾的关联提醒逐条核对，确认不需要同步时在提交说明里写明原因。

## 凭据与隐私

本仓库公开。不提交真实凭据、本机路径、内部地址或私有项目名：

- 测试凭据在运行时拼接，不放宽 Gitleaks 规则；合成路径的用户名用 `example`。
- 分发测试扫描所有已跟踪文件；私有禁用词逐行写在被忽略的 `.verification/forbidden-patterns.txt`。
- 只给自己用的指令放在被忽略的 `CLAUDE.local.md`，不要写进本文件。

## 验证

```bash
node scripts/verify.mjs            # Linux、macOS：全部阶段，含原生 OpenCode 测试
node scripts/verify.mjs --windows  # Windows（PowerShell）：可在 Windows 上运行的子集
```

首次准备依赖和固定版本工具见 CONTRIBUTING.md。任一阶段失败、没有实际执行测试或出现非预期的跳过，都算验证失败。CI 在 Linux、macOS 跑全量，在 Windows 跑子集。
