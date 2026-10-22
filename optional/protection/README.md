# 扩展凭据保护规则

模板默认只保护 `.env` 类文件、第三方目录和生成目录。`extended-secrets.example.json` 补充四组读、写都拒绝的规则：

| 规则 | 路径 | 说明 |
| --- | --- | --- |
| `private-keys` | `*.pem`、`*.key`、`*.p12`、`*.pfx` | 私钥与证书包；公开证书同样会被拦截，需要时用精确 allow 放行 |
| `ssh-keys` | `*id_rsa`、`*id_ecdsa`、`*id_ed25519`、`*id_dsa` | SSH 私钥；同名 `.pub` 公钥不受影响 |
| `credential-files` | `*.netrc`、`*.pypirc`、`*.aws/credentials` | 常见凭据文件 |
| `terraform-state` | `*.tfstate`、`*.tfstate.*` | Terraform 状态里有明文资源属性和凭据 |

路径语义与其他配置相同：`*` 匹配任意字符（含 `/`），所以 `*.pem` 覆盖任意目录下的 `.pem` 文件。检出外的路径按相对检出的 `../` 路径匹配，`*.aws/credentials` 因此也能拦住 `~/.aws/credentials`。

## 启用

1. 把示例中的 `rules` 逐条追加到目标项目 `.opencode/workflow/protection.json` 的 `rules` 末尾。规则按顺序最后命中生效，追加在末尾不会影响已有的 `.env.example` 放行。
2. 需要放行的具体文件（例如公开证书 `certs/ca.pem`）在其后追加精确的 allow 规则，不要放宽通配。
3. 运行 `node scripts/workflow/doctor.mjs --print-permissions`，用输出替换 `opencode.jsonc` 中 `permissions` 末尾由保护规则生成的权限块，再运行 doctor 确认 `permissions` 通过。
4. doctor 若报已跟踪文件命中读取保护，逐个确认：真实凭据移出仓库并轮换，误伤追加精确 allow。

套件的分发测试会把这些规则合并进模板配置，确认配置有效，且 `deploy/key.pem`、`.ssh/id_ed25519` 读取被拒、`id_ed25519.pub` 与 `.env.example` 放行。
