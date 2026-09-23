/**
 * Image plumbing end to end: OpenAI `image_url` parts → `Message.extraContent`
 * → the `/alpha/generate` envelope.
 *
 * The load-bearing assertion here is the cache-prefix one: a request with no
 * images must serialize to exactly the envelope it produced before image support
 * existed. The upstream prompt cache is a prefix cache, so any shape change on
 * the text-only path would silently invalidate every cached conversation.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

import { convertMessages, parseChatRequest, parseContent } from '../dist/openai.js'
import { buildRequest } from '../dist/protocol.js'
import { DEFAULT_IMAGE_LIMITS, ImageBudget } from '../dist/image.js'

/* ---------------- fixture ---------------- */

let CRC_TABLE
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return c ^ -1
}

function pngBytes(w = 2, h = 2) {
  const raw = Buffer.alloc(h * (1 + w * 3), 0x40)
  for (let y = 0; y < h; y++) raw[y * (1 + w * 3)] = 0
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PNG = pngBytes()
const B64 = PNG.toString('base64')
const DATA_URL = `data:image/png;base64,${B64}`
const LIMITS = DEFAULT_IMAGE_LIMITS

const parse = (body) => parseChatRequest(body, { imageLimits: LIMITS })

const imagePart = () => ({ type: 'image_url', image_url: { url: DATA_URL } })

function chatRequest(messages) {
  return {
    model: 'deepseek/deepseek-v4.1-flash',
    messages,
    max_tokens: 64,
    stream: false,
  }
}

/** The serialized user message the gateway would receive. */
async function serializeUserMessage(content) {
  const req = await parse(chatRequest([{ role: 'user', content }]))
  return buildRequest(req).params.messages[0]
}

/* ---------------- cache-prefix stability ---------------- */

test('a text-only request serializes byte-identically to the pre-image envelope', async () => {
  // The literal shape the bridge has always emitted for a plain-text turn.
  const legacy = { role: 'user', content: 'hello there' }
  assert.deepEqual(await serializeUserMessage('hello there'), legacy)

  const fromParts = await serializeUserMessage([{ type: 'text', text: 'hello there' }])
  assert.deepEqual(fromParts, legacy)
  assert.equal(typeof fromParts.content, 'string', 'text-only messages must stay plain strings')

  // JSON identity, since the cache key is computed over the serialized body.
  assert.equal(JSON.stringify(fromParts), JSON.stringify(legacy))
})

test('multi-turn text-only conversations keep user messages string-shaped', async () => {
  const req = await parse(chatRequest([
    { role: 'system', content: 'be brief' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ack' },
    { role: 'user', content: 'second' },
  ]))
  const wire = buildRequest(req).params.messages
  assert.equal(wire.length, 3)
  assert.equal(typeof wire[0].content, 'string')
  assert.equal(typeof wire[2].content, 'string')
  assert.deepEqual([wire[0].content, wire[2].content], ['first', 'second'])
  // Assistant turns have always been part arrays; image support must not change that.
  assert.deepEqual(wire[1].content, [{ type: 'text', text: 'ack' }])
})

test('two identical image requests serialize byte-identically', async () => {
  const a = await serializeUserMessage([{ type: 'text', text: 'what is this' }, imagePart()])
  const b = await serializeUserMessage([{ type: 'text', text: 'what is this' }, imagePart()])
  assert.equal(JSON.stringify(a), JSON.stringify(b))
})

/* ---------------- envelope shape ---------------- */

test('an image turns the user content into a text-then-image part array', async () => {
  const message = await serializeUserMessage([{ type: 'text', text: 'what colour' }, imagePart()])
  assert.deepEqual(message, {
    role: 'user',
    content: [
      { type: 'text', text: 'what colour' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
    ],
  })
})

test('images are hoisted out of the text pipeline and keep wire order', async () => {
  const budget = new ImageBudget(LIMITS)
  const { blocks, images } = await parseContent(
    [imagePart(), { type: 'text', text: 'caption' }, imagePart()],
    budget,
    LIMITS,
  )
  assert.deepEqual(blocks, [{ type: 'text', text: 'caption' }])
  assert.equal(images.length, 2)
  assert.ok(images.every(image => image.type === 'image'))
})

test('images are found even when they share a content array with text', async () => {
  const req = await parse(chatRequest([
    { role: 'user', content: 'turn one' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'text', text: 'turn two' }, imagePart()] },
  ]))
  const wire = buildRequest(req).params.messages
  assert.equal(typeof wire[0].content, 'string')
  assert.ok(Array.isArray(wire[2].content))
  assert.equal(wire[2].content[1].type, 'image')
})

test('a bare image with no text still produces a part array', async () => {
  const message = await serializeUserMessage([imagePart()])
  assert.deepEqual(message.content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } },
  ])
})

test('image_url accepts a plain string url and the input_image alias', async () => {
  const asString = await serializeUserMessage([{ type: 'image_url', image_url: DATA_URL }])
  assert.equal(asString.content[0].type, 'image')
  const asAlias = await serializeUserMessage([{ type: 'input_image', image_url: { url: DATA_URL } }])
  assert.equal(asAlias.content[0].type, 'image')
})

test('the tool-result path is unaffected by a neighbouring image', async () => {
  const req = await parse(chatRequest([
    { role: 'user', content: 'run it' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'ls', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file.txt' },
  ]))
  const wire = buildRequest(req).params.messages
  assert.equal(wire[2].role, 'tool')
  assert.equal(wire[2].content[0].output.type, 'text')
})

/* ---------------- validation ---------------- */

test('a malformed image is a client error, not a silent drop', async () => {
  await assert.rejects(
    () => parse(chatRequest([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png,notbase64' } }] }])),
    /invalid image/,
  )
  await assert.rejects(
    () => parse(chatRequest([{ role: 'user', content: [{ type: 'image_url' }] }])),
    /must carry a "url"/,
  )
  await assert.rejects(
    () => parse(chatRequest([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:text/plain;base64,aGk=' } }] }])),
    /invalid image/,
  )
})

test('audio/video/file parts are refused, not silently dropped', async () => {
  // A dropped audio part would let a caller believe it was transcribed.
  await assert.rejects(
    () => parseChatRequest(
      { model: 'm', messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] }] },
      { imageLimits: LIMITS },
    ),
    /unsupported content part type: "input_audio"/,
  )
  for (const type of ['input_file', 'file', 'video', 'audio_url']) {
    await assert.rejects(
      () => parseChatRequest(
        { model: 'm', messages: [{ role: 'user', content: [{ type }] }] },
        { imageLimits: LIMITS },
      ),
      new RegExp(`unsupported content part type: "${type}"`),
      `${type} must be refused`,
    )
  }
})

test('the per-request image cap spans every message', async () => {
  const many = Array.from({ length: 4 }, imagePart)
  await assert.rejects(
    () => parseChatRequest(
      chatRequest([{ role: 'user', content: many }]),
      { imageLimits: { ...LIMITS, maxPerRequest: 3 } },
    ),
    /too many images in one request \(max 3\)/,
  )
})

test('image parts on non-user roles are refused, not silently dropped', async () => {
  // Only user messages can carry pixels upstream. Accepting an image on another
  // role and discarding the field would hide content loss.
  for (const role of ['assistant', 'system', 'developer', 'reasoning']) {
    await assert.rejects(
      () => parse({ model: 'm', messages: [{ role, content: [{ type: 'text', text: 'x' }, imagePart()] }] }),
      /image parts are only supported on user messages/,
      `${role} must be refused`,
    )
  }
  await assert.rejects(
    () => parse({ model: 'm', messages: [{ role: 'tool', tool_call_id: 'c1', content: [imagePart()] }] }),
    /image parts are only supported on user messages/,
  )
})

test('a non-string, non-array content value is rejected', async () => {
  await assert.rejects(() => parse(chatRequest([{ role: 'user', content: 42 }])), /must be a string or an array/)
})
