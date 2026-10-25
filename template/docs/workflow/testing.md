# 测试与证据

按行为、调用方和共享依赖选择验证。行为修复使用能重现失败的测试；无行为变化的文案或文档不机械增加镜像测试。

运行前核正确的工作目录和资源。记录实际命令、输入基线、退出码和必要原件；空跑、全跳过、失败被管道吞掉或命令超时都不能称为通过。

测试或构建经 tail 等管道时保留上游失败。内置 pipefail 识别之外的命令用 `.opencode/workflow/pipefail.json` 登记 token 前缀。不要用 head 截断测试后忽略 SIGPIPE。

单元测试验证局部行为，集成测试核真实边界，原生运行证明插件或平台行为；互不替代。对相同输入已有可靠结果可复用，不为增加全绿次数重复执行。

生成验证报告时说明已验证与未验证范围。发布证据放忽略目录 `.opencode/workflow/.state/`，按启用的发布扩展格式关联任务。二进制附可读 companion；exit=0 本身不证明测试真正执行。

本模板的自测入口是插件 `npm test`、`npm run typecheck`、守卫 `bash .opencode/workflow/checks/run-tests.sh`（Windows PowerShell 中见 `.opencode/workflow/checks/README.md` 的 `py -3` 命令）。项目业务命令在接入后按实际包脚本填入领域规则。
