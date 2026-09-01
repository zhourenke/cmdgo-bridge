# cmdgo-bridge

Command Code **Go 套餐**独立桥接服务：把只能用官方 CLI 私有网关 `POST /alpha/generate` 的 Go 订阅，包装成 **OpenAI 兼容 API**，任何支持自定义 OpenAI 端点的 Agent 工具都能接入（Cherry Studio、Cline、Roo Code、Continue、Cursor 自定义供应商等）。自带 Web 控制台完成 OAuth 登录与多账号池管理。

> 核心协议/登录/账号池代码从 [dsh-cmdgo-provider](../README.md) 移植（零 DSH 依赖），请求信封与流式解析对齐官方 CLI。

## 快速开始

```sh
cd standalone
npm install
npm run build

# 启动（首次自动生成 ~/.cmdgo-bridge/config.json，含客户端 API key）
node dist/index.js
```

启动后终端会打印：

- 控制台地址：`http://127.0.0.1:11435/`（OAuth 登录 / 账号池 / 接入信息）
- OpenAI 端点：`http://127.0.0.1:11435/v1`
- 客户端 API key（Bearer token）

打开控制台 →「发起登录」→ 浏览器授权 → 回调自动回收 key 入池，即可在任意 Agent 工具中使用。

## 接入 Agent 工具

任何 OpenAI 兼容客户端，配置三件事：

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:11435/v1` |
| API Key | 终端打印的 key（或控制台 CONFIG 区查看/复制） |
| 模型 ID | 控制台 MODELS 区从官方目录同步的 Go 模型（点击复制） |

```sh
curl http://127.0.0.1:11435/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<模型ID>","messages":[{"role":"user","content":"你好"}]}'
```

支持：流式 / 非流式、工具调用（含 `role: tool` 结果回传）、`reasoning_effort`、`max_tokens`、`temperature` / `top_p`。

## 多账号池

每完成一次 OAuth 登录，新 key 自动成为池中独立账号（元数据在 `~/.cmdgo-bridge/accounts.json`，key 在 `credentials.json`）；重复登录同一 key 只刷新标签。

- **调度**：请求级 round-robin；某账号失败（401/403/429/5xx/传输错误）按指数冷却（30s 起，封顶 15min），同请求内自动切换下一账号（首字节前才允许换号，绝不重放半截回答）。
- **管理**：控制台可停用/启用/移除单个账号，「清空账号池」清空全部。

## 配置

`~/.cmdgo-bridge/config.json`（首次启动自动生成）：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址；`0.0.0.0` 局域网共享时 `/v1` 靠 API key 鉴权，控制台 `/api` 无鉴权请注意 |
| `port` | `11435` | 监听端口（`node dist/index.js --port 8080` 可覆盖并持久化） |
| `baseURL` | `https://api.commandcode.ai` | 网关 base；`/alpha/generate` 自动追加 |
| `apiKey` | 随机生成 | 客户端 Bearer token；手动改需 ≥8 字符 |
| `maxTokens` | `64000` | 单次输出上限 |
| `defaultContextWindow` | `1000000` | 模型无精确上下文时的兜底 |

数据目录可用 `--data-dir <dir>` 指定。

## 协议对齐

请求指纹完整复刻官方 `cmd` CLI（v1.31.0）：`User-Agent: commandcode/1.31.0` + `x-command-code-version` / `x-cli-environment: production` / `x-taste-learning` / `x-session-id`（`cli-<ISO时间>`）/ `x-project-slug`；event 流为 NDJSON（text-delta / reasoning-delta / tool-call / finish-step）。模型目录来自公开端点 `/provider/v1/models`（按 Go 套餐规则筛选）＋官方 CLI catalog 的 reasoning effort 元数据，每 15 分钟刷新。

## 排错

- **对话报 401 MISSING_CREDENTIAL**：先到控制台完成一次 OAuth 登录。
- **报 `invalid_api_key`**：Agent 工具里填的 key 不是终端打印的客户端 key。
- **模型列表为空**：目录来自 `https://api.commandcode.ai/provider/v1/models`（免鉴权），检查网络；日志会告警并在 15 分钟后重试。
- **回调收不到**：回调服务器绑定 `127.0.0.1:5959..5968`；浏览器与宿主不同机时需保证 `localhost:<port>` 能回到宿主（端口转发/SSH 隧道）。

## 本地联调（无需真订阅）

`scripts/mock-gateway.mjs` 是一个模拟网关，可完整走通流式/工具调用/故障转移：

```sh
npm run mock &                  # 模拟网关 127.0.0.1:18999
node dist/index.js --data-dir /tmp/bridge-test   # 然后把 config.json 的 baseURL 改成 http://127.0.0.1:18999
```

mock 的行为：`user_goodkey` 成功、`user_failkey` 403、`user_noplan` 返回 `MODEL_NOT_IN_PLAN`；登录回调时用这些 key 即可测故障转移。

> 非官方项目，仅限个人使用；请遵守 Command Code 服务条款。