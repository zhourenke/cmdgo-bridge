/**
 * Guards the metadata `GET /v1/models` discloses (F-25).
 *
 * Two fields were placeholders that look like data:
 *
 *   - `created` was literally `0` for every model. OpenAI defines it as a Unix
 *     timestamp, so a client that sorts or caches by it concludes every model was
 *     created in 1970. The upstream listing carries no creation time, so "when
 *     this bridge last saw the catalog" is the closest honest value.
 *   - `owned_by` was hardcoded to `'commandcode'`, collapsing deepseek / Qwen /
 *     MiniMaxAI into one bucket. A relay that routes or bills per provider has no
 *     way to tell them apart. The id's `<vendor>/<model>` prefix is the real
 *     answer; an id without a prefix falls back to `'commandcode'` because it
 *     genuinely carries no vendor.
 *
 * The third part of F-25 is documentation, not code: the catalog is not the
 * callable set, and a failed first refresh leaves `/v1/models` empty while
 * `/v1/chat/completions` keeps working. That has to be written down, because the
 * obvious inference from an empty list is "nothing is available".
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

const API_KEY = 'models-key-0123456789abcdef'
const realFetch = globalThis.fetch

/** A catalog with mixed vendor prefixes, plus one id that carries none. */
const CATALOG = [
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', context_length: 163_840 },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen3.7 Max', context_length: 262_144 },
  { id: 'MiniMaxAI/MiniMax-M3', name: 'MiniMax M3', context_length: 1_000_000 },
  { id: 'zai-org/GLM-5.3', name: 'GLM-5.3' },
  { id: 'gpt-5.6-luna', name: 'Luna', context_length: 400_000 },
]

/**
 * Boots a bridge whose catalog fetch either succeeds with `CATALOG` or fails.
 * @param {{ catalogFails?: boolean }} [options]
 */
async function boot(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'cmdgo-models-'))
  await writeFile(join(dataDir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [] }), 'utf8')
  globalThis.fetch = (url, init) => {
    const target = String(url)
    if (target.includes('api.commandcode.ai')) {
      if (options.catalogFails === true) return Promise.reject(new Error('catalog offline'))
      return Promise.resolve(new Response(JSON.stringify({ data: CATALOG }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
    }
    if (target.includes('cdn.jsdelivr.net')) {
      return Promise.resolve(new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }))
    }
    return realFetch(url, init)
  }
  const cfg = { ...defaultConfig(), host: '0.0.0.0', port: 0, apiKey: API_KEY }
  const state = buildState(cfg, dataDir)
  const server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  const port = server.address().port

  return {
    /** GETs a path with the bearer token. */
    get: (path) => new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${API_KEY}` },
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
      req.end()
    }),
    close: async () => {
      globalThis.fetch = realFetch
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
      await removeDataDir(dataDir, { pool: state.pool })
    },
  }
}

/** Waits for the async catalog sync to land, then returns the parsed list. */
async function modelsOf(bridge) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await bridge.get('/v1/models')
    assert.equal(res.status, 200, res.body.slice(0, 200))
    const parsed = JSON.parse(res.body)
    if (parsed.data.length > 0) return parsed
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the catalog never synced')
}

test('created is a real Unix timestamp, not zero', async () => {
  const bridge = await boot()
  try {
    const before = Math.floor(Date.now() / 1000)
    const list = await modelsOf(bridge)
    const after = Math.floor(Date.now() / 1000)
    for (const model of list.data) {
      assert.equal(typeof model.created, 'number')
      assert.notEqual(model.created, 0, 'created: 0 tells clients the model dates from 1970')
      // A sync that just happened must be within the window of this test.
      assert.ok(model.created >= before - 5 && model.created <= after + 5,
        `created=${model.created} is not a plausible sync time (test window ${before}..${after})`)
    }
    // Every model shares the catalog's sync time; it is a catalog property.
    const distinct = new Set(list.data.map((m) => m.created))
    assert.equal(distinct.size, 1, `all models share one sync time, got ${[...distinct].join(', ')}`)
  } finally {
    await bridge.close()
  }
})

test('owned_by reflects the vendor prefix in the model id', async () => {
  const bridge = await boot()
  try {
    const list = await modelsOf(bridge)
    const byId = new Map(list.data.map((m) => [m.id, m.owned_by]))
    assert.equal(byId.get('deepseek/deepseek-v4.1-flash'), 'deepseek')
    assert.equal(byId.get('Qwen/Qwen3.7-Max'), 'Qwen', 'the prefix is reported verbatim, case included')
    assert.equal(byId.get('MiniMaxAI/MiniMax-M3'), 'MiniMaxAI')
    assert.equal(byId.get('zai-org/GLM-5.3'), 'zai-org')
    // No prefix means no vendor information; do not invent one.
    assert.equal(byId.get('gpt-5.6-luna'), 'commandcode')
    assert.ok(!list.data.every((m) => m.owned_by === 'commandcode'),
      'providers must not all collapse into one bucket')
  } finally {
    await bridge.close()
  }
})

test('a failed first catalog sync leaves the list empty but does not crash', async () => {
  const bridge = await boot({ catalogFails: true })
  try {
    // Give the sync attempt time to fail.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const res = await bridge.get('/v1/models')
    assert.equal(res.status, 200, 'an empty catalog is still a valid response')
    const parsed = JSON.parse(res.body)
    assert.deepEqual(parsed.data, [], 'the documented degradation is an empty list')
    assert.equal(parsed.object, 'list')
  } finally {
    await bridge.close()
  }
})

test('the README documents the catalog degradation semantics', async () => {
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8')
  // The dangerous inference is "empty list means nothing is callable".
  assert.match(readme, /模型目录的降级语义/,
    'the degradation behaviour must have its own documented section')
  assert.match(readme, /保留上一次成功的结果/, 'a failed refresh keeps the previous catalog')
  assert.match(readme, /首次启动就拉取失败时列表为空/, 'a failed first refresh yields an empty list')
  assert.match(readme, /仍然可用/, 'an empty list does not mean chat is unavailable')
  // And the metadata semantics the fields now carry.
  assert.match(readme, /目录同步时刻/, 'created semantics must be documented')
  assert.match(readme, /前缀/, 'owned_by semantics must be documented')
})
