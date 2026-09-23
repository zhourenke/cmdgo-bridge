/**
 * Keeps `npm test` runnable across the whole range `engines` claims to support.
 *
 * `package.json` declares `"node": ">=20.3.0"`, and that floor is real, not decorative:
 * `AbortSignal.any()` — used in `src/image.ts` and `src/openai.ts` — landed in Node 20.3.
 *
 * The test command, however, used to be:
 *
 *     node --test "test/*.test.mjs"
 *
 * Passing a glob to `--test` only works from **Node 21**; Node 20 does not expand it and
 * does not accept it as a path, so the command fails to find any tests. The suite was
 * therefore broken on part of the range the package claims to support — a confusing
 * failure for a contributor whose Node satisfies `engines`, in a command unrelated to
 * whether the bridge itself runs.
 *
 * Two ways out: raise the floor to 21+, or stop depending on glob support. The floor is
 * kept, because it is the honest requirement for RUNNING the bridge and raising it would
 * wrongly lock out Node 20.3-20.x users; the script now lists its files instead.
 *
 * That trade has one hazard — a new test file that nobody adds to the list would silently
 * never run — so the list is pinned here against the directory. A glob cannot silently
 * under-run; a hand-written list can, which is exactly why it needs this check.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchored on this file's own location, not `process.cwd()`: the checks below are about the
// package this test ships in, so running the file from another directory must not change
// what they inspect (or silently make them read a different package.json).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const script = String(pkg.scripts?.test ?? '')

/** The file arguments the script passes to `node --test`. */
function listedFiles() {
  const match = /node\s+--test\s+(.+)$/.exec(script)
  return match === null ? [] : match[1].trim().split(/\s+/).filter(Boolean).sort()
}

test('every test file on disk is listed in the npm test script', async () => {
  const actual = (await readdir(join(ROOT, 'test')))
    .filter((name) => name.endsWith('.test.mjs'))
    .map((name) => `test/${name}`)
    .sort()
  assert.ok(actual.length > 0, 'the test directory must contain test files')
  assert.deepEqual(listedFiles(), actual,
    'the npm test script and test/*.test.mjs disagree; a file listed but missing means a '
    + 'hard failure, and a file present but unlisted means it silently never runs')
})

test('the test script does not use a glob, because that needs Node 21+', () => {
  // The invariant that ties the two halves together: a glob is only acceptable if the
  // declared floor is high enough to support it.
  const floor = Number(/(\d+)/.exec(String(pkg.engines?.node ?? ''))?.[1])
  assert.ok(Number.isFinite(floor), 'engines.node must declare a minimum major version')

  const hasGlob = /[*?[\]]/.test(script)
  if (hasGlob) {
    assert.ok(floor >= 21,
      `the test script passes a glob to node --test, which only works from Node 21, but `
      + `engines.node allows Node ${floor}. Either raise engines or list the files explicitly.`)
  }
  // And the positive statement of what we rely on: everything after `--test` is a real
  // path, which every supported Node accepts.
  for (const file of listedFiles()) {
    assert.match(file, /^test\/[a-z0-9-]+\.test\.mjs$/, `unexpected argument in the test script: ${file}`)
  }
})

test('the declared engine floor matches what the source actually needs', async () => {
  // `AbortSignal.any` is the reason for the 20.3 floor; if the last use disappears the
  // floor could be lowered, and if a newer API is adopted the floor must rise. Pinning the
  // reason here means the number cannot drift away from the code without a test noticing.
  const usesAbortSignalAny = await Promise.all(
    ['image.ts', 'openai.ts'].map(async (name) => {
      const source = await readFile(join(ROOT, 'src', name), 'utf8')
      return source.includes('AbortSignal.any')
    }),
  )
  const floor = String(pkg.engines?.node ?? '')
  if (usesAbortSignalAny.some(Boolean)) {
    assert.match(floor, />=20\.3/, `AbortSignal.any needs Node 20.3+, but engines.node is ${floor}`)
  }
})
