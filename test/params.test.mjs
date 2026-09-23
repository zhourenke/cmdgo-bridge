/**
 * Guards request-parameter validation and honest `finish_reason` reporting.
 *
 * F-07 (`max_tokens`): the field was read with a helper that fell back to the
 * default for any value it did not recognise, so `0`, `-1`, `"100"` and `1e9`
 * all produced a normal 200 whose length the caller never asked for. `-1` in
 * particular is a widespread "no limit" convention that this bridge does not
 * honour — silently substituting `DEFAULT_MAX_TOKENS` there is the worst case,
 * because the caller believes the answer was unlimited. OpenAI answers 400 with
 * `param` naming the field; so does the bridge now.
 *
 * F-13 (`finish_reason`): the streaming path mapped an unrecognised reason to
 * `'stop'`, and the non-streaming path required a `finish-step` or failed with
 * 502 `STREAM_CLOSED`. Neither is honest. A consumer keys its "is this answer
 * complete" decision off `finish_reason`, so an unknown or absent reason must be
 * `null` (OpenAI's "not applicable"), and a stream that ended cleanly must be
 * reported as the answer it is rather than discarded as a 502.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'
import { startFaultUpstream } from './helpers/fault-upstream.mjs'

const API_KEY = 'params-test-key-0123456789abcdef'
const realFetch = globalThis.fetch

const stubCatalog = (url, init) =>
  String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
    ? Promise.resolve(new Response(JSON.stringify({ data: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

const ACCOUNT = { id: 'solo', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 1, enabled: true, failCount: 0 }

/** Boots a bridge against `scenario` and returns a chat caller. */
async function boot(scenario) {
  const upstream = await startFaultUpstream(scenario)
  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-params-'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [ACCOUNT] }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'upstream-key-solo' },
  }), 'utf8')
  globalThis.fetch = stubCatalog
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY, baseURL: upstream.baseURL }
  const state = buildState(cfg, dataDir)
  const server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port
  return {
    upstream,
    chat: (payload) => post(port, '/v1/chat/completions', payload),
    close: async () => {
      globalThis.fetch = realFetch
      // Drain the manifest writes BEFORE removing the directory: pooled failures
      // persist asynchronously, so an `rm` racing a pending rename fails with
      // ENOTEMPTY (the temp file reappears mid-delete) and the leftover handle
      // then keeps the whole test process alive.
      await state.pool.flush().catch(() => {})
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await rm(dataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
      await upstream.close()
    },
  }
}

function post(port, path, payload) {
  const body = JSON.stringify(payload)
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: `Bearer ${API_KEY}`,
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

const chatBody = (extra) => ({
  model: 'deepseek/deepseek-v4.1-flash',
  stream: false,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

/* ---------------- F-07: max_tokens validation ---------------- */

// `1e9` is NOT in this list: it is a safe integer, so it is a legal (if unwise)
// limit and the bridge forwards it. Only values that cannot be a token count —
// wrong type, non-integral, zero or negative — are refused.
for (const bad of [0, -1, 1.5, '100', true, [], {}, '0']) {
  test(`max_tokens ${JSON.stringify(bad)} is refused with 400 instead of silently ignored`, async () => {
    const bridge = await boot('healthy')
    try {
      const res = await bridge.chat(chatBody({ max_tokens: bad }))
      assert.equal(res.status, 400, `expected 400 for max_tokens=${JSON.stringify(bad)}, got ${res.status}: ${res.body.slice(0, 200)}`)
      const payload = JSON.parse(res.body)
      assert.equal(payload.error.param, 'max_tokens', 'the error must name the offending field')
      assert.match(payload.error.message, /positive integer/)
      // A rejected request must not reach the gateway. Any upstream traffic here
      // would mean the bridge validated after starting the call.
      assert.equal(bridge.upstream.requests, 0, 'an invalid parameter must be rejected before the upstream call')
    } finally {
      await bridge.close()
    }
  })
}

test('a very large but valid max_tokens is forwarded rather than rejected', async () => {
  // The boundary the validation must NOT cross: `1e9` is a safe integer, so it
  // is a legal token count even though the model will never honour it. Rejecting
  // it would break callers that use a big sentinel to mean "as long as possible".
  const bridge = await boot('healthy')
  try {
    const res = await bridge.chat(chatBody({ max_tokens: 1e9 }))
    assert.equal(res.status, 200, res.body.slice(0, 200))
    assert.equal(bridge.upstream.requests, 1)
  } finally {
    await bridge.close()
  }
})

test('a null max_tokens means "unset", and a NaN arrives as null', async () => {
  // A null field is what many serializers emit for an absent optional value, so
  // it must be lenient. A NaN cannot be transmitted as NaN: `JSON.stringify`
  // renders a bare NaN as `null` and, inside an object, as a null property.
  assert.equal(JSON.stringify(NaN), 'null')
  assert.equal(JSON.stringify({ max_tokens: NaN }), '{"max_tokens":null}')
  const bridge = await boot('healthy')
  try {
    const res = await bridge.chat(chatBody({ max_tokens: null }))
    assert.equal(res.status, 200, res.body.slice(0, 200))
  } finally {
    await bridge.close()
  }
})

test('max_completion_tokens is validated under its own name', async () => {
  const bridge = await boot('healthy')
  try {
    const res = await bridge.chat(chatBody({ max_completion_tokens: -5 }))
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(res.body).error.param, 'max_completion_tokens')
  } finally {
    await bridge.close()
  }
})

test('a valid max_tokens still works, and max_tokens wins over max_completion_tokens', async () => {
  const bridge = await boot('healthy')
  try {
    const res = await bridge.chat(chatBody({ max_tokens: 7, max_completion_tokens: 9 }))
    assert.equal(res.status, 200, res.body.slice(0, 200))
    assert.equal(JSON.parse(res.body).choices[0].finish_reason, 'stop')
    assert.equal(bridge.upstream.requests, 1)
  } finally {
    await bridge.close()
  }
})

test('omitting both limits keeps the documented default', async () => {
  const bridge = await boot('healthy')
  try {
    const res = await bridge.chat(chatBody({}))
    assert.equal(res.status, 200, res.body.slice(0, 200))
  } finally {
    await bridge.close()
  }
})

/* ---------------- F-13: finish_reason honesty ---------------- */

test('an unrecognised finish reason becomes null, not "stop"', async () => {
  const bridge = await boot('unknown-finish-reason')
  try {
    const res = await bridge.chat(chatBody({}))
    assert.equal(res.status, 200, res.body.slice(0, 200))
    const payload = JSON.parse(res.body)
    assert.equal(payload.choices[0].finish_reason, null,
      'an unknown reason must not be reported as the model choosing to stop')
    assert.equal(payload.choices[0].message.content, 'answer with a novel stop reason',
      'the answer itself must still be delivered')
  } finally {
    await bridge.close()
  }
})

test('a finish-step with no reason becomes null', async () => {
  const bridge = await boot('missing-finish-reason')
  try {
    const res = await bridge.chat(chatBody({}))
    assert.equal(res.status, 200, res.body.slice(0, 200))
    assert.equal(JSON.parse(res.body).choices[0].finish_reason, null)
  } finally {
    await bridge.close()
  }
})

test('a clean end without finish-step is the answer, not a 502', async () => {
  const bridge = await boot('no-finish-step')
  try {
    const res = await bridge.chat(chatBody({}))
    assert.equal(res.status, 200, `a cleanly ended stream must not be discarded: ${res.body.slice(0, 200)}`)
    const payload = JSON.parse(res.body)
    assert.equal(payload.choices[0].message.content, 'answer without finish step')
    // The text is real, so usage must reflect it rather than reporting zeros.
    assert.ok(payload.usage.completion_tokens > 0, 'usage must be synthesized for a stream with no reported usage')
  } finally {
    await bridge.close()
  }
})

test('a truly truncated stream is still a failure, and streams no [DONE]', async () => {
  // The distinction the previous test must not erase: a reset socket is an
  // error, a clean end is not.
  const bridge = await boot('die-mid-stream')
  try {
    const res = await bridge.chat(chatBody({ stream: true }))
    assert.equal(res.status, 200, 'headers are already committed for a stream')
    assert.ok(!res.body.includes('[DONE]'), 'a truncated stream must not look complete')
    assert.match(res.body, /"error"/, 'the failure must be reported in-band')
    assert.ok(!res.body.includes('"usage"'), 'a failed stream must not report usage')
  } finally {
    await bridge.close()
  }
})

test('streaming reports an unknown finish reason as null too', async () => {
  const bridge = await boot('unknown-finish-reason')
  try {
    const res = await bridge.chat(chatBody({ stream: true }))
    assert.equal(res.status, 200)
    const frames = res.body.split('\n\n').filter((f) => f.startsWith('data: ') && f !== 'data: [DONE]')
    const choices = frames.map((f) => JSON.parse(f.slice(6)))
    assert.ok(res.body.endsWith('data: [DONE]\n\n'), 'a clean stream still terminates with [DONE]')
    // The terminal frame is the one choice whose delta is empty; in-progress
    // deltas carry content. Both report `finish_reason: null` here, so the empty
    // delta is what identifies the end. The usage frame is excluded because it
    // carries no choices at all.
    const terminal = choices.filter((c) => c.choices[0] !== undefined
      && Object.keys(c.choices[0].delta ?? {}).length === 0)
    assert.equal(terminal.length, 1, `expected one terminal frame, got ${terminal.length}`)
    assert.equal(terminal[0].choices[0].finish_reason, null,
      'the terminal frame must not invent "stop" for an unrecognised reason')
  } finally {
    await bridge.close()
  }
})
