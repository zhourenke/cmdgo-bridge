/**
 * Guards the OpenAI usage invariants on the wire.
 *
 * The Command Code gateway reports input as two disjoint halves
 * (`noCacheTokens` / `cacheReadTokens`). The OpenAI wire format instead defines
 * `prompt_tokens` as the TOTAL input and
 * `prompt_tokens_details.cached_tokens` as a subset of it, so the two halves
 * have to be summed at serialization.
 *
 * A regression here is silent rather than loud: any consumer that derives the
 * uncached remainder by subtraction (`prompt_tokens - cached_tokens`) clamps
 * the result to zero instead of failing, which is how a bridge-side mapping
 * error once surfaced as "uncached input: 0" three layers downstream. These
 * assertions are the only thing that catches it at the source.
 *
 * Run with `npm test` (builds first, then uses the built-in Node runner).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyEvent, emptyAccumulator, usageObject } from '../dist/openai.js'

/**
 * Fold one finish-step event into a fresh accumulator and serialize it.
 * @param inputTokenDetails - gateway `inputTokenDetails`, or undefined to omit it.
 * @param outputTokens - completion token count.
 * @param extraUsage - additional `usage` fields merged into the event.
 * @returns the OpenAI-shaped usage object.
 */
function usageFrom(inputTokenDetails, outputTokens = 0, extraUsage = {}) {
  const acc = emptyAccumulator()
  applyEvent(acc, {
    type: 'finish-step',
    finishReason: 'end_turn',
    usage: { outputTokens, ...(inputTokenDetails === undefined ? {} : { inputTokenDetails }), ...extraUsage },
  })
  return usageObject(acc)
}

test('cached_tokens stays within prompt_tokens when the cache dominates', () => {
  // The real-world warm-cache shape: nearly the whole prompt is a cache read
  // and the uncached half is small. This is the case that used to emit
  // prompt_tokens < cached_tokens and collapse to zero downstream.
  const usage = usageFrom({ noCacheTokens: 1_024, cacheReadTokens: 203_264 }, 278)

  assert.equal(usage.prompt_tokens, 204_288, 'prompt_tokens is the cache-inclusive total')
  assert.ok(
    usage.prompt_tokens_details.cached_tokens <= usage.prompt_tokens,
    'cached_tokens must be a subset of prompt_tokens',
  )
  assert.equal(
    usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens,
    1_024,
    'subtracting the cache leaves exactly the uncached half',
  )
  assert.equal(usage.total_tokens, 204_288 + 278)
})

test('prompt_tokens is the total input, not the uncached half', () => {
  // Mirrors scripts/mock-gateway.mjs: inputTokens 55 = noCache 40 + cacheRead 15.
  const usage = usageFrom({ noCacheTokens: 40, cacheReadTokens: 15 }, 12)

  assert.equal(usage.prompt_tokens, 55)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 15)
  assert.equal(usage.total_tokens, 67)
})

test('falls back to inputTokens minus cacheRead when noCacheTokens is absent', () => {
  const usage = usageFrom(undefined, 5, { inputTokens: 100, inputTokenDetails: { cacheReadTokens: 60 } })

  assert.equal(usage.prompt_tokens, 100, 'the total is preserved, not the remainder')
  assert.equal(usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens, 40)
})

test('a fully uncached prompt passes through unchanged', () => {
  const usage = usageFrom({ noCacheTokens: 100 }, 7)

  assert.equal(usage.prompt_tokens, 100)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 0)
  assert.equal(usage.total_tokens, 107)
})

test('an absent usage block degrades to zeros rather than NaN', () => {
  const usage = usageFrom(undefined, 0)

  assert.equal(usage.prompt_tokens, 0)
  assert.equal(usage.total_tokens, 0)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 0)
})

test('reasoning tokens are reported under completion_tokens_details', () => {
  const usage = usageFrom({ noCacheTokens: 10, cacheReadTokens: 5 }, 3, {
    outputTokenDetails: { textTokens: 1, reasoningTokens: 2 },
  })

  assert.equal(usage.completion_tokens_details.reasoning_tokens, 2)
})
