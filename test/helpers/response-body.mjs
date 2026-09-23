/**
 * Collects a whole HTTP response body without ever resolving a truncated one.
 *
 * Every test fixture in this suite used to do this by hand:
 *
 *     res.on('data', (c) => chunks.push(c))
 *     res.on('end', finish)
 *     res.on('close', finish)          // <-- the bug
 *
 * The `close` fallback exists for a good reason: when the peer goes away
 * mid-response, `end` never fires, and without a fallback the test hangs until the
 * runner's timeout instead of failing an assertion. The problem is what it resolves
 * WITH. `end` and `close` can both be pending, and when `close` wins it resolves the
 * partial body — so a valid, complete response is silently reported as truncated.
 *
 * That is not hypothetical. It produced failures whose symptoms pointed at the code
 * under test rather than at the helper:
 *
 *   - `params`: a clean SSE stream lost its trailing `data: [DONE]`, failing
 *     `assert.ok(res.body.endsWith('data: [DONE]'))` in a test about finish reasons.
 *   - `chat`: "expected several chunks" — only one chunk had arrived when the
 *     assertions ran, in a test about per-frame envelope fields.
 *
 * `res.complete` is what separates the two cases: it is `true` when the HTTP message
 * has been received in full. So on `close`:
 *
 *   - `complete === true`  → the body is whole; defer to the pending `end` (and cover
 *                            the case where the stream was destroyed right at the end
 *                            so `end` never emitted) via `setImmediate`.
 *   - `complete === false` → genuinely cut off; resolve with what arrived so the
 *                            assertions can report the truncation.
 *
 * `res.on('error')` resolves too, so a reset surfacing on the response object cannot
 * become an unhandled error attributed to whichever test happens to be running.
 *
 * @param {import('node:http').IncomingMessage} res
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
export function readResponse(res) {
  return new Promise((resolve) => {
    const chunks = []
    let settled = false
    const settle = () => {
      if (settled) return
      settled = true
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      })
    }
    res.on('data', (chunk) => chunks.push(chunk))
    // Authoritative: by the time `end` fires the whole message has been read.
    res.on('end', settle)
    res.on('close', () => {
      if (res.complete) {
        // The body is whole, so `end` is about to fire; let it resolve, or resolve on
        // the next turn if the stream was torn down right at the end.
        setImmediate(settle)
        return
      }
      // Really truncated: hand back the partial body so the caller's assertions fail
      // with something meaningful instead of the test hanging.
      settle()
    })
    res.on('error', settle)
  })
}
