/**
 * Guards the credential store's atomicity.
 *
 * The store used to mutate its in-memory cache before writing, so a failed
 * write left memory and disk disagreeing: later reads reported a credential
 * that had never been persisted, and the pool would hand out a key that did not
 * exist.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileCredentials } from '../dist/credentials.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'cmdgo-cred-'))
}

test('a failed write leaves the in-memory cache untouched', async () => {
  const dir = await tempDir()
  const creds = new FileCredentials(dir)
  await creds.set('A', 'v1')
  assert.equal((await creds.resolve('A')).value, 'v1')

  // Break the destination: replacing the directory with a file makes every
  // subsequent mkdir/write fail.
  await rm(dir, { recursive: true, force: true })
  await writeFile(dir, 'blocker', 'utf8')

  await assert.rejects(creds.set('B', 'v2'), 'the write must surface the failure')

  assert.equal(await creds.resolve('B'), undefined, 'an unpersisted credential must not be readable')
  assert.equal((await creds.resolve('A')).value, 'v1', 'the previous entry must survive')

  await rm(dir, { force: true })
})

test('concurrent writes both reach disk', async () => {
  const dir = await tempDir()
  const creds = new FileCredentials(dir)
  await Promise.all([creds.set('X', '1'), creds.set('Y', '2')])

  // A fresh instance reads only what actually landed on disk.
  const reloaded = new FileCredentials(dir)
  assert.equal((await reloaded.resolve('X')).value, '1')
  assert.equal((await reloaded.resolve('Y')).value, '2')

  await rm(dir, { recursive: true, force: true })
})

test('unset removes the entry and preserves the rest', async () => {
  const dir = await tempDir()
  const creds = new FileCredentials(dir)
  await creds.set('A', 'v1')
  await creds.set('B', 'v2')
  await creds.unset('A')

  const reloaded = new FileCredentials(dir)
  assert.equal(await reloaded.resolve('A'), undefined)
  assert.equal((await reloaded.resolve('B')).value, 'v2')

  await rm(dir, { recursive: true, force: true })
})

test('empty values read as unconfigured and corrupt files start clean', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'credentials.json'), '{ not json', 'utf8')
  const creds = new FileCredentials(dir)
  assert.equal(await creds.resolve('MISSING'), undefined)
  assert.equal((await creds.describe('MISSING')).configured, false)

  await creds.set('A', 'v1')
  assert.equal((await creds.describe('A')).configured, true)

  await rm(dir, { recursive: true, force: true })
})
