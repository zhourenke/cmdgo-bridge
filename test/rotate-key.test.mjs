/**
 * Guards client-token rotation.
 *
 * Before the fix there was no supported way to change the token: the console
 * only displayed and copied it, the CLI had no `--api-key`, and the admin API
 * exposed no rotation route. The only recourse was hand-editing `config.json`
 * and restarting — which, done with a BOM, silently regenerated a random key
 * instead. So a leaked token could only be retired by an outage.
 *
 * The invariant that matters for a shared deployment: a rotation takes effect
 * **immediately and completely** — no window where the retired token still
 * authenticates, and no restart required.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeDataDir } from './helpers/teardown.mjs'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'

/** Holds the fixture state so teardown can flush its pending writes. */
let bridgeState

const OLD_TOKEN = 'old-token-0123456789abcdef'
const realFetch = globalThis.fetch

const stubCatalog = (url, init) =>
  String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
    ? Promise.resolve(new Response(JSON.stringify({ data: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

let server
let port
let dataDir

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-rotate-'))
  globalThis.fetch = stubCatalog
  // Seed the file the rotation must write back to, so the test can prove the
  // change reaches disk rather than only the in-memory config.
  await writeFile(join(dataDir, 'config.json'), JSON.stringify({
    ...defaultConfig(),
    host: '0.0.0.0',
    port: 0,
    apiKey: OLD_TOKEN,
    allowedHosts: ['console.example'],
  }, null, 2), 'utf8')
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: OLD_TOKEN, allowedHosts: ['console.example'] }
  server = createBridgeServer((bridgeState = buildState(cfg, dataDir)))
  await new Promise((resolve) => server.once('listening', resolve))
  port = server.address().port
})

after(async () => {
  globalThis.fetch = realFetch
  await new Promise((resolve) => server.close(resolve))
  await removeDataDir(dataDir, { pool: bridgeState?.pool })
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const withToken = (token) => ({ authorization: `Bearer ${token}` })

test('the old token works before rotation', async () => {
  const res = await call('/v1/models', { headers: withToken(OLD_TOKEN) })
  assert.equal(res.status, 200)
})

test('rotating returns a new token and retires the old one immediately', async () => {
  const rotate = await call('/api/rotate-key', { method: 'POST', body: {} })
  assert.equal(rotate.status, 200, rotate.body)
  const { ok, apiKey } = JSON.parse(rotate.body)
  assert.equal(ok, true)
  assert.equal(typeof apiKey, 'string')
  assert.equal(apiKey.length, 48, 'a 24-byte hex token, same shape as the generated default')
  assert.notEqual(apiKey, OLD_TOKEN)

  // No restart happened between these two calls — that is the point.
  const retired = await call('/v1/models', { headers: withToken(OLD_TOKEN) })
  assert.equal(retired.status, 401, 'the retired token must stop working at once')
  assert.equal(JSON.parse(retired.body).error.code, 'invalid_api_key')

  const fresh = await call('/v1/models', { headers: withToken(apiKey) })
  assert.equal(fresh.status, 200, 'the new token must work without a restart')
})

test('the rotated token is persisted, so a restart keeps it', async () => {
  const snapshot = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'))
  const live = JSON.parse((await call('/api/status')).body).apiKey
  assert.equal(snapshot.apiKey, live, 'disk and runtime must agree on the active token')
  assert.notEqual(snapshot.apiKey, OLD_TOKEN)
})

test('rotation preserves every other config field', async () => {
  const snapshot = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(snapshot.host, '0.0.0.0', 'the bind address must survive')
  assert.deepEqual(snapshot.allowedHosts, ['console.example'], 'allowedHosts must survive')
  assert.equal(snapshot.baseURL, defaultConfig().baseURL)
  assert.equal(snapshot.maxTokens, defaultConfig().maxTokens)
})

test('rotating twice keeps only the newest token valid', async () => {
  const first = JSON.parse((await call('/api/status')).body).apiKey
  const second = JSON.parse((await call('/api/rotate-key', { method: 'POST', body: {} })).body).apiKey
  assert.notEqual(first, second)
  assert.equal((await call('/v1/models', { headers: withToken(first) })).status, 401, 'the previous token is retired')
  assert.equal((await call('/v1/models', { headers: withToken(second) })).status, 200)
})

test('a request with no token is still rejected', async () => {
  assert.equal((await call('/v1/models')).status, 401)
})

test('the rotated key is not disclosed to a cross-origin caller', async () => {
  const res = await call('/api/rotate-key', { method: 'POST', headers: { origin: 'http://evil.example' }, body: {} })
  assert.equal(res.status, 403, 'the admin surface refuses cross-origin callers')
  const live = JSON.parse((await call('/api/status')).body).apiKey
  assert.ok(!res.body.includes(live), 'a refused rotation must not leak the current token')
})

test('a non-loopback caller cannot rotate the token', async () => {
  // An allowed `Origin`/`Host` plus a non-loopback socket address: exactly the
  // widened-bind or reverse-proxy case the loopback restriction exists for.
  // The source address is spoofed because that is what the handler reads.
  const spoofDir = await mkdtemp(join(tmpdir(), 'cmdgo-rotate-src-'))
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: OLD_TOKEN }
  const spoofed = createBridgeServer((bridgeState = buildState(cfg, spoofDir)))
  await new Promise((resolve) => spoofed.once('listening', resolve))
  spoofed.on('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { value: '10.9.8.7', configurable: true })
  })
  globalThis.fetch = stubCatalog
  const spoofPort = spoofed.address().port
  try {
    const res = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: spoofPort, path: '/api/rotate-key', method: 'POST', headers: { host: `127.0.0.1:${spoofPort}`, 'content-length': 2 } }, (r) => {
        const chunks = []
        r.on('data', (c) => chunks.push(c))
        r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end('{}')
    })
    assert.equal(res.status, 403, 'rotation must be loopback-only')
    assert.ok(res.body.includes('回环'), `the refusal must explain why: ${res.body}`)
    // And the token the caller could not rotate is untouched.
    assert.equal(JSON.parse(await readFile(join(spoofDir, 'config.json'), 'utf8').catch(() => '{"apiKey":"' + OLD_TOKEN + '"}')).apiKey, OLD_TOKEN)
  } finally {
    await new Promise((resolve) => spoofed.close(resolve))
    await removeDataDir(spoofDir, { pool: bridgeState?.pool })
    globalThis.fetch = stubCatalog
  }
})

test('the console exposes a rotate control', async () => {
  const page = await call('/')
  assert.equal(page.status, 200)
  assert.ok(page.body.includes('btnKeyRotate'), 'the rotate button must exist')
  assert.ok(page.body.includes('/rotate-key'), 'and must call the rotation route')
  assert.ok(page.body.includes('window.confirm'), 'and must ask for confirmation first')
  assert.ok(page.body.includes('立即失效'), 'and must warn that the old token dies immediately')
})

test('the rotation hint stays a full-width grid row rendered as plain text', async () => {
  const page = await call('/')
  const hint = page.body.match(/<div class="hint"[^>]*>[^<]*轮换后[^<]*<\/div>/)
  assert.ok(hint, 'the CONFIG section must carry the rotation hint')

  // `.kv` is `display:grid; grid-template-columns:auto 1fr`. A hint that participates as an
  // ordinary grid item lands in column 1, widens that `auto` column to the full sentence, and
  // starves column 2 (the API-key field plus its three buttons) until they wrap out of the
  // card. Spanning both columns is what keeps the row intact — this has regressed once.
  assert.match(hint[0], /grid-column:\s*1\s*\/\s*-1/,
    'the hint must span both .kv columns or it crushes the API-key row')

  // Typography: the page's sans-serif body and its monospace stack are separate systems, so a
  // bare <code>/<b> inside a body-text line renders in the browser's default Courier/bold and
  // stops matching the neighbouring status line. Keep this line plain text.
  assert.doesNotMatch(hint[0], /<(b|code)>/,
    'keep the hint plain text so it matches the other status lines')

  assert.match(hint[0], /无需重启/,
    'and it must carry the current wording, which says no restart is needed')
})
