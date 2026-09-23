/**
 * Guards access-log hygiene and the operational counters on `/health` (F-26).
 *
 * Three separate defects, all about an operator being able to see what is
 * happening:
 *
 *   1. `access.log` grew without limit. An unbounded file on a long-running relay
 *      eventually fills the disk, and the failure was silent — `appendFile(...)
 *      .catch(() => {})` swallowed it, so logging simply STOPPED. A quiet log
 *      reads as "no traffic", which is the opposite of the truth.
 *   2. There were no aggregate counters at all: telling "my keys are cooling down"
 *      from "the plan is throttling me" from "the bridge itself is broken" meant
 *      grepping free-text lines.
 *   3. Nothing said whether the catalog or the pool was degraded.
 *
 * `/health` is unauthenticated, so the counters are deliberately aggregate-only:
 * counts and latency percentiles, never account ids, key names, or `lastError`
 * strings. A test pins that down.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtemp, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeDataDir } from './helpers/teardown.mjs'
import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'

const API_KEY = 'observability-key-0123456789abcdef'
const MODEL = 'xiaomi/mimo-v2.6-flash'
const realFetch = globalThis.fetch

const HEALTHY = [
  { type: 'text-start' },
  { type: 'text-delta', text: 'hello' },
  {
    type: 'finish-step',
    finishReason: 'stop',
    usage: {
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0 },
      outputTokens: 1,
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
  },
]

/**
 * Boots a bridge whose upstream always answers well.
 * @param {{ accounts?: object[] }} [options]
 */
async function boot(options = {}) {
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    for (const event of HEALTHY) res.write(`${JSON.stringify(event)}\n`)
    res.end()
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-obs-'))
  const accounts = options.accounts ?? [
    { id: 'solo', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 1, enabled: true, failCount: 0 },
  ]
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'upstream-key-solo' },
  }), 'utf8')

  globalThis.fetch = (url, init) =>
    String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
      ? Promise.resolve(new Response(JSON.stringify({ data: [{ id: MODEL, name: 'MiMo', context_length: 163_840 }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
      : realFetch(url, init)

  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY, baseURL: `http://127.0.0.1:${upstream.address().port}` }
  const state = buildState(cfg, dataDir)
  const server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port

  const fetchPath = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${API_KEY}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(payload)
  })

  return {
    dataDir,
    health: async () => JSON.parse((await fetchPath('/health')).body),
    chat: (extra = {}) => fetchPath('/v1/chat/completions', {
      method: 'POST',
      body: { model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...extra },
    }),
    close: async () => {
      globalThis.fetch = realFetch
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await removeDataDir(dataDir, { pool: state.pool })
      upstream.closeAllConnections?.()
      await new Promise((resolve) => upstream.close(resolve))
    },
  }
}

test('/health reports account health counters', async () => {
  const bridge = await boot({
    accounts: [
      { id: 'a', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 1, enabled: true, failCount: 0 },
      { id: 'b', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 2, enabled: true, failCount: 0, cooldownUntil: Date.now() + 60_000, lastError: 'secret-ish detail' },
      { id: 'c', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 3, enabled: false, failCount: 4 },
    ],
  })
  try {
    const health = await bridge.health()
    assert.equal(health.ok, true)
    assert.deepEqual(health.pool, { total: 3, enabled: 2, available: 1, cooling: 1, failing: 1 },
      `unexpected pool counters: ${JSON.stringify(health.pool)}`)
  } finally {
    await bridge.close()
  }
})

test('/health counts chat outcomes and reports latency percentiles', async () => {
  const bridge = await boot()
  try {
    assert.deepEqual((await bridge.health()).chats, { ok: 0, failed: 0, latencyMs: {} },
      'a bridge that has served nothing must report no samples, not zeros')

    for (let i = 0; i < 3; i++) {
      const res = await bridge.chat()
      assert.equal(res.status, 200, res.body.slice(0, 200))
    }
    const health = await bridge.health()
    assert.equal(health.chats.ok, 3)
    assert.equal(health.chats.failed, 0)
    assert.equal(health.chats.latencyMs.samples, 3)
    for (const key of ['p50', 'p95', 'p99']) {
      assert.equal(typeof health.chats.latencyMs[key], 'number', `${key} must be a number`)
      assert.ok(health.chats.latencyMs[key] >= 0)
    }
    // Nearest-rank percentiles never exceed the largest observation.
    assert.ok(health.chats.latencyMs.p99 >= health.chats.latencyMs.p50)
  } finally {
    await bridge.close()
  }
})

test('/health leaks no account identity, key name, or error text', async () => {
  // `/health` has no authentication. Counters are fine; "which key is broken and
  // why" is not, because the error strings carry upstream URLs and account ids.
  const bridge = await boot({
    accounts: [{
      id: 'zhourenke-9a7e',
      ref: 'COMMANDCODE_API_KEY_SOLO',
      userName: 'zhourenke',
      keyName: 'my-laptop',
      addedAt: 1,
      enabled: true,
      failCount: 1,
      cooldownUntil: Date.now() + 60_000,
      lastError: 'Command Code 网关请求超时 https://api.commandcode.ai/alpha/generate',
    }],
  })
  try {
    const res = await bridge.health()
    const raw = JSON.stringify(res)
    for (const secret of ['zhourenke-9a7e', 'zhourenke', 'my-laptop', 'COMMANDCODE_API_KEY_SOLO', 'commandcode.ai', API_KEY, 'upstream-key-solo']) {
      assert.ok(!raw.includes(secret), `/health must not disclose ${JSON.stringify(secret)}: ${raw}`)
    }
  } finally {
    await bridge.close()
  }
})

test('the access log rotates instead of growing without bound', async () => {
  const bridge = await boot()
  try {
    // Drive enough traffic to pass the 5 MiB threshold. The threshold is a
    // production constant; reaching it with real requests would take a very long
    // time, so the file is pre-filled instead — rotation only looks at the size.
    const logPath = join(bridge.dataDir, 'access.log')
    await writeFile(logPath, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf8')

    // Any request appends one line and trips the size check.
    await bridge.health()
    const deadline = Date.now() + 5_000
    let rotated = false
    while (Date.now() < deadline) {
      const names = await readdir(bridge.dataDir)
      if (names.includes('access.log.1')) { rotated = true; break }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(rotated, 'the oversized log must be rotated aside')
    const current = await stat(logPath)
    assert.ok(current.size < 5 * 1024 * 1024,
      `the live log must restart small, got ${current.size} bytes`)
    // The rotated file keeps the old contents.
    const old = await stat(`${logPath}.1`)
    assert.ok(old.size > 5 * 1024 * 1024)
  } finally {
    await bridge.close()
  }
})

test('the access log keeps a bounded number of rotated files', async () => {
  const bridge = await boot()
  try {
    const logPath = join(bridge.dataDir, 'access.log')
    // Rotate four times over; only `access.log.1..3` may survive.
    for (let round = 0; round < 4; round++) {
      await writeFile(logPath, 'x'.repeat(5 * 1024 * 1024 + 1), 'utf8')
      await bridge.health()
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        const names = await readdir(bridge.dataDir)
        if (names.includes('access.log.1')) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      // Wait for the rotation to settle before the next round overwrites the file.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const names = (await readdir(bridge.dataDir)).filter((n) => n.startsWith('access.log'))
    assert.ok(!names.includes('access.log.4'),
      `rotation must discard the oldest file, found ${JSON.stringify(names)}`)
    assert.ok(names.length <= 4, `at most the live log plus 3 rotated files, found ${JSON.stringify(names)}`)
  } finally {
    await bridge.close()
  }
})

test('a failing log write is reported on stderr instead of vanishing', async () => {
  const bridge = await boot()
  const original = process.stderr.write.bind(process.stderr)
  const captured = []
  process.stderr.write = (chunk, ...rest) => {
    captured.push(String(chunk))
    return true
  }
  try {
    // Replace the log with a DIRECTORY: appending to it fails with EISDIR, which
    // is the same class of failure as a full disk or a read-only mount.
    const logPath = join(bridge.dataDir, 'access.log')
    await writeFile(logPath, '', 'utf8').catch(() => {})
    const { rm, mkdir } = await import('node:fs/promises')
    await rm(logPath, { force: true })
    await mkdir(logPath)

    await bridge.health()
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !captured.some((line) => line.includes('访问日志写入失败'))) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(captured.some((line) => line.includes('访问日志写入失败')),
      `a swallowed log failure hides a silent logging outage; stderr got: ${JSON.stringify(captured.slice(0, 3))}`)
  } finally {
    process.stderr.write = original
    await bridge.close()
  }
})

test('the access log never contains credentials', async () => {
  // The audit confirmed this was already correct; pin it so a future logging
  // change cannot quietly introduce a leak.
  const bridge = await boot()
  try {
    await bridge.chat()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const log = await readFile(join(bridge.dataDir, 'access.log'), 'utf8')
    for (const secret of [API_KEY, 'upstream-key-solo', 'Bearer']) {
      assert.ok(!log.includes(secret), `the access log must not contain ${JSON.stringify(secret)}`)
    }
    assert.ok(log.includes('chat'), 'the log must still record chat activity')
  } finally {
    await bridge.close()
  }
})
