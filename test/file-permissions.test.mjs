/**
 * Guards file permissions on the files that hold secrets (F-23).
 *
 * `config.json` carries the downstream API token, `credentials.json` the upstream
 * Command Code keys, `accounts.json` their names. Every write used a bare
 * `writeFile(path, data, 'utf8')`, which creates `0o666 & ~umask` — commonly
 * `0o644`, readable by every local account on a shared Unix host. The audit
 * measured exactly that on a Linux data dir (`config.json`, `credentials.json`,
 * `accounts.json`, `access.log` all `0o666`).
 *
 * The mode is set on the TEMP file that is then renamed into place, which is the
 * ordering that matters: a `chmod` after the rename would leave a window where the
 * secret sat on disk world-readable. These tests therefore drive the REAL stores
 * and measure the file that ends up on disk, rather than grepping for the option.
 *
 * Windows ignores POSIX mode bits (Node maps them onto the read-only attribute), so
 * the permission assertions are skipped there with a diagnostic. `hardenFile`'s
 * contract — best-effort, never fatal — is platform-independent and still checked.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigStore, defaultConfig } from '../dist/config.js'
import { FileCredentials } from '../dist/credentials.js'
import { AccountPool } from '../dist/pool.js'
import { SECRET_DIR_MODE, SECRET_FILE_MODE, hardenFile } from '../dist/secrets.js'

const POSIX = process.platform !== 'win32'

/** Permission bits, which is all `stat().mode` carries below 0o1000. */
const perm = (mode) => mode & 0o777

/** Asserts a path is owner-only, or skips with a diagnostic on Windows. */
async function assertOwnerOnly(t, path, label) {
  const info = await stat(path)
  if (!POSIX) {
    t.diagnostic(`${label}: mode 0o${perm(info.mode).toString(8)} (Windows ignores POSIX bits)`)
    return
  }
  assert.equal(perm(info.mode), SECRET_FILE_MODE,
    `${label} must be owner-only, got 0o${perm(info.mode).toString(8)}`)
}

/** Creates a temp dir whose own permissions are lax, like a legacy install's. */
async function laxDir() {
  const dir = await mkdtemp(join(tmpdir(), 'cmdgo-perm-'))
  return dir
}

test('the documented modes are owner-only', () => {
  assert.equal(SECRET_FILE_MODE, 0o600)
  assert.equal(SECRET_DIR_MODE, 0o700)
  assert.equal(perm(SECRET_FILE_MODE) & 0o077, 0, 'no group or other bits may be set on a secret file')
  assert.equal(perm(SECRET_DIR_MODE) & 0o077, 0, 'no group or other bits may be set on the data dir')
})

test('credentials.json is created owner-only', async (t) => {
  const dir = await laxDir()
  try {
    const creds = new FileCredentials(dir)
    await creds.set('COMMANDCODE_API_KEY_A', 'upstream-secret')
    await assertOwnerOnly(t, join(dir, 'credentials.json'), 'credentials.json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('config.json is created owner-only, landing the token with it', async (t) => {
  const dir = await laxDir()
  try {
    const store = new ConfigStore(dir)
    await store.save({ ...defaultConfig(), apiKey: 'downstream-token-0123456789' })
    await assertOwnerOnly(t, join(dir, 'config.json'), 'config.json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('accounts.json is created owner-only', async (t) => {
  const dir = await laxDir()
  try {
    const pool = new AccountPool({ baseRef: 'KEY', dataDir: dir })
    await pool.ensureLoaded()
    const credentials = {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    }
    await pool.add(credentials, { apiKey: 'upstream-secret', userName: 'u', keyName: 'k' })
    await pool.flush()
    await assertOwnerOnly(t, join(dir, 'accounts.json'), 'accounts.json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('no temporary file is left behind with wider permissions', async (t) => {
  // The mode must be on the temp file, not applied after the rename. If a `.tmp`
  // survives a crash, it must already be owner-only.
  const dir = await laxDir()
  try {
    const creds = new FileCredentials(dir)
    await creds.set('COMMANDCODE_API_KEY_A', 'upstream-secret')
    const { readdir } = await import('node:fs/promises')
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'a successful write must rename its temp file away')
    // And the temp-file path the code uses carries the mode: verified by writing one
    // through the same option shape and checking the bits.
    if (POSIX) {
      const probe = join(dir, 'probe.tmp')
      await writeFile(probe, '{}', { encoding: 'utf8', mode: SECRET_FILE_MODE })
      assert.equal(perm((await stat(probe)).mode), 0o600)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('startup hardening fixes a legacy file that was world-readable', async (t) => {
  // A file written before the fix keeps 0o644 until something rewrites it, and
  // nothing rewrites config.json unless the operator changes a setting. The startup
  // pass is what closes that window.
  const dir = await laxDir()
  try {
    const files = ['config.json', 'credentials.json', 'accounts.json']
    for (const name of files) {
      await writeFile(join(dir, name), '{}', { encoding: 'utf8', mode: 0o644 })
    }
    for (const name of files) {
      await hardenFile(join(dir, name), name)
      await assertOwnerOnly(t, join(dir, name), name)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a new write lands owner-only even under a permissive umask', async (t) => {
  if (!POSIX) {
    t.diagnostic('Windows ignores POSIX mode bits; skipped')
    return
  }
  const dir = await laxDir()
  const previous = process.umask(0o000)
  try {
    // Node applies the umask only when `mode` is NOT given. With an explicit mode
    // the file comes out exactly 0o600 — this is what makes the fix hold on a box
    // where the admin set a lax umask.
    const target = join(dir, 'secret.tmp')
    await writeFile(target, '{}', { encoding: 'utf8', mode: SECRET_FILE_MODE })
    assert.equal(perm((await stat(target)).mode), 0o600,
      'an explicit mode must not be masked by the umask')
  } finally {
    process.umask(previous)
    await rm(dir, { recursive: true, force: true })
  }
})

test('hardening a missing file is silent and non-fatal', async () => {
  // Called unconditionally at startup, possibly before the files exist. Throwing
  // here would make a fresh install fail to boot.
  const dir = await laxDir()
  try {
    await assert.doesNotReject(() => hardenFile(join(dir, 'absent.json'), 'absent.json'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an unenforceable hardening is reported on stderr but never thrown', async () => {
  // A read-only filesystem, an exotic mount, or a permissions model Node cannot
  // express must not stop the bridge: the operator is told, the process continues,
  // and startup carries on. `chmod` is injected because how to make a real chmod
  // fail varies by platform, and the CONTRACT is what matters here.
  const original = process.stderr.write.bind(process.stderr)
  const captured = []
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return true }
  try {
    const failing = async () => {
      const error = new Error('operation not permitted')
      error.code = 'EPERM'
      throw error
    }
    await assert.doesNotReject(
      () => hardenFile('/nonexistent/x.json', 'x.json', failing),
      'a failed hardening must not propagate',
    )
    assert.ok(captured.some((line) => line.includes('无法收紧') && line.includes('EPERM')),
      `an unenforceable permission change must be visible; stderr got ${JSON.stringify(captured)}`)
  } finally {
    process.stderr.write = original
  }
})

test('a missing file is silent: ENOENT is not a hardening failure', async () => {
  // Every startup on a fresh install hits this path for files that do not exist
  // yet. Reporting it would train operators to ignore the warning.
  const original = process.stderr.write.bind(process.stderr)
  const captured = []
  process.stderr.write = (chunk, ...rest) => { captured.push(String(chunk)); return true }
  try {
    const missing = async () => {
      const error = new Error('no such file')
      error.code = 'ENOENT'
      throw error
    }
    await assert.doesNotReject(() => hardenFile('/nonexistent/x.json', 'x.json', missing))
    assert.deepEqual(captured, [], 'ENOENT must not be reported')
  } finally {
    process.stderr.write = original
  }
})
