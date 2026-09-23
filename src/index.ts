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

import type { Server } from 'node:http'
import { pathToFileURL } from 'node:url'

import { ConfigStore, DEFAULT_DATA_DIR } from './config.js'
import { buildState, createBridgeServer, isLoopbackHost } from './server.js'
import { hardenFile } from './secrets.js'

/** Grace period for in-flight requests during shutdown, before force-closing. */
export const SHUTDOWN_GRACE_MS = 10_000

export interface ShutdownOptions {
  /** How long to wait for in-flight requests; see {@link SHUTDOWN_GRACE_MS}. */
  graceMs?: number
  /** Progress log; defaults to `console.log`. */
  log?: (message: string) => void
}

/**
 * Stops accepting work, waits briefly for in-flight responses, then flushes
 * pending manifest writes.
 *
 * Exported and free of `process.exit` so the sequence itself can be tested:
 * signal DELIVERY cannot be exercised on Windows (there `child.kill('SIGTERM')`
 * terminates the process without running `'SIGTERM'` handlers), so the ordering
 * this function guarantees — close, then flush — is otherwise untestable.
 *
 * Why a shutdown path exists at all: `toggle` and the account cool-down
 * bookkeeping update `accounts.json` outside any request. Ctrl-C or a service
 * restart landing between the in-memory change and the write would leave the
 * operator seeing a disabled account enabled again, with nothing in the log.
 */
export async function shutdown(
  server: Server,
  pool: { flush(): Promise<void> },
  reason: string,
  options: ShutdownOptions = {},
): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(message))
  const graceMs = options.graceMs ?? SHUTDOWN_GRACE_MS
  log(`[cmdgo] 收到 ${reason}，正在退出…`)
  // `close()` stops new connections and waits for in-flight responses, so a long
  // agent run can hold it for minutes. Bound the wait: past the grace period the
  // flush matters more than the last few tokens.
  const closed = new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeIdleConnections?.()
  })
  const timer = setTimeout(() => {
    log(`[cmdgo] 等待在途请求超时（${Math.round(graceMs / 1000)}s），强制关闭连接`)
    server.closeAllConnections?.()
  }, graceMs)
  try {
    await closed
  } finally {
    clearTimeout(timer)
  }
  await pool.flush()
  log('[cmdgo] 账号清单已落盘，退出完成')
}

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

/**
 * Shrinks the permissions of every secret-bearing file in the data directory.
 *
 * `config.json` holds the downstream token, `credentials.json` the upstream keys,
 * and `accounts.json` their names. Files written before the mode fix keep whatever
 * permissions they were created with (`0o644` under a typical umask, i.e. readable
 * by every local account on a shared Unix host), and nothing rewrites them until
 * an account is toggled — so a startup pass is what actually closes that window.
 *
 * Best-effort: `hardenFile` logs and continues on failure.
 *
 * @param dataDir resolved data directory
 */
async function hardenDataDirFiles(dataDir: string): Promise<void> {
  const { join } = await import('node:path')
  await Promise.all([
    hardenFile(join(dataDir, 'config.json'), 'config.json'),
    hardenFile(join(dataDir, 'credentials.json'), 'credentials.json'),
    hardenFile(join(dataDir, 'accounts.json'), 'accounts.json'),
  ])
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
  // Shrink the permissions of files written before this hardening existed.
  // Awaited but never fatal (see `hardenFile`), and run before the manifest is
  // loaded so an operator sees the warning next to the startup banner rather than
  // in the middle of the first request.
  await hardenDataDirFiles(store.dataDir)
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
  const server = createBridgeServer(state)

  let shuttingDown = false
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (shuttingDown) return
      shuttingDown = true
      void shutdown(server, state.pool, signal).then(() => process.exit(0))
    })
  }
}

// Only start the server when this module is the entry point. Without the guard,
// importing it (for `shutdown`, in tests) would boot a second bridge on the
// configured port — and fight the one under test for the data directory.
const isEntryPoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error(`[cmdgo] 启动失败：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}