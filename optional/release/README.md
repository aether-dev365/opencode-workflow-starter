# 可选发布扩展

这是可执行扩展，基础模板已包含实现，默认未启用。运行基线和依赖见套件 README。

## 启用

1. 将 `release.example.json` 复制到目标项目 `.opencode/workflow/release.json`，填写真实固定入口 argv、发布范围和产物路径，再设 enabled 为 true。argv 是参数数组，默认不经过 shell。Windows 上 argv 的第一项不能是 `.cmd`/`.bat` 启动器（例如 `npm`、`npx`），Node 不会直接启动它们；改为直接调用解释器，例如 `["node", "scripts/publish.mjs"]`。
2. 保留目标 `opencode.jsonc` 中 workflow_release 的 ask 权限；重新加载插件。该工具只有 entry 参数，不能临时传命令、环境变量或工作目录。
3. 将此处的 `release-checklist.md` 作为项目专项检查单接入 catalog/routing，按领域确定适用路径。默认 core、tests 与 sync 覆盖所有变更。
4. 提交候选和配置。在忽略目录 `.opencode/workflow/.state/release/` 保存本次日志和产物，用 evidence 示例登记真实验证，不填写虚构成功。

## 流程

- 静态预审：workflow_review run mode=preflight。预审只收 pass/findings，不授发布许可。
- 正式审核：workflow_review run mode=release，显式给 evidence 的检出内相对路径；首次发布或基线不明时显式给 base。
- 默认基线只选匹配 tagPattern 的可达 annotated 标签，不按最高版本号猜测。base 是 commit SHA；tree 用 `git rev-parse 'HEAD^{tree}'` 获取。
- reviewer 读取逐单元差异及证据后提交；主代理收齐结论并 close。只有当前候选最新 release 全 pass 才能 check 通过。
- workflow_release entry=配置的入口 ID。工具确认权限后再次核对候选、配置、证据与产物，再运行固定 argv。

证据清单必须关联全部审核任务，可按检查单 ID 或具体任务 ID 指定。test/build 条目 exit 必须为 0，实际测试是否执行由 reviewer 核原件。二进制附可读 companion；每个配置的产物必须在 inputs 中有唯一 `sha256:<相对路径>`，且与实际字节一致。sync 也需要证据：可用 check-sync 对发布范围的输出（kind 为 manual，exit 填实际退出码，示例中的 null 只是占位）；没启用质量扩展时附人工核对记录，exit 为 null。

首版每轮重新审核，不自动沿用旧结论。摘要证明审核时的字节没有变化，不证明构建环境可信。ask 使用原生权限语义，操作者若选择 always 可能保存入口批准；审核核查仍在每次执行前进行，这不是生产 SQL 逐输入一次性审批。

发布范围 include/exclude 与其他路径配置使用同一原生 `*`/`?` 语义；`**` 已包含 `.github/` 和 `.opencode/` 等点目录。花括号不支持，须拆成多条模式。

只有此受控入口受发布核查保护。外部终端、任意 shell 部署或恶意修改插件不在承诺内；团队仍须约定实际发布入口。插件不接管远程账号权限。

## 堵住 shell 绕行

受控入口只保护 `workflow_release`。在目标 `opencode.jsonc` 的 permissions 中、protection 生成的权限块之前加入以下规则，并把占位替换为实际发布脚本或命令：

```json
{ "action": "shell", "resource": "*<发布脚本或命令>*", "effect": "deny" }
```

doctor 要求 protection 权限块位于末尾。前后的 `*` 可以覆盖 `cd … && <命令>` 一类写法；代价是在 shell 里查看该脚本也会被拒绝，需改用 read 工具。

原生 shell 规则只检查解析器识别出的命令，不是可靠的发布边界。路径守卫会对所有代理拒绝可识别的隐藏命令替换与运行时求值组合，并提示改写成直接的命令；分析出错时也拒绝。运行时才构造出来的命令（例如先写进文件再执行）无法静态分析，守卫只拒绝能识别的形式。

这些检查不约束外部终端。固定入口仍通过 `workflow_release` 运行，发布前照常核候选、审核和证据；实际发布权限仍须由执行环境控制。
