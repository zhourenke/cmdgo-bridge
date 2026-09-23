/**
 * A fake Command Code gateway that keeps each request open until the test says
 * otherwise, plus a "flood" mode for backpressure tests.
 *
 * The existing fault upstream answers and finishes, so it cannot express
 * "N requests are simultaneously in flight" — which is exactly the state the
 * concurrency ceiling has to be tested against. Here every connection is held
 * until `release()`/`releaseAll()` is called, so a test can drive the bridge to
 * its limit deterministically.
 *
 * Lives in `test/helpers/` because `node --test` treats every file directly
 * under `test/` as a test file.
 */
import { createServer } from 'node:http'

/**
 * @param {{ mode?: 'hold' | 'flood', deltaBytes?: number, floodFrames?: number }} [options]
 * @returns {Promise<{
 *   baseURL: string,
 *   requests: number,
 *   pending: number,
 *   releaseAll: () => void,
 *   destroyAll: () => void,
 *   close: () => Promise<void>,
 * }>}
 */
export async function startHoldingUpstream({ mode = 'hold', deltaBytes = 512, floodFrames = 4000 } = {}) {
  const state = { requests: 0, aborted: 0 }
  /** id -> the response being held. */
  const held = new Map()
  let nextId = 0

  const send = (res, obj) => res.write(`${JSON.stringify(obj)}\n`)

  /** Ends a held request as a normal completion. */
  const release = (id) => {
    const res = held.get(id)
    if (res === undefined) return
    held.delete(id)
    if (res.writableEnded || res.destroyed) return
    send(res, {
      type: 'finish-step',
      finishReason: 'stop',
      usage: {
        inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0 },
        outputTokens: 1,
        outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
      },
    })
    res.end()
  }

  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    if (!(req.url ?? '').startsWith('/alpha/generate')) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    state.requests += 1
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/x-ndjson')
    // First delta immediately: the bridge flushes its SSE headers on request
    // start, and this makes the stream observably live without releasing.
    send(res, { type: 'text-start' })
    send(res, { type: 'text-delta', text: 'held answer ' })

    if (mode === 'flood') {
      // Emit far more than a client will read, to drive the bridge's write buffer
      // past its high-water mark.
      const payload = 'x'.repeat(deltaBytes)
      for (let i = 0; i < floodFrames; i++) {
        if (res.writableEnded || res.destroyed) break
        if (!res.write(`${JSON.stringify({ type: 'text-delta', text: payload })}\n`)) {
          await new Promise((resolve) => res.once('drain', resolve))
        }
      }
      return
    }

    const id = nextId++
    held.set(id, res)
    res.on('close', () => {
      if (held.delete(id)) state.aborted += 1
    })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}`,
    get requests() { return state.requests },
    get aborted() { return state.aborted },
    get pending() { return held.size },
    releaseAll: () => { for (const id of [...held.keys()]) release(id) },
    destroyAll: () => {
      for (const [, res] of held) res.destroy()
      held.clear()
    },
    close: () => new Promise((resolve, reject) => {
      for (const [, res] of held) res.destroy()
      held.clear()
      server.close((error) => (error === undefined || error === null ? resolve() : reject(error)))
      // Sockets held open by a paused client would delay close(); the responses
      // above are destroyed, so this settles promptly.
      server.closeAllConnections?.()
    }),
  }
}
