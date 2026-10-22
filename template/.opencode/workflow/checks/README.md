# 检查协议与回归

从项目根执行 `bash .opencode/workflow/checks/run-tests.sh`。测试使用临时 Git 仓库和合成凭据，凭据测试必须安装固定版 Gitleaks，缺失不会算作跳过通过。

输入为 stdin JSON：`version:1`，phase 为 before/inspect/after，绝对 directory、sessionId、callId、tool、input、paths 必填。输出为 JSON 的 allow/deny/ask、可选 reason/input 和 reminders。拒绝退出 2，正常退出 0。插件将无效输出、超时和非预期退出视为失败。

保护规则来自 `protection.json`，按顺序最后命中生效，路径中只有 `*`、`?` 为通配符。插件还在原生权限边界检查规范化后的路径。shell 解析覆盖字面路径、cd、常见写命令、数据 heredoc 和部分命令替换；不是执行任意程序的系统沙盒。

`source .env` 允许加载环境；打印凭据会拒绝。删除受保护目录，或目标下有凭据文件的递归清理（`rm -r`、`git clean -x/-X`、`find -delete`）会被拒绝，清理时指定不含凭据的子目录。

测试管道自动补 pipefail；grep 提前退出的消费模式除外，head 导致的 SIGPIPE 如实保留。自定义测试命令可添加 `.opencode/workflow/pipefail.json`：

```json
{"version":1,"commandPrefixes":[["cargo","test"],["go","test"]]}
```

规则是 token 前缀，不执行配置，不使用配置正则。
