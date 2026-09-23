/**
 * Shared teardown for tests that boot a real bridge.
 *
 * Pool bookkeeping (`reportFailure` / `reportSuccess` / account toggles) persists
 * to `accounts.json` asynchronously, through a queue of temp-file renames. Two
 * things go wrong when a test removes its data directory without draining that
 * queue first:
 *
 *   1. `rm` races a pending rename and fails with `ENOTEMPTY`, because the temp
 *      file reappears between the directory scan and the delete;
 *   2. the write that lost the race leaves an open handle, and the test PROCESS
 *      then never exits — `node --test` reports every test as passing and hangs
 *      forever on an otherwise healthy file.
 *
 * (2) is the dangerous one: it looks like a passing run. `pool.flush()` is the
 * drain point; `maxRetries` covers the remaining narrow window between the flush
 * returning and the delete starting, and `force` keeps a leftover file from
 * failing an unrelated test.
 *
 * Not a test file itself — `node --test` treats every file under `test/` as a
 * test, so helpers live in `test/helpers/`.
 */

import { rm } from 'node:fs/promises'
// Registers a narrow socket-error tolerance. Imported here so every file that uses the
// shared teardown is covered without a per-file opt-in; see the module for why the
// suite provokes these errors on purpose and what is deliberately NOT tolerated.
import './tolerate-socket-errors.mjs'

/** Removes a temp data directory without racing the pool's pending writes. */
export async function removeDataDir(dataDir, { pool } = {}) {
  await pool?.flush?.().catch(() => {})
  await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }).catch(() => {})
}

/**
 * Closes a bridge test fixture completely: pending writes, then sockets, then
 * the directory. Order matters — closing the server first stops new bookkeeping
 * while the flush drains what is already queued.
 *
 * @param {object} options
 * @param {import('node:http').Server} options.server
 * @param {string} options.dataDir
 * @param {{flush?: () => Promise<void>}} [options.pool]
 * @param {{close: () => Promise<void>}} [options.upstream]
 */
export async function closeBridge({ server, dataDir, pool, upstream }) {
  await pool?.flush?.().catch(() => {})
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  await removeDataDir(dataDir)
  await upstream?.close?.()
}
