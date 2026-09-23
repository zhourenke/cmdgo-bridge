/**
 * Guards the README statements that audit section 5 found wrong or incomplete (F-35).
 *
 * Five rows were outright INCONSISTENT with the code and twelve were partial. Those
 * are operator-facing: two of the inconsistencies (the `host` description and the
 * `allowPrivateNetwork` description) led an operator to a wrong deployment decision,
 * and one (`reasoning_tokens` accounting) led to a wrong billing conclusion. A later
 * edit that quietly drops one of these statements would restore the exact problem the
 * audit found, and nothing else in the suite would notice — the code would still be
 * correct while the documentation told operators the opposite.
 *
 * These assertions are keyword-based on purpose. Pinpointing a Chinese sentence
 * verbatim would make the test fail on any wording improvement, which is the wrong
 * tradeoff: what must survive is that the subject is addressed. The endpoint claims
 * are verified for real against a live instance in
 * `cmdgo-fix/verify-readme-endpoints.mjs`; the shapes asserted here are the ones that
 * cannot be checked without booting a server.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8')

/**
 * Each row lists patterns that must ALL appear. Grouped by the audit's own sections
 * so a failure names the row that regressed.
 */
const REQUIRED = {
  '5.1 host: "仅接受同源请求" is false': [
    /非浏览器/,
    // Full-width comma in the README; match the words around it instead.
    /任何非浏览器客户端都不发送 `Origin`/,
    /头完全由请求方控制/,
  ],
  '5.1 host: --host/--port write back unconditionally': [
    /`--host` \/ `--port` 会\*\*写回/,
    /永久/,
  ],
  '5.4 allowPrivateNetwork does not merely allow private images': [
    /链路本地/,
    /169\.254/,
    /fe80/,
    /盲 SSRF/,
  ],
  '5.4 reasoning_tokens semantics': [
    /`reasoning_tokens`/,
    /completion_tokens/,
  ],
  '5.8 disclaimer vs deployment shape': [
    /非商业/,
    /SLA/,
    /计费/,
    /服务条款/,
  ],
  '5.2 BOM intolerance': [/BOM/],
  '5.2 accounts.json is not re-read while running': [/accounts\.json/, /reload/],
  '5.2 /v1/models created and owned_by': [/`created`/, /`owned_by`/],
  '5.3 reasoning_effort is normalized': [/reasoning_effort/, /转小写/],
  '5.3 max_tokens validation and context check': [/context_length_exceeded/],
  '5.3 single shared token, no per-consumer keys': [/per-consumer/, /一个\*\* `apiKey`/],
  '5.3 /v1/completions is not implemented': [/\/v1\/completions/, /404/],
  '5.5 failover covers only specific error classes': [/AUTH/, /RATE_LIMIT/, /TRANSPORT/, /4/],
  '5.6 catalog degradation semantics': [/降级/, /保留上一次/],
  '5.7 MISSING_CREDENTIAL': [/MISSING_CREDENTIAL/],
  '5.7 log rotation and aggregation': [/轮转/, /\/health/],
}

for (const [row, patterns] of Object.entries(REQUIRED)) {
  test(`README covers audit row: ${row}`, () => {
    const absent = patterns.filter((pattern) => !pattern.test(readme))
    assert.deepEqual(absent.map((p) => p.source), [],
      `README.md no longer addresses this audited inconsistency (F-35): ${row}`)
  })
}

test('the README does not repeat the two retracted audit claims', () => {
  // The audit's own §2 withdrew two findings after re-testing: a domain `Host` was
  // never bypassable, and a trailing dot plus uppercase was already refused. If the
  // README started claiming those protections were ADDED, it would be describing a
  // change that never happened.
  assert.doesNotMatch(readme, /尾点归一化/, 'no trailing-dot normalization was implemented')
  assert.doesNotMatch(readme, /仅接受同源请求/, 'the retracted same-origin claim must not come back')
})

test('the README documents the two independent tokens', () => {
  // The single most consequential thing an operator must understand: rotating the
  // upstream login does not rotate the downstream token, and vice versa.
  assert.match(readme, /两个独立的东西/)
  assert.match(readme, /轮换/)
})

test('the README records every accepted risk (gate 5 / D-5)', () => {
  // Not-fixed is a legitimate outcome, but an undocumented not-fixed is a trap: the
  // next reader assumes the protection exists. Each acceptance must be visible.
  assert.match(readme, /已知限制与接受的风险/)
  for (const finding of ['F-24', 'F-15', 'F-19', 'F-20', 'F-31', 'F-28', 'F-26', 'F-32']) {
    assert.ok(readme.includes(finding), `the accepted risk ${finding} is no longer recorded in README.md`)
  }
  // F-24 must state the actual mitigation honestly. An earlier draft of this check
  // asserted the OPPOSITE — that `CMDGO_IMAGE_ALLOW_REMOTE` appeared nowhere, because
  // at the time the README promised a switch that no code read, and documenting a
  // nonexistent setting sends an operator to a knob that silently does nothing.
  //
  // The switch now exists (D-5 approved it; `src/config.ts` parses it and
  // `src/image.ts` enforces it), so the assertion is inverted: the README must NAME
  // it, and the acceptance note must say the race itself is still unmitigated rather
  // than implying the switch removes it. The existence direction is covered by the
  // `CMDGO_*` cross-check below.
  assert.match(readme, /CMDGO_IMAGE_ALLOW_REMOTE/,
    'the switch now exists, so the accepted-risk note must name it as the available mitigation')
  assert.match(readme, /竞态本身未消除/,
    'turning remote fetching off must not be described as fixing the rebinding race itself')
})

test('every CMDGO_* env var the README names as configuration actually exists in src/', async () => {
  // The inverse direction: an operator following the README must not be sent to a
  // setting that is never read. `config.ts` is the only place these are parsed.
  //
  // The README also shows one-off inline env vars for running the test suite (e.g.
  // `CMDGO_TEST_NETWORK=1 node --test ...`). Those are read by the TEST files, not by
  // config.ts, so they are checked against the test directory instead.
  const configSource = await readFile(join(process.cwd(), 'src', 'config.ts'), 'utf8')
  const testSource = (await Promise.all(
    (await readdir(join(process.cwd(), 'test')))
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => readFile(join(process.cwd(), 'test', name), 'utf8')),
  )).join('\n')

  const named = [...new Set(readme.match(/CMDGO_[A-Z_]+/g) ?? [])]
  const unknown = named.filter((name) => !configSource.includes(name) && !testSource.includes(name))
  assert.deepEqual(unknown, [], `README names env vars that nothing reads: ${unknown.join(', ')}`)

  // The documented configuration surface is exactly what config.ts parses: nothing
  // missing, nothing invented.
  const implemented = [...new Set((configSource.match(/CMDGO_[A-Z_]+/g) ?? []))]
  const undocumented = implemented.filter((name) => !readme.includes(name))
  assert.deepEqual(undocumented, [], `src/config.ts reads env vars the README never mentions: ${undocumented.join(', ')}`)
})
