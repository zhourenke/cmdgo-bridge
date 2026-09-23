/**
 * Image intake: `image_url` parts → the base64 envelope the gateway accepts.
 *
 * The upstream envelope shape and the fact that models actually read the pixels
 * were established against the live gateway; these tests guard the translation
 * and the limits that keep a hostile body from exhausting the request budget.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'

import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  DEFAULT_IMAGE_LIMITS,
  ImageBudget,
  ImageError,
  fetchImage,
  isPrivateAddress,
  parseDataUrl,
  sniffImageMediaType,
} from '../dist/image.js'

/* ---------------- fixtures ---------------- */

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
const GIF = Buffer.from('GIF89a' + '\x01\x00\x01\x00\x80\x00\x00'.repeat(1), 'binary')
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('VP8 ', 'ascii'),
])

const dataUrl = (bytes, mediaType = 'image/png') =>
  `data:${mediaType};base64,${bytes.toString('base64')}`

const limits = (over = {}) => ({ ...DEFAULT_IMAGE_LIMITS, ...over })

/* ---------------- sniffing ---------------- */

test('sniffs the four supported container formats', () => {
  assert.equal(sniffImageMediaType(PNG)?.mediaType, 'image/png')
  assert.equal(sniffImageMediaType(GIF)?.mediaType, 'image/gif')
  assert.equal(sniffImageMediaType(JPEG)?.mediaType, 'image/jpeg')
  assert.equal(sniffImageMediaType(WEBP)?.mediaType, 'image/webp')
})

test('refuses bytes that are not a supported image', () => {
  assert.equal(sniffImageMediaType(Buffer.from('<!DOCTYPE html>')), undefined)
  assert.equal(sniffImageMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined)
  assert.equal(sniffImageMediaType(Buffer.alloc(0)), undefined)
})

/* ---------------- data: URLs ---------------- */

test('decodes a base64 data: URL, byte-identically and without newlines', () => {
  const part = parseDataUrl(dataUrl(PNG), limits())
  assert.equal(part.mediaType, 'image/png')
  assert.equal(part.dataBase64, PNG.toString('base64'))
  assert.ok(!part.dataBase64.includes('\n'))
  // Determinism is what keeps the upstream prefix cache warm across turns.
  assert.equal(parseDataUrl(dataUrl(PNG), limits()).dataBase64, part.dataBase64)
})

test('accepts a parameter-only data: URL and a missing media type', () => {
  assert.equal(parseDataUrl(`data:;base64,${PNG.toString('base64')}`, limits()).mediaType, 'image/png')
  assert.equal(parseDataUrl(`data:image/gif;base64,${GIF.toString('base64')}`, limits()).mediaType, 'image/gif')
})

test('trusts sniffed bytes over a wrong declared media type', () => {
  // Declared jpeg, actually png: the bytes win, so the gateway sees a coherent part.
  const part = parseDataUrl(dataUrl(PNG, 'image/jpeg'), limits())
  assert.equal(part.mediaType, 'image/png')
})

test('rejects non-image, unsupported and non-base64 data: URLs', () => {
  assert.throws(() => parseDataUrl(`data:text/plain;base64,${Buffer.from('hi').toString('base64')}`, limits()), ImageError)
  assert.throws(() => parseDataUrl(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`, limits()), ImageError)
  assert.throws(() => parseDataUrl('data:image/png,notbase64', limits()), ImageError)
  assert.throws(() => parseDataUrl('data:image/png;base64,', limits()), ImageError)
  assert.throws(() => parseDataUrl('not-a-data-url', limits()), ImageError)
})

test('enforces the per-image byte cap before decoding', () => {
  const big = Buffer.concat([PNG, Buffer.alloc(4096)])
  assert.throws(() => parseDataUrl(dataUrl(big), limits({ maxBytes: 1024 })), /over the 1024-byte limit/)
  // Base64 is not validated before the size guard, so an oversized part is
  // rejected on its declared length alone — no decode, no allocation.
  assert.throws(() => parseDataUrl(dataUrl(big), limits({ maxBytes: 64 })), /over the 64-byte limit/)
  assert.throws(
    () => parseDataUrl(`data:image/png;base64,${'A'.repeat(8192)}`, limits({ maxBytes: 64 })),
    /over the 64-byte limit/,
  )
})

test('every allowed media type has a sniffer branch', () => {
  assert.deepEqual(
    [...ALLOWED_IMAGE_MEDIA_TYPES].sort(),
    ['image/gif', 'image/jpeg', 'image/png', 'image/webp'],
  )
})

/* ---------------- budget ---------------- */

test('the per-request budget is shared and caps the image count', () => {
  const budget = new ImageBudget(limits({ maxPerRequest: 2 }))
  assert.equal(budget.remaining, 2)
  budget.take()
  budget.take()
  assert.equal(budget.remaining, 0)
  assert.throws(() => budget.take(), /too many images in one request \(max 2\)/)
})

/* ---------------- SSRF guard ---------------- */

test('classifies private, loopback and link-local addresses', () => {
  for (const address of [
    '127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.5.5', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1',
    '::1', '::', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:127.0.0.1',
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} must be private`)
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(address), false, `${address} must be public`)
  }
})

test('refuses a private image URL without any network access', async () => {
  await assert.rejects(
    () => fetchImage('http://127.0.0.1:11435/v1/models', limits()),
    /private address/,
  )
  // 169.254.0.0/16 is link-local, and the refusal now says so specifically instead
  // of lumping it in with RFC1918 ranges. The narrower reason matters: it is the
  // cloud metadata range, and it stays blocked even with allowPrivateNetwork on.
  await assert.rejects(
    () => fetchImage('http://169.254.169.254/latest/meta-data/', limits()),
    /link-local address/,
  )
  await assert.rejects(
    () => fetchImage('http://10.1.2.3/x.png', limits()),
    /private address/,
    'a plain RFC1918 host must still be refused as private',
  )
})

test('refuses non-http(s) schemes and malformed URLs', async () => {
  await assert.rejects(() => fetchImage('file:///etc/passwd', limits()), /unsupported image URL protocol/)
  await assert.rejects(() => fetchImage('gopher://example.com/x', limits()), /unsupported image URL protocol/)
  await assert.rejects(() => fetchImage('http://', limits()), /invalid image URL/)
})
