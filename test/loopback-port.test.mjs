/**
 * Guards the fetchable-port rule the whole suite's fixtures now depend on.
 *
 * Background and the measurement that established it: see `helpers/loopback-port.mjs`. In
 * short, `fetch` refuses certain ports by policy ("bad port"), the machine's dynamic port
 * range can overlap that list, and a fixture that lands on one makes every request the
 * bridge sends it fail before a byte leaves the process — which the test then reports as a
 * bridge failure. It cost a ~3% random failure rate in `params.test.mjs` alone.
 *
 * Two things are asserted: the helper really returns reachable ports, and no fixture has
 * quietly gone back to letting the OS choose. The second is a source scan, because the bug
 * it prevents is invisible when it works — it only shows up as a rare, misleading failure
 * on a machine whose port range happens to overlap the blocked list.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { HIGHEST_BLOCKED_PORT, listenOnFetchablePort } from './helpers/loopback-port.mjs'

test('the helper binds ports above the blocked list, and they are reachable by fetch', async () => {
  // Property test rather than a single sample: the failure this prevents is a rare
  // collision, so one lucky port proves nothing.
  const seen = new Set()
  for (let i = 0; i < 30; i++) {
    const server = createServer((_req, res) => res.end('ok'))
    const port = await listenOnFetchablePort(server)
    try {
      assert.ok(port > HIGHEST_BLOCKED_PORT,
        `port ${port} is inside the range fetch refuses (<= ${HIGHEST_BLOCKED_PORT})`)
      // The number being high is necessary but not sufficient — prove it end to end.
      const response = await fetch(`http://127.0.0.1:${port}/`)
      assert.equal(response.status, 200, `port ${port} must be reachable by fetch`)
      await response.text()
      seen.add(port)
    } finally {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  }
  // Distinct ports are not required, but 30 identical ones would mean the helper is not
  // actually choosing; flag it rather than silently accepting a constant.
  assert.ok(seen.size > 1, `the helper must choose varying ports, saw only ${[...seen].join(',')}`)
})

test('the helper retries when a port is already taken instead of failing', async () => {
  // Collisions are the normal case when several test processes run at once, so a bind
  // failure must be absorbed. Demonstrated by occupying a port and asking for many binds:
  // some of them will land on it and the helper must still succeed.
  const occupants = []
  try {
    for (let i = 0; i < 8; i++) {
      const holder = createServer((_req, res) => res.end('held'))
      const port = await listenOnFetchablePort(holder)
      occupants.push({ holder, port })
    }
    for (let i = 0; i < 8; i++) {
      const server = createServer((_req, res) => res.end('ok'))
      const port = await listenOnFetchablePort(server)
      assert.ok(!occupants.some((entry) => entry.port === port),
        `the helper returned ${port}, which is already in use`)
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  } finally {
    for (const { holder } of occupants) {
      holder.closeAllConnections?.()
      await new Promise((resolve) => holder.close(resolve))
    }
  }
})

test('no fixture lets the OS choose a port for a server the bridge will fetch', async () => {
  // The regression guard. `listen` with port 0 is the shape that produced the flake; it is
  // also the shape a new fixture is most likely to copy, because it is the idiomatic way to
  // get a free port. Anything that binds must go through the helper.
  // Derived from this file's own location rather than `process.cwd()`, so the scan always
  // covers the same files no matter where the runner was started from.
  const dir = dirname(fileURLToPath(import.meta.url))
  const roots = [dir, join(dir, 'helpers')]
  const offenders = []
  for (const root of roots) {
    for (const name of await readdir(root)) {
      if (!name.endsWith('.mjs')) continue
      // The helper's own documentation mentions the pattern; it is not a binding site.
      if (name === 'loopback-port.mjs') continue
      const source = await readFile(join(root, name), 'utf8')
      if (/\.listen\(\s*0\s*,/.test(source)) offenders.push(name)
    }
  }
  assert.deepEqual(offenders, [],
    'these files bind an OS-chosen port; a fetch to such a port is refused when the OS '
    + 'happens to pick one on the blocked list. Use helpers/loopback-port.mjs')
})

test('the blocked-port policy this helper exists for is still in effect', async (t) => {
  // A characterisation check, deliberately non-fatal: it documents WHY the helper is
  // needed, and tells a future maintainer to re-read that reasoning if Node ever stops
  // refusing these ports. It must not fail the suite over an upstream policy change.
  const BLOCKED_SAMPLE = 6665
  const server = createServer((_req, res) => res.end('ok'))
  let bound = false
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(BLOCKED_SAMPLE, '127.0.0.1', () => { bound = true; resolve() })
    })
  } catch (error) {
    t.diagnostic(`could not bind ${BLOCKED_SAMPLE} (${error.code}); check skipped`)
    return
  }
  try {
    let cause
    try {
      const response = await fetch(`http://127.0.0.1:${BLOCKED_SAMPLE}/`)
      await response.text()
    } catch (error) {
      cause = error.cause?.message ?? error.message
    }
    if (cause === undefined) {
      t.diagnostic(`fetch no longer refuses port ${BLOCKED_SAMPLE}; the helper may be removable`)
      return
    }
    assert.match(cause, /bad port/i, `expected a policy refusal, got: ${cause}`)
  } finally {
    if (bound) {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    }
  }
})
