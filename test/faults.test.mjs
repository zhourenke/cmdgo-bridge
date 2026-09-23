/**
 * Guards the failure contract of `/v1/chat/completions`.
 *
 * A gateway that dies mid-answer must never be reported downstream as a
 * completed completion. The specific invariants, all of which the bridge
 * violated before the fix:
 *
 *   1. A failed stream sends no `usage` frame — a zeroed usage reads to a
 *      billing downstream as "succeeded, cost nothing", which is worse than
 *      a missing one.
 *   2. A failed stream sends no `[DONE]` sentinel, so a client that waits for
 *      it sees the truncation instead of a clean end.
 *   3. A failed stream DOES send an error event, so the failure is visible.
 *   4. A request that cannot even start (empty pool / missing credential)
 *      fails before the SSE headers are committed and therefore returns a
 *      real HTTP status with a JSON body, instead of `200` + an empty answer.
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'
import { startFaultUpstream } from './helpers/fault-upstream.mjs'

const API_KEY = 'test-key-faults-0123456789'
const realFetch = globalThis.fetch
/**
 * The background catalog sync must stay offline, but the bridge's gateway call
 * must still reach the fault upstream. Only the two catalog hosts are stubbed:
 * `openai.ts` calls the *built-in* fetch, not `globalThis.fetch`, so a blanket
 * stub would silently shadow it (and every streaming case would then look like
 * an empty response).
 */
const catalogHosts = ['api.commandcode.ai', 'cdn.jsdelivr.net']
const stubCatalog = (url, init) =>
  catalogHosts.some((host) => String(url).includes(host))
    ? Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo', context_length: 163_840 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

/**
 * Boots a bridge whose upstream is the given base URL, with an optionally
 * seeded account pool. Returns a `call` helper and a teardown.
 */
async function bootBridge({ baseURL, seedPool = true }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-faults-'))
  if (seedPool) {
    await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({
      version: 1,
      accounts: [{
        id: 'acct', ref: 'COMMANDCODE_API_KEY_ACCT', userName: 'acct', keyName: 'test',
        addedAt: Date.now(), enabled: true, failCount: 0,
      }],
    }), 'utf8')
  }
  // 'no-credential' seeds the account manifest but NOT the credential store, so
  // the pool names an account the credential seam cannot resolve. Distinct from
  // an empty pool: the failure has to come from resolution, not from selection.
  if (seedPool && seedPool !== 'no-credential') {
    await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
      COMMANDCODE_API_KEY_ACCT: { value: 'user_goodkey', source: 'test' },
    }), 'utf8')
  }
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY, baseURL }
  const state = buildState(cfg, dataDir)
  const server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  globalThis.fetch = stubCatalog

  const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
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
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
      }
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', finish)
      // A failed stream ends without [DONE], and the socket close can be
      // observed a tick before the last frame is emitted: drain once more on
      // close so the test sees every byte the client actually received.
      res.on('close', () => setImmediate(finish))
      res.on('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
    })
    req.on('error', reject)
    req.end(payload)
  })

  const teardown = async () => {
    globalThis.fetch = realFetch
    // Drain the manifest writes BEFORE removing the directory: pooled failures
    // persist asynchronously, so an `rm` racing a pending rename fails with
    // ENOTEMPTY (the temp file reappears mid-delete) and leaves the directory
    // behind.
    await state.pool.flush().catch(() => {})
    await new Promise((resolve) => server.close(resolve))
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
  return { call, teardown }
}

/** Splits an SSE body into its `data:` payloads. */
function sseFrames(body) {
  return body.split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => block.replace(/^data: /, ''))
}

const chatBody = (overrides = {}) => ({
  model: 'deepseek/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hi' }],
  ...overrides,
})

let upstream
let bridge

before(async () => {
  upstream = await startFaultUpstream('die-mid-stream')
})

after(async () => {
  globalThis.fetch = realFetch
  await upstream.close()
})

test('a stream that dies mid-answer sends no usage frame', async () => {
  bridge = await bootBridge({ baseURL: upstream.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    assert.equal(res.status, 200, 'the SSE headers are already committed by the time the stream dies')
    const frames = sseFrames(res.body)
    const usageFrames = frames.filter((f) => f !== '[DONE]' && 'usage' in JSON.parse(f))
    assert.equal(
      usageFrames.length, 0,
      'a failed stream must not report usage: a zeroed usage is indistinguishable from a genuinely free success',
    )
  } finally {
    await bridge.teardown()
  }
})

test('a stream that dies mid-answer sends no [DONE] sentinel', async () => {
  bridge = await bootBridge({ baseURL: upstream.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    const frames = sseFrames(res.body)
    assert.ok(
      !frames.includes('[DONE]'),
      '[DONE] means "the completion finished"; emitting it after a transport failure hides the truncation',
    )
  } finally {
    await bridge.teardown()
  }
})

test('a stream that dies mid-answer still surfaces an error event', async () => {
  bridge = await bootBridge({ baseURL: upstream.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    const frames = sseFrames(res.body).filter((f) => f !== '[DONE]')
    const errorFrames = frames.filter((f) => 'error' in JSON.parse(f))
    assert.equal(errorFrames.length, 1, 'the failure must be reported to the client exactly once')
    const [errorFrame] = errorFrames
    assert.ok(errorFrame !== undefined)
    const parsed = JSON.parse(errorFrame)
    assert.equal(parsed.choices.length, 0, 'an error frame carries no choices')
    assert.ok(typeof parsed.error.message === 'string' && parsed.error.message.length > 0)
  } finally {
    await bridge.teardown()
  }
})

test('the partial content that did arrive is still delivered', async () => {
  bridge = await bootBridge({ baseURL: upstream.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    const content = sseFrames(res.body)
      .filter((f) => f !== '[DONE]')
      .map((f) => JSON.parse(f))
      .flatMap((f) => f.choices ?? [])
      .map((c) => c.delta?.content ?? '')
      .join('')
    assert.equal(
      content, 'partial answer part one part two',
      'a truncation must not discard the tokens already delivered — only the false success signal is removed',
    )
  } finally {
    await bridge.teardown()
  }
})

test('an empty pool rejects a streaming request with a real HTTP status, not 200', async () => {
  bridge = await bootBridge({ baseURL: upstream.baseURL, seedPool: false })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    assert.equal(
      res.status, 401,
      'with no account the request never reaches the upstream, so the SSE headers must not be committed',
    )
    assert.ok(
      (res.headers['content-type'] ?? '').includes('application/json'),
      'the failure must be a JSON error body, not an event stream',
    )
    assert.equal(JSON.parse(res.body).error.code, 'MISSING_CREDENTIAL')
  } finally {
    await bridge.teardown()
  }
})

test('an empty pool rejects a non-streaming request the same way', async () => {
  bridge = await bootBridge({ baseURL: upstream.baseURL, seedPool: false })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: false }),
    })
    assert.equal(res.status, 401)
    assert.equal(JSON.parse(res.body).error.code, 'MISSING_CREDENTIAL')
  } finally {
    await bridge.teardown()
  }
})

test('a clean stream still ends with exactly one [DONE] and one usage frame', async () => {
  const healthy = await startFaultUpstream('healthy')
  bridge = await bootBridge({ baseURL: healthy.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    assert.equal(res.status, 200)
    const frames = sseFrames(res.body)
    assert.equal(frames.filter((f) => f === '[DONE]').length, 1, 'exactly one sentinel')
    assert.equal(frames.at(-1), '[DONE]', 'and it must come last')
    const usageFrames = frames.filter((f) => f !== '[DONE]' && 'usage' in JSON.parse(f))
    assert.equal(usageFrames.length, 1, 'a completed stream reports usage exactly once')
    const usage = JSON.parse(usageFrames[0]).usage
    assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens)
    assert.ok(usage.completion_tokens >= usage.completion_tokens_details.reasoning_tokens)
    assert.ok(!frames.some((f) => f !== '[DONE]' && 'error' in JSON.parse(f)), 'no error event on a healthy stream')
  } finally {
    await bridge.teardown()
    await healthy.close()
  }
})

/**
 * A stream that ends cleanly without `finish-step`.
 *
 * This is the ambiguous case the F-13 fix has to get right in both directions:
 * the text that arrived is real and must be delivered, but the gateway never
 * said the model stopped, so `finish_reason` must be null rather than an
 * invented `'stop'`. It must NOT be treated as a transport failure — the socket
 * closed normally, which is a different event from a reset.
 */
test('a clean end without finish-step delivers the answer with finish_reason null (stream)', async () => {
  const noFinish = await startFaultUpstream('no-finish-step')
  bridge = await bootBridge({ baseURL: noFinish.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    assert.equal(res.status, 200)
    const frames = sseFrames(res.body)
    assert.equal(frames.at(-1), '[DONE]', 'a normally-ended stream still terminates the client')
    const chunks = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f))
    assert.ok(!chunks.some((c) => c.error !== undefined), 'a clean end is not an error')

    const text = chunks.flatMap((c) => c.choices ?? []).map((c) => c.delta?.content ?? '').join('')
    assert.equal(text, 'answer without finish step', 'the delivered text must not be discarded')

    const terminal = chunks.find((c) => c.choices[0] !== undefined
      && Object.keys(c.choices[0].delta ?? {}).length === 0)
    assert.equal(terminal.choices[0].finish_reason, null,
      'without finish-step the bridge cannot claim the model stopped')

    // Usage must be synthesized from the deltas: reporting zeros over a complete
    // answer books it downstream as a free success.
    const usageFrames = chunks.filter((c) => c.usage !== undefined)
    assert.equal(usageFrames.length, 1)
    assert.ok(usageFrames[0].usage.completion_tokens > 0,
      'a stream with no reported usage must still count what it delivered')
  } finally {
    await bridge.teardown()
    await noFinish.close()
  }
})

test('a clean end without finish-step is a 200 with the answer, not a 502 (non-stream)', async () => {
  const noFinish = await startFaultUpstream('no-finish-step')
  bridge = await bootBridge({ baseURL: noFinish.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: false }),
    })
    assert.equal(res.status, 200, 'a cleanly ended response is the answer, not a gateway failure')
    const payload = JSON.parse(res.body)
    assert.equal(payload.choices[0].message.content, 'answer without finish step')
    assert.equal(payload.choices[0].finish_reason, null)
    assert.ok(payload.usage.completion_tokens > 0)
  } finally {
    await bridge.teardown()
    await noFinish.close()
  }
})

/**
 * A 200 with no body at all. There is no content and no reason, but the HTTP
 * exchange itself succeeded — so this is an empty answer, not a broken bridge.
 * What must not happen is a fabricated `'stop'` on a completion that carries
 * nothing, which would look to a downstream ledger like a real, empty answer.
 */
test('an empty response body is an empty answer, not a fabricated success (stream)', async () => {
  const empty = await startFaultUpstream('empty-body')
  bridge = await bootBridge({ baseURL: empty.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    assert.equal(res.status, 200)
    const frames = sseFrames(res.body)
    assert.equal(frames.at(-1), '[DONE]', 'the stream still terminates cleanly')
    const chunks = frames.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f))
    assert.ok(!chunks.some((c) => c.error !== undefined), 'an empty body is not a transport failure')
    const terminal = chunks.find((c) => c.choices[0] !== undefined
      && Object.keys(c.choices[0].delta ?? {}).length === 0)
    assert.equal(terminal.choices[0].finish_reason, null)
    const usage = chunks.find((c) => c.usage !== undefined)?.usage
    assert.equal(usage.completion_tokens, 0, 'nothing was delivered, so nothing may be billed')
  } finally {
    await bridge.teardown()
    await empty.close()
  }
})

test('an empty response body is a 200 with empty content (non-stream)', async () => {
  const empty = await startFaultUpstream('empty-body')
  bridge = await bootBridge({ baseURL: empty.baseURL })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: false }),
    })
    assert.equal(res.status, 200)
    const payload = JSON.parse(res.body)
    assert.equal(payload.choices[0].message.content, '')
    assert.equal(payload.choices[0].finish_reason, null)
    assert.equal(payload.usage.completion_tokens, 0)
  } finally {
    await bridge.teardown()
    await empty.close()
  }
})

/**
 * Credential missing for an account that IS in the pool. Distinct from an empty
 * pool: the manifest names an account the credential store cannot resolve, so
 * the request must fail before committing SSE headers for the same reason.
 */
test('an account with no resolvable credential fails before the SSE headers', async () => {
  const dataDirBridge = await bootBridge({ baseURL: upstream.baseURL, seedPool: 'no-credential' })
  bridge = dataDirBridge
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}` },
      body: chatBody({ stream: true }),
    })
    assert.ok(res.status >= 400, `expected a real error status, got ${res.status}: ${res.body.slice(0, 200)}`)
    assert.ok((res.headers['content-type'] ?? '').includes('application/json'),
      'the failure must not be an event stream')
    assert.ok(JSON.parse(res.body).error.code.length > 0)
  } finally {
    await bridge.teardown()
  }
})
