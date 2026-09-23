/**
 * Guards the model-catalog URL pinning (F-21).
 *
 * The catalog of per-model reasoning efforts is fetched from the official CLI's
 * npm tarball via jsDelivr, and the URL was `command-code@latest`. The bridge also
 * forges `CC_VERSION` on every gateway call to look like the official CLI. Those
 * two facts together are a fingerprint mismatch: the request claims to be CLI
 * 1.31.0 while the effort metadata could come from any newer release, and the two
 * can disagree about which models exist and which accept `reasoning_effort`.
 *
 * The URL is now pinned to `CC_VERSION`. This file pins down both halves: that the
 * URL carries a concrete version, and that the version is the same one the bridge
 * advertises. It also fetches the pinned document for real (once) to prove the
 * pinned reference actually exists — a pin to a nonexistent version would silently
 * degrade every model to "effort unknown", which is exactly the failure a version
 * bump could introduce unnoticed.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CC_VERSION } from '../dist/protocol.js'

const SRC = join(process.cwd(), 'src', 'models.ts')

/** The pinned catalog URL, as written in the source. */
async function catalogUrlTemplate() {
  const src = await readFile(SRC, 'utf8')
  const match = /const CATALOG_URL = `([^`]+)`/.exec(src)
  assert.ok(match, 'CATALOG_URL must be a template literal so the version can be interpolated')
  return match[1]
}

test('CC_VERSION is a concrete release, not a range or tag', () => {
  assert.match(CC_VERSION, /^\d+\.\d+\.\d+$/,
    `the impersonated CLI version must be an exact release, got ${JSON.stringify(CC_VERSION)}`)
})

test('the catalog URL is pinned to a version instead of a moving tag', async () => {
  const template = await catalogUrlTemplate()
  assert.match(template, /command-code@\$\{CC_VERSION\}/,
    `the npm specifier must interpolate CC_VERSION, got ${template}`)
  assert.doesNotMatch(template, /@latest|@next|\*|@\^|@~/,
    'no moving tag or range may remain: the fetched metadata must describe one release')
})

test('the pinned version is the one the bridge impersonates', async () => {
  // The point of the pin. If these drift, the bridge advertises one CLI while
  // taking its model metadata from another. The URL interpolates `CC_VERSION` by
  // construction, so what this checks is that the interpolation target is the
  // constant the gateway fingerprint actually uses — and that no second, hardcoded
  // version has crept in beside it.
  const src = await readFile(SRC, 'utf8')
  const template = await catalogUrlTemplate()
  assert.match(template, /\$\{CC_VERSION\}/)
  assert.match(src, /import \{ CC_VERSION \} from '\.\/protocol\.js'/,
    'models.ts must interpolate the same constant that openai.ts sends upstream')
  // openai.ts is what forges the fingerprint; confirm it uses that constant too.
  const openai = await readFile(join(process.cwd(), 'src', 'openai.ts'), 'utf8')
  assert.match(openai, /'x-command-code-version': CC_VERSION/,
    'the impersonated version must be the same constant the catalog is pinned to')
})

test('the URL shape still points at the CLI knowledge document', async () => {
  const template = await catalogUrlTemplate()
  assert.match(template, /^https:\/\/cdn\.jsdelivr\.net\/npm\/command-code@/)
  assert.match(template, /dist\/bundled\/command-code-knowledge\/reference\/models\.md$/)
})

test('the pinned document exists and parses', async (t) => {
  // A pin that 404s is worse than `@latest`: jsDelivr would answer "not found",
  // the bridge would fall back to the default effort set for every model, and the
  // only symptom would be `reasoning_effort` quietly behaving differently.
  //
  // Opt-in via CMDGO_TEST_NETWORK=1 rather than always on: this suite runs offline
  // in CI, other files replace `globalThis.fetch` with a stub, and a network
  // dependency in the default path turns an unrelated outage into a red build.
  if (process.env.CMDGO_TEST_NETWORK !== '1') {
    t.diagnostic('set CMDGO_TEST_NETWORK=1 to verify the pinned catalog exists upstream')
    return
  }
  const url = `https://cdn.jsdelivr.net/npm/command-code@${CC_VERSION}/dist/bundled/command-code-knowledge/reference/models.md`
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  assert.equal(response.status, 200,
    `the pinned catalog ${url} must exist; HTTP ${response.status} means the pin is wrong`)
  const body = await response.text()
  assert.ok(body.includes('|'), 'the catalog must be a markdown table')
  // The parser reads column 5 as the effort list; a shape change would silently
  // yield an empty map. At least one row must produce efforts.
  const { parseCatalogEfforts } = await import('../dist/models.js')
  const parsed = parseCatalogEfforts(body)
  assert.ok(parsed.size > 0,
    `the pinned document parsed to zero models, so the row shape moved: ${body.slice(0, 300)}`)
})
