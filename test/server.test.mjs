/**
 * Guards the HTTP surface: the token-protected `/v1/*` API stays reachable
 * cross-origin, while the unauthenticated console/admin surface does not.
 *
 * `/api/status` discloses the bearer token and `/api/logout` wipes the account
 * pool, so a wildcard `Access-Control-Allow-Origin` on those routes let any web
 * page the user visited read the token or destroy the pool.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'

const API_KEY = 'test-key-0123456789abcdef'
const realFetch = globalThis.fetch

let server
let port
let dataDir

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-server-'))
  // The background catalog sync hits this stub instead of the network, so the
  // suite stays offline. One entry discloses its capacity and one does not,
  // which is what exercises the `defaultContextWindow` fallback.
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      data: [
        { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo V2.6 Flash', context_length: 163_840 },
        { id: 'deepseek/deepseek-v4.1-flash', name: 'V4.1 Flash' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })

  // host 0.0.0.0 keeps createBridgeServer from additionally binding the ::1
  // listener, for which it returns no handle the test could close.
  const cfg = {
    ...defaultConfig(),
    host: '0.0.0.0',
    port: 0,
    apiKey: API_KEY,
    allowedHosts: ['console.example'],
    // Distinctive, so a fallback can be told apart from a disclosed capacity.
    defaultContextWindow: 424_242,
  }
  server = createBridgeServer(buildState(cfg, dataDir))
  await new Promise((resolve) => server.once('listening', resolve))
  port = server.address().port
})

after(async () => {
  globalThis.fetch = realFetch
  await new Promise((resolve) => server.close(resolve))
  await rm(dataDir, { recursive: true, force: true })
})

function call(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const sameOrigin = () => `http://127.0.0.1:${port}`

test('same-origin console traffic reaches /api/status', async () => {
  const res = await call('/api/status', { headers: { origin: sameOrigin() } })
  assert.equal(res.status, 200)
  const snapshot = JSON.parse(res.body)
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.apiKey, API_KEY, 'the console displays the key it must connect with')
  assert.equal(res.headers['access-control-allow-origin'], undefined, 'the admin surface must not be readable cross-origin')
})

test('a curl-style request with no Origin still works', async () => {
  const res = await call('/api/status')
  assert.equal(res.status, 200)
})

test('a cross-origin page cannot read /api/status', async () => {
  const res = await call('/api/status', { headers: { origin: 'http://evil.example' } })
  assert.equal(res.status, 403)
  assert.ok(!res.body.includes(API_KEY), 'the bearer token must never reach a cross-origin caller')
  assert.equal(res.headers['access-control-allow-origin'], undefined)
})

test('a hostname rebound to loopback is refused', async () => {
  // DNS rebinding: no Origin at all, but Host names the attacker's domain.
  const page = await call('/', { headers: { host: 'evil.example' } })
  assert.equal(page.status, 403)

  const api = await call('/api/status', { headers: { host: 'evil.example' } })
  assert.equal(api.status, 403)
  assert.ok(!api.body.includes(API_KEY))
})

test('loopback names other than the bind address are accepted', async () => {
  const res = await call('/health', { headers: { host: `localhost:${port}` } })
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).service, 'cmdgo-bridge')
})

test('hostnames listed in allowedHosts are accepted, others are not', async () => {
  const listed = await call('/health', { headers: { host: 'console.example' } })
  assert.equal(listed.status, 200, 'a reverse-proxy or LAN name must work once configured')

  const unlisted = await call('/health', { headers: { host: 'other.example' } })
  assert.equal(unlisted.status, 403)
})

test('the upstream budget allows long agent runs', async () => {
  const { REQUEST_TIMEOUT_MS } = await import('../dist/openai.js')
  assert.ok(
    REQUEST_TIMEOUT_MS >= 600_000,
    'a long reasoning or codegen run must not be truncated mid-stream',
  )
})

/** The catalog sync is fire-and-forget; poll until it lands. */
async function waitForModels() {
  for (let attempt = 0; attempt < 80; attempt++) {
    const res = await call('/v1/models', { headers: { authorization: `Bearer ${API_KEY}` } })
    const body = JSON.parse(res.body)
    if (Array.isArray(body.data) && body.data.length > 0) return body
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the model catalog never populated')
}

test('/v1/models discloses the capacity clients need, with a configured fallback', async () => {
  const body = await waitForModels()
  const byId = new Map(body.data.map((m) => [m.id, m]))
  assert.equal(body.data.length, 2)
  assert.equal(
    byId.get('xiaomi/mimo-v2.6-flash').context_length,
    163_840,
    'a disclosed capacity must be reported verbatim',
  )
  assert.equal(
    byId.get('deepseek/deepseek-v4.1-flash').context_length,
    424_242,
    'an undisclosed one falls back to defaultContextWindow',
  )
})

test('a cross-origin page cannot wipe the account pool', async () => {
  const res = await call('/api/logout', {
    method: 'POST',
    headers: { origin: 'http://evil.example' },
    body: {},
  })
  assert.equal(res.status, 403)
  assert.ok(!res.body.includes('"ok":true'))
})

test('cross-origin preflight is answered only for the token-protected surface', async () => {
  const admin = await call('/api/status', { method: 'OPTIONS', headers: { origin: 'http://evil.example' } })
  assert.equal(admin.status, 403)

  const api = await call('/v1/models', { method: 'OPTIONS', headers: { origin: 'http://console.example' } })
  assert.equal(api.status, 204)
  assert.equal(api.headers['access-control-allow-origin'], '*')
})

test('the OpenAI surface keeps permissive CORS and still requires the token', async () => {
  const anonymous = await call('/v1/models')
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.headers['access-control-allow-origin'], '*', 'browser clients must still be able to call /v1')

  const authed = await call('/v1/models', { headers: { authorization: `Bearer ${API_KEY}` } })
  assert.equal(authed.status, 200)
  assert.equal(JSON.parse(authed.body).object, 'list')

  const wrong = await call('/v1/models', { headers: { authorization: 'Bearer nope' } })
  assert.equal(wrong.status, 401)
})

test('the access log follows the configured data directory', async () => {
  // logLine() is fire-and-forget; give the append a moment to land.
  let text
  for (let attempt = 0; attempt < 40; attempt++) {
    text = await readFile(join(dataDir, 'access.log'), 'utf8').catch(() => undefined)
    if (text !== undefined && text.includes('/health')) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(text !== undefined, 'the access log must be written into --data-dir, not ~/.cmdgo-bridge')
  assert.ok(text.includes('/health'), 'requests must be recorded')
})
