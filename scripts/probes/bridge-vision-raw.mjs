/**
 * Diagnostic: dump the RAW bridge response for an image request, including
 * finish_reason, reasoning_content and completion token details.
 *
 * ⚠️ 消耗真实额度：会通过桥发起带图对话请求。确认后再执行。
 *
 * Usage: node scripts/probes/bridge-vision-raw.mjs [--base URL] [--model M] [--max-tokens N]
 */
import './_live-probe-guard.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { deflateSync } from 'node:zlib'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const BASE = (arg('--base', 'http://127.0.0.1:11436/v1') ?? '').replace(/\/+$/, '')
const MODEL = arg('--model', 'deepseek/deepseek-v4.1-flash')
const MAX = Number(arg('--max-tokens', '1200'))

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
    px[i] = r; px[i + 1] = g; px[i + 2] = b
  }
  painter(set)
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0
    px.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3)
  }
  const chunk = (tag, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(tag, 'ascii'), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ])
}

const FONT = {
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
}
const W = 640, H = 220, SCALE = 20
const image = png(W, H, (set) => {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, [26, 26, 46])
  let cx = 50
  for (const ch of 'VISION') {
    const rows = FONT[ch]
    for (let ry = 0; ry < 7; ry++) for (let rx = 0; rx < 5; rx++) {
      if (rows[ry][rx] !== '1') continue
      for (let dy = 0; dy < SCALE; dy++) for (let dx = 0; dx < SCALE; dx++) {
        set(cx + rx * SCALE + dx, 60 + ry * SCALE + dy, [255, 255, 255])
      }
    }
    cx += 6 * SCALE
  }
})
const dataUrl = `data:image/png;base64,${image.toString('base64')}`

const key = JSON.parse(await readFile(join(homedir(), '.cmdgo-bridge-visiontest', 'config.json'), 'utf8')).apiKey

const QUESTION =
  'The attached image shows one word in large white letters on a dark background. ' +
  'Reply with exactly two lines and nothing else:\nWORD: <the word>\nBACKGROUND: <colour name>'

async function run(label, content, extra = {}) {
  const body = {
    model: MODEL,
    messages: [{ role: 'user', content }],
    max_tokens: MAX,
    temperature: 0,
    ...extra,
  }
  const response = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(600_000),
  })
  const text = await response.text()
  console.log('='.repeat(74))
  console.log(`[${label}] http=${response.status} max_tokens=${MAX}`)
  console.log(text.slice(0, 2500))
  console.log()
}

await run('data URL image, no tools', [
  { type: 'text', text: QUESTION },
  { type: 'image_url', image_url: { url: dataUrl } },
])

await run('data URL image + tools', [
  { type: 'text', text: QUESTION },
  { type: 'image_url', image_url: { url: dataUrl } },
], {
  tools: [{
    type: 'function',
    function: { name: 'report', description: 'Report a finding.', parameters: { type: 'object', properties: {} } },
  }],
})

await run('remote URL image, no tools', [
  { type: 'text', text: 'Describe the main colours of this image in one short sentence.' },
  { type: 'image_url', image_url: { url: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png' } },
])
