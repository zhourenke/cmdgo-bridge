/**
 * Guards base64 validation of `data:` URL image payloads (F-22).
 *
 * `Buffer.from(payload, 'base64')` does not throw on malformed input — Node drops
 * every character outside the base64 alphabet and decodes what is left. So the
 * `try/catch` that claimed to reject invalid base64 was dead code, and a caller
 * who pasted a truncated blob, a URL-encoded one, or plain garbage was told
 * "unrecognized image format (expected png/jpeg/gif/webp)". That sends them
 * hunting for a format problem that does not exist.
 *
 * The behaviour was never unsafe — garbage decodes to garbage bytes, which the
 * magic-number sniff then refuses — so these tests are about diagnosability, plus
 * one real correctness point: when the length is not a multiple of 4 the final
 * character carries bits that no byte can hold, and Node silently ignores them.
 * `...AAAB` and `...AAAA` decode to the same bytes, so a single corrupted
 * character is invisible unless it is checked here.
 *
 * The check must stay permissive where it should be: whitespace-wrapped payloads
 * are legal base64 and must keep working.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseDataUrl } from '../dist/image.js'

const LIMITS = { maxBytes: 4 * 1024 * 1024, maxPerRequest: 8, maxCount: 4 }

/** A 1x1 PNG, base64-encoded. */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const PNG_BYTES = Buffer.from(PNG_B64, 'base64')

/** Builds `data:image/png;base64,<payload>`. */
const dataUrl = (payload) => `data:image/png;base64,${payload}`

/**
 * True when the payload was refused AT THE BASE64 STAGE.
 *
 * The distinction is the whole finding: a malformed payload must be reported as
 * base64, while well-formed base64 that is not an image must still be reported as
 * a format problem. Asserting on the message is the only way to tell which stage
 * rejected a given input, and it keeps these tests from depending on the decoders
 * of whatever bytes happen to be under test.
 */
function refusedAsBase64(payload) {
  try {
    parseDataUrl(dataUrl(payload), LIMITS)
  } catch (error) {
    return /not valid base64/.test(error.message)
  }
  // Accepted outright: valid base64 that is also a valid image.
  return false
}

/** Asserts the payload is refused as invalid base64, naming the reason. */
function assertInvalidBase64(payload, note) {
  assert.ok(refusedAsBase64(payload),
    `${note}: ${JSON.stringify(payload)} must be refused as base64 (message: ${
      (() => { try { parseDataUrl(dataUrl(payload), LIMITS); return 'accepted' } catch (e) { return e.message } })()
    })`)
}

test('the fixture decodes to a real PNG', () => {
  // Guard the fixture itself: if this ever stops being a PNG the other tests
  // would fail for the wrong reason.
  assert.deepEqual([...PNG_BYTES.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

test('a valid payload is accepted and decoded to the same bytes', () => {
  const part = parseDataUrl(dataUrl(PNG_B64), LIMITS)
  assert.equal(part.mediaType, 'image/png')
  assert.deepEqual(Buffer.from(part.dataBase64, 'base64'), PNG_BYTES)
})

test('characters outside the base64 alphabet are refused as base64, not as a format', () => {
  // The message is the whole point: "unrecognized image format" is a lie here.
  for (const payload of ['!!!!not-base64-at-all!!!', 'AAAA%%%%', '@@@@', 'iVBORw0KGgoAAAANSUhEUgAA$AAA']) {
    assertInvalidBase64(payload, `payload ${JSON.stringify(payload)}`)
  }
})

test('a payload that is not a multiple of 4 with a dangling character is refused', () => {
  // Length % 4 === 1 can never encode whole bytes.
  assertInvalidBase64('iVBORw0KGgoAAAANSUhEUgAAA', 'five-character tail')
  assertInvalidBase64(PNG_B64.slice(0, PNG_B64.length - 3), 'truncated valid payload')
})

test('non-canonical trailing bits are refused when the input is unpadded', () => {
  // The rule only applies to unpadded input. When the length is a multiple of 4
  // every bit belongs to a byte, so 'AAAB' is ordinary (if useless) base64 and is
  // refused later by the image sniff — see the test below.
  //
  // Unpadded, length % 4 === 3 (two bytes): the final character's low TWO bits are
  // dropped. 'A' is index 0 (clean), 'B' is index 1 (1 % 4 !== 0, dirty).
  assertInvalidBase64('AAB', 'unpadded 2 bytes, dirty final character')
  // Unpadded, length % 4 === 2 (one byte): the low FOUR bits are dropped.
  // 'Q' is index 16 (16 % 16 === 0, clean), 'R' is index 17 (dirty).
  assertInvalidBase64('AR', 'unpadded 1 byte, dirty final character')
})

test('mod-4-aligned base64 with arbitrary bits is valid base64', () => {
  // Length 4 carries three whole bytes: there are no dropped bits to police, so
  // these must NOT be reported as a base64 problem even though they are not an
  // image. Conflating the two complaints is the bug this file guards.
  for (const payload of ['AAAB', 'AAAE', 'AAAA']) {
    assert.equal(refusedAsBase64(payload), false,
      `${JSON.stringify(payload)} is well-formed base64 and must not be blamed on the encoding`)
    assert.throws(() => parseDataUrl(dataUrl(payload), LIMITS), /unrecognized image format|image is empty/)
  }
})

test('a bare PNG signature is a valid image, not a base64 failure', () => {
  // 'iVBORw0KGgo=' is the 8-byte PNG magic on its own. It is truncated as an
  // image, but the base64 layer must not be what complains — and the sniff accepts
  // it, because the bytes genuinely are a PNG header.
  const part = parseDataUrl(dataUrl('iVBORw0KGgo='), LIMITS)
  assert.equal(part.mediaType, 'image/png')
  assert.deepEqual([...Buffer.from(part.dataBase64, 'base64')],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

test('canonical unpadded payloads are not refused as base64', () => {
  // 'A' is index 0, so its dropped bits are all zero: this is canonical, merely
  // unpadded, and it must survive the base64 stage (it then fails the image sniff,
  // which is a different and correct complaint).
  assert.equal(refusedAsBase64('AA'), false, "'AA' is canonical unpadded base64")
  assert.equal(refusedAsBase64('AAA'), false, "'AAA' is canonical unpadded base64")
  assert.equal(refusedAsBase64(PNG_B64.replace(/=+$/, '')), false,
    'the unpadded form of a real PNG must pass the base64 stage')
})

test('whitespace-wrapped base64 is accepted', () => {
  // MIME wrapping puts a newline every 76 characters. Those are legal in base64
  // (though not in the alphabet), and callers do paste such blobs.
  const wrapped = `${PNG_B64.slice(0, 40)}\n${PNG_B64.slice(40, 80)}\r\n  ${PNG_B64.slice(80)}`
  const part = parseDataUrl(dataUrl(wrapped), LIMITS)
  assert.deepEqual(Buffer.from(part.dataBase64, 'base64'), PNG_BYTES,
    'stripping whitespace must not change the decoded bytes')
})

test('too much padding is refused as base64', () => {
  assertInvalidBase64('AAAA===', 'three padding characters')
  assertInvalidBase64('AA==AA', 'padding in the middle')
})

test('an empty payload is refused as base64, not as an empty image', () => {
  // Previously: "data: URL: image is empty", which reads like a valid-but-blank
  // image rather than a missing payload.
  assertInvalidBase64('', 'empty payload')
})

test('valid base64 that is not an image is still refused as a format', () => {
  // The two failures must stay distinguishable: this one really IS a format
  // problem, and its message must keep saying so.
  assert.throws(
    () => parseDataUrl(dataUrl(Buffer.from('not an image at all').toString('base64')), LIMITS),
    /unrecognized image format/,
  )
})
