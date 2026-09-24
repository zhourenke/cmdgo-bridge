/**
 * Guards refusal of parameters this bridge cannot honour (F-12).
 *
 * `n`, `stop`, `response_format`, `tool_choice` and `parallel_tool_calls` used to
 * be read out of the body and then dropped on the floor. The caller got a 200 and
 * a normal-looking answer, so it had no way to learn that its option never took
 * effect — until its own downstream parser failed on prose it expected to be
 * JSON, or an agent that asked for exactly one tool call got several.
 *
 * A 400 is the honest answer: the request cannot be satisfied as written. The
 * `error.param` names the field so the caller does not have to guess.
 *
 * The other half of the contract matters just as much: only an EXPLICIT request is
 * refused. Missing fields, and the values that already agree with what the bridge
 * does (`n: 1`, `tool_choice: 'auto'`, `parallel_tool_calls: true`,
 * `stream_options`), must keep working — otherwise every client that sends OpenAI's
 * own defaults would break.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeDataDir } from './helpers/teardown.mjs'
import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'
import { startCapturingUpstream } from './helpers/capture-upstream.mjs'

const API_KEY = 'unsupported-key-0123456789abcdef'
const MODEL = 'xiaomi/mimo-v2.6-flash'
const realFetch = globalThis.fetch

const stubCatalog = (url, init) =>
  String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
    ? Promise.resolve(new Response(JSON.stringify({ data: [{ id: MODEL, name: 'MiMo', context_length: 163_840 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

let upstream
let bridge
let port
let dataDir
let state

test.before(async () => {
  upstream = await startCapturingUpstream()
  dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-unsupported-'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{ id: 'solo', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 1, enabled: true, failCount: 0 }],
  }), 'utf8')
  await writeFile(join(dataDir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'upstream-key-solo' },
  }), 'utf8')
  globalThis.fetch = stubCatalog
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY, baseURL: upstream.baseURL }
  state = buildState(cfg, dataDir)
  bridge = createBridgeServer(state)
  await new Promise((resolve) => bridge.once('listening', resolve))
  port = bridge.address().port
})

test.after(async () => {
  globalThis.fetch = realFetch
  bridge.closeAllConnections?.()
  await new Promise((resolve) => bridge.close(resolve))
  await removeDataDir(dataDir, { pool: state.pool })
  await upstream.close()
})

/** One chat request; `extra` is merged over a minimal valid body. */
function chat(extra = {}, { stream = false } = {}) {
  const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream, ...extra })
  return new Promise((resolve, reject) => {
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
    req.end(body)
  })
}

/** Requests that must be refused, with the field the error has to name. */
const UNSUPPORTED = [
  ['n', { n: 3 }],
  ['n', { n: 0 }],
  ['n', { n: '2' }],
  ['stop', { stop: ['\n'] }],
  ['stop', { stop: 'END' }],
  ['response_format', { response_format: { type: 'json_object' } }],
  ['tool_choice', { tool_choice: 'required' }],
  ['tool_choice', { tool_choice: 'none' }],
  ['tool_choice', { tool_choice: { type: 'function', function: { name: 'f' } } }],
  ['parallel_tool_calls', { parallel_tool_calls: false }],
]

for (const [field, extra] of UNSUPPORTED) {
  test(`${field} = ${JSON.stringify(extra[field])} is refused with error.param "${field}"`, async () => {
    const res = await chat(extra)
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.body.slice(0, 200)}`)
    const parsed = JSON.parse(res.body)
    assert.equal(parsed.error.param, field, `error.param must name the offending field`)
    assert.equal(parsed.error.code, 'unsupported_parameter')
    assert.ok(typeof parsed.error.message === 'string' && parsed.error.message.includes(field),
      'the message must name the field too')
  })
}

test('a refused request never reaches the gateway', async () => {
  const before = upstream.envelopes.length
  const res = await chat({ n: 2 })
  assert.equal(res.status, 400)
  assert.equal(upstream.envelopes.length, before,
    'a request that cannot be honoured must not consume upstream quota')
})

/** Requests that must keep working, because they ask for what already happens. */
const ACCEPTED = [
  ['no such field at all', {}],
  ['n: 1 (the default)', { n: 1 }],
  ['tool_choice: auto (the default)', { tool_choice: 'auto' }],
  ['parallel_tool_calls: true (the default)', { parallel_tool_calls: true }],
  ['stream_options', { stream_options: { include_usage: true } }],
  ['sampling hints', { seed: 42, presence_penalty: 1, frequency_penalty: 0, logit_bias: {}, user: 'abc' }],
  ['logprobs', { logprobs: false, top_logprobs: 0 }],
  ['explicit nulls', { n: null, stop: null, response_format: null }],
]

for (const [label, extra] of ACCEPTED) {
  test(`${label} is accepted`, async () => {
    const res = await chat(extra, { stream: false })
    assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body.slice(0, 200)}`)
  })
}

test('the streamed path refuses unsupported parameters too', async () => {
  // SSE headers must NOT be committed before validation: a 200 followed by an
  // in-band error looks like a successful completion to many clients.
  const res = await chat({ n: 3 }, { stream: true })
  assert.equal(res.status, 400, `the refusal must be an HTTP status, got ${res.status}: ${res.body.slice(0, 200)}`)
  assert.ok(!res.body.includes('data:'), 'no SSE frames may be emitted for a refused request')
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.error.param, 'n')
})

test('the docs list the parameters that are refused', async () => {
  // The audit's point was not only the 400 but the discoverability: a caller that
  // never sends the field should still be able to read what is unsupported. The
  // parameter table is user-facing, but the rationale moved to DEVELOPMENT.md, so
  // both files are read as one text.
  const read = (name) => readFile(join(process.cwd(), name), 'utf8')
  const docs = `${await read('README.md')}\n${await read('DEVELOPMENT.md')}`
  for (const field of ['n', 'stop', 'response_format', 'tool_choice', 'parallel_tool_calls']) {
    assert.ok(docs.includes(field), `the docs must document the unsupported parameter ${field}`)
  }
  assert.match(docs, /不支持|unsupported/i)
})
