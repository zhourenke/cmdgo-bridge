/**
 * HTTP wiring: OpenAI-compatible endpoints (`/v1/*`), the admin API the
 * console page talks to (`/api/*`), and static serving of the console itself.
 *
 * @module cmdgo-bridge/server
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { appendFile } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timingSafeEqual, randomBytes } from 'node:crypto'
import { DEFAULT_DATA_DIR, ConfigStore } from './config.js'
import type { ServerConfig } from './config.js'
import { AccountPool } from './pool.js'
import type { CredentialsSeam, PoolAccount } from './pool.js'
import { FileCredentials } from './credentials.js'
import { DEFAULT_STUDIO_BASE, CommandCodeLoginManager } from './oauth.js'
import type { LoginSuccessInfo, LoginStatus } from './oauth.js'
import { fetchCatalogEfforts, fetchGoModels } from './models.js'
import {
  ClientError,
  GatewayError,
  applyEvent,
  buildNonStream,
  chatCompletionId,
  emptyAccumulator,
  openGateway,
  parseChatRequest,
  poolState,
  usageObject,
} from './openai.js'
import type { ChatRequest, Accumulator } from './openai.js'

/** Catalog refresh cadence; the listing is stable so slow polling is fine. */
const REFRESH_MS = 15 * 60_000
/** Request body cap（LLM 对话请求可到数 MB，只拦真正的滥用）。 */
const BODY_CAP = 8 * 1024 * 1024

export interface BridgeModel {
  id: string
  name: string
  contextWindow: number
  efforts?: string[]
}

export interface BridgeState {
  cfg: ServerConfig
  /** Data directory; also where the access log is written. */
  dataDir: string
  credentials: CredentialsSeam
  pool: AccountPool
  login: CommandCodeLoginManager
  /** Called once the primary loopback listener is up. */
  onListening?: () => void
  /** Fatal server error (e.g. EADDRINUSE); the caller decides to exit. */
  onError?: (error: NodeJS.ErrnoException) => void
}

/**
 * Reads the optional diagnostics a credential store may expose.
 *
 * `CredentialsSeam` is the pool's minimal contract (resolve/describe/set/unset)
 * and is stubbed in tests, so these are probed rather than required.
 */
function credentialsDiagnose(credentials: CredentialsSeam): string | undefined {
  const diagnose = (credentials as { diagnose?: () => { error?: string } }).diagnose
  if (typeof diagnose !== 'function') return undefined
  return diagnose.call(credentials).error
}

/** Drops a credential store's cache when it supports reloading. */
function credentialsInvalidate(credentials: CredentialsSeam): void {
  const invalidate = (credentials as { invalidate?: () => void }).invalidate
  if (typeof invalidate === 'function') invalidate.call(credentials)
}

const INDEX_FILE = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'index.html')
/**
 * 访问/聊天日志落盘：无论桥由谁启动(控制台 vs 双击脚本)都可追溯。
 * Follows the configured data directory so a `--data-dir` run does not scatter
 * its logs into `~/.cmdgo-bridge`; `createBridgeServer` overrides this.
 */
let accessLogFile = join(DEFAULT_DATA_DIR, 'access.log')

function logLine(line: string): void {
  console.log(line)
  void appendFile(accessLogFile, `${line}\n`).catch(() => {})
}

function json(res: ServerResponse, statusCode: number, body: unknown): void {
  if (res.writableEnded) return
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * CORS for the OpenAI-compatible surface only. That surface is protected by the
 * bearer token, and browser-based clients legitimately live on other origins.
 */
function cors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
}

/** IPv4 literal, e.g. 192.168.1.10. */
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** IPv4-mapped IPv6 (`::ffff:127.0.0.1`), which Node reports for v4 clients on a dual-stack socket. */
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i

/**
 * Whether a socket address is the local machine.
 *
 * Used to decide whether the admin surface may disclose the bearer token: with
 * `--host 0.0.0.0` any LAN client reaches `/api/status`, and the token it
 * returns is the only credential `/v1/*` has.
 */
function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined || address.length === 0) return false
  const bare = address.replace(/^\[|\]$/g, '')
  const mapped = IPV4_MAPPED.exec(bare)
  if (mapped?.[1] !== undefined) return isLoopbackAddress(mapped[1])
  if (bare === '::1') return true
  return /^127\./.test(bare)
}

/**
 * Whether a configured bind host keeps the admin surface on this machine.
 *
 * A hostname (anything that is not an IP literal) is treated as non-loopback:
 * `localhost` is the one exception, and `0.0.0.0`/`::` are explicitly exposed
 * because those are the wildcard binds that reach the network.
 */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (name === 'localhost') return true
  if (name === '0.0.0.0' || name === '::' || name === '*') return false
  if (IPV4_LITERAL.test(name)) return /^127\./.test(name)
  return name === '::1'
}

/**
 * Whether the `Host` header names something the admin surface may answer to.
 *
 * Without this, a DNS-rebinding page (`evil.com` resolving to 127.0.0.1) is
 * same-origin with the bridge and sails past the `Origin` check below. Only
 * loopback names, IP literals, the configured bind host and anything listed in
 * `allowedHosts` are accepted, so a rebound request carrying `Host: evil.com`
 * is refused. Operators behind a reverse proxy or a LAN name add it to
 * `allowedHosts` in config.json.
 */
function hostAllowed(req: IncomingMessage, cfg: ServerConfig): boolean {
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  const name = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
  if (name === 'localhost' || name === '::1') return true
  if (IPV4_LITERAL.test(name)) return true
  // Bracketed IPv6 keeps its colons after the port strip.
  if (name.includes(':')) return true
  if (name === cfg.host.toLowerCase()) return true
  return cfg.allowedHosts.includes(name)
}

/**
 * Whether a browser request may touch the admin surface.
 *
 * `/api/*` and `/health` carry no token, so without this check any web page the
 * user visits could read `/api/status` — which discloses the bearer token — or
 * POST `/api/logout` and wipe the account pool. Cross-origin requests are
 * refused; the same-origin console and non-browser clients such as curl (which
 * send no `Origin`) are unaffected.
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Reject an oversized body from its declared length before buffering anything.
  const declared = Number(req.headers['content-length'])
  if (Number.isSafeInteger(declared) && declared > BODY_CAP) {
    throw new ClientError(`request body too large (max ${BODY_CAP / 1024 / 1024} MiB)`, 413)
  }
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  /**
   * Discard everything past the cap instead of buffering it.
   *
   * The declared-length check above only covers an honest `Content-Length`. A
   * chunked upload (or one that under-declares) used to set an `overflow` flag
   * and drop further chunks, but it still read to the end of a body of unbounded
   * size before answering — one client could occupy a connection indefinitely.
   *
   * The bytes past the cap are still consumed, not paused. Pausing looks like
   * the cheaper option but deadlocks: with the request stalled the client keeps
   * filling the socket, the receive window closes, and the 413 cannot be flushed
   * back — the client is left waiting for a response that is stuck behind its
   * own upload. Reading and dropping uses no extra memory, lets the response
   * out, and the connection is torn down once the 413 is on the wire (see
   * `closeAfterOversize`).
   */
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (overflow) return
      if (size > BODY_CAP) {
        overflow = true
        chunks.length = 0
        finish()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', finish)
    req.on('error', finish)
    req.on('close', finish)
  })
  if (overflow) throw new ClientError(`request body too large (max ${BODY_CAP / 1024 / 1024} MiB)`, 413)
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    logLine(`[cmdgo] body parse failed (${raw.length} bytes)`)
    throw new ClientError('invalid JSON body')
  }
}

export function createBridgeServer(state: BridgeState): Server {
  const { cfg, credentials, pool, login } = state
  accessLogFile = join(state.dataDir, 'access.log')

  // 池预热：`openGateway` 会自行等待加载完成，这里只是免去首个请求的加载
  // 延迟，并让坏清单在启动日志里尽早暴露。
  void pool.list().catch(() => {})

  /** 模型目录实时视图；sync() 换入新目录后接口立刻可见。 */
  const holder: { current: BridgeModel[] } = { current: [] }
  const models = (): readonly BridgeModel[] => holder.current
  let indexCache: string | undefined
  void readFile(INDEX_FILE, 'utf8').then((text) => { indexCache = text }).catch(() => { indexCache = undefined })

  // --- OAuth 登录生命周期（与插件侧一致：幂等 start + 后台等待 + 入池持久化） ---
  let loginPromise: Promise<LoginSuccessInfo> | undefined
  const log = (message: string) => { console.log(`[cmdgo] ${message}`) }

  async function persistKey(info: LoginSuccessInfo): Promise<void> {
    try {
      const known = await pool.findByKey(credentials, info.apiKey)
      if (known !== undefined) {
        pool.touchMeta(known, { userName: info.userName, keyName: info.keyName })
        log(`该 key 已在账号池（${known.id}），仅刷新标签`)
        return
      }
      const account = await pool.add(credentials, info)
      log(`API key 已入池 ${account.ref}${info.userName === undefined ? '' : `（user=${info.userName}）`}`)
    } catch (error) {
      log(`凭据写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function beginLogin(): Promise<{ authUrl: string; callbackUrl: string }> {
    const started = await login.start({ studioBase: DEFAULT_STUDIO_BASE })
    if (loginPromise === undefined || !login.isWaiting()) {
      loginPromise = login.waitForCallback().then(
        (info) => { void persistKey(info); return info },
        (error: unknown) => {
          log(`登录结束：${error instanceof Error ? error.message : String(error)}`)
          throw error
        },
      )
      // 后台等待；拒绝由上面分支记录，避免 unhandled rejection。
      loginPromise.catch(() => {})
    }
    return started
  }

  interface StatusSnapshot {
    ok: boolean
    provider: string
    baseURL: string
    endpoint: string
    /** 仅在回环来源请求时下发；见 {@link statusSnapshot}。 */
    apiKey?: string
    maxTokens: number
    modelCount: number
    modelIds: string[]
    login: LoginStatus
    activeAccounts: number
    accounts: unknown[]
    /** Parse failures on the on-disk state files; absent when both are usable. */
    storageWarning?: string
  }

  /**
   * Builds the console snapshot.
   *
   * `includeApiKey` must only be true for loopback callers. The admin surface is
   * unauthenticated, so with `--host 0.0.0.0` a bare `curl http://<lan-ip>:11435/
   * api/status` would otherwise hand any client on the network the bearer token
   * that `/v1/*` accepts — and the same reachability lets it POST `/api/logout`
   * to wipe the pool. Binding to loopback (the default) keeps this dormant; the
   * check is depth in case the bind is ever widened.
   */
  async function statusSnapshot(includeApiKey: boolean): Promise<StatusSnapshot> {
    const snapshot = models()
    const now = Date.now()
    const rows = await Promise.all((await pool.list()).map(async (account: PoolAccount) => {
      let accountConfigured = false
      try { accountConfigured = (await credentials.describe(account.ref)).configured } catch { /* 视为缺失 */ }
      return {
        id: account.id,
        ref: account.ref,
        ...(account.userName === undefined ? {} : { userName: account.userName }),
        ...(account.keyName === undefined ? {} : { keyName: account.keyName }),
        addedAt: account.addedAt,
        enabled: account.enabled,
        failCount: account.failCount,
        cooling: (account.cooldownUntil ?? 0) > now,
        ...(account.lastError === undefined ? {} : { lastError: account.lastError }),
        configured: accountConfigured,
      }
    }))
    const endpoint = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}/v1`
    // A credentials.json that failed to parse presents as "no account
    // configured", which looks exactly like a fresh install. Surface the
    // difference here so the console can say which file is broken. The seam
    // intentionally does not carry this, so accept the optional extension.
    const credentialProblem = credentialsDiagnose(credentials)
    const missingKeys = rows.filter(row => row.configured !== true).map(row => row.id)
    const warnings: string[] = []
    if (credentialProblem !== undefined) warnings.push(`credentials.json 无法解析：${credentialProblem}`)
    if (missingKeys.length > 0) warnings.push(`以下账号缺少凭据：${missingKeys.join(', ')}`)
    return {
      ok: true,
      provider: 'commandcode',
      baseURL: cfg.baseURL,
      endpoint,
      ...(includeApiKey ? { apiKey: cfg.apiKey } : {}),
      maxTokens: cfg.maxTokens,
      modelCount: snapshot.length,
      modelIds: snapshot.map(m => m.id),
      login: login.status,
      activeAccounts: pool.activeCount(now),
      accounts: rows,
      ...(warnings.length === 0 ? {} : { storageWarning: warnings.join('；') }),
    }
  }

  /** 请求承载的 bearer token 是否与配置一致（常数时间比较）。 */
  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (match === null) return false
    const presented = Buffer.from(match[1] ?? '')
    const expected = Buffer.from(cfg.apiKey)
    if (presented.length !== expected.length) return false
    return timingSafeEqual(presented, expected)
  }

  /* ---------------- /v1/* : OpenAI 兼容面 ---------------- */

  function handleModelsList(_req: IncomingMessage, res: ServerResponse): void {
    json(res, 200, {
      object: 'list',
      data: models().map(m => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'commandcode',
        // Not part of the OpenAI schema, but the field clients actually read
        // for this (it is also what Command Code's own listing discloses, and
        // the first name DSH's discovery tries). A client without it can only
        // guess the capacity, and so cannot tell a reply the provider truncated
        // from one the model chose to end.
        context_length: m.contextWindow,
      })),
    })
  }

  function openaiErrorBody(message: string, code: string): unknown {
    return { error: { message, type: 'invalid_request_error', code, param: null } }
  }

  /**
   * Sends a JSON error and stops the client from finishing the upload.
   *
   * `readBody` rejects as soon as it has seen enough, so for a large body the
   * request stream is still unread when the error goes out. Without
   * `Connection: close` the client keeps uploading a body nobody will read and
   * the socket lingers; the header tells it to stop and drop the connection.
   */
  function jsonError(res: ServerResponse, status: number, body: unknown): void {
    if (!res.headersSent) res.setHeader('Connection', 'close')
    json(res, status, body)
  }

  /**
   * Refuses to keep a connection whose body was rejected as oversized.
   *
   * The body keeps being read (see `readBody`) so the 413 can reach the client,
   * which means an unbounded upload would otherwise hold the connection until it
   * finished on its own. `destroySoon()` waits for the queued response bytes to
   * flush before closing; a plain `destroy()` on `'finish'` is not equivalent —
   * `'finish'` only means the response was handed to the socket, so destroying
   * there discards the bytes still queued and the client sees a connection reset
   * instead of the 413.
   */
  function closeAfterOversize(req: IncomingMessage, res: ServerResponse, status: number): void {
    if (status !== 413) return
    res.once('close', () => req.socket.destroySoon())
  }

  async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Record<string, unknown>
    let chat: ChatRequest
    // The abort controller is created before parsing because a remote image URL
    // is fetched during parsing and must die with a disconnected client.
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    try {
      body = await readBody(req)
      chat = await parseChatRequest(body, { imageLimits: cfg.images, signal: controller.signal })
    } catch (error) {
      const message = error instanceof ClientError ? error.message : 'invalid request'
      const status = error instanceof ClientError ? error.httpStatus : 400
      jsonError(res, status, openaiErrorBody(message, 'invalid_request_error'))
      closeAfterOversize(req, res, status)
      logLine(`[cmdgo] chat 请求被拒 ${status} ${message}`)
      return
    }

    const startedAt = Date.now()
    const ctx = {
      cfg,
      pool,
      credentials,
      signal: controller.signal,
      onAccount: (account: PoolAccount) => {
        logLine(`[cmdgo] chat 开始 model=${chat.model} stream=${chat.stream} account=${account.id}`)
      },
    }
    const logOutcome = (outcome: string, detail = ''): void => {
      logLine(`[cmdgo] chat 结束 model=${chat.model} stream=${chat.stream} ${outcome} ${Date.now() - startedAt}ms${detail ? ` ${detail}` : ''}`)
    }

    if (!chat.stream) {
      try {
        const acc = emptyAccumulator()
        let finished = false
        for await (const event of openGateway(chat, ctx)) {
          applyEvent(acc, event)
          if (event.type === 'finish-step') { finished = true; break }
        }
        if (!finished) throw new GatewayError('Command Code 网关未发送 finish-step', 502, 'STREAM_CLOSED')
        json(res, 200, buildNonStream(chat, acc))
        logOutcome('ok')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof ClientError) {
          json(res, error.httpStatus, openaiErrorBody(message, 'invalid_request_error'))
          logOutcome('client-error', message)
        } else if (error instanceof GatewayError) {
          json(res, error.httpStatus, openaiErrorBody(message, error.code))
          logOutcome(`error ${error.code}`, message)
        } else {
          json(res, 500, openaiErrorBody(message, 'INTERNAL'))
          logOutcome('error INTERNAL', message)
        }
      }
      return
    }

    // 流式：请求校验一过就提交 SSE 头——真实网关首 token 可能数秒，
    // 等上游首个事件再发头会让带首字节超时的客户端误判连接失败。
    //
    // 但「根本发不出去」的请求（空池 / 凭据缺失）必须在提交头之前就失败：
    // 头一旦发出，状态码被冻结在 200，客户端只会看到「200 + 空回答」，
    // 把一次从未发生的上游调用记成成功。这里用与故障转移循环同一套错误。
    const preflight = await poolState(ctx)
    if (preflight !== undefined) {
      json(res, preflight.httpStatus, openaiErrorBody(preflight.message, preflight.code))
      logOutcome(`error ${preflight.code}`, preflight.message)
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    // 立即送出响应头：setHeader 只是登记，flushHeaders 才真正发出去；
    // 否则首 token 之前的等待期里客户端收不到任何字节。
    res.flushHeaders()

    const id = chatCompletionId()
    const created = Math.floor(Date.now() / 1000)
    const meta = { id, object: 'chat.completion.chunk', created, model: chat.model }
    const emit = (chunk: unknown): void => {
      if (res.writableEnded) return
      res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    }
    const choice = (delta: unknown, finishReason: string | null) => ({
      ...meta, choices: [{ index: 0, delta, finish_reason: finishReason }],
    })

    const acc: Accumulator = emptyAccumulator()
    let roleSent = false
    const emitDelta = (delta: Record<string, unknown>): void => {
      if (!roleSent && Object.keys(delta).length > 0) {
        delta = { role: 'assistant', ...delta }
        roleSent = true
      }
      emit(choice(delta, null))
    }

    const apply = (event: { type: string; [key: string]: unknown }): void => {
      applyEvent(acc, event)
      switch (event.type) {
        case 'text-delta': {
          const text = typeof event.text === 'string' ? event.text : ''
          if (text.length > 0) emitDelta({ content: text })
          break
        }
        case 'reasoning-delta': {
          const text = typeof event.text === 'string' ? event.text : ''
          if (text.length > 0) emitDelta({ reasoning_content: text })
          break
        }
        case 'tool-call': {
          const tc = acc.toolCalls[acc.toolCalls.length - 1]
          if (tc !== undefined) {
            emitDelta({
              tool_calls: [{
                index: acc.toolCalls.length - 1,
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              }],
            })
          }
          break
        }
        default:
          break
      }
    }

    let failed = false
    try {
      for await (const event of openGateway(chat, ctx)) {
        apply(event)
        if (event.type === 'finish-step') break
      }
      logOutcome('ok')
    } catch (error) {
      failed = true
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof GatewayError ? error.code
        : error instanceof ClientError ? 'invalid_request_error'
          : 'INTERNAL'
      logOutcome(`error ${code}`, message)
      // 头已发出，无法改状态码：以事件形式告知客户端。
      emit({ ...meta, choices: [], error: { message, type: code, code } })
    }
    if (!res.writableEnded) {
      if (failed) {
        // 失败流只发错误事件。补一个 finish_reason 或 usage 会把截断伪装成
        // 正常结束：全 0 的 usage 在下游账本里与「成功且免费」无法区分，
        // [DONE] 则让等待终止哨兵的客户端认为回答完整。直接结束连接，
        // 让缺少 [DONE] 本身成为可判定的终止信号。
        res.end()
      } else {
        emit(choice({}, acc.finishReason ?? 'stop'))
        emit({ ...meta, choices: [], usage: usageObject(acc) })
        res.end('data: [DONE]\n\n')
      }
    }
  }

  /* ---------------- /api/* : 控制台管理面 ---------------- */

  async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    // The pool loads lazily and `toggle` reads it synchronously; awaiting here
    // keeps every admin action from racing the first load.
    await pool.ensureLoaded()
    const action = pathname.slice('/api'.length) || '/'
    if (req.method === 'GET' && (action === '/status' || action === '/')) {
      const fromLoopback = isLoopbackAddress(req.socket.remoteAddress)
      if (!fromLoopback) {
        logLine(`[cmdgo] 非回环来源 ${req.socket.remoteAddress ?? '?'} 读取 /api/status：已隐去 apiKey（管理面无鉴权，请勿把监听地址设为 0.0.0.0）`)
      }
      json(res, 200, await statusSnapshot(fromLoopback))
      return
    }
    if (req.method === 'POST' && action === '/login') {
      await readBody(req)
      const started = await beginLogin()
      json(res, 200, { ok: true, ...started })
      return
    }
    if (req.method === 'POST' && action === '/cancel') {
      await readBody(req)
      await login.stop('用户取消')
      json(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && action === '/account/toggle') {
      const body = await readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      const enabled = body.enabled === true
      const changed = id.length > 0 && pool.toggle(id, enabled)
      json(res, changed ? 200 : 404, changed ? { ok: true } : { ok: false, error: '账号不存在或状态未变化' })
      return
    }
    if (req.method === 'POST' && action === '/account/remove') {
      const body = await readBody(req)
      const id = typeof body.id === 'string' ? body.id : ''
      if (id.length === 0) {
        json(res, 400, { ok: false, error: 'missing id' })
        return
      }
      const removed = await pool.remove(credentials, id)
      json(res, removed ? 200 : 404, removed ? { ok: true } : { ok: false, error: '账号不存在' })
      return
    }
    if (req.method === 'POST' && action === '/logout') {
      await readBody(req)
      const removed = await pool.clear(credentials)
      json(res, 200, { ok: true, removed })
      return
    }
    if (req.method === 'POST' && action === '/reload') {
      await readBody(req)
      // Re-read accounts.json and credentials.json so an operator who just
      // repaired a hand-edited file (or added an account out of band) does not
      // have to restart. Restricted to loopback for the same reason rotation is:
      // it can change which accounts the bridge will spend quota on.
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        logLine(`[cmdgo] 拒绝来自 ${req.socket.remoteAddress ?? '?'} 的 /api/reload（仅允许回环来源）`)
        json(res, 403, { ok: false, error: '重载账号与凭据仅允许从本机（回环地址）发起' })
        return
      }
      credentialsInvalidate(credentials)
      let accounts: PoolAccount[]
      try {
        accounts = await pool.reload()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logLine(`[cmdgo] 重载 accounts.json 失败：${message}`)
        json(res, 500, { ok: false, error: message })
        return
      }
      // Touch credentials so a parse failure surfaces here rather than at the
      // next chat request.
      const credentialError = (await Promise.all(
        accounts.map(async (account) => {
          try { return (await credentials.describe(account.ref)).configured ? undefined : `${account.id}: 凭据缺失` } catch (error) {
            return `${account.id}: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )).filter((entry): entry is string => entry !== undefined)
      logLine(`[cmdgo] 已重载：账号 ${accounts.length} 个，启用 ${pool.activeCount()} 个${credentialError.length === 0 ? '' : `，其中 ${credentialError.length} 个凭据有问题`}`)
      json(res, 200, { ok: true, accounts: accounts.length, active: pool.activeCount(), problems: credentialError })
      return
    }
    if (req.method === 'POST' && action === '/rotate-key') {
      await readBody(req)
      // Rotation changes the one credential `/v1/*` accepts, so it is restricted
      // to loopback callers even though the rest of the admin surface is open to
      // any host the `Host`/`Origin` checks admit. `authorized()` compares
      // against `cfg.apiKey` on every request, so mutating it here — and
      // persisting — takes effect immediately, with no restart and no window
      // where both the old and the new token work.
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        logLine(`[cmdgo] 拒绝来自 ${req.socket.remoteAddress ?? '?'} 的 /api/rotate-key（仅允许回环来源）`)
        json(res, 403, { ok: false, error: '轮换客户端 token 仅允许从本机（回环地址）发起' })
        return
      }
      const previous = cfg.apiKey
      cfg.apiKey = randomBytes(24).toString('hex')
      try {
        await new ConfigStore(state.dataDir).save(cfg)
      } catch (error) {
        // Keep the in-memory token in step with disk: a half-applied rotation
        // would invalidate the old token at runtime while the file still holds
        // it, so a later restart would silently resurrect the retired value.
        cfg.apiKey = previous
        const message = error instanceof Error ? error.message : String(error)
        logLine(`[cmdgo] 轮换客户端 token 失败：${message}`)
        json(res, 500, { ok: false, error: `写入 config.json 失败，未轮换：${message}` })
        return
      }
      logLine('[cmdgo] 客户端 token 已轮换：旧值立即失效，新值已写入 config.json（无需重启）')
      json(res, 200, { ok: true, apiKey: cfg.apiKey })
      return
    }
    json(res, 404, { ok: false, error: `unknown action: ${action}` })
  }

  /* ---------------- 路由 ---------------- */

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.on('error', () => {})
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    // `/v1/*` authenticates with the bearer token; every other path is the
    // unauthenticated console/admin surface, which must not be reachable
    // cross-origin or through a hostname rebound to loopback.
    const tokenProtected = pathname.startsWith('/v1/')
    // 访问日志：任何到达桥的请求都会留痕（含客户端断连）。
    const accessStartedAt = Date.now()
    const logAccess = (note = ''): void => {
      const status = res.statusCode === 200 ? '' : ` ${res.statusCode}`
      logLine(`[cmdgo] ${req.method ?? '?'} ${pathname}${status} ${Date.now() - accessStartedAt}ms${note ? ` ${note}` : ''}`)
    }
    res.on('finish', () => logAccess())
    res.on('close', () => { if (!res.writableFinished) logAccess('(client closed)') })
    try {
      if (!tokenProtected && (!hostAllowed(req, cfg) || !originAllowed(req))) {
        logLine(`[cmdgo] 拒绝跨源/异常 Host 请求 ${req.method ?? '?'} ${pathname} host=${req.headers.host ?? '?'} origin=${req.headers.origin ?? '-'}（经反向代理或域名访问时，请把该域名加入 config.json 的 allowedHosts）`)
        json(res, 403, { ok: false, error: 'forbidden: cross-origin or unrecognized host' })
        return
      }
      if (req.method === 'OPTIONS') {
        // Same-origin console traffic never preflights; only the token-protected
        // surface answers cross-origin preflights at all.
        if (tokenProtected) {
          cors(res)
          res.statusCode = 204
        } else {
          res.statusCode = 403
        }
        res.end()
        return
      }
      // 控制台页面（本机管理面，不开鉴权；监听非回环地址时注意局域网暴露）。
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        if (indexCache === undefined) {
          json(res, 404, { ok: false, error: 'console page not built' })
        } else {
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html; charset=utf-8')
          res.end(indexCache)
        }
        return
      }
      if (req.method === 'GET' && pathname === '/favicon.ico') {
        res.statusCode = 204
        res.end()
        return
      }
      if (req.method === 'GET' && pathname === '/health') {
        const snapshot = await statusSnapshot(false)
        json(res, 200, {
          ok: true,
          service: 'cmdgo-bridge',
          version: '0.1.0',
          accounts: snapshot.accounts.length,
          activeAccounts: snapshot.activeAccounts,
          models: snapshot.modelCount,
        })
        return
      }
      if (pathname.startsWith('/v1/')) {
        cors(res)
        if (!authorized(req)) {
          jsonError(res, 401, openaiErrorBody('无效或缺失的 API key（Authorization: Bearer <key>）', 'invalid_api_key'))
          // Auth is checked before the body is read, so a rejected POST may still
          // have megabytes in flight. Close, or the client uploads the whole
          // thing into a request that will never be read.
          if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
            res.once('close', () => req.socket.destroySoon())
          }
          return
        }
        const route = pathname.replace(/\/+$/, '')
        if (req.method === 'GET' && route === '/v1/models') {
          handleModelsList(req, res)
          return
        }
        if (req.method === 'POST' && route === '/v1/chat/completions') {
          await handleChat(req, res)
          return
        }
        json(res, 404, openaiErrorBody(`unknown /v1 route: ${pathname}`, 'not_found'))
        return
      }
      if (pathname.startsWith('/api')) {
        await handleApi(req, res, pathname)
        return
      }
      json(res, 404, { ok: false, error: `not found: ${pathname}` })
    } catch (error) {
      if (res.writableEnded) return
      // A client fault (oversized body, unparseable JSON) keeps its own status
      // instead of being flattened into a 500. `readBody` may have stopped
      // early, so the response closes the connection rather than leaving the
      // client uploading into a request nobody will read.
      const status = error instanceof ClientError ? error.httpStatus : 500
      jsonError(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
      closeAfterOversize(req, res, status)
    }
  }

  /* ---------------- 模型目录同步 ---------------- */

  async function sync(): Promise<void> {
    const entries = await fetchGoModels()
    if (entries.length === 0) throw new Error('no Go models found; keeping the previous catalog')
    let efforts = new Map<string, string[]>()
    try {
      efforts = await fetchCatalogEfforts()
    } catch (error) {
      console.log(`[cmdgo] effort catalog scan failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const next = entries.map(entry => ({
      id: entry.id,
      name: entry.name,
      // `defaultContextWindow` is the configured fallback for models whose
      // listing entry discloses no capacity. Always reporting a number is what
      // lets a client clamp `max_tokens` and tell a truncated reply apart from
      // a finished one.
      contextWindow: entry.contextWindow ?? cfg.defaultContextWindow,
      ...(efforts.get(entry.id) === undefined ? {} : { efforts: efforts.get(entry.id)! }),
    }))
    const same = next.length === holder.current.length
      && next.every((m, i) => m.id === holder.current[i]?.id)
    if (same) return
    holder.current = next
    console.log(`[cmdgo] synced ${next.length} Go model(s): ${next.map(m => m.id).join(', ')}`)
  }
  void sync().catch((error: unknown) => {
    console.log(`[cmdgo] 初始模型目录扫描失败: ${error instanceof Error ? error.message : String(error)}`)
  })
  const refreshTimer = setInterval(() => {
    void sync().catch((error: unknown) => {
      console.log(`[cmdgo] 模型目录刷新失败: ${error instanceof Error ? error.message : String(error)}`)
    })
  }, REFRESH_MS)
  refreshTimer.unref?.()

  // 监听：主 IPv4 回环；host 为默认回环时同时挂 IPv6 回环——
  // 有些客户端把 localhost 解析成 ::1，只有 IPv4 监听会被拒绝连接。
  const server = createServer((req: IncomingMessage, res: ServerResponse) => { void handleRequest(req, res) })
  if (state.onError !== undefined) server.on('error', state.onError)
  server.listen(cfg.port, cfg.host, state.onListening)
  if (cfg.host === '127.0.0.1') {
    const v6 = createServer((req: IncomingMessage, res: ServerResponse) => { void handleRequest(req, res) })
    v6.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRNOTAVAIL') logLine(`[cmdgo] IPv6 回环监听失败（忽略）: ${error.message}`)
    })
    v6.listen(cfg.port, '::1')
  }
  return server
}

export function buildState(cfg: ServerConfig, dataDir: string): BridgeState {
  const log = (m: string): void => console.log(`[cmdgo] ${m}`)
  const credentials = new FileCredentials(dataDir, log)
  return {
    cfg,
    dataDir,
    credentials,
    pool: new AccountPool({ baseRef: 'COMMANDCODE_API_KEY', dataDir, log }),
    login: new CommandCodeLoginManager(log),
  }
}