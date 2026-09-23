/**
 * Guards the on-disk state files against a UTF-8 BOM, and against silent
 * failure when they are genuinely unparseable.
 *
 * All three files are documented hand-edit targets (the rotation runbook says to
 * edit `config.json`; adding an account by hand means editing `accounts.json`),
 * and on Windows `notepad`, `>` and `Out-File` all prepend a BOM by default.
 * `JSON.parse` rejects it, and every reader treated that as "absent or corrupt":
 *
 *   - `config.json` was moved aside and recreated with a **fresh random client
 *     key**, so all downstream tools started failing 401 with nothing in the log
 *     explaining why.
 *   - `credentials.json` and `accounts.json` read as *empty* — indistinguishable
 *     from a fresh install — and the next mutation then persisted that emptiness
 *     over the operator's only copy of the account list.
 *
 * Also covers `POST /api/reload`, which makes a repaired file take effect
 * without a restart.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigStore, defaultConfig, readJsonObject, stripBom } from '../dist/config.js'
import { FileCredentials } from '../dist/credentials.js'
import { AccountPool, ManifestError } from '../dist/pool.js'
import { buildState, createBridgeServer } from '../dist/server.js'

const BOM = '\ufeff'
const realFetch = globalThis.fetch

const stubCatalog = (url, init) =>
  String(url).includes('commandcode.ai') || String(url).includes('jsdelivr')
    ? Promise.resolve(new Response(JSON.stringify({ data: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }))
    : realFetch(url, init)

const tempDir = () => mkdtemp(join(tmpdir(), 'cmdgo-bom-'))

/** Writes `text` with a leading UTF-8 BOM, as Notepad would. */
async function writeBom(path, text) {
  await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]))
}

/** The bytes a BOM actually is, so the test fails if `writeBom` is wrong. */
async function assertHasBom(path) {
  const head = (await readFile(path)).subarray(0, 3)
  assert.deepEqual([...head], [0xef, 0xbb, 0xbf], `${path} should start with a UTF-8 BOM`)
}

function callOn(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const body = method === 'POST' ? '{}' : undefined
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
        ...headers,
      },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/**
 * Every pool this file has booted, so teardown can drain pending writes.
 *
 * The pool persists asynchronously through temp-file renames. Deleting a data
 * directory while one is in flight fails with ENOTEMPTY (the temp file reappears
 * mid-delete) and leaves the directory behind for the next run, so the queue is
 * drained first. A registry rather than a single variable because each test boots
 * its own bridge and several run against the same directory.
 */
const bootedPools = []

/**
 * Removes a temp directory without racing a pending manifest write.
 * @param {string} dir
 */
async function removeDir(dir) {
  await Promise.all(bootedPools.map((pool) => pool.flush().catch(() => {})))
  await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
}

async function boot(dir, cfg = {}) {
  globalThis.fetch = stubCatalog
  const config = { ...defaultConfig(), host: '0.0.0.0', port: 0, ...cfg }
  const state = buildState(config, dir)
  bootedPools.push(state.pool)
  const server = createBridgeServer(state)
  await new Promise((resolve) => server.once('listening', resolve))
  return {
    port: server.address().port,
    state,
    close: async () => {
      globalThis.fetch = realFetch
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

/* ---------------- the shared helper ---------------- */

test('stripBom removes only a leading BOM', () => {
  assert.equal(stripBom(`${BOM}{} `), '{} ')
  assert.equal(stripBom('{}'), '{}')
  assert.equal(stripBom(`{ "a": "${BOM}" }`), `{ "a": "${BOM}" }`, 'a BOM inside a string is data, not a marker')
})

test('readJsonObject tolerates a BOM and distinguishes missing from broken', async () => {
  const dir = await tempDir()
  const good = join(dir, 'bom.json')
  await writeBom(good, '{"a":1}')
  await assertHasBom(good)
  assert.deepEqual(await readJsonObject(good), { a: 1 }, 'a BOM must not change the parsed value')
  assert.equal(await readJsonObject(join(dir, 'absent.json')), undefined, 'absent is not an error')
  const bad = join(dir, 'bad.json')
  await writeFile(bad, '{ not json', 'utf8')
  await assert.rejects(() => readJsonObject(bad), /JSON 解析失败/, 'broken content must be reported, not swallowed')
  const array = join(dir, 'array.json')
  await writeFile(array, '[1,2]', 'utf8')
  await assert.rejects(() => readJsonObject(array), /顶层不是 JSON 对象/)
  await removeDir(dir)
})

/* ---------------- config.json ---------------- */

test('a BOM-prefixed config.json keeps its client API key', async () => {
  const dir = await tempDir()
  const key = 'bom-preserved-client-key-0123456789'
  await writeBom(join(dir, 'config.json'), JSON.stringify({
    ...defaultConfig(), port: 43210, apiKey: key, baseURL: 'https://kept.example',
  }))

  const warnings = []
  const cfg = await new ConfigStore(dir, (m) => warnings.push(m)).load()

  assert.equal(cfg.apiKey, key, 'the client API key must survive a BOM — this is the whole bug')
  assert.equal(cfg.port, 43210)
  assert.equal(cfg.baseURL, 'https://kept.example')
  assert.deepEqual(warnings, [], 'a BOM is not a corruption and must not warn')
  const entries = await readdir(dir)
  assert.ok(!entries.some((name) => name.includes('.corrupt-')), `nothing should be moved aside: ${entries.join(', ')}`)
  await removeDir(dir)
})

test('a genuinely corrupt config is set aside and the key change is announced', async () => {
  const dir = await tempDir()
  const doomedKey = 'key-that-will-be-lost-0123456789'
  // Valid JSON fields, but the file as a whole cannot be parsed.
  await writeFile(join(dir, 'config.json'), `{ "apiKey": "${doomedKey}", `, 'utf8')

  const warnings = []
  const cfg = await new ConfigStore(dir, (m) => warnings.push(m)).load()

  const entries = await readdir(dir)
  assert.ok(entries.some((name) => name.includes('.corrupt-')), 'the unreadable original must be preserved')
  assert.notEqual(cfg.apiKey, doomedKey, 'with the file unreadable there is no key to preserve')
  assert.equal(cfg.apiKey.length, 48, 'a fresh 24-byte hex key, as on first run')
  const text = warnings.join('\n')
  assert.match(text, /config\.json 无法解析/)
  assert.match(text, /API key 已重新随机生成/, 'the operator must be told downstream clients will need the new key')
  await removeDir(dir)
})

/* ---------------- credentials.json ---------------- */

test('a BOM-prefixed credentials.json still resolves its keys', async () => {
  const dir = await tempDir()
  await writeBom(join(dir, 'credentials.json'), JSON.stringify({
    REF_A: { value: 'sk-aaa', source: 'file' },
    REF_B: { value: 'sk-bbb' },
  }))

  const warnings = []
  const creds = new FileCredentials(dir, (m) => warnings.push(m))
  assert.equal((await creds.resolve('REF_A')).value, 'sk-aaa')
  assert.equal((await creds.describe('REF_B')).configured, true)
  assert.equal(creds.diagnose().error, undefined, 'a BOM is not a corruption')
  assert.deepEqual(warnings, [])
  await removeDir(dir)
})

test('an unparseable credentials.json reports itself instead of looking empty', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'credentials.json'), '{ "REF_A": { "value"', 'utf8')

  const warnings = []
  const creds = new FileCredentials(dir, (m) => warnings.push(m))
  assert.equal(await creds.resolve('REF_A'), undefined)
  assert.match(creds.diagnose().error ?? '', /credentials\.json/, 'the failure must be attributable to the file')
  assert.match(warnings.join('\n'), /credentials\.json 无法解析/)
  assert.match(warnings.join('\n'), /\/api\/reload/, 'and must say how to recover without a restart')

  // The file must be left alone so the operator can repair it.
  const onDisk = await readFile(join(dir, 'credentials.json'), 'utf8')
  assert.match(onDisk, /REF_A/, 'the damaged file must not be deleted or rewritten')
  await removeDir(dir)
})

test('invalidate() makes a repaired credentials.json take effect', async () => {
  const dir = await tempDir()
  const path = join(dir, 'credentials.json')
  await writeFile(path, '{ broken', 'utf8')
  const creds = new FileCredentials(dir)
  assert.equal(await creds.resolve('REF_A'), undefined)
  assert.notEqual(creds.diagnose().error, undefined, 'the breakage is known')

  await writeBom(path, JSON.stringify({ REF_A: { value: 'sk-fixed' } }))
  creds.invalidate()

  assert.equal((await creds.resolve('REF_A')).value, 'sk-fixed', 'the repair must be picked up')
  assert.equal(creds.diagnose().error, undefined, 'and the warning must clear')
  await removeDir(dir)
})

/* ---------------- accounts.json ---------------- */

const account = (id) => ({ id, ref: `COMMANDCODE_API_KEY_${id.toUpperCase()}`, addedAt: 1, enabled: true, failCount: 0 })

test('a BOM-prefixed accounts.json keeps the account list', async () => {
  const dir = await tempDir()
  await writeBom(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [account('a'), account('b')] }))

  const pool = new AccountPool({ baseRef: 'COMMANDCODE_API_KEY', dataDir: dir })
  const accounts = await pool.list()
  assert.deepEqual(accounts.map(a => a.id), ['a', 'b'], 'a BOM must not empty the pool')
  assert.equal(pool.activeCount(), 2)
  await removeDir(dir)
})

test('a corrupt accounts.json fails loudly rather than starting empty', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [account('a')] }).slice(0, 20), 'utf8')

  const pool = new AccountPool({ baseRef: 'COMMANDCODE_API_KEY', dataDir: dir })
  await assert.rejects(() => pool.list(), (error) => {
    assert.ok(error instanceof ManifestError, `expected ManifestError, got ${error?.constructor?.name}`)
    assert.match(error.message, /accounts\.json 无法解析/)
    assert.match(error.message, /覆盖/, 'the message must explain why it refuses to continue')
    return true
  }, 'an empty pool and a corrupt one must not be conflated')
  await removeDir(dir)
})

test('reload() picks up a manifest that appeared after the first load', async () => {
  const dir = await tempDir()
  const pool = new AccountPool({ baseRef: 'COMMANDCODE_API_KEY', dataDir: dir })
  assert.deepEqual(await pool.list(), [], 'no manifest yet')

  await writeBom(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [account('late')] }))
  assert.deepEqual((await pool.reload()).map(a => a.id), ['late'], 'reload must see the new file')
  assert.equal(pool.activeCount(), 1)
  await removeDir(dir)
})

test('a rejected load is not cached, so a repair can be retried', async () => {
  const dir = await tempDir()
  const path = join(dir, 'accounts.json')
  await writeFile(path, '{ broken', 'utf8')
  const pool = new AccountPool({ baseRef: 'COMMANDCODE_API_KEY', dataDir: dir })
  await assert.rejects(() => pool.list())
  await writeFile(path, JSON.stringify({ version: 1, accounts: [account('fixed')] }), 'utf8')
  assert.deepEqual((await pool.list()).map(a => a.id), ['fixed'], 'the first failure must not poison later reads')
  await removeDir(dir)
})

/* ---------------- end to end ---------------- */

test('the whole bridge starts from BOM-prefixed state files', async () => {
  const dir = await tempDir()
  const key = 'bom-e2e-client-key-0123456789ab'
  await writeBom(join(dir, 'config.json'), JSON.stringify({ ...defaultConfig(), apiKey: key }))
  await writeBom(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [account('solo')] }))
  await writeBom(join(dir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_SOLO: { value: 'upstream-key-solo' },
  }))

  const bridge = await boot(dir, { apiKey: key })
  try {
    const models = await callOn(bridge.port, '/v1/models', { headers: { authorization: `Bearer ${key}` } })
    assert.equal(models.status, 200, 'the preserved client key must authenticate')

    const status = JSON.parse((await callOn(bridge.port, '/api/status')).body)
    assert.equal(status.activeAccounts, 1, 'the account must be loaded')
    assert.equal(status.storageWarning, undefined, `no warning expected, got: ${status.storageWarning}`)
    assert.equal(status.accounts[0].configured, true, 'the credential must resolve')
  } finally {
    await bridge.close()
    await removeDir(dir)
  }
})

test('/api/status names the broken file when credentials.json cannot be parsed', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [account('solo')] }), 'utf8')
  await writeFile(join(dir, 'credentials.json'), '{ broken', 'utf8')

  const bridge = await boot(dir)
  try {
    const status = JSON.parse((await callOn(bridge.port, '/api/status')).body)
    assert.match(status.storageWarning ?? '', /credentials\.json/, 'the console must be able to name the file')
    assert.match(status.storageWarning ?? '', /缺少凭据/, 'and must flag the affected account')
  } finally {
    await bridge.close()
    await removeDir(dir)
  }
})

test('POST /api/reload restores service after a hand repair, without a restart', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [account('solo')] }), 'utf8')
  await writeFile(join(dir, 'credentials.json'), '{ broken', 'utf8')

  const bridge = await boot(dir)
  try {
    const before = JSON.parse((await callOn(bridge.port, '/api/status')).body)
    assert.match(before.storageWarning ?? '', /credentials\.json/)

    // Operator repairs the file in place.
    await writeBom(join(dir, 'credentials.json'), JSON.stringify({
      COMMANDCODE_API_KEY_SOLO: { value: 'upstream-key-solo' },
    }))

    const reload = await callOn(bridge.port, '/api/reload', { method: 'POST' })
    assert.equal(reload.status, 200, reload.body)
    const payload = JSON.parse(reload.body)
    assert.equal(payload.ok, true)
    assert.equal(payload.accounts, 1)
    assert.deepEqual(payload.problems, [], 'the repair must be visible immediately')

    const after = JSON.parse((await callOn(bridge.port, '/api/status')).body)
    assert.equal(after.storageWarning, undefined, 'the warning must clear after reload')
    assert.equal(after.accounts[0].configured, true, 'the account is usable again')
  } finally {
    await bridge.close()
    await removeDir(dir)
  }
})

test('POST /api/reload reports a still-broken accounts.json instead of emptying the pool', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'accounts.json'), '{ broken', 'utf8')

  const bridge = await boot(dir)
  try {
    const res = await callOn(bridge.port, '/api/reload', { method: 'POST' })
    assert.equal(res.status, 500, 'a parse failure is not a successful reload')
    assert.match(JSON.parse(res.body).error, /accounts\.json/)
    const onDisk = await readFile(join(dir, 'accounts.json'), 'utf8')
    assert.equal(onDisk, '{ broken', 'the broken manifest must be left untouched')
  } finally {
    await bridge.close()
    await removeDir(dir)
  }
})

test('a reload discovers an account added by hand while running', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [account('first')] }), 'utf8')
  await writeFile(join(dir, 'credentials.json'), JSON.stringify({
    COMMANDCODE_API_KEY_FIRST: { value: 'k1' },
    COMMANDCODE_API_KEY_SECOND: { value: 'k2' },
  }), 'utf8')

  const bridge = await boot(dir)
  try {
    assert.equal(JSON.parse((await callOn(bridge.port, '/api/status')).body).activeAccounts, 1)

    await writeFile(join(dir, 'accounts.json'), JSON.stringify({
      version: 1, accounts: [account('first'), account('second')],
    }), 'utf8')
    const reload = JSON.parse((await callOn(bridge.port, '/api/reload', { method: 'POST' })).body)
    assert.equal(reload.accounts, 2)
    assert.equal(JSON.parse((await callOn(bridge.port, '/api/status')).body).activeAccounts, 2)
  } finally {
    await bridge.close()
    await removeDir(dir)
  }
})
