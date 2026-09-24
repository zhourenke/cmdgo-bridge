# cmdgo-bridge

把 **Command Code Go 套餐**接入任意 Agent 工具的本地桥接服务，自带 Web 控制台。

![控制台](assets/console.png)

## 这是什么

Command Code 的订阅分两种形态。标准 Provider API 是 OpenAI 兼容的，任何工具都能直连；**Go 套餐**无法直连官方 OpenAI 端点。本桥把 Go 套餐包装成 **OpenAI 兼容 API**，于是 Cherry Studio、Cline、Roo Code、Continue、Cursor、ZCode 等所有支持自定义 OpenAI 端点的 Agent 工具都能直接连上来。

本桥跑在你自己的机器上，默认只监听回环地址 `127.0.0.1`，数据落盘在你的用户目录，自带控制台完成 OAuth 登录与账号池管理，不需要数据库或任何框架。

> 本仓库是 [Patrick-mufeng/cmdgo-bridge](https://github.com/Patrick-mufeng/cmdgo-bridge) 的 fork，上游提交历史完整保留，并在原版基础上做了协议合规、并发与持久化、管理面安全边界等方面的改进。

## 功能特性

- **OpenAI 兼容接口**：对话补全支持流式与非流式，支持工具调用、`reasoning_effort`、`max_tokens`、`temperature` 与 `top_p`。
- **图片输入**：支持内联 `data:` 图片与远程 `http(s)` 图片地址。
- **OAuth 登录**：控制台一键发起登录，浏览器授权后凭据自动入池，免手动复制。
- **多账号池**：多份凭据轮流使用以摊薄额度，某一份失效时自动切换到下一份。
- **并发保护**：同时进行的对话请求有上限，超出时立刻返回 `429`，不在上游排队。
- **模型目录**：自动同步 Go 套餐可用的模型列表，控制台点击即复制模型 ID。

## 快速开始

### 1. 准备并构建

需要 **Node.js ≥ 20.3**，其中包含 `npm`。用 `node --version` 确认版本，然后获取项目并安装构建：

```sh
git clone https://github.com/zhourenke/cmdgo-bridge.git
cd cmdgo-bridge
npm install
npm run build
```

也可以直接下载仓库 ZIP 并解压，再执行后两条命令。

### 2. 启动

**Windows**：双击 `start.cmd`。窗口保持开启即在线，关闭即停止。

**任意平台**：

```sh
npm start
```

首次启动会自动生成配置，终端打印类似：

```
OpenAI 端点: http://127.0.0.1:11435/v1
客户端 API key: 4e80cd8cbac4c07ab03db0afc95fdb5c1d0d9f9f22d073f7
```

### 3. 完成 OAuth 登录

1. 浏览器打开 `http://127.0.0.1:11435/`。
2. 点「**▸ 发起登录**」，出现登录地址后点「**打开登录页 ↗**」。
3. 在 Command Code 授权页确认，浏览器会把凭据回传给本机。
4. 控制台状态变为「**✓ 授权成功**」，账号出现在账号池，状态为 `READY`。

每完成一次登录都会新增一个独立账号，可以登录多次来扩大账号池。

### 4. 在 Agent 工具中配置

任意 OpenAI 兼容客户端都填这三项：

| 配置项 | 值 |
| --- | --- |
| Base URL | `http://127.0.0.1:11435/v1` |
| API Key | 终端打印的值，也可以在控制台 CONFIG 区查看与复制 |
| 模型 ID | 控制台 MODELS 区列出的模型，点击即复制，例如 `deepseek/deepseek-v4-pro` |

验证连通：

```sh
curl http://127.0.0.1:11435/v1/chat/completions \
  -H "Authorization: Bearer <你的API Key>" \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-pro","messages":[{"role":"user","content":"你好"}]}'
```

常见工具的填写位置：**Cherry Studio / NextChat / LobeChat** 新增 OpenAI 兼容供应商并填入上表三项；**Cline / Roo Code** 选 OpenAI Compatible 供应商；**Cursor** 在 Settings → Models 里填 key 并覆写 Base URL；**Continue** 在 `config.json` 里加 `{"provider":"openai","apiBase":"http://127.0.0.1:11435/v1",...}`。

## 配置

数据目录默认 `~/.cmdgo-bridge/`，可以用 `--data-dir` 指定。`config.json` 在首次启动时自动生成：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `host` | `127.0.0.1` | 监听地址 |
| `port` | `11435` | 监听端口 |
| `apiKey` | 随机生成 | 客户端 Bearer token，下游工具用它访问本桥 |
| `maxTokens` | `64000` | 单次输出上限 |
| `defaultContextWindow` | `262144` | 上游未披露容量时的兜底值 |
| `allowedHosts` | `[]` | 允许访问控制台的额外域名 |
| `images.maxBytes` | `8388608` | 单张图片解码后的字节上限 |
| `images.maxPerRequest` | `12` | 单次请求的图片数量上限 |
| `images.fetchTimeoutMs` | `15000` | 远程图片抓取超时 |
| `images.maxRedirects` | `3` | 远程图片允许的重定向跳数 |
| `images.allowPrivateNetwork` | `false` | 是否允许远程图片地址指向内网 |
| `images.allowRemote` | `true` | 是否允许抓取远程图片地址 |

命令行参数有 `--host <addr>`、`--port <port>`、`--data-dir <dir>` 与 `--help`。

> ⚠️ **把 `host` 改成非回环地址，会让没有鉴权的管理面暴露给网络内任何客户端。** 对方可以读取客户端 API key，也可以清空账号池。启动时会打印醒目告警。仅本机使用时请保持默认值；确需局域网访问，请在前面加一层带鉴权的反向代理。另外 `--host` 与 `--port` 会写回 `config.json` 持久生效，一次 `--host 0.0.0.0` 会跨重启一直生效，直到你显式改回来。

## 使用须知

**客户端 key 与上游凭据是两个独立的东西。** 前者是下游工具连本桥用的，后者是本桥连上游用的。重新登录上游不会改变前者。**轮换客户端 key 是全局操作**：本桥只有一个客户端 key，所有下游工具共用，没有按使用者区分的账号，也没有按 key 的计量，换掉之后每一个下游工具都要跟着换。

**全局并发上限是 16。** 超出的对话请求不会排队，而是立刻返回一个真实的状态码，客户端可以按 `Retry-After` 重试。想知道当前占用，可以查 `GET /health`：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 2

{"error":{"message":"并发对话请求已达上限（16），请稍后重试","type":"invalid_request_error","code":"rate_limit_exceeded","param":null}}
```

**失败的回答不带 `usage`，也不带结束标记。** 因此「回包里有 `usage`」就等于「这次真的生成完了」，不要把没有 `usage` 的流当成完整回答。**`completion_tokens` 包含思维链 token**，推理型模型的 `reasoning_tokens` 往往占大头，一次只输出两三行答案的请求也可能花掉数千 token，按输出计费或做预算时必须算进去。

**`max_tokens` 超过模型上下文窗口会直接被拒**，返回 400 与 `context_length_exceeded`，错误信息里同时给出请求值与窗口值，便于自动收缩重试。

**以下参数会被明确拒绝**，返回 400 与 `unsupported_parameter`，而不是被静默忽略：

| 参数 | 说明 |
| --- | --- |
| `n` | 本桥固定只回 1 个 choice，`n: 1` 照常接受 |
| `stop` | 上游网关没有停止序列参数 |
| `response_format` | 上游网关没有响应格式参数 |
| `tool_choice` | 无法强制或禁止工具调用，`auto` 照常接受 |
| `parallel_tool_calls` | 同上，`true` 照常接受 |

**模型列表可能为空，但对话请求仍然可用。** 列表来自上游目录，首次拉取失败时会是空的，此时对话请求照常工作，不要用模型列表做可用性预检。

**图片输入**支持内联 `data:` 图片与远程 `http(s)` 地址，单张图片的字节数与单次请求的图片数量都有上限。参数名 `input_image` 同样接受，而 `input_audio`、`input_file`、`video` 会被明确拒绝，不会静默丢弃。如果你不希望本桥替客户端抓取远程图片，把 `images.allowRemote` 设为 `false`，此后只接受内联图片，本桥不会再发起任何出站请求。

## 轮换客户端 API key

怀疑 key 泄露、或有人不再需要访问时，在运行本桥的机器上打开控制台 `http://127.0.0.1:11435/`，在 CONFIG 区的 API KEY 一行点「轮换」。确认后页面会直接显示新 key，用「复制」分发下去。

轮换后旧 key **立即失效**，没有宽限期，所有使用它的下游工具都要换成新值。凡是填过这个 key 的地方都要改，包括 Agent 工具里的 API Key、`OPENAI_API_KEY` 环境变量、写进 `~/.codex/config.toml` 之类的配置文件以及 CI 里的 secret。轮换本身不影响上游授权，也不需要重启。

## 排错

| 现象 | 处理 |
| --- | --- |
| 启动报「端口已被占用」 | 已有一个实例在运行，关掉旧窗口，或者用 `--port` 换一个端口 |
| 对话报 `401 invalid_api_key` | Agent 工具里填的 key 与终端打印的不一致，去控制台 CONFIG 区复制正确的值 |
| 对话报 `401 MISSING_CREDENTIAL` | 还没有完成 OAuth 登录，先到控制台发起登录 |
| 启动提示「config.json 无法解析」 | 配置文件损坏，原文件已改名保留为 `config.json.corrupt-<时间戳>`，用控制台复制新的 key 重新分发给下游 |
| 启动提示「accounts.json 无法解析」 | 账号清单损坏。本桥会拒绝启动，以免覆盖掉你的账号列表；按提示修好或删除该文件后重启 |
| 手改了账号文件但不生效 | 运行中的本桥以内存副本为准。在控制台点重载，或调用 `curl -X POST http://127.0.0.1:11435/api/reload` |
| 想进一步排查 | 每个请求都记在启动窗口与 `~/.cmdgo-bridge/access.log` 里，聊天请求另有模型与账号明细 |
| 启动打印「监听地址不是回环地址」 | 管理面已对网络暴露。仅本机使用就改回 `--host 127.0.0.1`，确需局域网访问请加反向代理 |
| 控制台 CONFIG 区显示「非回环来源，已隐去」 | 你是从非回环地址打开控制台的，本桥只对回环来源下发客户端 key；请在运行本桥的机器上访问 `http://127.0.0.1:<port>/` |
| 控制台打不开或全是 403 | 用域名访问时，把该域名加进 `config.json` 的 `allowedHosts` 再重启 |
| 连不上 11435 | 检查 `~/.cmdgo-bridge/config.json` 里的 `port`，它可能被 `--port` 改过并持久化了 |
| 控制台登录后收不到回调 | 回调服务器绑定 `127.0.0.1:5959..5968`；浏览器与宿主不同机时需端口转发或 SSH 隧道 |
| 「重新连接 / 超时」 | 本桥没有在运行，或者请求体超过了大小上限 |

## 定位与免责

本桥是非官方项目，仅限个人与小范围非商业使用。它不是 Command Code 的官方产品，也不提供任何面向第三方的计费、SLA 或用量承诺。请遵守 Command Code 的服务条款。

更完整的安全边界、已知限制与开发运维说明见 [DEVELOPMENT.md](DEVELOPMENT.md)。