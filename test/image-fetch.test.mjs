/**
 * Remote (`http(s)`) image intake, exercised against a real local HTTP server.
 *
 * The SSRF guard tests cover the refusal path; these cover the *retrieval* path,
 * which is where the interesting failure modes live: a body that never ends, a
 * body that lies about its type, a redirect chain that never resolves, and an
 * oversized body that must be abandoned without buffering it.
 *
 * Loopback URLs are used deliberately, so the guard is opened with
 * `allowPrivateNetwork` — the documented escape hatch — rather than bypassed.
 *
 * Run with `npm test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'

import { DEFAULT_IMAGE_LIMITS, fetchImage } from '../dist/image.js'
import { listenOnFetchablePort } from './helpers/loopback-port.mjs'

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

/** Local limits that allow loopback and keep every cap small. */
const localLimits = (over = {}) => ({
  ...DEFAULT_IMAGE_LIMITS,
  allowPrivateNetwork: true,
  ...over,
})

/** Start a server on an ephemeral port; returns its base URL and a close fn. */
async function serve(handler) {
  const server = createServer(handler)
  server.on('clientError', () => {})
  await listenOnFetchablePort(server)
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('fetches and decodes an image served over http', async () => {
  const { base, close } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })
  try {
    const part = await fetchImage(`${base}/a.png`, localLimits())
    assert.equal(part.mediaType, 'image/png')
    assert.equal(part.dataBase64, PNG.toString('base64'))
  } finally {
    await close()
  }
})

test('follows a redirect chain within the hop limit', async () => {
  const { base, close } = await serve((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/middle' })
      res.end()
    } else if (req.url === '/middle') {
      res.writeHead(301, { location: '/final.png' })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(PNG)
    }
  })
  try {
    const part = await fetchImage(`${base}/start`, localLimits({ maxRedirects: 3 }))
    assert.equal(part.mediaType, 'image/png')
  } finally {
    await close()
  }
})

test('refuses a redirect loop once the hop limit is exhausted', async () => {
  const { base, close } = await serve((req, res) => {
    res.writeHead(302, { location: '/again' })
    res.end()
  })
  try {
    await assert.rejects(
      () => fetchImage(`${base}/again`, localLimits({ maxRedirects: 2 })),
      /too many redirects/,
    )
  } finally {
    await close()
  }
})

test('rejects a response that is not an image', async () => {
  const { base, close } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>not an image</html>')
  })
  try {
    await assert.rejects(() => fetchImage(`${base}/page`, localLimits()), /not an image/)
  } finally {
    await close()
  }
})

test('rejects an octet-stream body whose bytes are not a supported format', async () => {
  const { base, close } = await serve((req, res) => {
    // The generic type passes the header check, so magic-number sniffing is what
    // rejects it.
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(Buffer.from('plain text pretending to be an image'))
  })
  try {
    await assert.rejects(() => fetchImage(`${base}/blob`, localLimits()), /unrecognized image format/)
  } finally {
    await close()
  }
})

test('accepts a real image served as a generic binary type', async () => {
  // Object stores and CDNs commonly serve png as application/octet-stream; the
  // bytes are authoritative, so this must succeed.
  const { base, close } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream' })
    res.end(PNG)
  })
  try {
    const part = await fetchImage(`${base}/image`, localLimits())
    assert.equal(part.mediaType, 'image/png')
  } finally {
    await close()
  }
})

test('abandons an oversized body instead of buffering it', async () => {
  const { base, close } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    // 1 MiB of zeroes, far past the 4 KiB cap below.
    res.end(Buffer.alloc(1024 * 1024))
  })
  try {
    await assert.rejects(() => fetchImage(`${base}/big.png`, localLimits({ maxBytes: 4096 })))
  } finally {
    await close()
  }
})

test('gives up on a server that never finishes responding', async () => {
  const { base, close } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.write(PNG.subarray(0, 8)) // headers and a few bytes, then silence
  })
  try {
    await assert.rejects(
      () => fetchImage(`${base}/slow.png`, localLimits({ fetchTimeoutMs: 300 })),
      /timed out fetching image/,
    )
  } finally {
    await close()
  }
})

test('surfaces a non-2xx status as an image error', async () => {
  const { base, close } = await serve((req, res) => {
    res.writeHead(404)
    res.end('nope')
  })
  try {
    await assert.rejects(() => fetchImage(`${base}/missing.png`, localLimits()), /HTTP 404/)
  } finally {
    await close()
  }
})

test('honours an already-aborted signal', async () => {
  const { base, close } = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(PNG)
  })
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(() => fetchImage(`${base}/a.png`, localLimits(), controller.signal))
  } finally {
    await close()
  }
})
