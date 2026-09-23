/**
 * The wire contract of `/v1/*`, as a downstream relay or aggregator sees it.
 *
 * This bridge runs as an upstream supplier to other API gateways, so its own
 * response shapes are an interface, not an implementation detail: a downstream
 * that bills from `usage`, waits for `[DONE]`, or replays `tool_calls` will
 * misbehave in ways that are hard to trace back here. These assertions were
 * originally written as one-off audit scripts; they live in the repository now so
 * a future change cannot quietly break the contract.
 *
 * Invariants covered:
 *   - every SSE line is a `data:` frame, and exactly one `[DONE]` arrives, last;
 *   - the first content delta carries `role`, so a client can emit the message
 *     envelope before the text;
 *   - ids and `created` are stable across every frame of one stream;
 *   - `tool_calls[].index` starts at 0 and never goes backwards, which is what
 *     lets a consumer append arguments to the right call;
 *   - the `usage` frame is the shape OpenAI consumers expect, with
 *     `cached_tokens <= prompt_tokens` and `reasoning_tokens <= completion_tokens`
 *     (a detail larger than its parent makes tokenizers clamp the parent to zero);
 *   - the non-streaming body carries the fields a relay reads;
 *   - `/v1/*` is token-protected, including `/v1/models`, and refusals are
 *     OpenAI-shaped JSON rather than HTML or an empty body.
 *
 * The upstream is a local mock, so nothing here touches the network and no quota
 * is spent. Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { request } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'

const API_KEY = 'contract-key-0123456789abcdef'
const realFetch = globalThis.fetch
const catalogHosts = ['api.commandcode.ai', 'cdn.jsdelivr.net']
const stubCatalog = (url, init) =>
  catalogHosts.some((host) => String(url).includes(host))
    ? Promise.resolve(new Response(JSON.stringify({
      data: [{ id: 'deepseek/deepseek-v4.1-flash', name: 'v4.1-flash', context_length: 163_840 }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

/**
 * Mock gateway with the option shapes the contract tests need.
 *
 * A local copy rather than `scripts/mock-gateway.mjs`: that script binds a fixed
 * port and is a standalone tool, while these tests need an ephemeral port and
 * per-test behaviour.
 */
async function startMockGateway({ tools = false, reasoning = false } = {}) {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    if (!(req.url ?? '').startsWith('/alpha/generate')) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    const send = (obj) => res.write(`${JSON.stringify(obj)}\n`)
    send({ type: 'text-start' })
    if (tools) {
      send({ type: 'text-delta', text: 'let me check ' })
      send({ type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Beijing' } })
      send({ type: 'tool-call', toolCallId: 'call_2', toolName: 'get_time', input: { zone: 'CST' } })
      send({
        type: 'finish-step',
        finishReason: 'tool_calls',
        usage: {
          inputTokens: 55,
          outputTokens: 12,
          inputTokenDetails: { noCacheTokens: 40, cacheReadTokens: 15 },
          outputTokenDetails: { textTokens: 6, reasoningTokens: 6 },
        },
      })
    } else {
      send({ type: 'text-delta', text: 'hello ' })
      if (reasoning) {
        send({ type: 'reasoning-start' })
        send({ type: 'reasoning-delta', text: 'thinking about it' })
      }
      send({ type: 'text-delta', text: 'world' })
      send({
        type: 'finish-step',
        finishReason: 'end_turn',
        usage: {
          inputTokens: 42,
          outputTokens: 10,
          inputTokenDetails: { noCacheTokens: 30, cacheReadTokens: 12 },
          outputTokenDetails: { textTokens: 8, reasoningTokens: 2 },
        },
      })
    }
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve) }),
  }
}

const ACCOUNT = { id: 'solo', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 1, enabled: true, failCount: 0 }

async function boot(options = {}) {
  const upstream = await startMockGateway(options)
  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-chat-'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [ACCOUNT] }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'user_goodkey', source: 'test' },
  }), 'utf8')
  globalThis.fetch = stubCatalog
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY, baseURL: upstream.baseURL }
  const server = createBridgeServer(buildState(cfg, dataDir))
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  return {
    upstream,
    port,
    call: (path, { method = 'GET', headers = {}, body } = {}) => call(port, path, { method, headers, body }),
    close: async () => {
      globalThis.fetch = realFetch
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await rm(dataDir, { recursive: true, force: true })
      await upstream.close()
    },
  }
}

function call(port, path, { method = 'GET', headers = {}, body } = {}) {
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
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const chat = (extra = {}) => ({
  model: 'deepseek/deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

const authed = { authorization: `Bearer ${API_KEY}` }

/** Splits an SSE body into its `data:` payloads, asserting framing as it goes. */
function sseFrames(body) {
  const frames = []
  for (const block of body.split('\n\n')) {
    if (block === '') continue
    assert.ok(block.startsWith('data: '), `every SSE block must be a data frame, got: ${JSON.stringify(block.slice(0, 80))}`)
    frames.push(block.slice('data: '.length))
  }
  return frames
}

/** Asserts the usage block is internally consistent per the OpenAI contract. */
function assertUsageShape(usage, label) {
  assert.ok(usage !== undefined && usage !== null, `${label}: usage must be present`)
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    assert.equal(typeof usage[field], 'number', `${label}: usage.${field} must be a number`)
    assert.ok(Number.isInteger(usage[field]) && usage[field] >= 0, `${label}: usage.${field} must be a non-negative integer, got ${usage[field]}`)
  }
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens,
    `${label}: total_tokens must equal prompt + completion`)
  const cached = usage.prompt_tokens_details?.cached_tokens
  assert.ok(Number.isInteger(cached) && cached >= 0, `${label}: cached_tokens must be present`)
  assert.ok(cached <= usage.prompt_tokens, `${label}: cached_tokens (${cached}) must not exceed prompt_tokens (${usage.prompt_tokens})`)
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  assert.ok(Number.isInteger(reasoning) && reasoning >= 0, `${label}: reasoning_tokens must be present`)
  assert.ok(reasoning <= usage.completion_tokens,
    `${label}: reasoning_tokens (${reasoning}) must not exceed completion_tokens (${usage.completion_tokens})`)
}

/* ---------------- streaming frame contract ---------------- */

test('a streaming answer has exactly one [DONE], and it is last', async () => {
  const bridge = await boot()
  try {
    const res = await bridge.call('/v1/chat/completions', { method: 'POST', headers: authed, body: chat({ stream: true }) })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /^text\/event-stream/)
    const frames = sseFrames(res.body)
    const done = frames.filter((f) => f === '[DONE]')
    assert.equal(done.length, 1, `expected exactly one [DONE], got ${done.length}`)
    assert.equal(frames[frames.length - 1], '[DONE]', '[DONE] must be the final frame')
  } finally {
    await bridge.close()
  }
})

test('every delta frame carries the envelope fields a relay reads', async () => {
  const bridge = await boot()
  try {
    const res = await bridge.call('/v1/chat/completions', { method: 'POST', headers: authed, body: chat({ stream: true }) })
    const chunks = sseFrames(res.body).filter((f) => f !== '[DONE]').map((f) => JSON.parse(f))
    assert.ok(chunks.length >= 3, 'expected several chunks')

    const first = chunks[0]
    for (const chunk of chunks) {
      assert.equal(chunk.object, 'chat.completion.chunk')
      assert.equal(typeof chunk.id, 'string')
      assert.match(chunk.id, /^chatcmpl-/)
      assert.equal(typeof chunk.created, 'number')
      assert.equal(chunk.model, 'deepseek/deepseek-v4.1-flash')
      // One id and one timestamp for the whole stream: a consumer groups frames
      // by id, and per-frame values would split one answer into several.
      assert.equal(chunk.id, first.id, 'the completion id must be stable across frames')
      assert.equal(chunk.created, first.created, 'created must be stable across frames')
      assert.ok(Array.isArray(chunk.choices))
    }

    // The first frame that carries content must also announce the role, or a
    // consumer cannot open the assistant message before appending text to it.
    const firstContent = chunks.find((c) => c.choices[0]?.delta?.content !== undefined)
    assert.ok(firstContent !== undefined, 'expected at least one content delta')
    assert.equal(firstContent.choices[0].delta.role, 'assistant')
  } finally {
    await bridge.close()
  }
})

test('the terminal frame reports finish_reason and is followed by usage', async () => {
  const bridge = await boot()
  try {
    const res = await bridge.call('/v1/chat/completions', { method: 'POST', headers: authed, body: chat({ stream: true }) })
    const raw = sseFrames(res.body)
    const chunks = raw.filter((f) => f !== '[DONE]').map((f) => JSON.parse(f))

    // The terminal frame is the one choice whose delta is empty. The usage frame
    // also has an empty delta expression but carries NO choices at all, so the
    // presence of a choice has to be part of the test.
    const terminal = chunks.filter((c) => c.choices[0] !== undefined
      && Object.keys(c.choices[0].delta ?? {}).length === 0)
    assert.equal(terminal.length, 1, 'exactly one terminal frame')
    assert.equal(terminal[0].choices[0].finish_reason, 'stop', 'end_turn maps to stop')

    // Exactly one usage frame, and it carries no choices: a relay that sums
    // every frame's usage would otherwise double-count.
    const withUsage = chunks.filter((c) => c.usage !== undefined)
    assert.equal(withUsage.length, 1, 'exactly one usage frame')
    assert.equal(withUsage[0].choices.length, 0, 'the usage frame carries no choices')
    assertUsageShape(withUsage[0].usage, 'stream')
    assert.equal(withUsage[0].usage.prompt_tokens, 42, 'cached 12 + uncached 30')
    assert.equal(withUsage[0].usage.prompt_tokens_details.cached_tokens, 12)
  } finally {
    await bridge.close()
  }
})

test('reasoning deltas are exposed as reasoning_content and counted in usage', async () => {
  const bridge = await boot({ reasoning: true })
  try {
    const res = await bridge.call('/v1/chat/completions', { method: 'POST', headers: authed, body: chat({ stream: true, reasoning_effort: 'high' }) })
    const chunks = sseFrames(res.body).filter((f) => f !== '[DONE]').map((f) => JSON.parse(f))
    const reasoning = chunks.flatMap((c) => c.choices[0]?.delta?.reasoning_content ?? [])
    assert.ok(reasoning.length > 0, 'reasoning must be surfaced, not dropped')
    const usageFrame = chunks.find((c) => c.usage !== undefined)
    assert.ok(usageFrame.usage.completion_tokens_details.reasoning_tokens > 0, 'reasoning tokens must be reported')
  } finally {
    await bridge.close()
  }
})

test('tool_calls carry a monotonic index and parseable arguments', async () => {
  const bridge = await boot({ tools: true })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST', headers: authed,
      body: chat({
        stream: true,
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
      }),
    })
    const chunks = sseFrames(res.body).filter((f) => f !== '[DONE]').map((f) => JSON.parse(f))
    const calls = chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])
    assert.equal(calls.length, 2, 'one frame per tool call')

    let previous = -1
    for (const call of calls) {
      assert.equal(typeof call.index, 'number', 'index is required to place the call')
      assert.ok(call.index > previous, `index must increase, got ${call.index} after ${previous}`)
      previous = call.index
      assert.equal(call.type, 'function')
      assert.equal(typeof call.id, 'string')
      assert.ok(call.id.length > 0, 'a tool call must be identifiable')
      assert.equal(typeof call.function?.name, 'string')
      assert.doesNotThrow(() => JSON.parse(call.function.arguments), 'arguments must be a JSON string')
    }
    assert.equal(calls[0].index, 0, 'indices start at 0')

    const terminal = chunks.find((c) => c.choices[0] !== undefined
      && Object.keys(c.choices[0].delta ?? {}).length === 0)
    assert.equal(terminal.choices[0].finish_reason, 'tool_calls')
  } finally {
    await bridge.close()
  }
})

/* ---------------- non-streaming body contract ---------------- */

test('the non-streaming body carries the fields a relay reads, with valid usage', async () => {
  const bridge = await boot()
  try {
    const res = await bridge.call('/v1/chat/completions', { method: 'POST', headers: authed, body: chat({ stream: false }) })
    assert.equal(res.status, 200)
    assert.match(res.headers['content-type'], /^application\/json/)
    const payload = JSON.parse(res.body)

    assert.equal(payload.object, 'chat.completion')
    assert.match(payload.id, /^chatcmpl-/)
    assert.equal(typeof payload.created, 'number')
    assert.equal(payload.model, 'deepseek/deepseek-v4.1-flash')
    assert.ok(Array.isArray(payload.choices) && payload.choices.length === 1)
    const choice = payload.choices[0]
    assert.equal(choice.index, 0)
    assert.equal(choice.message.role, 'assistant')
    assert.equal(choice.message.content, 'hello world')
    assert.equal(choice.finish_reason, 'stop')
    assertUsageShape(payload.usage, 'non-stream')
  } finally {
    await bridge.close()
  }
})

test('a non-streaming tool call is a complete, parseable message', async () => {
  const bridge = await boot({ tools: true })
  try {
    const res = await bridge.call('/v1/chat/completions', {
      method: 'POST', headers: authed,
      body: chat({ stream: false, tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }] }),
    })
    const payload = JSON.parse(res.body)
    const calls = payload.choices[0].message.tool_calls
    assert.equal(calls.length, 2)
    assert.equal(calls[0].index, undefined, 'non-streaming tool calls are not indexed')
    for (const c of calls) {
      assert.equal(c.type, 'function')
      assert.equal(typeof c.id, 'string')
      assert.doesNotThrow(() => JSON.parse(c.function.arguments))
    }
    assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  } finally {
    await bridge.close()
  }
})

/* ---------------- auth and routing on /v1 ---------------- */

test('/v1/models requires the token and returns an OpenAI-shaped catalogue', async () => {
  const bridge = await boot()
  try {
    const denied = await bridge.call('/v1/models')
    assert.equal(denied.status, 401)
    const body = JSON.parse(denied.body)
    assert.equal(body.error.code, 'invalid_api_key')
    assert.ok(body.error.message.length > 0)

    const ok = await bridge.call('/v1/models', { headers: authed })
    assert.equal(ok.status, 200)
    const list = JSON.parse(ok.body)
    assert.equal(list.object, 'list')
    assert.ok(Array.isArray(list.data))
  } finally {
    await bridge.close()
  }
})

test('a malformed or wrong token is refused on the chat endpoint too', async () => {
  const bridge = await boot()
  try {
    for (const headers of [{}, { authorization: 'Bearer wrong-key' }, { authorization: 'Basic abc' }]) {
      const res = await bridge.call('/v1/chat/completions', { method: 'POST', headers, body: chat({ stream: true }) })
      assert.equal(res.status, 401, `expected 401 for ${JSON.stringify(headers)}`)
      assert.equal(JSON.parse(res.body).error.code, 'invalid_api_key')
      // Never an SSE stream: a rejected request must not look like it started.
      assert.match(res.headers['content-type'] ?? '', /^application\/json/)
    }
  } finally {
    await bridge.close()
  }
})

test('an unknown /v1 route is a 404 in the OpenAI error shape', async () => {
  const bridge = await boot()
  try {
    const res = await bridge.call('/v1/embeddings', { method: 'POST', headers: authed, body: {} })
    assert.equal(res.status, 404)
    assert.equal(JSON.parse(res.body).error.code, 'not_found')
  } finally {
    await bridge.close()
  }
})

test('/health needs no token but discloses no credential', async () => {
  const bridge = await boot()
  try {
    const res = await bridge.call('/health')
    assert.equal(res.status, 200)
    const body = JSON.parse(res.body)
    assert.equal(body.ok, true)
    assert.equal(body.service, 'cmdgo-bridge')
    assert.ok(!('apiKey' in body), 'the health endpoint must not carry the client token')
    assert.ok(!res.body.includes(API_KEY), 'the health endpoint must not echo the client token')
    assert.ok(!res.body.includes('user_goodkey'), 'the health endpoint must not leak the upstream key')
  } finally {
    await bridge.close()
  }
})
