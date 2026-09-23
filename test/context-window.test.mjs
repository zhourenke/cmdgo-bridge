/**
 * Guards the model-level context-window check on `max_tokens` (F-27).
 *
 * `/v1/models` publishes `context_length` for every model, and nothing read it
 * back. A caller that sets `max_tokens` above the model's window — the usual
 * "better too big than too small" client default — sent a request that could only
 * fail at the gateway, and the bridge had to CLASSIFY that failure by matching the
 * error text (`/context|token limit|too many tokens/i`). Rephrase the upstream
 * message, or answer in another language, and the client gets a generic 400 it
 * cannot act on.
 *
 * The capacity is already known here, so the request is refused before it costs a
 * round trip, with `code: context_length_exceeded` and `param: max_tokens` so the
 * caller can shrink and retry automatically.
 *
 * Two things this must NOT become:
 *   - a check that rejects requests which would have worked. The catalog is a
 *     filtered view and chat accepts ids outside it, so an unknown model is
 *     compared against `defaultContextWindow` rather than an invented small value.
 *   - a check that runs after the SSE headers. A streamed request must get a real
 *     400, not a 200 followed by an in-band error.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeDataDir } from './helpers/teardown.mjs'
import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'
import { startCapturingUpstream } from './helpers/capture-upstream.mjs'

const API_KEY = 'context-key-0123456789abcdef'
const SMALL = 'xiaomi/mimo-v2.6-flash'   // 163,840
const LARGE = 'deepseek/deepseek-v4-flash' // 1,000,000
const realFetch = globalThis.fetch

const CATALOG = [
  { id: SMALL, name: 'MiMo', context_length: 163_840 },
  { id: LARGE, name: 'DeepSeek', context_length: 1_000_000 },
]

let upstream
let server
let port
let dataDir
let state

before(async () => {
  upstream = await startCapturingUpstream()
  dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-context-'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{ id: 'solo', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 1, enabled: true, failCount: 0 }],
  }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'upstream-key-solo' },
  }), 'utf8')
  globalThis.fetch = (url, init) =>
    String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
      ? Promise.resolve(new Response(JSON.stringify({ data: CATALOG }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
      : realFetch(url, init)
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY, baseURL: upstream.baseURL }
  state = buildState(cfg, dataDir)
  server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  port = server.address().port
  // Let the async catalog sync land; the check reads the synced catalog.
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && upstream.envelopes.length === 0) {
    const models = await call('/v1/models')
    if (JSON.parse(models.body).data.length > 0) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
})

after(async () => {
  globalThis.fetch = realFetch
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  await removeDataDir(dataDir, { pool: state.pool })
  await upstream.close()
})

function call(path, { method = 'GET', body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${API_KEY}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      const finish = () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') })
      res.on('end', finish)
      // Resolve on close too, so a truncated body fails an assertion instead of leaving
      // the request pending until the runner's timeout — but defer first, and only when
      // the message was received in full. See test/helpers/response-body.mjs: resolving
      // `close` directly lets it beat the pending `end` and report a COMPLETE response as
      // truncated, which is how a clean SSE stream lost its trailing `data: [DONE]`.
      res.on('close', () => setImmediate(finish))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const chat = (extra) => call('/v1/chat/completions', {
  method: 'POST',
  body: { model: SMALL, messages: [{ role: 'user', content: 'hi' }], ...extra },
})

test('the catalog exposes the windows this test relies on', async () => {
  const res = await call('/v1/models')
  const byId = new Map(JSON.parse(res.body).data.map((m) => [m.id, m.context_length]))
  assert.equal(byId.get(SMALL), 163_840)
  assert.equal(byId.get(LARGE), 1_000_000)
})

test('max_tokens above the model window is refused with context_length_exceeded', async () => {
  const before = upstream.envelopes.length
  const res = await chat({ max_tokens: 200_000 })
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.body.slice(0, 200)}`)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.error.code, 'context_length_exceeded')
  assert.equal(parsed.error.param, 'max_tokens')
  // The message must name both numbers so the caller can pick a working value.
  assert.match(parsed.error.message, /200000/)
  assert.match(parsed.error.message, /163840/)
  assert.equal(upstream.envelopes.length, before,
    'a request that cannot fit must not cost a round trip')
})

test('max_tokens exactly at the window is accepted', async () => {
  const res = await chat({ max_tokens: 163_840 })
  assert.equal(res.status, 200, res.body.slice(0, 200))
})

test('a larger window accepts a larger max_tokens', async () => {
  // The same value refused for SMALL is fine for LARGE: the check is per model.
  const res = await call('/v1/chat/completions', {
    method: 'POST',
    body: { model: LARGE, messages: [{ role: 'user', content: 'hi' }], max_tokens: 200_000 },
  })
  assert.equal(res.status, 200, res.body.slice(0, 200))
})

test('max_completion_tokens is checked the same way', async () => {
  const res = await chat({ max_completion_tokens: 500_000 })
  assert.equal(res.status, 400, res.body.slice(0, 200))
  assert.equal(JSON.parse(res.body).error.code, 'context_length_exceeded')
})

test('a model outside the catalog is compared against defaultContextWindow', async () => {
  // Chat accepts ids the catalog does not list. Rejecting those would turn a
  // working request into an error, which is worse than a late upstream error.
  const cfg = defaultConfig()
  const atFloor = await call('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'unknown/model-not-listed', messages: [{ role: 'user', content: 'hi' }], max_tokens: cfg.defaultContextWindow },
  })
  assert.equal(atFloor.status, 200,
    `a request at defaultContextWindow must not be refused for an unknown model: ${atFloor.body.slice(0, 200)}`)

  const overFloor = await call('/v1/chat/completions', {
    method: 'POST',
    body: { model: 'unknown/model-not-listed', messages: [{ role: 'user', content: 'hi' }], max_tokens: cfg.defaultContextWindow + 1 },
  })
  assert.equal(overFloor.status, 400)
  assert.equal(JSON.parse(overFloor.body).error.code, 'context_length_exceeded')
})

test('an absent max_tokens is never refused', async () => {
  // The bridge substitutes DEFAULT_MAX_TOKENS; that is not the caller asking for
  // more than the window, so it must stay permissive.
  const res = await chat({})
  assert.equal(res.status, 200, res.body.slice(0, 200))
})

test('the streamed path refuses before committing SSE headers', async () => {
  const res = await chat({ max_tokens: 200_000, stream: true })
  assert.equal(res.status, 400, `expected an HTTP status, got ${res.status}: ${res.body.slice(0, 200)}`)
  assert.ok(!res.body.includes('data:'), 'no SSE frames may be emitted for a refused request')
  assert.equal(JSON.parse(res.body).error.code, 'context_length_exceeded')
})

test('the README documents the context check', async () => {
  const { readFile } = await import('node:fs/promises')
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8')
  assert.match(readme, /context_length_exceeded/, 'the error code must be documented')
  assert.match(readme, /上下文/, 'the context window behaviour must be explained')
})
