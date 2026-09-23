/**
 * Guards account-health accounting and same-request failover.
 *
 * Two independent questions were previously answered by one condition:
 *
 *   - "may this request be replayed?"  → no, once anything was yielded
 *     (a half-delivered answer must never restart);
 *   - "is this account healthy?"       → should be recorded either way.
 *
 * `if (yielded || attempt >= attempts - 1) throw error` answered the first and
 * silently skipped the second, so an account that died mid-answer — the most
 * common way a key goes bad — was never cooled down. The next request picked it
 * again and failed identically, and every request in between spent a doomed
 * upstream call.
 *
 * The third invariant here is the converse: a CLIENT disconnect must NOT be
 * charged to the account. An abandoned agent run says nothing about the key, and
 * cooling it down would shrink the pool a little more each time.
 *
 * `PERMISSION` (403 `MODEL_NOT_IN_PLAN`) is failover-eligible because plan
 * coverage is per-account: the reason to pool several subscriptions is that a
 * model one key cannot reach may be available on the next.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { request } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'

const API_KEY = 'failover-key-0123456789abcdef'
const realFetch = globalThis.fetch
const catalogHosts = ['api.commandcode.ai', 'cdn.jsdelivr.net']
const stubCatalog = (url, init) =>
  catalogHosts.some((host) => String(url).includes(host))
    ? Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo', context_length: 163_840 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

/**
 * An upstream whose behaviour per key is scripted, so a test can make account A
 * fail in a specific way and account B succeed.
 *
 * @param {(key: string, call: number) => { status?: number, body?: string, stream?: 'die-mid' | 'ok' }} behaviour
 */
async function startScriptedUpstream(behaviour) {
  const calls = []
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    const key = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    calls.push(key)
    const verdict = behaviour(key, calls.filter((k) => k === key).length)
    if (verdict.status !== undefined && verdict.status !== 200) {
      res.statusCode = verdict.status
      res.end(verdict.body ?? JSON.stringify({ error: { message: 'scripted failure' } }))
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    const send = (o) => res.write(`${JSON.stringify(o)}\n`)
    send({ type: 'text-start' })
    send({ type: 'text-delta', text: 'partial answer ' })
    if (verdict.stream === 'die-mid') {
      // Yield something, then reset: this is the "died mid-answer" shape.
      setTimeout(() => res.destroy(), 30)
      return
    }
    if (verdict.stream === 'slow-ok') {
      // Answer, but late enough that a client can disconnect first.
      setTimeout(() => {
        if (res.writableEnded || res.destroyed) return
        send({ type: 'text-delta', text: 'rest of answer' })
        send({
          type: 'finish-step',
          finishReason: 'stop',
          usage: {
            inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 0 },
            outputTokens: 4,
            outputTokenDetails: { textTokens: 4, reasoningTokens: 0 },
          },
        })
        res.end()
      }, 250)
      return
    }
    send({ type: 'text-delta', text: 'rest of answer' })
    send({
      type: 'finish-step',
      finishReason: 'stop',
      usage: {
        inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 0 },
        outputTokens: 4,
        outputTokenDetails: { textTokens: 4, reasoningTokens: 0 },
      },
    })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    get keys() { return [...calls] },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

/** Seeds a two-account pool whose accounts resolve to `key-a` and `key-b`. */
async function boot(baseURL, { accountCount = 2 } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-failover-'))
  const accounts = []
  const credentials = {}
  for (let i = 0; i < accountCount; i++) {
    const letter = String.fromCharCode(97 + i)
    const id = `acct-${letter}`
    accounts.push({ id, ref: `COMMANDCODE_API_KEY_${letter.toUpperCase()}`, addedAt: i + 1, enabled: true, failCount: 0 })
    credentials[`COMMANDCODE_API_KEY_${letter.toUpperCase()}`] = { value: `key-${letter}`, source: 'test' }
  }
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify(credentials), 'utf8')
  globalThis.fetch = stubCatalog
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY, baseURL }
  const state = buildState(cfg, dataDir)
  const server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  return {
    port,
    state,
    dataDir,
    /** Current pool state as seen by the scheduler. */
    accounts: async () => (await state.pool.list()).map((a) => ({
      id: a.id, failCount: a.failCount, cooling: (a.cooldownUntil ?? 0) > Date.now(), lastError: a.lastError,
    })),
    readManifest: async () => JSON.parse(await readFile(join(dataDir, 'accounts.json'), 'utf8')),
    chat: (extra = {}) => new Promise((resolve, reject) => {
      // `stream` defaults to false; callers pass `stream: true` explicitly.
      const body = JSON.stringify({
        model: 'xiaomi/mimo-v2.6-flash',
        messages: [{ role: 'user', content: 'hi' }],
        ...extra,
      })
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = []
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
        }
        res.on('data', (c) => chunks.push(c))
        res.on('end', finish)
        res.on('close', finish)
      })
      req.on('error', reject)
      req.end(body)
    }),
    /**
     * Starts a streaming request and hands back the raw client request so the
     * caller can walk away mid-answer. The response is consumed into `body`
     * because an unread response would stall the bridge's write, not the
     * disconnect this simulates.
     */
    chatAbortable: (extra = {}) => {
      const body = JSON.stringify({
        model: 'xiaomi/mimo-v2.6-flash',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        ...extra,
      })
      const state = { status: undefined, body: '' }
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        state.status = res.statusCode
        res.setEncoding('utf8')
        res.on('data', (c) => { state.body += c })
      })
      req.on('error', () => { /* the abort below is expected to surface here */ })
      req.end(body)
      return { req, state }
    },
    close: async () => {
      globalThis.fetch = realFetch
      // Drain the manifest writes BEFORE removing the directory. Pool bookkeeping
      // persists asynchronously, so an `rm` that races a pending rename either
      // fails outright (`ENOTEMPTY`: the temp file appears mid-delete) or leaves
      // the directory behind for the next run.
      await state.pool.flush().catch(() => {})
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
    },
  }
}

/** Waits for `predicate` or fails; used to observe async pool bookkeeping. */
async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`)
}

/**
 * Bounds a test's teardown as well as its body.
 *
 * `node --test --test-timeout` cannot interrupt a `finally` block that is
 * awaiting a server whose sockets never drained, so the whole FILE hangs and no
 * individual test is reported. Wrapping teardown in its own deadline makes such
 * a stall a visible failure instead of a silent hang.
 */
async function withDeadline(label, ms, fn) {
  let timer
  try {
    return await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

test('an account that dies mid-answer is still cooled down', async () => {
  // key-a always dies mid-answer; key-b is healthy.
  const upstream = await startScriptedUpstream((key) => (key === 'key-a' ? { stream: 'die-mid' } : { stream: 'ok' }))
  const bridge = await boot(upstream.baseURL)
  try {
    const first = await bridge.chat({ stream: false })
    assert.ok(first.status >= 400 || first.body.includes('error'),
      `the truncated answer must be reported as a failure, got ${first.status}`)

    // The failing account must be marked, whichever account was picked.
    await waitFor(async () => (await bridge.accounts()).some((a) => a.failCount > 0), 5_000,
      'the failing account to be cooled down')
    const marked = (await bridge.accounts()).filter((a) => a.failCount > 0)
    assert.ok(marked.length >= 1, 'the account that died mid-answer must be recorded as failed')

    // The bookkeeping must reach disk, not just memory.
    await bridge.state.pool.flush()
    const manifest = await bridge.readManifest()
    assert.ok(manifest.accounts.some((a) => a.failCount > 0), 'the failure must be persisted')
  } finally {
    await bridge.close()
    await upstream.close()
  }
})

test('a client disconnect does not punish the account', async () => {
  // Slow enough that the client can leave before the answer completes.
  const upstream = await startScriptedUpstream(() => ({ stream: 'slow-ok' }))
  const bridge = await boot(upstream.baseURL)
  try {
    const { req } = bridge.chatAbortable()
    await waitFor(() => Promise.resolve(upstream.keys.length > 0), 5_000, 'the request to reach the gateway')
    // Walk away mid-answer.
    req.destroy()

    // Give the bridge time to observe the disconnect and finish its bookkeeping.
    await new Promise((resolve) => setTimeout(resolve, 400))
    const accounts = await bridge.accounts()
    assert.ok(accounts.every((a) => a.failCount === 0),
      `an abandoned request must not be charged to the account: ${JSON.stringify(accounts)}`)
    assert.ok(accounts.every((a) => !a.cooling), 'and it must not trigger a cool-down')
  } finally {
    await bridge.close()
    await upstream.close()
  }
})

test('a 403 MODEL_NOT_IN_PLAN fails over to another account', async () => {
  // key-a is not entitled to the model; key-b is.
  const upstream = await startScriptedUpstream((key) => (key === 'key-a'
    ? { status: 403, body: JSON.stringify({ error: { message: 'MODEL_NOT_IN_PLAN: model above Go tier' } }) }
    : { stream: 'ok' }))
  const bridge = await boot(upstream.baseURL)
  try {
    // Try until the model succeeds: which account goes first is round-robin.
    const seen = []
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await bridge.chat({ stream: false })
      seen.push(res.status)
      if (res.status === 200) {
        assert.match(res.body, /rest of answer/, 'the entitled account must serve the answer')
        assert.ok(upstream.keys.includes('key-a') && upstream.keys.includes('key-b'),
          `both accounts must have been tried, got ${JSON.stringify(upstream.keys)}`)
        return
      }
    }
    assert.fail(`the entitled account was never reached; statuses seen: ${JSON.stringify(seen)}`)
  } finally {
    await bridge.close()
    await upstream.close()
  }
})

test('failover stops after the attempt cap and reports the failure', async () => {
  // Every account refuses the model: bounded attempts, and the client learns why.
  const upstream = await startScriptedUpstream(() => ({
    status: 403,
    body: JSON.stringify({ error: { message: 'MODEL_NOT_IN_PLAN: nope' } }),
  }))
  const bridge = await boot(upstream.baseURL, { accountCount: 6 })
  try {
    const res = await bridge.chat({ stream: false })
    assert.equal(res.status, 403, res.body.slice(0, 200))
    assert.match(res.body, /MODEL_NOT_IN_PLAN/)
    // MAX_FAILOVER_ATTEMPTS is 4, so six accounts must not mean six upstream calls.
    assert.ok(upstream.keys.length <= 4,
      `failover must be capped, saw ${upstream.keys.length} upstream calls`)
    assert.ok(upstream.keys.length >= 2, 'more than one account must be tried')
  } finally {
    await bridge.close()
    await upstream.close()
  }
})

test('a half-delivered answer is never replayed onto another account', async () => {
  // key-a yields content then dies; key-b would happily answer. Replaying WITHIN
  // the same request would duplicate the text already sent, so the failure must
  // surface instead. (A subsequent, separate request legitimately reaches key-b
  // once key-a is cooling down — that is the pool working, not a replay.)
  const upstream = await startScriptedUpstream((key) => (key === 'key-a' ? { stream: 'die-mid' } : { stream: 'ok' }))
  const bridge = await boot(upstream.baseURL)
  try {
    const before = upstream.keys.length
    const res = await bridge.chat({ stream: true })
    assert.equal(upstream.keys.length - before, 1,
      'once an answer has been partially delivered the request must not start a second upstream call')
    assert.ok(!res.body.includes('[DONE]'), 'the truncation must remain visible')
    assert.match(res.body, /"error"/, 'the failure must be reported in-band')
    assert.ok(!res.body.includes('"usage"'), 'a failed stream must not report usage')

    // The account that died must be the one marked, and it must be cooling.
    const marked = (await bridge.accounts()).filter((a) => a.failCount > 0)
    assert.equal(marked.length, 1, `exactly one account should be marked, got ${JSON.stringify(marked)}`)
    assert.ok(marked[0].cooling, 'the account that died mid-answer must be cooling down')
  } finally {
    await bridge.close()
    await upstream.close()
  }
})
