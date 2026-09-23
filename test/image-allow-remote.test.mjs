/**
 * The `allowRemote` / `CMDGO_IMAGE_ALLOW_REMOTE` switch (D-5).
 *
 * D-5 approved a way to turn remote image fetching off entirely, so an operator
 * running the bridge as someone else's upstream can stop it from making outbound
 * requests on a client's behalf. Two things have to hold, and both are asserted here:
 *
 *   1. the switch is real — configuration reaches the code that fetches, and
 *   2. when it is off, NO request is made. Not "the request is rejected after being
 *      sent", not "the response is discarded" — nothing leaves the process. That is
 *      the entire point of the switch, so it is checked by counting connections on a
 *      listening socket rather than by inspecting an error message.
 *
 * `data:` URLs must keep working with the switch off: "only allow inline images" is
 * the documented behaviour, not "images stop working".
 *
 * Run with `npm test`.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigStore, defaultConfig } from '../dist/config.js'
import { DEFAULT_IMAGE_LIMITS, fetchImage, parseDataUrl } from '../dist/image.js'

/** A minimal valid PNG, so the magic-number sniff accepts it. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

/** A server that records every connection AND request, so "no egress" is observable. */
let connections
let requests
let server
let pngUrl

before(async () => {
  connections = 0
  requests = 0
  server = createServer((_req, res) => {
    requests += 1
    res.statusCode = 200
    res.setHeader('content-type', 'image/png')
    res.end(PNG)
  })
  server.on('connection', () => { connections += 1 })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  pngUrl = `http://127.0.0.1:${server.address().port}/pixel.png`
})

after(async () => {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
})

/** Limits that permit loopback, so the SSRF guard is not what refuses the fetch. */
const loopbackLimits = (over = {}) => ({ ...DEFAULT_IMAGE_LIMITS, allowPrivateNetwork: true, ...over })

/** An isolated data dir, so a config file can be written without touching the user's. */
async function withDataDir(run) {
  const dir = await mkdtemp(join(tmpdir(), 'cmdgo-allowremote-'))
  try {
    return await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  }
}

/**
 * Runs `run` with the given `CMDGO_IMAGE_ALLOW_REMOTE` value in the real environment.
 *
 * `ConfigStore.load()` reads `process.env` itself, so there is no injection point —
 * the env has to actually be mutated, and restored afterwards whether or not the body
 * throws (a leaked value would change the behaviour of every later test in the file).
 * An empty string means "unset": `applyImageEnv` treats a blank value as absent.
 */
async function withEnvRemote(value, run) {
  const previous = { ...process.env }
  try {
    if (value === '') delete process.env.CMDGO_IMAGE_ALLOW_REMOTE
    else process.env.CMDGO_IMAGE_ALLOW_REMOTE = value
    return await run()
  } finally {
    process.env = previous
  }
}

test('the default keeps the documented behaviour: remote fetching stays on', () => {
  // "Default preserves the current behaviour" is what D-5 required. A silent flip here
  // would break every existing deployment that relies on remote image URLs.
  assert.equal(DEFAULT_IMAGE_LIMITS.allowRemote, true)
  assert.equal(defaultConfig().images.allowRemote, true)
})

test('with allowRemote off, no connection is ever made and the error says why', async () => {
  const beforeConnections = connections
  const beforeRequests = requests
  await assert.rejects(
    () => fetchImage(pngUrl, loopbackLimits({ allowRemote: false })),
    (error) => {
      assert.match(error.message, /remote image URLs are disabled/i)
      // The message must be actionable: name the switch and the alternative.
      assert.match(error.message, /CMDGO_IMAGE_ALLOW_REMOTE=false/)
      assert.match(error.message, /data: URL/)
      return true
    },
  )
  // The real assertion: nothing reached the wire. A check placed after the fetch would
  // pass this test while still being a blind SSRF, which is the bug shape F-24 warns about.
  // Both counters are checked: a connection alone (no request) would still be egress, and
  // a request alone would be impossible without one.
  assert.equal(connections, beforeConnections, 'the bridge must not open a connection when remote fetching is off')
  assert.equal(requests, beforeRequests, 'the bridge must not send a request when remote fetching is off')
})

test('with allowRemote off, the refusal wins before DNS is ever consulted', async () => {
  // A hostname that cannot resolve. If the refusal happened after resolution, this would
  // surface as a DNS error instead; the switch must win, so it must be the switch message.
  await assert.rejects(
    () => fetchImage('http://definitely-not-a-real-host.invalid/x.png', loopbackLimits({ allowRemote: false })),
    /remote image URLs are disabled/i,
  )
})

test('with allowRemote on, the same URL is fetched normally', async () => {
  // The control: proves the refusal above is caused by the switch, not by the stub being
  // unreachable or the guard rejecting loopback.
  //
  // Counts REQUESTS, not connections: HTTP keep-alive means a successful fetch may reuse
  // a pooled socket and open no new connection, so a connection-count assertion here
  // would fail whenever the pool happened to be warm — which is exactly what it did
  // while this evidence was first being captured.
  const before = requests
  const image = await fetchImage(pngUrl, loopbackLimits())
  assert.equal(image.mediaType, 'image/png')
  assert.ok(image.dataBase64.length > 0)
  assert.ok(requests > before, 'the control fetch must actually reach the server')
})

test('inline data: URLs keep working when remote fetching is off', async () => {
  // "Only allow data:" is the documented behaviour, so this must NOT be refused.
  const inline = `data:image/png;base64,${PNG.toString('base64')}`
  const image = parseDataUrl(inline, loopbackLimits({ allowRemote: false }))
  assert.equal(image.mediaType, 'image/png')
  assert.equal(image.dataBase64, PNG.toString('base64'))
})

test('CMDGO_IMAGE_ALLOW_REMOTE=true disables remote fetching for every off-value spelling', async () => {
  for (const value of ['false', 'FALSE', 'False', '0', 'no', 'off', ' off ']) {
    await withEnvRemote(value, () => withDataDir(async (dir) => {
      const cfg = await new ConfigStore(dir).load()
      assert.equal(cfg.images.allowRemote, false,
        `CMDGO_IMAGE_ALLOW_REMOTE=${JSON.stringify(value)} must disable remote fetching`)
    }))
  }
})

test('explicit on-values keep remote fetching enabled', async () => {
  for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
    await withEnvRemote(value, () => withDataDir(async (dir) => {
      const cfg = await new ConfigStore(dir).load()
      assert.equal(cfg.images.allowRemote, true,
        `CMDGO_IMAGE_ALLOW_REMOTE=${JSON.stringify(value)} must keep remote fetching on`)
    }))
  }
})

test('an unrecognised env value leaves the configured setting alone, unlike the private-network switch', async () => {
  // The deliberate asymmetry documented in config.ts and README. `allowPrivateNetwork`
  // defaults to false, so "anything unrecognised means false" is fail-closed and
  // harmless. This switch defaults to true, so the same rule would let a typo silently
  // disable the switch the operator was trying to set. A typo must not flip it.
  for (const value of ['enabled', 'y', 'maybe', 'sure']) {
    await withEnvRemote(value, () => withDataDir(async (dir) => {
      await writeFile(join(dir, 'config.json'), JSON.stringify({ images: { allowRemote: false } }), 'utf8')
      const kept = await new ConfigStore(dir).load()
      assert.equal(kept.images.allowRemote, false,
        `CMDGO_IMAGE_ALLOW_REMOTE=${JSON.stringify(value)} must not override an explicit config.json setting`)
    }))
  }
})

test('config.json alone can turn remote fetching off, with no env var set', async () => {
  await withEnvRemote('', () => withDataDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ images: { allowRemote: false } }), 'utf8')
    const cfg = await new ConfigStore(dir).load()
    assert.equal(cfg.images.allowRemote, false)
  }))
})

test('an env value can re-enable remote fetching that config.json turned off', async () => {
  // The env override is documented as higher priority than config.json, in both directions.
  await withEnvRemote('true', () => withDataDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ images: { allowRemote: false } }), 'utf8')
    const cfg = await new ConfigStore(dir).load()
    assert.equal(cfg.images.allowRemote, true)
  }))
})

test('a non-boolean allowRemote in config.json is ignored rather than coerced', async () => {
  // Coercing the string "false" to true would silently leave remote fetching on for an
  // operator who wrote what they meant in the wrong type; the validated field simply
  // does not apply, exactly like the other image limits.
  await withEnvRemote('', () => withDataDir(async (dir) => {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ images: { allowRemote: 'false' } }), 'utf8')
    const cfg = await new ConfigStore(dir).load()
    assert.equal(cfg.images.allowRemote, true, 'only a real boolean is honoured')
  }))
})

test('the switch survives a config round-trip through save() and load()', async () => {
  // `save()` writes the whole ServerConfig, so a field missing from the defaults or from
  // the loader would be silently dropped on the next restart — the classic way a switch
  // appears to work and then reverts.
  await withEnvRemote('', () => withDataDir(async (dir) => {
    const store = new ConfigStore(dir)
    const cfg = await store.load()
    cfg.images.allowRemote = false
    await store.save(cfg)
    const reloaded = await new ConfigStore(dir).load()
    assert.equal(reloaded.images.allowRemote, false)
  }))
})
