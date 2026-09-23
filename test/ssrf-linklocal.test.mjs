/**
 * Guards link-local refusal that survives `allowPrivateNetwork` (F-29).
 *
 * `allowPrivateNetwork` exists so an operator can point the bridge at an internal
 * image host. Its implementation returned from `assertPublicHost` before ANY check
 * ran, so switching it on also re-opened `169.254.169.254` — the cloud metadata
 * service that hands out instance credentials. On a cloud host that is the most
 * valuable SSRF target there is, and the README described the switch only as
 * "allow private image addresses", which nobody reads as "allow the metadata
 * endpoint".
 *
 * The fix is a narrow one on purpose: link-local (`169.254.0.0/16`, `fe80::/10`) is
 * refused unconditionally, while RFC1918 ranges remain reachable when the switch is
 * on. An image host on `10.x` or `192.168.x` is plausible; one on `169.254.x` is not
 * (the range is not routable off-link), so nobody who needs the switch is hurt.
 *
 * This is a BLIND SSRF guard: the bridge only surfaces image bytes, but the request
 * itself reaches the endpoint, which is enough to probe internal services or trigger
 * unauthenticated state-changing handlers.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchImage, isLinkLocalAddress, isPrivateAddress, rejectionForLiteral, rejectionForResolved } from '../dist/image.js'

const LIMITS = { maxBytes: 4 * 1024 * 1024, maxPerRequest: 8, maxCount: 4, fetchTimeoutMs: 250, maxRedirects: 0 }

/** Limits with the private-network switch either on or off. */
const limits = (allowPrivateNetwork) => ({ ...LIMITS, allowPrivateNetwork })

test('the link-local ranges are exactly 169.254.0.0/16 and fe80::/10', () => {
  for (const address of ['169.254.0.0', '169.254.0.1', '169.254.169.254', '169.254.255.255']) {
    assert.equal(isLinkLocalAddress(address), true, `${address} is link-local`)
  }
  for (const address of ['169.253.255.255', '169.255.0.0', '168.254.169.254', '10.0.0.1', '93.184.216.34', '127.0.0.1']) {
    assert.equal(isLinkLocalAddress(address), false, `${address} is not link-local`)
  }
  for (const address of ['fe80::1', 'fe80::', 'fe9f::1', 'febf::1', 'fe80::1%eth0']) {
    assert.equal(isLinkLocalAddress(address), true, `${address} is fe80::/10`)
  }
  for (const address of ['fec0::1', 'feff::1', 'fd00::1', '2606:4700::1111', '::1']) {
    assert.equal(isLinkLocalAddress(address), false, `${address} is not link-local`)
  }
})

test('IPv4-mapped IPv6 forms of the metadata address are recognised', () => {
  // `::ffff:169.254.169.254` is the metadata URL wearing an IPv6 costume, and a
  // first-hextet test alone cannot see it. Same for the hex-packed form.
  for (const address of ['::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:a9fe:0', '::a9fe:a9fe']) {
    assert.equal(isLinkLocalAddress(address), true, `${address} must be seen as link-local`)
  }
  assert.equal(isLinkLocalAddress('::ffff:93.184.216.34'), false, 'a public mapped address is not link-local')
})

test('the metadata address is refused with the switch OFF', async () => {
  await assert.rejects(
    () => fetchImage('http://169.254.169.254/latest/meta-data/iam/security-credentials/', limits(false)),
    /link-local address/,
  )
})

test('the metadata address is refused with the switch ON', async () => {
  // The regression this file exists for. Before the fix, `allowPrivateNetwork: true`
  // reached the network here.
  await assert.rejects(
    () => fetchImage('http://169.254.169.254/latest/meta-data/iam/security-credentials/', limits(true)),
    /link-local address/,
    'allowPrivateNetwork must not open the cloud metadata endpoint',
  )
})

test('every metadata alias in literal form stays blocked with the switch ON', async () => {
  const targets = [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials',
    'http://[fe80::1]/latest/meta-data/',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
  ]
  for (const url of targets) {
    await assert.rejects(
      () => fetchImage(url, limits(true)),
      /link-local address/,
      `${url} must be refused even with allowPrivateNetwork on`,
    )
  }
})

test('private-but-not-link-local hosts remain reachable with the switch ON', async () => {
  // The narrowness is the design. These must NOT be refused up front — they fail
  // later because nothing is listening, which proves the guard let them through.
  for (const url of ['http://10.1.2.3/x.png', 'http://192.168.1.50/x.png', 'http://172.16.0.9/x.png']) {
    const error = await fetchImage(url, limits(true)).then(
      () => undefined,
      (reason) => reason,
    )
    assert.ok(error !== undefined, `${url} should have failed to fetch (nothing is listening)`)
    assert.doesNotMatch(error.message, /link-local|private address/,
      `${url} must not be refused by the SSRF guard when the switch is on: ${error.message}`)
  }
})

test('with the switch OFF the same private hosts are refused without a network call', async () => {
  for (const url of ['http://10.1.2.3/x.png', 'http://192.168.1.50/x.png', 'http://172.16.0.9/x.png']) {
    await assert.rejects(() => fetchImage(url, limits(false)), /private address/,
      `${url} must be refused when the switch is off`)
  }
})

test('a hostname that RESOLVES to link-local is refused with the switch ON', () => {
  // `metadata.google.internal` is the documented GCP alias for the metadata
  // service. Whether it resolves, and to what, depends on the resolver — a
  // corporate DNS may map it into the RFC2544 range instead of to 169.254.169.254 —
  // so the POLICY is tested directly against the resolved addresses, and the real
  // lookup is checked separately below.
  const reason = rejectionForResolved('metadata.google.internal', ['169.254.169.254'], true)
  assert.match(reason ?? '', /link-local address/,
    'a DNS alias for the metadata service must not slip through with the switch on')
  // With the switch off it must also be refused (as link-local, which is the
  // narrower and more accurate reason).
  assert.match(rejectionForResolved('metadata.google.internal', ['169.254.169.254'], false) ?? '', /link-local address/)
  // A name resolving to a public address is fine either way.
  assert.equal(rejectionForResolved('images.example.com', ['93.184.216.34'], true), undefined)
  assert.equal(rejectionForResolved('images.example.com', ['93.184.216.34'], false), undefined)
})

test('a resolver answer containing ANY link-local address is refused', () => {
  // Round-robin / dual-stack answers mix families. One bad address is enough; a
  // check that only looked at the first would be bypassable by ordering.
  assert.match(
    rejectionForResolved('mixed.example.com', ['93.184.216.34', 'fe80::1'], true) ?? '',
    /link-local address/,
  )
  assert.match(
    rejectionForResolved('mixed.example.com', ['169.254.169.254', '93.184.216.34'], true) ?? '',
    /link-local address/,
  )
})

test('the switch off still refuses private resolver answers', () => {
  assert.match(rejectionForResolved('internal.example.com', ['10.0.0.5'], false) ?? '', /private address/)
  assert.match(rejectionForResolved('internal.example.com', ['fd00::1'], false) ?? '', /private address/)
  // With the switch on those same answers are allowed.
  assert.equal(rejectionForResolved('internal.example.com', ['10.0.0.5'], true), undefined)
  assert.equal(rejectionForResolved('internal.example.com', ['fd00::1'], true), undefined)
})

test('literal rejection distinguishes link-local from private', () => {
  assert.match(rejectionForLiteral('169.254.169.254', true) ?? '', /link-local/)
  assert.match(rejectionForLiteral('169.254.169.254', false) ?? '', /link-local/)
  assert.match(rejectionForLiteral('10.0.0.5', false) ?? '', /private address/)
  assert.equal(rejectionForLiteral('10.0.0.5', true), undefined)
  assert.equal(rejectionForLiteral('93.184.216.34', false), undefined)
})

test('the real metadata alias is refused when the environment resolves it', async (t) => {
  // The end-to-end form. Some resolvers answer with something other than
  // 169.254.169.254 (this development host returns an RFC2544 address), in which
  // case the name is simply not a metadata name here and there is nothing to
  // assert — that is reported rather than papered over.
  const { lookup } = await import('node:dns/promises')
  const answers = await lookup('metadata.google.internal', { all: true }).catch(() => [])
  const linkLocal = answers.filter((entry) => isLinkLocalAddress(entry.address))
  if (linkLocal.length === 0) {
    t.diagnostic(`metadata.google.internal resolves to ${JSON.stringify(answers.map((a) => a.address))} here, not a link-local address; nothing to assert`)
    return
  }
  await assert.rejects(
    () => fetchImage('http://metadata.google.internal/computeMetadata/v1/', limits(true)),
    /link-local address/,
  )
})
