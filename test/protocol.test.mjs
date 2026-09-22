/**
 * Guards the upstream stream lifecycle.
 *
 * The HTTP layer stops reading as soon as it sees `finish-step` and returns the
 * generator. Releasing the reader without cancelling used to leave the upstream
 * response body unconsumed, stranding the HTTP connection on every streamed
 * request.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseEventStream, gatewayErrorMessage } from '../dist/protocol.js'

const encoder = new TextEncoder()

/**
 * A stream that records whether it was cancelled.
 *
 * `close` is off by default on purpose: a closed stream does not run its
 * `cancel()` hook, and the leak test needs the source to still be readable when
 * the consumer walks away.
 */
function openStream(text, { close = false } = {}) {
  const state = { cancelled: false }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      if (close) controller.close()
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { stream, state }
}

test('cancels the upstream when the consumer stops at finish-step', async () => {
  const { stream, state } = openStream('{"type":"text-delta"}\n{"type":"finish-step"}\n{"type":"trailing"}\n')

  const seen = []
  for await (const event of parseEventStream(stream)) {
    seen.push(event.type)
    if (event.type === 'finish-step') break
  }

  assert.deepEqual(seen, ['text-delta', 'finish-step'])
  assert.equal(state.cancelled, true, 'the reader must cancel the body, not merely release the lock')
})

test('drains a complete stream and yields the trailing line', async () => {
  // The final line has no newline terminator; it must still be parsed.
  const { stream } = openStream('{"type":"a"}\n{"type":"b"}', { close: true })
  const seen = []
  for await (const event of parseEventStream(stream)) seen.push(event.type)
  assert.deepEqual(seen, ['a', 'b'])
})

test('skips comment lines, blank lines and malformed JSON', async () => {
  const { stream } = openStream(': keep-alive\n\n{ not json }\n{"type":"ok","n":1}\n', { close: true })
  const seen = []
  for await (const event of parseEventStream(stream)) seen.push(event)
  assert.deepEqual(seen, [{ type: 'ok', n: 1 }])
})

test('reassembles an event split across chunk boundaries', async () => {
  const state = { cancelled: false }
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"sp'))
      controller.enqueue(encoder.encode('lit"}\n'))
      controller.close()
    },
    cancel() {
      state.cancelled = true
    },
  })
  const seen = []
  for await (const event of parseEventStream(stream)) seen.push(event.type)
  assert.deepEqual(seen, ['split'])
})

test('cancelling an already-closed stream is harmless', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"type":"only"}\n'))
      controller.close()
    },
  })
  const seen = []
  for await (const event of parseEventStream(stream)) seen.push(event.type)
  assert.deepEqual(seen, ['only'])
})

test('extracts a gateway error message and falls back on junk', () => {
  assert.equal(gatewayErrorMessage('{"error":{"message":"boom"}}'), 'boom')
  assert.equal(gatewayErrorMessage('{"error":{}}'), undefined)
  assert.equal(gatewayErrorMessage('<html>502</html>'), undefined)
})
