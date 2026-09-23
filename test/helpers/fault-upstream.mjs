/**
 * Local fault-injection upstream for the bridge tests.
 *
 * The stock `scripts/mock-gateway.mjs` always answers well, so it cannot
 * express the gateway behaviours the bridge must survive: a stream that dies
 * mid-answer, a stream that never sends `finish-step`, an empty body, and
 * pre-first-byte HTTP failures.
 *
 * Imported in-process by `test/faults.test.mjs` (no child process, no fixed
 * port): `startFaultUpstream('die-mid-stream')` resolves to a base URL the
 * bridge can be pointed at.
 *
 * Lives in `test/helpers/` rather than directly in `test/`: `node --test` treats
 * every file under `test/` as a test file, so a helper sitting there would be
 * executed as a test — and its standalone mode would then fight the test runner
 * over a fixed port.
 *
 * Run standalone with `node test/helpers/fault-upstream.mjs <port> <scenario>`
 * when debugging by hand.
 */
import { createServer } from 'node:http'

/** Upstream events the bridge expects on `POST /alpha/generate` (NDJSON). */
const SCENARIOS = {
  /**
   * Two text deltas, then the connection dies: no `finish-step`, no usage. This
   * is the shape that must NOT be reported downstream as a completed answer.
   *
   * The two stages are deliberate: the deltas are written and FLUSHED, and only
   * then does the socket die. Killing it in the write callback races the kernel —
   * the response is torn down before anything reaches the client, so the failure
   * arrives as a request-time `fetch failed` and the deltas are lost. Waiting for
   * the write to drain puts the answer on the wire first, which is the case worth
   * testing: a truncated answer that was already partly delivered.
   *
   * `res.destroy()` (not `end()`) is what makes this a failure rather than a
   * completion — a stream that simply stops is a legitimate end.
   */
  'die-mid-stream': (res, send) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    send({ type: 'text-start' })
    send({ type: 'text-delta', text: 'partial answer part one ' })
    send({ type: 'text-delta', text: 'part two' })
    // `write` alone only queues the bytes; wait for the flush, then kill it.
    res.write('', () => {
      setTimeout(() => {
        if (!res.destroyed) res.destroy()
      }, 30)
    })
  },
  /** Events arrive and the stream ends cleanly, but `finish-step` never comes. */
  'no-finish-step': (res, send) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    send({ type: 'text-start' })
    send({ type: 'text-delta', text: 'answer without finish step' })
    res.end()
  },
  /** 200 with no body at all. */
  'empty-body': (res) => {
    res.statusCode = 200
    res.end()
  },
  /** A well-formed stream carrying usage, for happy-path control cases. */
  healthy: (res, send) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    send({ type: 'text-start' })
    send({ type: 'text-delta', text: 'complete answer' })
    send({
      type: 'finish-step',
      finishReason: 'stop',
      usage: {
        inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 5 },
        outputTokens: 4,
        outputTokenDetails: { textTokens: 4, reasoningTokens: 0 },
      },
    })
    res.end()
  },
  /**
   * `finish-step` carrying a reason this bridge does not know. Must surface as
   * `finish_reason: null` (OpenAI's "not applicable"), never as `'stop'`: the
   * consumer decides whether a turn ended on this field, and a wrong `'stop'`
   * claims the model chose to finish when it may have been cut off.
   */
  'unknown-finish-reason': (res, send) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    send({ type: 'text-start' })
    send({ type: 'text-delta', text: 'answer with a novel stop reason' })
    send({
      type: 'finish-step',
      finishReason: 'content_filter_v2',
      usage: {
        inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0 },
        outputTokens: 2,
        outputTokenDetails: { textTokens: 2, reasoningTokens: 0 },
      },
    })
    res.end()
  },
  /** A finish-step with no reason field at all. */
  'missing-finish-reason': (res, send) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    send({ type: 'text-start' })
    send({ type: 'text-delta', text: 'answer without a stated reason' })
    send({ type: 'finish-step' })
    res.end()
  },
}

/**
 * Starts the upstream on an ephemeral port bound to loopback.
 * @param {keyof typeof SCENARIOS} scenario
 * @returns {Promise<{ baseURL: string, close: () => Promise<void>, requests: number }>}
 */
export async function startFaultUpstream(scenario = 'die-mid-stream') {
  const handler = SCENARIOS[scenario]
  if (handler === undefined) throw new Error(`unknown fault scenario: ${scenario}`)
  const state = { requests: 0 }
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request body */ }
    if (!(req.url ?? '').startsWith('/alpha/generate')) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    state.requests += 1
    handler(res, (obj) => res.write(`${JSON.stringify(obj)}\n`))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  // Retire idle keep-alive sockets the moment a response finishes.
  //
  // A stub lives for one test and is then closed. A socket the client's pool keeps
  // cached afterwards points at a server that no longer exists, and the NEXT test's
  // request can be handed that dead socket — surfacing as an intermittent
  // `fetch failed` inside the bridge, blamed on the bridge. The pool belongs to the
  // test process and cannot be cleared from here, so the sockets are retired
  // instead. `Connection: close` would do that too, but it also changes what a
  // mid-stream destroy looks like: the FIN turns the truncation into a clean EOF
  // and `die-mid-stream` stops being a failure at all. A 1 ms keep-alive timeout
  // leaves the teardown semantics alone.
  server.keepAliveTimeout = 1
  server.headersTimeout = 60_000
  server.requestTimeout = 60_000
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}`,
    get requests() { return state.requests },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

// Standalone mode: node test/fault-upstream.mjs <port> <scenario>
if (process.argv[1]?.endsWith('fault-upstream.mjs')) {
  const port = Number(process.argv[2] ?? 19001)
  const scenario = process.argv[3] ?? 'die-mid-stream'
  const handler = SCENARIOS[scenario]
  if (handler === undefined) {
    console.error(`unknown scenario ${scenario}; known: ${Object.keys(SCENARIOS).join(', ')}`)
    process.exit(1)
  }
  createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    handler(res, (obj) => res.write(`${JSON.stringify(obj)}\n`))
  }).listen(port, '127.0.0.1', () => {
    console.log(`[fault] ${scenario} on http://127.0.0.1:${port}/alpha/generate`)
  })
}
