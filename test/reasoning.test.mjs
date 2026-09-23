/**
 * Guards `reasoning_effort` normalization on the way upstream (F-17).
 *
 * "Do not reason" has to be expressed by OMITTING the field, because the gateway
 * treats it as optional. The bridge hardcoded one spelling of that (`'off'`) and
 * forwarded every other one verbatim — so `'OFF'`, `'none'` and `'disabled'`
 * reached the gateway as-is, and `'off'` was the only spelling that worked. An
 * upstream that rejects unknown effort values would then answer 400 to a request
 * that only ever meant "no reasoning please", which is an error the client cannot
 * diagnose: nothing in its request was wrong.
 *
 * The rule these tests pin down: casefold and trim, treat the spellings that
 * unambiguously mean off as absent, and pass everything else through in the
 * gateway's own lowercase vocabulary.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { removeDataDir } from './helpers/teardown.mjs'
import { defaultConfig } from '../dist/config.js'
import { buildState, createBridgeServer } from '../dist/server.js'
import { startCapturingUpstream } from './helpers/capture-upstream.mjs'

const API_KEY = 'reasoning-key-0123456789abcdef'
const MODEL = 'xiaomi/mimo-v2.6-flash'
const realFetch = globalThis.fetch

const stubCatalog = (url, init) =>
  String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
    ? Promise.resolve(new Response(JSON.stringify({ data: [{ id: MODEL, name: 'MiMo', context_length: 163_840 }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

/** Boots a bridge pointed at a capturing upstream. */
async function boot() {
  const upstream = await startCapturingUpstream()
  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-reasoning-'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{ id: 'solo', ref: 'COMMANDCODE_API_KEY_SOLO', addedAt: 1, enabled: true, failCount: 0 }],
  }), 'utf8')
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
    /** Sends one chat request and resolves with the status and body. */
    chat: (extra) => new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], ...extra })
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
      // resolve on close too, so a truncated body fails an assertion instead of
      // leaving the request pending until the runner's timeout
      res.on('close', finish)
      })
      req.on('error', reject)
      req.end(body)
    }),
    close: async () => {
      globalThis.fetch = realFetch
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await removeDataDir(dataDir, { pool: state.pool })
      await upstream.close()
    },
  }
}

/** Every spelling that means "no reasoning", which must not reach the gateway. */
const OFF_SPELLINGS = ['off', 'OFF', 'Off', 'oFf', 'none', 'NONE', 'disabled', 'DISABLED', ' off ', 'off\n']

for (const spelling of OFF_SPELLINGS) {
  test(`reasoning_effort ${JSON.stringify(spelling)} is omitted upstream`, async () => {
    const bridge = await boot()
    try {
      const res = await bridge.chat({ reasoning_effort: spelling })
      assert.equal(res.status, 200, res.body.slice(0, 200))
      const params = bridge.upstream.lastParams()
      assert.ok(params !== undefined, 'the request must reach the gateway')
      assert.ok(!('reasoning_effort' in params),
        `${JSON.stringify(spelling)} means "no reasoning" and must not be forwarded, got ${JSON.stringify(params.reasoning_effort)}`)
    } finally {
      await bridge.close()
    }
  })
}

test('reasoning_effort is lowercased and trimmed on the way upstream', async () => {
  const bridge = await boot()
  try {
    for (const [sent, expected] of [['HIGH', 'high'], [' Medium ', 'medium'], ['Low', 'low'], ['minimal', 'minimal']]) {
      const res = await bridge.chat({ reasoning_effort: sent })
      assert.equal(res.status, 200, res.body.slice(0, 200))
      const params = bridge.upstream.lastParams()
      assert.equal(params?.reasoning_effort, expected,
        `${JSON.stringify(sent)} must be normalized to ${JSON.stringify(expected)}`)
    }
  } finally {
    await bridge.close()
  }
})

test('an absent or empty reasoning_effort sends no field', async () => {
  const bridge = await boot()
  try {
    for (const value of [undefined, '', '   ', null]) {
      const res = await bridge.chat(value === undefined ? {} : { reasoning_effort: value })
      assert.equal(res.status, 200, res.body.slice(0, 200))
      const params = bridge.upstream.lastParams()
      assert.ok(!('reasoning_effort' in params),
        `${JSON.stringify(value)} must not produce a field, got ${JSON.stringify(params.reasoning_effort)}`)
    }
  } finally {
    await bridge.close()
  }
})

test('a non-string reasoning_effort is ignored rather than forwarded', async () => {
  // A number or object here is a client bug, but forwarding it would make the
  // gateway's 400 look like the bridge's fault.
  const bridge = await boot()
  try {
    for (const value of [1, true, { effort: 'high' }, ['high']]) {
      const res = await bridge.chat({ reasoning_effort: value })
      assert.equal(res.status, 200, res.body.slice(0, 200))
      const params = bridge.upstream.lastParams()
      assert.ok(!('reasoning_effort' in params),
        `${JSON.stringify(value)} must not be forwarded, got ${JSON.stringify(params.reasoning_effort)}`)
    }
  } finally {
    await bridge.close()
  }
})
