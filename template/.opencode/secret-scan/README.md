# 提交前凭据扫描

安装：`python3 .opencode/secret-scan/install.py`；校验：追加 `--check`。已有不同版本不会覆盖，可用 `--bin-dir <独立目录>` 并调整 PATH。Linux x64/arm64 的官方发布包及二进制 SHA-256 固定于 pinned.json。

OpenCode 插件在独立 `git commit` 前扫描拟提交新增内容，支持普通提交、amend、-a 和显式路径；真实 index 与 objects 不被扫描过程改写。先独立 `git add`，再独立 `git commit`，不要在同一工具调用里夹带修改索引的其他命令。

扫描器缺失、版本不符、超时、无效报告或疑似凭据均阻断。输出只报告位置和规则，不回显秘密。审核材料导出前同样扫描完整范围的新增内容。

这不是系统 Git hook；外部终端和任意包装脚本不在自动拦截范围。新增行扫描不证明历史未修改内容没有秘密，仍应按需要在 CI 执行完整扫描。
