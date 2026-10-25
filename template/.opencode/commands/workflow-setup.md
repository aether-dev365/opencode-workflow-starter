---
description: 引导接入或调整工作流程、子代理模型和可选组件
subagent: false
---

接入请求：$ARGUMENTS

先加载 `workflow-onboarding` 技能，并调用 `workflow_setup` 的 `status`。按技能逐步解释和询问，不直接使用默认答案安装。完整模式缺少 Superpowers 时先处理其安装与实际加载，再进入设计和计划。

工具或技能缺失时说明基础模板尚未加载，阅读 `docs/workflow/onboarding.md` 的首次接入与恢复说明；不编造调用结果，不把 shell 安装脚本的等待输入当成用户选择。不要绕过用户拒绝的权限请求。
