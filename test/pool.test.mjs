/**
 * Guards the account pool's scheduling and persistence.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AccountPool } from '../dist/pool.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'cmdgo-pool-'))
}

/**
 * `toggle`/`reportFailure`/`reportSuccess` persist fire-and-forget, so a rename
 * can still be in flight when a test tears its directory down.
 */
async function cleanup(dir) {
  // toggle/reportFailure/reportSuccess persist fire-and-forget, so writes can
  // still be landing — and recreating the directory — while a test tears down.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 60) throw error
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

/** In-memory CredentialsSeam. */
function memoryCredentials(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    async resolve(ref) {
      const value = store.get(ref)
      return value === undefined ? undefined : { value }
    },
    async describe(ref) {
      return { configured: store.has(ref) }
    },
    async set(ref, value) {
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

async function manifest(dir) {
  return JSON.parse(await readFile(join(dir, 'accounts.json'), 'utf8'))
}

test('a concurrent add cannot wipe a manifest it has not loaded yet', async () => {
  const dir = await tempDir()
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'accounts.json'), JSON.stringify({
    version: 1,
    accounts: [{ id: 'existing', ref: 'KEY_EXISTING', addedAt: 1, enabled: true, failCount: 0 }],
  }), 'utf8')

  const creds = memoryCredentials({ KEY_EXISTING: 'old-key' })
  const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })

  // Fire both without awaiting in between — exactly the shape the HTTP layer
  // produces when the console polls while an OAuth login lands.
  await Promise.all([
    pool.list(),
    pool.add(creds, { apiKey: 'new-key', userName: 'new' }),
  ])

  const onDisk = await manifest(dir)
  const ids = onDisk.accounts.map((a) => a.id).sort()
  assert.equal(ids.length, 2, `both accounts must survive, saw: ${ids.join(', ')}`)
  assert.ok(ids.includes('existing'), 'the pre-existing account must not be dropped')
  assert.equal((await creds.resolve('KEY_EXISTING')).value, 'old-key')

  await cleanup(dir)
})

test('ids that collapse to one credential ref stay separate accounts', async () => {
  const dir = await tempDir()
  const creds = memoryCredentials()
  const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })

  // `refFor` strips non-alphanumerics, so these two ids both slug to `KEY_AB`.
  const first = await pool.add(creds, { apiKey: 'key-a', userName: 'a-b' })
  const second = await pool.add(creds, { apiKey: 'key-b', userName: 'ab' })

  assert.notEqual(first.ref, second.ref, 'two accounts must never share a credential ref')
  assert.equal((await creds.resolve(first.ref)).value, 'key-a')
  assert.equal((await creds.resolve(second.ref)).value, 'key-b')

  await cleanup(dir)
})

test('a repeated key is recognised by value', async () => {
  const dir = await tempDir()
  const creds = memoryCredentials()
  const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })
  const account = await pool.add(creds, { apiKey: 'same-key', userName: 'someone' })

  assert.equal((await pool.findByKey(creds, 'same-key')).id, account.id)
  assert.equal(await pool.findByKey(creds, 'other-key'), undefined)

  await cleanup(dir)
})

test('pick skips disabled accounts and reports none when all are off', async () => {
  const dir = await tempDir()
  const creds = memoryCredentials()
  const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })
  const one = await pool.add(creds, { apiKey: 'k1', userName: 'one' })
  await pool.add(creds, { apiKey: 'k2', userName: 'two' })

  assert.equal(pool.size, 2)
  assert.equal(pool.activeCount(), 2)

  pool.toggle(one.id, false)
  assert.equal(pool.activeCount(), 1)
  assert.notEqual(pool.pick()?.id, one.id, 'a disabled account must not be picked')

  const [other] = [pool.pick()].filter(Boolean)
  pool.toggle(other.id, false)
  assert.equal(pool.pick(), undefined, 'no enabled account means nothing to pick')

  await cleanup(dir)
})

test('round-robin reaches every usable account', async () => {
  const dir = await tempDir()
  const creds = memoryCredentials()
  const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })
  const a = await pool.add(creds, { apiKey: 'k1', userName: 'one' })
  const b = await pool.add(creds, { apiKey: 'k2', userName: 'two' })

  const picked = new Set([pool.pick().id, pool.pick().id])
  assert.deepEqual([...picked].sort(), [a.id, b.id].sort())

  await cleanup(dir)
})

test('failures cool the account down and success clears the bookkeeping', async () => {
  const dir = await tempDir()
  const creds = memoryCredentials()
  const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })
  const account = await pool.add(creds, { apiKey: 'k1', userName: 'one' })

  const now = Date.now()
  pool.reportFailure(account, 'boom', now)
  assert.equal(account.failCount, 1)
  assert.ok(account.cooldownUntil > now, 'a failure must set a cool-down')
  assert.equal(pool.activeCount(now), 0, 'a cooling account is not active')
  assert.equal(pool.pick(now)?.id, account.id, 'all-cooling falls back to the least-cooled account')

  // The exponential back-off must stay capped rather than overflowing.
  // 30s * 2^39 already dwarfs the cap, so a short burst proves it.
  for (let i = 0; i < 40; i++) pool.reportFailure(account, 'boom', now)
  assert.ok(Number.isFinite(account.cooldownUntil), 'cool-down must stay finite')
  assert.ok(account.cooldownUntil <= now + 15 * 60_000, 'cool-down must stay capped')

  pool.reportSuccess(account)
  assert.equal(account.failCount, 0)
  assert.equal(account.cooldownUntil, undefined)
  assert.equal(account.lastError, undefined)

  await cleanup(dir)
})

test('remove and clear drop both the metadata and the stored key', async () => {
  const dir = await tempDir()
  const creds = memoryCredentials()
  const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })
  const a = await pool.add(creds, { apiKey: 'k1', userName: 'one' })
  const b = await pool.add(creds, { apiKey: 'k2', userName: 'two' })

  assert.equal(await pool.remove(creds, a.id), true)
  assert.equal(await creds.resolve(a.ref), undefined, 'the key must be deleted with the account')
  assert.equal(await pool.remove(creds, 'nope'), false)

  assert.equal(await pool.clear(creds), 1)
  assert.deepEqual((await manifest(dir)).accounts, [])
  assert.equal(await creds.resolve(b.ref), undefined)

  await cleanup(dir)
})
