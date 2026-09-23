/**
 * Round 2: with the image envelope shape now known (anthropic-style
 * `{type:'image', source:{type:'base64',media_type,data}}` passed upstream
 * validation), determine whether the model actually SEES the pixels.
 *
 * Discrimination image: a solid background plus one large black word. The word
 * cannot be guessed from the prompt, so a correct answer proves real vision.
 *
 * Usage: node test/upstream-image-probe2.mjs [--max-tokens N]
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { deflateSync } from 'node:zlib'

const BASE = 'https://api.commandcode.ai'
const CC_VERSION = '1.31.0'
const DATA_DIR = join(homedir(), '.cmdgo-bridge')
const SECRET_WORD = 'PLUMBUS'

/* ---------- minimal PNG encoder with filled rects ---------- */

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

function pngFrom(w, h, painter) {
  const px = Buffer.alloc(w * h * 3)
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const i = (y * w + x) * 3
    px[i] = r
    px[i + 1] = g
    px[i + 2] = b
  }
  painter(set, w, h)
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

// 7-row uppercase font, 5 columns, bit 4 = leftmost.
const FONT = {
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  M: ['10001', '11011', '10101', '10001', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
}

const BG = [255, 140, 0] // orange
const W = 480
const H = 200
const SCALE = 14

const image = pngFrom(W, H, (set) => {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, BG)
  let cx = 40
  for (const ch of SECRET_WORD) {
    const rows = FONT[ch]
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (rows[ry][rx] !== '1') continue
        for (let dy = 0; dy < SCALE; dy++) {
          for (let dx = 0; dx < SCALE; dx++) {
            set(cx + rx * SCALE + dx, 70 + ry * SCALE + dy, [0, 0, 0])
          }
        }
      }
    }
    cx += 6 * SCALE
  }
})

const b64 = image.toString('base64')
console.log(`discrimination image: ${W}x${H}, background rgb(${BG}), black word "${SECRET_WORD}"`)
console.log(`png=${image.length}B b64=${b64.length}B\n`)

const QUESTION =
  'The attached image shows one word in large black letters on a solid coloured background. ' +
  'Answer with exactly two lines and nothing else:\n' +
  'WORD: <the word you see>\n' +
  'BACKGROUND: <the English name of the background colour>'

async function credential() {
  const accounts = JSON.parse(await readFile(join(DATA_DIR, 'accounts.json'), 'utf8'))
  const ref = accounts.accounts?.[0]?.ref
  const store = JSON.parse(await readFile(join(DATA_DIR, 'credentials.json'), 'utf8'))
  const value = store[ref]?.value
  if (typeof value !== 'string' || value.length === 0) throw new Error(`no credential for ref ${ref}`)
  return value
}

function envelope(content, maxTokens, model) {
  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().split('T')[0],
      environment: `${process.platform}-${process.arch}`,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: '',
    taste: '',
    skills: null,
    permissionMode: 'standard',
    params: {
      model,
      messages: [{ role: 'user', content }],
      tools: [],
      system: '',
      max_tokens: maxTokens,
      stream: true,
    },
  }
}

async function callUpstream(apiKey, body, timeoutMs = 300_000) {
  const started = Date.now()
  let response
  try {
    response = await fetch(`${BASE}/alpha/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': `commandcode/${CC_VERSION}`,
        'x-command-code-version': CC_VERSION,
        'x-cli-environment': 'production',
        'x-taste-learning': 'false',
        'x-session-id': 'cmdgo-image-probe',
        'x-project-slug': 'cmdgo-bridge',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { transport: `${error?.name}: ${error?.message}` }
  }
  const raw = await response.text()
  if (!response.ok) return { status: response.status, raw: raw.slice(0, 500) }
  let text = ''
  let reasoning = ''
  let usage
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith(':')) continue
    let event
    try {
      event = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (typeof event.text === 'string') {
      if (event.type === 'text-delta') text += event.text
      else if (event.type === 'reasoning-delta') reasoning += event.text
    }
    if (event.type === 'finish' && event.usage) usage = event.usage
  }
  return { status: response.status, ms: Date.now() - started, text: text.trim(), reasoning: reasoning.trim(), usage }
}

const argMax = process.argv.indexOf('--max-tokens')
const maxTokens = argMax === -1 ? 400 : Number(process.argv[argMax + 1])
const apiKey = await credential()

const MODELS = process.argv.includes('--multi')
  ? ['deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-v4-flash-vision-exp', 'deepseek/deepseek-v4-pro']
  : [process.env.PROBE_MODEL ?? 'deepseek/deepseek-v4.1-flash']

const withImage = [
  { type: 'text', text: QUESTION },
  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
]
const control = [{ type: 'text', text: QUESTION + '\n(No image is attached to this message.)' }]

for (const model of MODELS) {
  console.log('='.repeat(72))
  console.log(`model=${model} max_tokens=${maxTokens}\n`)

  const ctrl = await callUpstream(apiKey, envelope(control, maxTokens, model))
  console.log('[control: no image]')
  console.log(' ', ctrl.transport ?? (ctrl.status !== 200 ? `HTTP ${ctrl.status} ${ctrl.raw}` : `${ctrl.ms}ms usage=${JSON.stringify(ctrl.usage?.inputTokenDetails)}`))
  console.log('  text:', JSON.stringify(ctrl.text))
  console.log()

  const res = await callUpstream(apiKey, envelope(withImage, maxTokens, model))
  console.log('[image: anthropic base64 source]')
  console.log(' ', res.transport ?? (res.status !== 200 ? `HTTP ${res.status} ${res.raw}` : `${res.ms}ms`))
  if (res.status === 200) {
    console.log('  usage:', JSON.stringify(res.usage))
    console.log('  text:', JSON.stringify(res.text))
    console.log('  reasoning(head):', JSON.stringify(res.reasoning.slice(0, 300)))
  }
  console.log()
}
