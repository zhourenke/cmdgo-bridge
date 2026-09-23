/**
 * Guards the binding-address defences.
 *
 * The admin surface (`/api/*`, `/health`, the console page) carries no token,
 * and `/api/status` discloses the bearer token that `/v1/*` accepts. That is
 * fine — and deliberate — while the bridge listens on loopback, which is the
 * default. It stops being fine the moment the bind address is widened, and
 * `--host` is persisted back into `config.json`, so one mistaken invocation
 * keeps reaching the network across every later restart.
 *
 * Two invariants protect that:
 *
 *   1. A non-loopback bind prints a loud startup warning.
 *   2. A request whose *socket* address is not loopback never receives
 *      `apiKey`, even if the bind is widened or a reverse proxy fronts it.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeDataDir } from './helpers/teardown.mjs'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer, isLoopbackHost } from '../dist/server.js'
import { listenOnFetchablePort } from './helpers/loopback-port.mjs'

/** Holds the fixture state so teardown can flush its pending writes. */
let bridgeState

const API_KEY = 'test-key-host-0123456789abcd'
const realFetch = globalThis.fetch

/** Catalog sync stays offline without shadowing the gateway's built-in fetch. */
const stubCatalog = (url, init) =>
  String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
    ? Promise.resolve(new Response(JSON.stringify({ data: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

/** Fails the test rather than hanging the suite if the child never speaks. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms).unref?.()
    }),
  ])
}

/** Asks the OS for a port nothing is using. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    listenOnFetchablePort(probe).then(() => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/** Raw request helper against an arbitrary port. */
function callOn(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * Boots a bridge whose inbound connections are made to look like they come from
 * `spoofedAddress`. The status handler reads `req.socket.remoteAddress`, so the
 * only faithful way to test the reverse-proxy / widened-bind case is to control
 * that value rather than to send a header.
 */
async function bootWithSourceAddress(spoofedAddress) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-src-'))
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY }
  const server = createBridgeServer((bridgeState = buildState(cfg, dataDir)))
  await new Promise((resolve) => server.once('listening', resolve))
  // `connection` fires for every socket before its request is parsed.
  server.on('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { value: spoofedAddress, configurable: true })
  })
  globalThis.fetch = stubCatalog
  return {
    port: server.address().port,
    close: async () => {
      globalThis.fetch = realFetch
      await new Promise((resolve) => server.close(resolve))
      await removeDataDir(dataDir, { pool: bridgeState?.pool })
    },
  }
}

let server
let port
let dataDir

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-host-'))
  globalThis.fetch = stubCatalog
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY }
  server = createBridgeServer((bridgeState = buildState(cfg, dataDir)))
  await new Promise((resolve) => server.once('listening', resolve))
  port = server.address().port
})

after(async () => {
  globalThis.fetch = realFetch
  await new Promise((resolve) => server.close(resolve))
  await removeDataDir(dataDir, { pool: bridgeState?.pool })
})

test('the loopback predicate accepts only addresses that stay on this machine', () => {
  for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(host), true, `${host} is loopback`)
  }
  for (const host of ['0.0.0.0', '::', '10.0.0.5', '192.168.1.20', '172.16.9.9', 'example.com', 'bridge.internal', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} reaches the network and must not count as loopback`)
  }
})

test('a loopback caller still receives the apiKey the console needs', async () => {
  const res = await callOn(port, '/api/status')
  assert.equal(res.status, 200)
  assert.equal(JSON.parse(res.body).apiKey, API_KEY, 'the local console must keep working')
})

test('/health never carries the token', async () => {
  const res = await callOn(port, '/health')
  assert.equal(res.status, 200)
  assert.ok(!res.body.includes(API_KEY))
  assert.equal(JSON.parse(res.body).service, 'cmdgo-bridge')
})

for (const source of ['10.1.2.3', '192.168.5.9', '::ffff:10.1.2.3']) {
  test(`a request from ${source} never receives the apiKey`, async () => {
    const remote = await bootWithSourceAddress(source)
    try {
      const res = await callOn(remote.port, '/api/status')
      assert.equal(res.status, 200, 'the snapshot itself is still served')
      const snapshot = JSON.parse(res.body)
      assert.equal(snapshot.apiKey, undefined, 'the bearer token must not leave the machine')
      assert.ok(!res.body.includes(API_KEY), 'the token must not appear anywhere in the body')
      assert.equal(snapshot.ok, true, 'the console still learns everything except the secret')
      assert.ok(Array.isArray(snapshot.accounts), 'account state is not secret and must still be reported')
    } finally {
      await remote.close()
    }
  })
}

test('binding a non-loopback host prints a loud startup warning', async (t) => {
  const warnDir = await mkdtemp(join(tmpdir(), 'cmdgo-warn-'))
  const warnPort = await freePort()
  const child = spawn(process.execPath, [
    'dist/index.js', '--host', '0.0.0.0', '--port', String(warnPort), '--data-dir', warnDir,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const collect = (chunk) => { output += chunk }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
    return rm(warnDir, { recursive: true, force: true })
  })

  await withTimeout(new Promise((resolve) => {
    const check = () => { if (output.includes('警告：监听地址不是回环地址')) resolve() }
    child.stdout.on('data', check)
    child.stderr.on('data', check)
    child.on('exit', () => resolve())
  }), 20_000, 'the startup warning')

  assert.ok(output.includes('警告：监听地址不是回环地址'), `warning missing from startup output:\n${output}`)
  assert.ok(output.includes('管理面'), 'the warning must name the exposed admin surface')
  assert.ok(/API key/i.test(output), 'the warning must say the token is readable')
  assert.ok(output.includes('账号池'), 'the warning must say the pool can be wiped')
  assert.ok(output.includes('config.json'), 'the warning must say the address persists')
})

test('a loopback bind prints no such warning', async (t) => {
  const quietDir = await mkdtemp(join(tmpdir(), 'cmdgo-quiet-'))
  const quietPort = await freePort()
  const child = spawn(process.execPath, [
    'dist/index.js', '--host', '127.0.0.1', '--port', String(quietPort), '--data-dir', quietDir,
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const collect = (chunk) => { output += chunk }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)

  t.after(() => {
    if (child.exitCode === null) child.kill('SIGKILL')
    return rm(quietDir, { recursive: true, force: true })
  })

  await withTimeout(new Promise((resolve) => {
    const check = () => { if (output.includes('客户端 API key')) resolve() }
    child.stdout.on('data', check)
    child.on('exit', () => resolve())
  }), 20_000, 'the startup banner')

  assert.ok(output.includes('客户端 API key'), `the normal banner must still print:\n${output}`)
  assert.ok(!output.includes('警告：监听地址不是回环地址'), `a loopback bind must not warn:\n${output}`)
})
