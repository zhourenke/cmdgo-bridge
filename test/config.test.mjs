/**
 * Guards config durability.
 *
 * `load()` used to swallow every error and return defaults, and the caller
 * saves immediately afterwards — so one unreadable byte silently replaced the
 * user's baseURL and client API key with fresh defaults. A corrupt file is now
 * moved aside instead.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigStore, defaultConfig } from '../dist/config.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'cmdgo-cfg-'))
}

test('a corrupt config is set aside, not overwritten', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'config.json'), '{ this is not json', 'utf8')

  const store = new ConfigStore(dir)
  const cfg = await store.load()

  // Falls back to defaults...
  assert.equal(cfg.baseURL, defaultConfig().baseURL)
  assert.equal(cfg.port, defaultConfig().port)

  // ...but keeps the unreadable original for forensics.
  const entries = await readdir(dir)
  assert.ok(
    entries.some((name) => name.includes('.corrupt-')),
    `the unreadable config must be preserved, saw: ${entries.join(', ')}`,
  )
  assert.ok(!entries.includes('config.json'), 'the bad file must be moved out of the way')

  await rm(dir, { recursive: true, force: true })
})

test('a valid config round-trips', async () => {
  const dir = await tempDir()
  const store = new ConfigStore(dir)
  const original = { ...defaultConfig(), port: 12345, baseURL: 'https://example.test', apiKey: 'abcdefgh' }
  await store.save(original)

  const loaded = await new ConfigStore(dir).load()
  assert.deepEqual(loaded, original)

  await rm(dir, { recursive: true, force: true })
})

test('out-of-range and wrongly typed fields fall back to defaults', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    port: 70000,
    maxTokens: -5,
    host: '',
    apiKey: 'short',
    baseURL: 42,
  }), 'utf8')

  const cfg = await new ConfigStore(dir).load()
  const defaults = defaultConfig()
  assert.equal(cfg.port, defaults.port)
  assert.equal(cfg.maxTokens, defaults.maxTokens)
  assert.equal(cfg.host, defaults.host)
  assert.equal(cfg.baseURL, defaults.baseURL)
  assert.notEqual(cfg.apiKey, 'short')
  assert.equal(cfg.apiKey.length, defaults.apiKey.length)

  await rm(dir, { recursive: true, force: true })
})

test('allowedHosts is normalised, and junk entries are dropped', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    allowedHosts: ['  Bridge.LAN ', 42, '', null, 'other.example'],
  }), 'utf8')

  const cfg = await new ConfigStore(dir).load()
  assert.deepEqual(cfg.allowedHosts, ['bridge.lan', 'other.example'])

  await rm(dir, { recursive: true, force: true })
})

test('allowedHosts defaults to empty', async () => {
  assert.deepEqual(defaultConfig().allowedHosts, [])

  const dir = await tempDir()
  await writeFile(join(dir, 'config.json'), JSON.stringify({ port: 1234 }), 'utf8')
  assert.deepEqual((await new ConfigStore(dir).load()).allowedHosts, [])

  await rm(dir, { recursive: true, force: true })
})

test('a missing config file is a normal first run', async () => {
  const dir = await tempDir()
  const cfg = await new ConfigStore(dir).load()
  assert.equal(cfg.apiKey.length, defaultConfig().apiKey.length)

  const entries = await readdir(dir)
  assert.deepEqual(entries, [], 'nothing is written until save() is called')

  await rm(dir, { recursive: true, force: true })
})

test('image limits default to the documented values', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'config.json'), JSON.stringify({ port: 1234 }), 'utf8')
  const cfg = await new ConfigStore(dir).load()
  assert.deepEqual(cfg.images, defaultConfig().images)
  await rm(dir, { recursive: true, force: true })
})

test('image limits load from config.json and env vars override them', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    images: { maxBytes: 2048, maxPerRequest: 3, maxRedirects: 0, allowPrivateNetwork: true },
  }), 'utf8')

  const fromFile = await new ConfigStore(dir).load()
  assert.equal(fromFile.images.maxBytes, 2048)
  assert.equal(fromFile.images.maxPerRequest, 3)
  assert.equal(fromFile.images.maxRedirects, 0)
  assert.equal(fromFile.images.allowPrivateNetwork, true)

  const previous = { ...process.env }
  try {
    process.env.CMDGO_IMAGE_MAX_MB = '2'
    process.env.CMDGO_IMAGE_MAX_PER_REQUEST = '7'
    process.env.CMDGO_IMAGE_ALLOW_PRIVATE_NETWORK = 'no'
    const overridden = await new ConfigStore(dir).load()
    assert.equal(overridden.images.maxBytes, 2 * 1024 * 1024)
    assert.equal(overridden.images.maxPerRequest, 7)
    assert.equal(overridden.images.allowPrivateNetwork, false)
  } finally {
    process.env = previous
  }

  await rm(dir, { recursive: true, force: true })
})

test('junk image limits fall back to defaults rather than to zero', async () => {
  const dir = await tempDir()
  await writeFile(join(dir, 'config.json'), JSON.stringify({
    images: { maxBytes: -1, maxPerRequest: 'lots', fetchTimeoutMs: 1.5, maxRedirects: -3, allowPrivateNetwork: 'yes' },
  }), 'utf8')

  const cfg = await new ConfigStore(dir).load()
  const defaults = defaultConfig().images
  assert.equal(cfg.images.maxBytes, defaults.maxBytes)
  assert.equal(cfg.images.maxPerRequest, defaults.maxPerRequest)
  assert.equal(cfg.images.fetchTimeoutMs, defaults.fetchTimeoutMs)
  assert.equal(cfg.images.maxRedirects, defaults.maxRedirects)
  assert.equal(cfg.images.allowPrivateNetwork, defaults.allowPrivateNetwork)

  await rm(dir, { recursive: true, force: true })
})

test('env overrides still apply on the first-run and corrupt-config paths', async () => {
  // Regression: these paths return early from the loader, so an override applied
  // only on the success path would be silently inert exactly when an operator is
  // recovering a service.
  const previous = { ...process.env }
  try {
    process.env.CMDGO_IMAGE_MAX_PER_REQUEST = '5'

    const empty = await tempDir()
    assert.equal((await new ConfigStore(empty).load()).images.maxPerRequest, 5, 'first run')
    await rm(empty, { recursive: true, force: true })

    const broken = await tempDir()
    await writeFile(join(broken, 'config.json'), '{ not json at all', 'utf8')
    assert.equal((await new ConfigStore(broken).load()).images.maxPerRequest, 5, 'corrupt config')
    await rm(broken, { recursive: true, force: true })
  } finally {
    process.env = previous
  }
})
