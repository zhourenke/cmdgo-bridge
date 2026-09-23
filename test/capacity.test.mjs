/**
 * Guards the two resource ceilings added for shared, long-running use.
 *
 * F-09 (concurrency): nothing bounded how many chat completions could run at
 * once. N downstream clients meant N simultaneous upstream calls, so one busy
 * agent workspace saturated the plan and every other request queued behind it at
 * the provider — invisible and unreportable from the bridge. The ceiling must be
 * a real status code (429 + `Retry-After`), not an in-band SSE error: the
 * streaming path commits `200` as soon as it flushes headers, so a capacity
 * failure after that point could only masquerade as a successful response.
 *
 * F-10 (backpressure): `res.write` was fire-and-forget. A client that stopped
 * reading — paused terminal, sleeping laptop, stalled proxy — accumulated the
 * entire answer in the writable buffer while upstream kept generating tokens and
 * the plan kept being charged.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer, waitForDrain } from '../dist/server.js'
import { removeDataDir } from './helpers/teardown.mjs'
import { startHoldingUpstream } from './helpers/hold-upstream.mjs'

/** Holds the fixture state so teardown can flush its pending writes. */
let bridgeState

const API_KEY = 'capacity-test-key-0123456789ab'
const CAPACITY = 4
const realFetch = globalThis.fetch

const stubCatalog = (url, init) =>
  String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
    ? Promise.resolve(new Response(JSON.stringify({ data: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

const ACCOUNT = {
  id: 'solo',
  ref: 'COMMANDCODE_API_KEY_SOLO',
  addedAt: 1,
  enabled: true,
  failCount: 0,
}

/** Boots a bridge pointed at `baseURL` with a single account in the pool. */
async function boot(baseURL, limits = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-cap-'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [ACCOUNT] }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'upstream-key-solo' },
  }), 'utf8')
  globalThis.fetch = stubCatalog
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY, baseURL }
  const server = createBridgeServer((bridgeState = buildState(cfg, dataDir, limits)))
  await new Promise((resolve) => server.once('listening', resolve))
  return {
    port: server.address().port,
    dataDir,
    close: async () => {
      globalThis.fetch = realFetch
      // Sockets from held streams would keep close() waiting.
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await removeDataDir(dataDir, { pool: bridgeState?.pool })
    },
  }
}

/** Opens a streaming chat request that stays open; `res` is the raw response. */
function openStream(port, { read = true } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', stream: true, messages: [{ role: 'user', content: 'hi' }] })
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
      if (!read) {
        // Never read: the kernel buffers fill and the bridge hits its watermark.
        res.pause()
        resolve({ req, res })
        return
      }
      res.setEncoding('utf8')
      let text = ''
      res.on('data', (chunk) => { text += chunk })
      resolve({ req, res, text: () => text })
    })
    req.on('error', () => { /* surfaced through the response or the test */ })
    req.end(body)
  })
}

/** Waits for `predicate` to hold, or fails after `ms`. */
async function waitFor(predicate, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`)
}

const call = (port, path, { method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}` } }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
  })
  req.on('error', reject)
  req.end()
})

/* ---------------- F-09: the concurrency ceiling ---------------- */

test(`at most ${CAPACITY} chat completions run at once, and the next one gets a real 429`, async () => {
  const upstream = await startHoldingUpstream()
  const bridge = await boot(upstream.baseURL, { maxConcurrentChats: CAPACITY })
  const open = []
  try {
    for (let i = 0; i < CAPACITY; i++) open.push(await openStream(bridge.port))
    await waitFor(() => Promise.resolve(upstream.pending === CAPACITY), 5_000, 'all held requests to reach upstream')

    const health = JSON.parse((await call(bridge.port, '/health')).body)
    assert.equal(health.chatInFlight, CAPACITY, 'capacity must be observable')
    assert.equal(health.chatCapacity, CAPACITY)

    const overflow = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: 'm', stream: true, messages: [{ role: 'user', content: 'hi' }] })
      const req = request({
        host: '127.0.0.1',
        port: bridge.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${bridge.port}`,
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end(body)
    })

    assert.equal(overflow.status, 429, `expected a real 429, got ${overflow.status}: ${overflow.body.slice(0, 200)}`)
    assert.match(overflow.headers['content-type'] ?? '', /^application\/json/, 'the refusal must not be an SSE stream')
    assert.ok(overflow.headers['retry-after'] !== undefined, 'a 429 must say when to retry')
    const payload = JSON.parse(overflow.body)
    assert.equal(payload.error.code, 'rate_limit_exceeded')
    assert.match(payload.error.message, /上限/)
    assert.equal(upstream.requests, CAPACITY, 'a refused request must never reach upstream')

    // Releasing one slot must let the next request through.
    upstream.releaseAll()
    await waitFor(async () => JSON.parse((await call(bridge.port, '/health')).body).chatInFlight === 0, 5_000, 'slots to be released')
    const after = await openStream(bridge.port)
    assert.equal(after.res.statusCode, 200, 'service resumes once capacity frees up')
  } finally {
    upstream.destroyAll()
    for (const { req } of open) req.destroy()
    await bridge.close()
    await upstream.close()
  }
})

test('a non-streaming request counts against the same ceiling', async () => {
  const upstream = await startHoldingUpstream()
  const bridge = await boot(upstream.baseURL, { maxConcurrentChats: 1 })
  let held
  try {
    held = await openStream(bridge.port)
    await waitFor(() => Promise.resolve(upstream.pending === 1), 5_000, 'the held request')

    const body = JSON.stringify({ model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] })
    const res = await new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port: bridge.port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${bridge.port}`,
          'content-type': 'application/json',
          authorization: `Bearer ${API_KEY}`,
          'content-length': Buffer.byteLength(body),
        },
      }, (r) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end(body)
    })
    assert.equal(res.status, 429, 'non-streaming shares the ceiling')
    assert.equal(JSON.parse(res.body).error.code, 'rate_limit_exceeded')
  } finally {
    upstream.destroyAll()
    held?.req.destroy()
    await bridge.close()
    await upstream.close()
  }
})

test('slots are released when a request fails, so one error cannot wedge capacity', async () => {
  // An upstream that dies mid-stream, with a capacity of one: after the failure
  // the next request must still be admitted.
  const upstream = await startHoldingUpstream()
  const bridge = await boot(upstream.baseURL, { maxConcurrentChats: 1 })
  try {
    const first = await openStream(bridge.port)
    await waitFor(() => Promise.resolve(upstream.pending === 1), 5_000, 'the first request')
    upstream.destroyAll()
    await waitFor(async () => JSON.parse((await call(bridge.port, '/health')).body).chatInFlight === 0, 5_000, 'the slot to be released after a failure')
    first.req.destroy()

    const second = await openStream(bridge.port)
    assert.equal(second.res.statusCode, 200, 'the bridge must still accept work after a failed request')
    second.req.destroy()
  } finally {
    upstream.destroyAll()
    await bridge.close()
    await upstream.close()
  }
})

/* ---------------- F-10: backpressure ---------------- */

test('waitForDrain resolves true once the buffer drains below the mark', async () => {
  const res = fakeResponse({ writableLength: 10 })
  const pending = waitForDrain(res, { highWater: 5, timeoutMs: 1_000 })
  res.writableLength = 0
  res.emit('drain')
  assert.equal(await pending, true)
})

test('waitForDrain gives up on a client that never drains', async () => {
  const res = fakeResponse({ writableLength: 100 })
  const started = Date.now()
  const drained = await waitForDrain(res, { highWater: 5, timeoutMs: 40 })
  assert.equal(drained, false, 'a stalled client must not be waited on forever')
  assert.ok(Date.now() - started >= 35, 'it must actually wait before giving up')
})

test('waitForDrain resolves false when the response closes', async () => {
  const res = fakeResponse({ writableLength: 100 })
  const pending = waitForDrain(res, { highWater: 5, timeoutMs: 5_000 })
  res.emit('close')
  assert.equal(await pending, false)
})

test('waitForDrain is a no-op below the high-water mark', async () => {
  const res = fakeResponse({ writableLength: 5 })
  assert.equal(await waitForDrain(res, { highWater: 5, timeoutMs: 1_000 }), true)
})

test('an already-finished response never waits', async () => {
  assert.equal(await waitForDrain(fakeResponse({ writableLength: 500, writableEnded: true }), { highWater: 1 }), false)
  assert.equal(await waitForDrain(fakeResponse({ writableLength: 500, destroyed: true }), { highWater: 1 }), false)
})

test('a client that stops reading is dropped instead of buffering the whole answer', async () => {
  const upstream = await startHoldingUpstream({ mode: 'flood', deltaBytes: 1024, floodFrames: 20_000 })
  // Tiny water mark and a short grace period: the production values are 1 MiB
  // and 30s, which no test should have to wait out.
  const bridge = await boot(upstream.baseURL, { writeBufferHighWater: 4 * 1024, writeDrainTimeoutMs: 150 })
  try {
    const { req, res } = await openStream(bridge.port, { read: false })
    // The bridge should give up on us. Its own log is the reliable signal.
    const log = join(bridge.dataDir, 'access.log')
    await waitFor(async () => {
      try {
        return (await readFile(log, 'utf8')).includes('client-stalled')
      } catch {
        return false
      }
    }, 15_000, 'the bridge to drop the stalled client')

    const text = await readFile(log, 'utf8')
    assert.match(text, /client-stalled/, 'the stalled client must be reported, not silently buffered')
    assert.ok(!text.includes('chat 结束 model=m stream=true ok'), 'a dropped stream must not be logged as a success')
    res.destroy()
    req.destroy()
  } finally {
    upstream.destroyAll()
    await bridge.close()
    await upstream.close()
  }
})

/** Minimal stand-in for a ServerResponse, for the drain-policy unit tests. */
function fakeResponse(overrides = {}) {
  const listeners = new Map()
  const res = {
    writableLength: 0,
    writableEnded: false,
    destroyed: false,
    on(event, handler) {
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
      return res
    },
    off(event, handler) {
      listeners.set(event, (listeners.get(event) ?? []).filter((h) => h !== handler))
      return res
    },
    emit(event) {
      for (const handler of listeners.get(event) ?? []) handler()
    },
    ...overrides,
  }
  return res
}
