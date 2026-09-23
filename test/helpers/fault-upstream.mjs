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
   * Two text deltas, then the socket dies: no `finish-step`, no usage. This is
   * the shape that must NOT be reported downstream as a completed answer.
   */
  'die-mid-stream': (res, send) => {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    send({ type: 'text-start' })
    send({ type: 'text-delta', text: 'partial answer part one ' })
    send({ type: 'text-delta', text: 'part two' })
    setTimeout(() => res.destroy(), 60)
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
