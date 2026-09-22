/**
 * Guards Go catalog parsing, in particular the context-window disclosure that
 * clients copy into their own model rows.
 *
 * The capacity matters beyond display: a client that cannot see it can neither
 * clamp `max_tokens` to the remaining context nor tell a reply the provider
 * truncated from one the model chose to end (Xiaomi MiMo, for one, truncates
 * oversized input and returns `length` with zero output).
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { fetchGoModels } from '../dist/models.js'

/** A fetch stub answering a listing request with `data`. */
function listing(data) {
  return async () => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const URL_UNDER_TEST = 'https://example.test/provider/v1/models'

test('a disclosed context_length is carried through', async () => {
  const models = await fetchGoModels(URL_UNDER_TEST, listing([
    { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo V2.6 Flash', context_length: 262_144 },
  ]))
  assert.equal(models.length, 1)
  assert.equal(models[0].contextWindow, 262_144)
})

test('context_window is accepted when context_length is absent', async () => {
  const models = await fetchGoModels(URL_UNDER_TEST, listing([
    { id: 'xiaomi/mimo-v2.6-flash', context_window: 131_072 },
  ]))
  assert.equal(models[0].contextWindow, 131_072)
})

test('context_length wins when both are present', async () => {
  const models = await fetchGoModels(URL_UNDER_TEST, listing([
    { id: 'xiaomi/mimo-v2.6-flash', context_length: 262_144, context_window: 8_192 },
  ]))
  assert.equal(models[0].contextWindow, 262_144)
})

test('an undisclosed capacity stays absent so the caller can fall back', async () => {
  const models = await fetchGoModels(URL_UNDER_TEST, listing([
    { id: 'xiaomi/mimo-v2.6-flash', name: 'MiMo V2.6 Flash' },
  ]))
  assert.equal(models.length, 1)
  assert.equal(models[0].contextWindow, undefined)
  assert.ok(!('contextWindow' in models[0]), 'the key must be absent, not zero or undefined')
})

test('a nonsense capacity counts as undisclosed', async () => {
  const entries = [
    { id: 'a/zero', context_length: 0 },
    { id: 'b/negative', context_length: -1 },
    { id: 'c/string', context_length: '262144' },
    { id: 'd/null', context_length: null },
    { id: 'e/nan', context_length: Number.NaN },
    { id: 'f/infinite', context_window: Number.POSITIVE_INFINITY },
  ]
  const models = await fetchGoModels(URL_UNDER_TEST, listing(entries))
  assert.deepEqual(models.map((m) => m.id), entries.map((e) => e.id))
  for (const model of models) {
    assert.equal(model.contextWindow, undefined, `${model.id} must stay undisclosed`)
  }
})

test('models outside the Go plan are still filtered out', async () => {
  const models = await fetchGoModels(URL_UNDER_TEST, listing([
    { id: 'xiaomi/mimo-v2.6-flash', context_length: 262_144 },
    { id: 'anthropic/claude-sonnet-5', context_length: 200_000 },
    { id: 'google/gemini-4-pro', context_length: 1_000_000 },
    { id: 'openai/gpt-5.6', context_length: 400_000 },
  ]))
  assert.deepEqual(models.map((m) => m.id), ['xiaomi/mimo-v2.6-flash'])
})

test('a listing with no usable entry is reported as empty, not guessed', async () => {
  const models = await fetchGoModels(URL_UNDER_TEST, listing([
    { id: '' },
    { name: 'no id' },
    'not an object',
    null,
  ]))
  assert.deepEqual(models, [])
})
