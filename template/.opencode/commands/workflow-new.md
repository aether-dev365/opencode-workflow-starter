---
description: 从空目录开始的新项目：接入工作流、设计、搭骨架、补齐项目规则并完成基线验收
subagent: false
---

新项目请求：$ARGUMENTS

先加载 `workflow-new-project` 技能，并调用 `workflow_setup` 的 `status`。按技能核对项目现状、判断当前阶段，向用户说明判断依据并得到确认后继续，不重做已完成的阶段。项目里已有业务代码时，先确认是否改用 `/workflow-setup` 按已有项目接入。

工具或技能缺失时说明基础模板尚未加载，阅读 `docs/workflow/new-project.md` 的准备阶段；不编造调用结果，不把脚手架或安装脚本的默认值当成用户选择。不要绕过用户拒绝的权限请求。
