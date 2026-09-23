# 实时探针（会消耗真实额度）

本目录下的脚本**全部会向真实 Command Code 上游发起请求**，因此：

1. **必须显式同意才能运行**：每个脚本都会先检查 `CMDGO_ALLOW_LIVE_PROBES=1`，
   未设置即打印原因并以退出码 1 结束，不会发出任何请求。

   ```powershell
   # Windows PowerShell
   $env:CMDGO_ALLOW_LIVE_PROBES = "1"
   ```

2. **不要在不知情的情况下批量执行**：`npm test` 与 `npm run build` **不会**运行本目录
   下任何脚本；仓库内的自动化测试使用 `test/helpers/fault-upstream.mjs` 与
   `scripts/mock-gateway.mjs`（纯本地、零额度）。
3. **不要把这些脚本的输出接进 CI**。

## 脚本清单

| 脚本 | 额度副作用 | 需要的前置条件 | 用途 |
| --- | --- | --- | --- |
| `check-live-roles.py` | **6 次**对话请求（其中 1 次带图片） | `CMDGO_KEY`（客户端 API key，**无默认值**）；桥已在运行 | 确认非 user 角色带图会被拒，且图片确实被计费（`prompt_tokens` 高于纯文本） |
| `bridge-vision-e2e.mjs` | **多次**带图对话请求 | 桥已在运行；`--base` / `--key`（或 `~/.cmdgo-bridge-visiontest/config.json`） | 端到端视觉验证：图片被真实读取、同字节 base64 可复现、纯文本信封保持逐字节稳定、畸形输入 400、远程 https 图片可抓取 |
| `bridge-vision-raw.mjs` | **1~2 次**带图请求 | `~/.cmdgo-bridge-visiontest/config.json` 存在 | 打印原始响应，用于排查 `finish_reason` / `reasoning_content` / token 明细 |
| `upstream-image-probe.mjs` | **多次**上游请求（**绕过桥**） | `~/.cmdgo-bridge/credentials.json` 中的账号池凭据 | 探测上游接受哪种图片信封形状 |
| `upstream-image-probe2.mjs` | **多次**上游请求（**绕过桥**） | 同上 | 用不可猜的词验证模型是否真的"看见"像素 |

## 凭据读取方式

- `check-live-roles.py` **只从环境变量**读 key（`CMDGO_KEY`），不读磁盘、**不提供默认值**。
  历史上这里硬编码过一个真实 key（审计发现 F-01），已移除。
- 其余 4 个脚本从本机数据目录读凭据（`~/.cmdgo-bridge/` 或
  `~/.cmdgo-bridge-visiontest/`）。请勿把这两个目录提交进 git，也不要把脚本输出贴到公开渠道。

## 相关审计发现

- **F-01**：`check-live-roles.py` 曾硬编码一个与运行配置逐字节相同的客户端 key。
- **F-33**：探针存在额度消耗副作用，而 README 的警告不完整。本文件与门禁即为此而加。
- **F-30**：`src/protocol.ts` / `src/image.ts` 的注释曾指向不存在的 `test/upstream-image-probe*.mjs`，已更正为 `scripts/probes/`。
