# 变更记录

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。模板版本以 `template/.opencode/plugins/workflow/package.json` 中的 `version` 为准。

## [未发布]

### 新增

- MIT 许可证（仓库根目录与 `template/.opencode/LICENSE`）、安全策略、贡献指南和本变更记录。

### 修复

- 分发测试不再在源码里写入私有项目名、本机路径和服务器地址；改为通用检查加被忽略的本地禁用词文件。
- 新增 `.gitattributes`（仓库与模板各一份）：Windows 上以 `core.autocrlf=true` 检出时，工作流脚本仍保持 LF，`run-tests.sh` 不再因 CRLF 报错。

## [1.0.0] - 2026-10-22

- 首个公开版本：领域规则加载、路径保护、提交前凭据扫描、手动 `/review`、可选发布核查和原生验收。
