/**
 * Capturing upstream: records the envelopes the bridge sends, then answers.
 *
 * The fault upstream models how the gateway FAILS; this one models what the
 * bridge SAYS. Several behaviours are only observable in the outgoing request
 * envelope — parameter normalization, the model id, the forged CLI fingerprint —
 * and asserting on them needs the body, not just the response.
 *
 * Lives in `test/helpers/` because `node --test` treats every file directly under
 * `test/` as a test file.
 */
import { createServer } from 'node:http'
import { listenOnFetchablePort } from './loopback-port.mjs'

/** A minimal well-formed stream so callers can also assert on the happy path. */
const HEALTHY_EVENTS = [
  { type: 'text-start' },
  { type: 'text-delta', text: 'ok' },
  {
    type: 'finish-step',
    finishReason: 'stop',
    usage: {
      inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0 },
      outputTokens: 1,
      outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    },
  },
]

/**
 * Starts the upstream on an ephemeral loopback port.
 * @param {{ status?: number, body?: string }} [options] override the response
 * @returns {Promise<{ baseURL: string, envelopes: object[], headers: object[], close: () => Promise<void> }>}
 */
export async function startCapturingUpstream(options = {}) {
  const envelopes = []
  const headers = []
  const server = createServer(async (req, res) => {
    // This stub's responses must never be left in the test process's fetch pool.
    //
    // undici does NOT retry a request whose reused socket fails with "other side
    // closed" — it cannot know whether the server acted on it — so a pooled socket
    // pointing at a closed stub surfaces as `fetch failed` / 502 TRANSPORT inside the
    // bridge. `Connection: close` is safe HERE and only here: this stub always sends a
    // complete, buffered response, so there is no mid-stream teardown whose meaning a
    // FIN could change. fault-upstream is the opposite case — there `res.destroy()` IS
    // the scenario, and a premature FIN turns a truncation into a clean EOF, so that
    // stub uses socket teardown in `close()` instead.
    res.setHeader('Connection', 'close')
    let raw = ''
    req.setEncoding('utf8')
    for await (const chunk of req) raw += chunk
    headers.push({ ...req.headers })
    try {
      envelopes.push(JSON.parse(raw))
    } catch {
      envelopes.push({ __unparsed: raw })
    }
    if (options.status !== undefined && options.status !== 200) {
      res.statusCode = options.status
      res.end(options.body ?? JSON.stringify({ error: { message: 'captured failure' } }))
      return
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    for (const event of HEALTHY_EVENTS) res.write(`${JSON.stringify(event)}\n`)
    res.end()
  })
  await listenOnFetchablePort(server)
  server.headersTimeout = 60_000
  server.requestTimeout = 60_000
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    envelopes,
    headers,
    /** Params of the most recent request, or undefined when none arrived. */
    lastParams: () => envelopes.at(-1)?.params,
    close: () => new Promise((resolve) => {
      // Destroy the idle sockets FIRST, and wait for the destroy to be observed.
      //
      // The bridge reaches this stub through Node's built-in `fetch`, whose connection
      // pool belongs to the test PROCESS. A socket left idle in that pool after the
      // stub is closed still looks reusable to the pool until the close event is
      // processed, and the NEXT test can be handed it — surfacing inside the bridge as
      // `fetch failed` / `ECONNRESET`, blamed on the bridge, in a different test each
      // time. `closeIdleConnections()` removes the socket while the close is still
      // causally tied to this teardown, so no stale entry survives into the next test.
      // It only touches IDLE sockets, so an in-flight exchange is unaffected.
      server.closeIdleConnections?.()
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}
