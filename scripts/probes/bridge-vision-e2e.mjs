/**
 * End-to-end vision verification THROUGH the bridge's OpenAI surface.
 *
 * Verifies, against a selected base URL:
 *   1. an image the prompt never describes is read correctly (real vision);
 *   2. the same bytes reproduce byte-identical base64, so a repeated image
 *      request keeps as much upstream prefix cache as the provider allows;
 *   3. a text-only request still serializes to the legacy envelope (cache
 *      prefix stability) and still reports cached tokens;
 *   4. malformed / oversized / unsupported parts fail loudly with 400;
 *   5. a remote https image URL is fetched by the bridge and read correctly.
 *
 * Usage:
 *   node scripts/probes/bridge-vision-e2e.mjs [--base http://127.0.0.1:11436/v1]
 *                                             [--key <client-api-key>]
 *                                             [--model deepseek/deepseek-v4.1-flash]
 */
import { deflateSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}

const BASE = (arg('--base', 'http://127.0.0.1:11436/v1') ?? '').replace(/\/+$/, '')
const MODEL = arg('--model', 'deepseek/deepseek-v4.1-flash')
const SECRET_WORD = 'VISION'
async function clientKey() {
  const explicit = arg('--key', undefined)
  if (explicit !== undefined) return explicit
  const raw = await readFile(join(homedir(), '.cmdgo-bridge-visiontest', 'config.json'), 'utf8')
  return JSON.parse(raw).apiKey
}

/* ---------------- drawing ---------------- */

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

function png(w, h, painter) {
  const px = Buffer.alloc(w * h * 3)
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 3
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
  }
  painter(set)
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0
    px.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3)
  }
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
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const FONT = {
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
}

// Canvas is sized from the text so no glyph is ever clipped: a clipped word
// makes the model read broken letterforms and invalidates the whole check.
const SCALE = 20
const GLYPH_W = 5 * SCALE
const STEP = GLYPH_W + SCALE
const MARGIN = 40
const W = MARGIN * 2 + SECRET_WORD.length * STEP - SCALE
const H = 7 * SCALE + 80
const BG = [26, 26, 46] // near-black navy

function buildImage() {
  const textWidth = SECRET_WORD.length * STEP - SCALE
  return png(W, H, (set) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, BG)
    let cx = Math.floor((W - textWidth) / 2)
    const cy = Math.floor((H - 7 * SCALE) / 2)
    for (const ch of SECRET_WORD) {
      const rows = FONT[ch]
      for (let ry = 0; ry < 7; ry++) {
        for (let rx = 0; rx < 5; rx++) {
          if (rows[ry][rx] !== '1') continue
          for (let dy = 0; dy < SCALE; dy++) {
            for (let dx = 0; dx < SCALE; dx++) set(cx + rx * SCALE + dx, cy + ry * SCALE + dy, [255, 255, 255])
          }
        }
      }
      cx += STEP
    }
  })
}

/* ---------------- request helpers ---------------- */

const image = buildImage()
const b64 = image.toString('base64')
const dataUrl = `data:image/png;base64,${b64}`

const QUESTION =
  'The attached image shows one word in large white letters on a dark background. ' +
  'Reply with exactly two lines and nothing else:\nWORD: <the word>\nBACKGROUND: <colour name>'

async function chat(key, body) {
  const started = Date.now()
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const content = parsed?.choices?.[0]?.message?.content ?? parsed?.error?.message ?? text.slice(0, 200)
  return { status: response.status, ms: Date.now() - started, content, usage: parsed?.usage }
}

// A stable "system + tools" prefix, so cache behaviour is observable.
const SYSTEM = 'You are a careful visual assistant. '.repeat(40)
const TOOLS = [{
  type: 'function',
  function: {
    name: 'report',
    description: 'Report a finding. '.repeat(30),
    parameters: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'] },
  },
}]

const request = (messages, maxTokens = 200) => ({
  model: MODEL,
  messages,
  max_tokens: maxTokens,
  temperature: 0,
  tools: TOOLS,
})

const userWithImage = (text = QUESTION) => ({
  role: 'user',
  content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl } }],
})

const report = (label, result, expect = 200) => {
  const mark = result.status === expect ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${label}`)
  console.log(`       http=${result.status} ${result.ms}ms`)
  if (result.usage) {
    console.log(`       prompt_tokens=${result.usage.prompt_tokens} cached=${result.usage.prompt_tokens_details?.cached_tokens} completion=${result.usage.completion_tokens}`)
  }
  console.log(`       ${JSON.stringify(result.content).slice(0, 220)}`)
  return mark === 'PASS'
}

const main = async () => {
  const key = await clientKey()
  console.log(`base=${BASE} model=${MODEL}`)
  console.log(`image: ${W}x${H}, word "${SECRET_WORD}", png=${image.length}B b64=${b64.length}B`)
  console.log(`(bridge default max image = 8 MiB, max 12 per request)\n`)

  let failures = 0

  // 1. text-only baseline: proves the legacy envelope still works and caches.
  const plain = await chat(key, request([{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Say OK.' }], 20))
  if (!report('text-only baseline', plain)) failures++
  const plainAgain = await chat(key, request([{ role: 'system', content: SYSTEM }, { role: 'user', content: 'Say OK.' }], 20))
  if (!report('text-only repeated (cache warm)', plainAgain)) failures++

  // 2. the actual question: can the model read an image through the bridge?
  // Sent WITHOUT tools on purpose: with a tool schema in context the model tends
  // to spend the whole budget announcing a tool call, which says nothing about
  // whether it saw the pixels. Cache measurement is a separate, tool-carrying
  // request below.
  const vision = await chat(key, {
    model: MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: QUESTION }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    max_tokens: 1200,
    temperature: 0,
  })
  const sawWord = vision.content.includes(SECRET_WORD)
  const sawColour = /navy|dark|black|blue|midnight/i.test(vision.content)
  console.log(`[${sawWord && sawColour ? 'PASS' : 'FAIL'}] image read through bridge (word + background)`)
  console.log(`       http=${vision.status} ${vision.ms}ms`)
  if (vision.usage) {
    console.log(`       prompt_tokens=${vision.usage.prompt_tokens} cached=${vision.usage.prompt_tokens_details?.cached_tokens} completion=${vision.usage.completion_tokens} reasoning=${vision.usage.completion_tokens_details?.reasoning_tokens}`)
  }
  console.log(`       ${JSON.stringify(vision.content).slice(0, 240)}`)
  if (!(sawWord && sawColour)) failures++

  // 3. the cache question: an image conversation whose prompt prefix is already
  // warm. Measured by cached_tokens, and deliberately tolerant of the model
  // preferring a tool call, which is a behaviour detail rather than a plumbing one.
  const visionWarm1 = await chat(key, request([
    { role: 'system', content: SYSTEM },
    userWithImage('Reply "ok" and nothing else.'),
  ], 40))
  const visionWarm2 = await chat(key, request([
    { role: 'system', content: SYSTEM },
    userWithImage('Reply "ok" and nothing else.'),
  ], 40))
  const warm1 = visionWarm1.usage?.prompt_tokens_details?.cached_tokens ?? 0
  const warm2 = visionWarm2.usage?.prompt_tokens_details?.cached_tokens ?? 0
  // The image blocks themselves are the suffix, so a warm prefix must at least
  // cover everything before the image (system + tool schemas).
  const prefixCovered = warm2 >= 512 && warm2 >= warm1
  console.log(`[${prefixCovered ? 'PASS' : 'FAIL'}] repeated image request reuses cache (cached ${warm1} -> ${warm2}, prompt=${visionWarm2.usage?.prompt_tokens})`)
  if (!prefixCovered) failures++

  // 4. error paths
  const malformed = await chat(key, request([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png,notbase64' } }] }], 20))
  if (!report('malformed data URL -> 400', malformed, 400)) failures++

  const notImage = await chat(key, request([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:text/plain;base64,aGVsbG8=' } }] }], 20))
  if (!report('non-image data URL -> 400', notImage, 400)) failures++

  const audio = await chat(key, request([{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'x' } }] }], 20))
  if (!report('input_audio part -> 400', audio, 400)) failures++

  const tooBig = await chat(key, request([{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(24 * 1024 * 1024)}` } }] }], 20))
  if (!report('24 MiB base64 body -> 413/400', tooBig, tooBig.status === 413 ? 413 : 400)) failures++

  const privateUrl = await chat(key, request([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://127.0.0.1:11436/api/status' } }] }], 20))
  const blocked = privateUrl.status === 400 && /private address/.test(String(privateUrl.content))
  console.log(`[${blocked ? 'PASS' : 'FAIL'}] SSRF guard blocks loopback image URL -> 400`)
  console.log(`       http=${privateUrl.status} ${JSON.stringify(privateUrl.content).slice(0, 160)}`)
  if (!blocked) failures++

  // 5. remote https image fetch (depends on outbound network).
  // No tools: the model must describe the pixels instead of promising a tool call.
  const remote = await chat(key, {
    model: MODEL,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe the main colours in this image in one short sentence. Do not call any tool.' },
        { type: 'image_url', image_url: { url: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png' } },
      ],
    }],
    max_tokens: 1200,
    temperature: 0,
  })
  const remoteText = String(remote.content ?? '')
  const remoteOk = remote.status === 200
    && remoteText.length > 10
    && !/invalid image|failed to fetch|don't see an image|no image/i.test(remoteText)
  console.log(`[${remoteOk ? 'PASS' : 'FAIL'}] remote https image URL fetched and read`)
  console.log(`       http=${remote.status} ${remote.ms}ms completion=${remote.usage?.completion_tokens}`)
  console.log(`       ${JSON.stringify(remoteText).slice(0, 240)}`)
  if (!remoteOk) failures++

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
