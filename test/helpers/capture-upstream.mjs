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
    // Tell the client's keep-alive pool not to hold this connection.
    //
    // A stub lives for one test and is then closed. Any socket the pool keeps
    // cached afterwards points at a server that no longer exists, and the NEXT
    // test's request can be handed that dead socket — surfacing as an
    // intermittent `fetch failed` inside the bridge, blamed on the bridge. It
    // cannot be cleared from here: the pool belongs to the test process. So the
    // server says `Connection: close` and no socket is ever cached.
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    envelopes,
    headers,
    /** Params of the most recent request, or undefined when none arrived. */
    lastParams: () => envelopes.at(-1)?.params,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.()
      server.close(resolve)
    }),
  }
}
