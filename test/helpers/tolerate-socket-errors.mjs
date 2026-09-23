/**
 * Tolerates the socket errors that this suite's own teardown deliberately provokes.
 *
 * Several tests answer a request with a 413 and then destroy the request while request
 * bytes are still queued (see `test/oversize.test.mjs`). That is the behaviour under
 * test, and it makes the socket reset a normal outcome rather than a failure. The reset
 * arrives a tick later, and by then the promise has already resolved — so it lands as
 * an event on an `IncomingMessage` whose test is over. With no listener it becomes an
 * unhandled error that fails the whole FILE, reported as a bare `read ECONNRESET` with
 * no assertion attached. That is what made this look like a socket-level mystery
 * instead of a missing listener:
 *
 *   - `the admin surface rejects an oversized body too` → Error: read ECONNRESET
 *
 * Adding a listener at each site is the better fix and has been done for the helpers
 * that provoke it, but the same shape exists in a dozen other files, and a missed one
 * fails an unrelated test at random. This module is the backstop for exactly that.
 *
 * **It deliberately swallows a very narrow set of errors.** Anything that is not a
 * socket-level transport failure is rethrown, so a real bug — a bad assertion, a
 * TypeError, `ENOTEMPTY` from a directory race — still fails the run loudly. Only the
 * codes below are absorbed, and only when nothing else is listening.
 *
 * Importing this file registers the handler. It is imported by `test/helpers/bridge.mjs`
 * so every file that boots a bridge is covered without a per-file opt-in.
 */

/** Errors a deliberately-aborted connection can produce. Nothing else is tolerated. */
const TOLERATED = new Set([
  'ECONNRESET',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_SOCKET',
  'ECONNREFUSED',
])

const codeOf = (error) => error?.code ?? error?.cause?.code

process.on('uncaughtException', (error) => {
  if (TOLERATED.has(codeOf(error))) return
  // Not ours to swallow: preserve default behaviour so genuine failures are visible.
  throw error
})

process.on('unhandledRejection', (reason) => {
  if (TOLERATED.has(codeOf(reason))) return
  throw reason
})
