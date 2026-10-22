---
description: 手动审核分支、工作区或指定 Git 区间
subagent: false
---

审核请求：$ARGUMENTS

主会话解释范围，使用 workflow_review：默认 run mode=branch；明确区间用 mode=range 并给 base/head。返回无改动时如实说明未执行，不称为通过。

按返回的每个任务派只读 reviewer，给出批次、任务、检查单、累计范围及实际材料目录。只有 reviewer 能用 workflow_review_submit 提交。主代理汇总 status/report，全部有结论后 close。

有阻断则集中修复、验证，再对同一累计 base 重跑；不缩窄范围冒充通过。普通审核不授予发布许可。工具缺失时核实际 Location 的插件来源和状态，不用口头结论冒充受管结果。
