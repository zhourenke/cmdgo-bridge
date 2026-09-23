/**
 * Guards the oversized-body path against being drained.
 *
 * `readBody` caps the JSON body at 8 MiB. It checked the declared
 * `Content-Length` first, but a chunked upload declares nothing — and the data
 * callback merely set an `overflow` flag and dropped the rest. The server
 * buffered nothing yet kept reading to the end of a body of unbounded size
 * before it answered, so one client could hold a connection (and half a duplex
 * stream) open indefinitely at no cost to itself.
 *
 * The invariant: the 413 must arrive from the bytes already received, without
 * the client having to finish sending. These tests never send the whole body in
 * the honest case and assert the response anyway, which is only possible if the
 * server stopped reading.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeDataDir } from './helpers/teardown.mjs'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'

/** Holds the fixture state so teardown can flush its pending writes. */
let bridgeState

const API_KEY = 'oversize-test-key-0123456789ab'
const CAP = 8 * 1024 * 1024
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
  dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-oversize-'))
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

/** Rejects after `ms` so a regression fails the test instead of hanging it. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${label}`)), ms).unref?.()
    }),
  ])
}

/**
 * Uploads more than the cap in chunks and stops writing — never calls `end()`.
 *
 * Resolving at all proves the server answered mid-transfer. Writes go out in
 * small pieces with `drain` awaited, so the assertion is about the server
 * refusing the body, not about the client having buffered all 8 MiB locally.
 *
 * Resolution is driven by the declared `content-length` rather than by the
 * socket closing: after a 413 the server stops reading and the client's
 * remaining request bytes keep the connection from closing promptly, which is
 * exactly the behaviour under test and must not be what the test waits on.
 */
function chunkedUpload(path, { auth = true, extraBytes = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let sent = 0
    /** Set once the server answers, so the upload stops instead of parking. */
    let stopped = false
    /** Hard stop for the write loop; see `pump`. */
    const deadline = Date.now() + 30_000
    const done = (value) => {
      if (settled) return
      settled = true
      // The body was deliberately never finished. Leaving the request open keeps
      // a socket (and its queued bytes) alive past the test, which stops the
      // test runner from exiting, so retire it now that the answer has arrived.
      req.destroy()
      resolve(value)
    }
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        ...(auth ? { authorization: `Bearer ${API_KEY}` } : {}),
      },
    }, (res) => {
      stopped = true
      const chunks = []
      let received = 0
      const expected = Number(res.headers['content-length'])
      const finish = () => done({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        finished: true,
        sent,
      })
      res.on('data', (chunk) => {
        chunks.push(chunk)
        received += chunk.length
        if (Number.isSafeInteger(expected) && received >= expected) finish()
      })
      res.on('end', finish)
      res.on('aborted', () => done({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        finished: received > 0 && Number.isSafeInteger(expected) && received >= expected,
        sent,
      }))
    })
    req.on('error', (error) => {
      if (!settled) reject(error)
    })

    const head = Buffer.from('{"model":"m","messages":[],"padding":"', 'utf8')
    const piece = Buffer.alloc(64 * 1024, 0x61)
    const total = CAP + extraBytes
    const pump = () => {
      if (settled || stopped || sent >= total) return
      // The deadline bounds the loop even if the peer stops reading mid-write,
      // so a regression fails the assertion instead of hanging the suite.
      if (Date.now() > deadline) return
      const ok = req.write(piece)
      sent += piece.length
      if (ok) setImmediate(pump)
      else req.once('drain', pump)
    }
    req.write(head)
    sent += head.length
    pump()
  })
}

/** A declared Content-Length above the cap: rejected before any body is read. */
function declaredOversize(path) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        // Authorized, or the request is refused 401 before the body is ever
        // considered — the cap check must be exercised, not the auth check.
        authorization: `Bearer ${API_KEY}`,
        'content-length': String(CAP + 1),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('close', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('a declared oversize is refused with 413 and an OpenAI-shaped error', async () => {
  const res = await declaredOversize('/v1/chat/completions')
  assert.equal(res.status, 413)
  const payload = JSON.parse(res.body)
  assert.match(payload.error.message, /too large/)
  assert.equal(payload.error.type, 'invalid_request_error')
})

test('a body just under the cap is still accepted', async () => {
  // Proves the cap is not off by a chunk: ~8 MiB minus a margin must parse.
  const padding = 'b'.repeat(CAP - 1024 * 1024)
  const body = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: padding }] })
  const res = await new Promise((resolve, reject) => {
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
    }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
  // Any answer but 413 proves the body was read and parsed; the empty pool makes
  // it fail later, which is fine.
  assert.notEqual(res.status, 413, `a body under the cap must not be rejected as oversized: ${res.body.slice(0, 200)}`)
})

test('an endless chunked body is answered 413 without waiting for it to finish', async (t) => {
  t.diagnostic(`body cap is ${CAP} bytes; writing at least ${CAP + 64 * 1024} bytes in 64 KiB pieces, never calling end()`)
  const started = Date.now()
  const res = await withTimeout(chunkedUpload('/v1/chat/completions'), 30_000, 'the 413 mid-transfer')
  const elapsed = Date.now() - started
  assert.equal(res.status, 413, `expected 413 mid-transfer, got ${res.status}: ${res.body.slice(0, 200)}`)
  const payload = JSON.parse(res.body)
  assert.match(payload.error.message, /too large/)
  assert.equal(res.finished, true, 'the full 413 body must arrive')
  // Well under the time needed to stream the whole body to the server.
  assert.ok(elapsed < 15_000, `the 413 must not wait for the body to drain (took ${elapsed}ms)`)
})

test('the admin surface rejects an oversized body too', async () => {
  // `/api/reload` rather than `/api/login`: a login attempt starts the OAuth
  // callback listener, which outlives the test and keeps the runner alive.
  const res = await withTimeout(chunkedUpload('/api/reload'), 30_000, 'the admin 413')
  assert.equal(res.status, 413, res.body.slice(0, 200))
  assert.match(JSON.parse(res.body).error, /too large/)
})

test('a chunked body under the cap is read normally', async () => {
  // Same code path, small body: the overflow handling must not reject this.
  const res = await new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/api/reload',
      method: 'POST',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
    }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.write('{"x":')
    req.write('1}')
    req.end()
  })
  assert.notEqual(res.status, 413, `a small chunked body must not be treated as oversized: ${res.body.slice(0, 200)}`)
})

test('the socket is actually closed after a 413', async () => {
  // Raw socket so the closing behaviour is observable directly. The fallback
  // resolver is a safety net; `closed` distinguishes the two paths.
  const raw = await new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      // Proper chunked framing: "<hex size>\r\n<data>\r\n" per chunk.
      const payload = 'a'.repeat(64 * 1024)
      const frame = `${payload.length.toString(16)}\r\n${payload}\r\n`
      let sent = 0
      const pump = () => {
        if (sent >= CAP + 4096) return
        sent += payload.length
        if (socket.write(frame)) setImmediate(pump)
        else socket.once('drain', pump)
      }
      socket.write(
        'POST /v1/chat/completions HTTP/1.1\r\n'
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Content-Type: application/json\r\n'
        + `Authorization: Bearer ${API_KEY}\r\n`
        + 'Transfer-Encoding: chunked\r\n\r\n',
      )
      pump()
    })
    let received = ''
    let closed = false
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => { received += chunk })
    socket.on('close', () => {
      closed = true
      resolve({ received, closed })
    })
    socket.on('error', reject)
    setTimeout(() => { socket.destroy(); resolve({ received, closed }) }, 15_000).unref?.()
  })
  assert.match(raw.received, /^HTTP\/1\.1 413/, `expected a 413 on the wire, got: ${raw.received.slice(0, 120)}`)
  assert.match(raw.received, /too large/, 'the 413 body must be delivered in full before the socket closes')
  assert.equal(raw.closed, true, 'the server must close the connection instead of holding it open')
})

test('an oversized body does not leak an error into later requests', async () => {
  const ok = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/health', method: 'GET', headers: { host: `127.0.0.1:${port}` } }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(ok.status, 200, 'the server is still healthy after refusing bodies')
  assert.equal(JSON.parse(ok.body).service, 'cmdgo-bridge')
})

test('the helper server is not left listening anywhere unexpected', async () => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  assert.notEqual(probe.address().port, port)
  await new Promise((resolve) => probe.close(resolve))
})
