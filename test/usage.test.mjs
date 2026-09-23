/**
 * Guards the usage block's internal consistency.
 *
 * The gateway reports the visible answer (`textTokens`) and the hidden reasoning
 * (`reasoningTokens`) as separate counters under `outputTokenDetails`, plus
 * sometimes an `outputTokens` total that appears to omit part of the reasoning.
 * The bridge used to pass `outputTokens` straight through as
 * `completion_tokens` while copying `reasoningTokens` into
 * `completion_tokens_details` — producing blocks where the detail exceeded its
 * parent.
 *
 * That is invalid OpenAI wire data, and it is not cosmetic: tokenizers derive
 * the visible tokens by subtracting the reasoning count from `completion_tokens`
 * (the harness TokenUsage contract does exactly this), so the subtraction went
 * negative, got clamped to zero, and the entire completion reported as free.
 *
 * The invariant: `completion_tokens >= completion_tokens_details.reasoning_tokens`,
 * and `total_tokens == prompt_tokens + completion_tokens`.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { applyEvent, completionTokensOf, emptyAccumulator, usageObject } from '../dist/openai.js'

/** Folds one `finish-step` event carrying `usage` into a fresh accumulator. */
function usageFrom(usage) {
  const acc = emptyAccumulator()
  applyEvent(acc, { type: 'finish-step', finishReason: 'stop', usage })
  return usageObject(acc)
}

/** Every invariant the block must satisfy, asserted in one place. */
function assertConsistent(block, label) {
  assert.ok(block.completion_tokens >= 0, `${label}: completion_tokens cannot be negative`)
  assert.ok(
    block.completion_tokens >= block.completion_tokens_details.reasoning_tokens,
    `${label}: reasoning_tokens (${block.completion_tokens_details.reasoning_tokens}) must not exceed completion_tokens (${block.completion_tokens})`,
  )
  assert.equal(
    block.total_tokens,
    block.prompt_tokens + block.completion_tokens,
    `${label}: total_tokens must be the sum of its parts`,
  )
  assert.ok(
    block.prompt_tokens_details.cached_tokens <= block.prompt_tokens,
    `${label}: cached_tokens must be a subset of prompt_tokens`,
  )
}

test('reasoning_tokens above the reported output total are folded into completion_tokens', () => {
  // The bug's signature: upstream reports reasoning 900 but outputTokens 500,
  // i.e. the total omits most of the reasoning.
  const block = usageFrom({
    inputTokens: 100,
    outputTokens: 500,
    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0 },
    outputTokenDetails: { textTokens: 120, reasoningTokens: 900 },
  })
  assertConsistent(block, 'reasoning-heavy')
  assert.equal(block.completion_tokens, 1020, 'text + reasoning must win over the too-small reported total')
  assert.equal(block.completion_tokens_details.reasoning_tokens, 900, 'the reasoning count is preserved, not truncated')
  const visible = block.completion_tokens - block.completion_tokens_details.reasoning_tokens
  assert.equal(visible, 120, 'the derived visible count must equal the actual text tokens')
})

test('an output total larger than the parts is trusted as-is', () => {
  const block = usageFrom({
    inputTokens: 10,
    outputTokens: 1000,
    outputTokenDetails: { textTokens: 50, reasoningTokens: 60 },
  })
  assertConsistent(block, 'total-larger')
  assert.equal(block.completion_tokens, 1000, 'upstream may count tokens the detail fields do not break down')
})

test('a reasoning-only turn still reports a non-zero completion', () => {
  const block = usageFrom({
    inputTokens: 42,
    outputTokenDetails: { textTokens: 0, reasoningTokens: 777 },
  })
  assertConsistent(block, 'reasoning-only')
  assert.equal(block.completion_tokens, 777)
  assert.equal(block.completion_tokens_details.reasoning_tokens, 777)
  assert.equal(block.total_tokens, 42 + 777)
})

test('a text-only turn is unchanged', () => {
  const block = usageFrom({
    inputTokens: 20,
    outputTokens: 30,
    inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 15 },
    outputTokenDetails: { textTokens: 30 },
  })
  assertConsistent(block, 'text-only')
  assert.equal(block.completion_tokens, 30)
  assert.equal(block.completion_tokens_details.reasoning_tokens, 0)
  assert.equal(block.prompt_tokens, 20, 'cached and uncached halves are summed')
  assert.equal(block.prompt_tokens_details.cached_tokens, 15)
})

test('a usage block with no token details at all still satisfies the invariants', () => {
  const block = usageFrom({ inputTokens: 7 })
  assertConsistent(block, 'bare')
  assert.equal(block.completion_tokens, 0)
  assert.equal(block.total_tokens, 7)
})

test('an absent usage event leaves a consistent all-zero block', () => {
  const acc = emptyAccumulator()
  applyEvent(acc, { type: 'finish-step', finishReason: 'stop' })
  const block = usageObject(acc)
  assertConsistent(block, 'no-usage')
  assert.deepEqual(block, {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  })
})

test('completionTokensOf is the documented max, not a sum that can regress', () => {
  assert.equal(completionTokensOf({ reportedCompletionTokens: 5, textTokens: 1, reasoningTokens: 1 }), 5)
  assert.equal(completionTokensOf({ reportedCompletionTokens: 2, textTokens: 1, reasoningTokens: 9 }), 10)
  assert.equal(completionTokensOf({ textTokens: 0, reasoningTokens: 0 }), 0)
})

test('a nonsense negative counter cannot corrupt the block', () => {
  const block = usageFrom({
    inputTokens: 10,
    outputTokenDetails: { textTokens: -5, reasoningTokens: -5 },
  })
  assertConsistent(block, 'negative-input')
  assert.equal(block.completion_tokens, 0)
})
