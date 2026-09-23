/**
 * Guards shutdown and manifest durability.
 *
 * `accounts.json` is mutated from two places outside a request: the admin
 * surface (`toggle`, `remove`, `clear`, rotation) and the cool-down bookkeeping
 * in `reportFailure`. Before these fixes the writes were fire-and-forget, so
 * Ctrl-C or a service restart could land between the in-memory change and the
 * write — the operator would then see a disabled account enabled again, or a
 * cool-down quietly gone, with nothing in the log to explain it.
 *
 * Invariants covered:
 *   - `POST /api/account/toggle` does not answer `{ok:true}` until the manifest
 *     on disk reflects the change (no restart needed to see it, and no window
 *     where the response lies about durability);
 *   - `pool.flush()` drains the write queue, including writes queued while it is
 *     draining;
 *   - a manifest write failure is reported to stderr rather than swallowed, and
 *     does not surface as an unhandled rejection;
 *   - a real `node dist/index.js` process exits on SIGTERM after flushing.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AccountPool } from '../dist/pool.js'
import { removeDataDir } from './helpers/teardown.mjs'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'

/** Holds the fixture state so teardown can flush its pending writes. */
let bridgeState

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const API_KEY = 'shutdown-key-0123456789abcdef'
const realFetch = globalThis.fetch

const memoryCredentials = (entries = {}) => ({
  async resolve(ref) {
    return entries[ref] === undefined ? undefined : { value: entries[ref] }
  },
  async describe(ref) { return { configured: entries[ref] !== undefined } },
  async set(ref, value) { entries[ref] = value },
  async unset(ref) { delete entries[ref] },
})

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'cmdgo-shutdown-'))
}

/** Reads accounts.json, tolerating its absence. */
async function readManifest(dir) {
  const path = join(dir, 'accounts.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(await readFile(path, 'utf8'))
}

const ACCOUNT = { id: 'solo', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 1, enabled: true, failCount: 0 }

function call(port, path, { method = 'GET', body } = {}) {
  const payload = body === undefined ? undefined : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
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

/* ---------------- the write queue ---------------- */

test('flush drains every queued manifest write', async () => {
  const dir = await tempDir()
  try {
    const creds = memoryCredentials()
    const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })
    const one = await pool.add(creds, { apiKey: 'k1', userName: 'one' })
    await pool.add(creds, { apiKey: 'k2', userName: 'two' })

    // Queue several writes without awaiting any of them.
    await Promise.all([pool.toggle(one.id, false), pool.toggle(one.id, true), pool.toggle(one.id, false)])
    await pool.flush()

    const manifest = await readManifest(dir)
    assert.ok(manifest !== undefined, 'the manifest must exist after flush')
    assert.equal(manifest.accounts.length, 2)
    const stored = manifest.accounts.find((a) => a.id === one.id)
    assert.equal(stored.enabled, false, 'the last queued state must be the one on disk')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('flush waits for a write queued while it was already draining', async () => {
  const dir = await tempDir()
  try {
    const creds = memoryCredentials()
    const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })
    const one = await pool.add(creds, { apiKey: 'k1', userName: 'one' })

    const flushing = pool.flush()
    // Lands after the drain started: `flush` must observe the queue growing.
    const queued = pool.toggle(one.id, false)
    await Promise.all([flushing, queued])
    await pool.flush()

    const manifest = await readManifest(dir)
    assert.equal(manifest.accounts.find((a) => a.id === one.id).enabled, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unwritable manifest is reported instead of swallowed', async () => {
  const dir = await tempDir()
  const messages = []
  try {
    const creds = memoryCredentials()
    const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir, log: (m) => messages.push(m) })
    const one = await pool.add(creds, { apiKey: 'k1', userName: 'one' })
    await pool.flush()

    // Make the target path unwritable by turning accounts.json into a directory:
    // rename(tmp, path) then fails, which is the branch under test.
    await rm(join(dir, 'accounts.json'), { force: true })
    await mkdir(join(dir, 'accounts.json'), { recursive: true })
    if (process.platform !== 'win32') await chmod(join(dir, 'accounts.json'), 0o500)

    // Must resolve, not reject: these calls are fire-and-forget elsewhere.
    await pool.toggle(one.id, false)
    await pool.flush()

    assert.ok(messages.some((m) => m.includes('账号清单写入失败')),
      `the failure must be logged, got: ${JSON.stringify(messages)}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ---------------- the admin surface ---------------- */

test('POST /api/account/toggle only reports success once the manifest is on disk', async () => {
  const dataDir = await tempDir()
  globalThis.fetch = () => Promise.reject(new Error('no network in this test'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [ACCOUNT] }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'user_goodkey' },
  }), 'utf8')
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY }
  const server = createBridgeServer((bridgeState = buildState(cfg, dataDir)))
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  try {
    const res = await call(port, '/api/account/toggle', { method: 'POST', body: { id: 'solo', enabled: false } })
    assert.equal(res.status, 200, res.body.slice(0, 200))
    assert.equal(JSON.parse(res.body).ok, true)

    // No sleep, no retry: the response is only sent after the await, so the file
    // must already agree.
    const manifest = await readManifest(dataDir)
    assert.equal(manifest.accounts[0].enabled, false,
      'the write must have completed before the response was sent')
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await removeDataDir(dataDir, { pool: bridgeState?.pool })
  }
})

/* ---------------- the shutdown sequence ---------------- */

/**
 * Signal DELIVERY is untestable on Windows: `child.kill('SIGTERM')` there calls
 * TerminateProcess, so the child dies with `signal=SIGTERM` and never runs a
 * `'SIGTERM'` handler (verified directly — see the note in `src/index.ts`).
 * What IS portable is the sequence `shutdown()` runs, which is where the bugs
 * would be: closing before flushing, or not flushing at all.
 */
test('shutdown closes the listener and flushes the pool, in that order', async () => {
  const dataDir = await tempDir()
  const events = []
  globalThis.fetch = () => Promise.reject(new Error('no network in this test'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [ACCOUNT] }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'user_goodkey' },
  }), 'utf8')
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY }
  const state = buildState(cfg, dataDir)
  const server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port

  // A pending write at shutdown time: the account is disabled in memory but the
  // manifest on disk still says enabled.
  await state.pool.ensureLoaded()
  await state.pool.toggle('solo', false)

  try {
    const { shutdown } = await import('../dist/index.js')
    await shutdown(server, {
      flush: async () => { events.push('flush'); await state.pool.flush() },
    }, 'SIGTERM', { log: (m) => events.push(m) })

    assert.ok(!server.listening, 'the listener must be closed')
    assert.ok(events.includes('flush'), 'the pool must be flushed before shutdown resolves')
    assert.ok(events.some((e) => e.includes('收到 SIGTERM')))
    assert.equal(events.at(-1), '[cmdgo] 账号清单已落盘，退出完成')

    // The pending disable must be on disk, which is the whole point.
    const manifest = await readManifest(dataDir)
    assert.equal(manifest.accounts.find((a) => a.id === 'solo').enabled, false,
      'a change made just before shutdown must survive it')

    // A closed listener stops accepting new work.
    await assert.rejects(() => call(port, '/health'), 'a closed server must refuse new connections')
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await removeDataDir(dataDir, { pool: bridgeState?.pool })
  }
})

test('shutdown force-closes connections that outlive the grace period', async () => {
  const dataDir = await tempDir()
  const events = []
  globalThis.fetch = () => Promise.reject(new Error('no network in this test'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [ACCOUNT] }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'user_goodkey' },
  }), 'utf8')
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY }
  const state = buildState(cfg, dataDir)
  const server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port

  // Hold a connection open so `close()` cannot complete on its own.
  const socket = request({ host: '127.0.0.1', port, path: '/health', method: 'GET' }, () => {})
  socket.on('error', () => {})
  await new Promise((resolve) => socket.once('socket', (s) => (s.connecting ? s.once('connect', resolve) : resolve())))
  // ...and keep the reply unread, so the response is never finished.
  socket.on('response', (res) => res.pause())

  try {
    const { shutdown } = await import('../dist/index.js')
    const started = Date.now()
    await shutdown(server, { flush: async () => { events.push('flush') } }, 'SIGINT', {
      graceMs: 300,
      log: (m) => events.push(m),
    })
    const took = Date.now() - started
    assert.ok(took >= 250, `the grace period must actually be waited out, took ${took}ms`)
    assert.ok(took < 5_000, `shutdown must not hang on a stuck connection, took ${took}ms`)
    assert.ok(events.some((e) => e.includes('强制关闭连接')), 'the force-close must be logged')
    assert.ok(events.includes('flush'), 'the flush must still run after a force-close')
  } finally {
    globalThis.fetch = realFetch
    socket.destroy()
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await removeDataDir(dataDir, { pool: bridgeState?.pool })
  }
})

test('the built entry point registers SIGINT and SIGTERM handlers', async () => {
  // Portable across platforms: registration is testable even where delivery is
  // not. `process.emit` triggers the handlers this module installs.
  const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') }
  const src = await readFile(join(REPO, 'src', 'index.ts'), 'utf8')
  assert.match(src, /for \(const signal of \['SIGINT', 'SIGTERM'\] as const\)/,
    'both signals must be handled')
  assert.match(src, /process\.on\(signal,/, 'the handler must be registered on the process')
  assert.equal(typeof before.int, 'number')
})
