#!/usr/bin/env node
/**
 * cmdgo-bridge — CommandCode Go 套餐独立桥接服务入口。
 *
 * 把只能走 CLI 私有网关 `POST /alpha/generate` 的 Go 订阅暴露成 OpenAI
 * 兼容 API，附自带控制台页面（OAuth 登录 / 多账号池管理 / 接入信息）。
 *
 * 用法：
 *   node dist/index.js [--host 127.0.0.1] [--port 11435] [--data-dir ~/.cmdgo-bridge]
 *
 * @module cmdgo-bridge
 */

import { ConfigStore, DEFAULT_DATA_DIR } from './config.js'
import { buildState, createBridgeServer, isLoopbackHost } from './server.js'

function parseArgs(argv: string[]): { host?: string; port?: number; dataDir?: string; help: boolean } {
  const out: { host?: string; port?: number; dataDir?: string; help: boolean } = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
    } else if (arg === '--host' || arg === '--port' || arg === '--data-dir') {
      const value = argv[i + 1]
      if (value === undefined) continue
      if (arg === '--host') out.host = value
      else if (arg === '--port') {
        const port = Number(value)
        if (Number.isInteger(port) && port > 0 && port < 65536) out.port = port
      } else out.dataDir = value
      i += 1
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(`cmdgo-bridge — CommandCode Go 套餐 OpenAI 兼容桥

用法:
  node dist/index.js [选项]

选项:
  --host <addr>     监听地址（默认 127.0.0.1）
  --port <port>     监听端口（默认 11435）
  --data-dir <dir>  数据目录（默认 ${DEFAULT_DATA_DIR}）
  --help            显示本帮助

首次运行自动生成 config.json（含客户端 API key）。浏览器打开
http://127.0.0.1:<port>/ 使用控制台完成 OAuth 登录。`)
    return
  }

  const store = new ConfigStore(args.dataDir ?? DEFAULT_DATA_DIR, (m) => console.log(m))
  const cfg = await store.load()
  if (args.host !== undefined) cfg.host = args.host
  if (args.port !== undefined) cfg.port = args.port
  await store.save(cfg)

  // `--host`/`--port` are written back above, so a single mistaken `--host
  // 0.0.0.0` keeps reaching the network across every later restart. Say so
  // loudly: the admin surface carries no token, and `/api/status` hands out the
  // only credential `/v1/*` accepts.
  if (!isLoopbackHost(cfg.host)) {
    // One `console.warn` call, not seven: separate calls can interleave with
    // stdout when the two streams are captured independently, which scrambles
    // the block and hides which line belongs to which warning.
    console.warn([
      '',
      '  ⚠️  警告：监听地址不是回环地址（当前 ' + cfg.host + '）',
      '     · 管理面（/api/*、/health、控制台页面）没有鉴权，网络内任何客户端都能访问',
      '     · 其中 GET /api/status 会返回客户端 API key，POST /api/logout 会清空账号池',
      '     · 该地址已写入 config.json，重启后依然生效',
      '     · 仅本机使用请改回 127.0.0.1：node dist/index.js --host 127.0.0.1',
      '     · 确需局域网共享：请在前面加带鉴权的反向代理，并把 /api/* 限制为回环来源',
      '',
    ].join('\n'))
  }

  const state = buildState(cfg, store.dataDir)
  // Load the account manifest now rather than on the first chat request, so a
  // corrupt accounts.json is reported at startup with a readable message instead
  // of as an unhandled rejection from inside a request handler.
  try {
    await state.pool.ensureLoaded()
  } catch (error) {
    console.error(`[cmdgo] 启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  state.onError = (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[cmdgo] 端口 ${cfg.port} 已被占用；换端口：node dist/index.js --port <port>`)
      process.exit(1)
    }
    console.error(`[cmdgo] 服务器错误: ${error.message}`)
    process.exit(1)
  }
  state.onListening = () => {
    const base = `http://${cfg.host === '127.0.0.1' ? '127.0.0.1' : cfg.host}:${cfg.port}`
    console.log('')
    console.log('  ┌────────────────────────────────────────────────┐')
    console.log('  │  cmdgo-bridge · Command Code Go → OpenAI 兼容   │')
    console.log('  └────────────────────────────────────────────────┘')
    console.log(`  控制台（OAuth 登录 / 账号池 / 接入信息）: ${base}/`)
    console.log(`  OpenAI 端点: ${base}/v1`)
    console.log(`  客户端 API key: ${cfg.apiKey}`)
    console.log(`  网关: ${cfg.baseURL}/alpha/generate`)
    console.log(`  数据目录: ${store.dataDir}`)
    console.log('')
    console.log('  Agent 工具接入示例:')
    console.log(`    baseURL: ${base}/v1`)
    console.log(`    apiKey : ${cfg.apiKey}`)
    console.log('')
  }
  createBridgeServer(state)
}

main().catch((error: unknown) => {
  console.error(`[cmdgo] 启动失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})