# 参与贡献

## 环境

Node.js 24+、Python 3.10+、Git 和 Bash，在 Linux 或 WSL2 上开发。OpenCode 的验收基线与 `template/.opencode/plugins/workflow/package.json` 中 `@opencode/plugin` 的版本一致。

## 本地验证

```bash
npm --prefix template/.opencode/plugins/workflow ci --ignore-scripts
python3 template/.opencode/secret-scan/install.py
node scripts/fetch-opencode.mjs
node scripts/verify.mjs
```

`verify.mjs` 依次运行类型检查、插件测试、守卫测试、分发测试、独立接入测试和原生测试，各阶段日志写入被忽略的 `.verification/`。任一阶段失败、没有实际执行测试或出现跳过，都算验证失败。

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
- 发布前更新 `CHANGELOG.md`，同步插件 `package.json` 的 `version`，创建 annotated tag，再按 README「本地交付」一节生成分发包和 SHA-256。
