# 项目协作入口

本文件是模型的日常入口。接入时补充本项目用途、实际目录与验证命令，保留已有团队约定。

## 工作流程

- 修改前读取相关领域规则。正文以各目录 `AGENTS.md` 为单源，路径映射在 `.opencode/workflow/scopes.json`。
- 小而明确的修改直接实施；跨模块或公共契约变化先明确设计和验收。缺影响行为的决定时提问。
- 主代理负责契约、集成、验证和提交。独立任务才委派，实现代理按任务卡限定文件范围；共享文件指定唯一写入者。
- 验证实际行为与失败分支，记录命令、工作目录、退出码和未验证项。测试、构建和平台验收各有边界。
- 普通实现和提交不自动派模型审核；用户要求时使用 `/review`，由只读 reviewer 提交结论。
- 凭据不进入上下文或提交。使用示例配置；提交前运行固定凭据扫描。暂存和提交分两次工具调用。
- 生成文件通过项目规定的生成入口更新。受保护路径见 `.opencode/workflow/protection.json`。
- 工作树放 `.worktrees/`，先确认已忽略；工作树不隔离端口、数据库和构建缓存。

## 按需阅读

- 开发协作与任务卡：`docs/workflow/development.md`
- 测试与证据：`docs/workflow/testing.md`
- 审核分级与结论：`docs/workflow/review-policy.md`
- 接入检查：`node scripts/workflow/doctor.mjs --root .`
- OpenCode V2 安装与版本检查：`docs/workflow/opencode-install.md`

插件在实际 Location 下生效才能执行受保护操作。文件存在或静态自检成功不等于原生验收通过。
