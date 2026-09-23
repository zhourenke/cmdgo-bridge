/**
 * Upstream envelope probe: which image content-block shape does the real
 * CommandCode `/alpha/generate` gateway accept, and does the model actually see
 * the pixels?
 *
 * Bypasses the bridge entirely: builds raw envelopes, posts them with the pool
 * credential, and reports (a) whether the HTTP call is accepted, (b) whether the
 * model answers the question that only the pixels can answer.
 *
 * ⚠️ 消耗真实额度：直接使用账号池凭据打真实上游。确认后再执行。
 *
 * Usage: node scripts/probes/upstream-image-probe.mjs [--max-tokens N]
 */
import './_live-probe-guard.mjs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'

const BASE = 'https://api.commandcode.ai'
const CC_VERSION = '1.31.0'
const MODEL = process.env.PROBE_MODEL ?? 'deepseek/deepseek-v4.1-flash'
const DATA_DIR = join(homedir(), '.cmdgo-bridge')

/** Solid-colour PNG: the true colour is unguessable from the prompt text. */
function solidPng(w, h, [r, g, b]) {
  const raw = Buffer.alloc(h * (1 + w * 3))
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3)
    raw[row] = 0
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
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

// Deliberately not a primary colour, so a lucky guess is implausible.
const TRUE_RGB = [255, 140, 0] // orange
const QUESTION =
  'Look at the attached image. It is a single solid colour. ' +
  'Reply with ONLY the English colour name of that solid fill (one word).'

const image = solidPng(160, 160, TRUE_RGB)
const b64 = image.toString('base64')
console.log(`probe image: 160x160 solid rgb(${TRUE_RGB}) png=${image.length}B b64=${b64.length}`)
console.log(`sha256=${createHash('sha256').update(image).digest('hex').slice(0, 16)}\n`)

/** Candidate shapes for one user message carrying an image. */
const VARIANTS = {
  'A anthropic base64 source': [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }, { type: 'text', text: QUESTION }],
  'B ai-sdk mediaType+base64': [{ type: 'image', mediaType: 'image/png', data: b64 }, { type: 'text', text: QUESTION }],
  'C openai image_url data': [{ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }, { type: 'text', text: QUESTION }],
  'D flat mimeType+base64': [{ type: 'image', mimeType: 'image/png', data: b64 }, { type: 'text', text: QUESTION }],
  'E text-then-image (anthropic)': [{ type: 'text', text: QUESTION }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } }],
}

async function credential() {
  const accounts = JSON.parse(await readFile(join(DATA_DIR, 'accounts.json'), 'utf8'))
  const ref = accounts.accounts?.[0]?.ref
  const store = JSON.parse(await readFile(join(DATA_DIR, 'credentials.json'), 'utf8'))
  const value = store[ref]?.value
  if (typeof value !== 'string' || value.length === 0) throw new Error(`no credential for ref ${ref}`)
  return value
}

function envelope(userContent, maxTokens) {
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
      model: MODEL,
      messages: [{ role: 'user', content: userContent }],
      tools: [],
      system: '',
      max_tokens: maxTokens,
      stream: true,
    },
  }
}

/** Collect the line-delimited JSON stream into text + usage + error events. */
async function callUpstream(apiKey, body, timeoutMs = 180_000) {
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
  if (!response.ok) return { status: response.status, raw: raw.slice(0, 700) }
  const events = []
  let text = ''
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
    events.push(event.type)
    if (typeof event.text === 'string' && (event.type === 'text-delta' || event.type === 'text')) text += event.text
    if (event.usage) usage = event.usage
    if (event.type === 'finish' && event.usage) usage = event.usage
  }
  return { status: response.status, ms: Date.now() - started, events, text: text.trim(), usage, raw: raw.slice(0, 400) }
}

const maxTokens = Number(process.argv[process.argv.indexOf('--max-tokens') + 1]) || 40
const apiKey = await credential()
console.log(`model=${MODEL} max_tokens=${maxTokens} upstream=${BASE}\n`)

// Baseline first: text-only, to prove the colour is not guessable.
const baseline = await callUpstream(apiKey, envelope(QUESTION, maxTokens))
console.log('[baseline text-only, no image]')
console.log('  ', JSON.stringify(baseline).slice(0, 400), '\n')

for (const [name, content] of Object.entries(VARIANTS)) {
  const result = await callUpstream(apiKey, envelope(content, maxTokens))
  const kind = result.transport !== undefined
    ? `TRANSPORT ${result.transport}`
    : result.status !== 200
      ? `HTTP ${result.status} ${result.raw.replace(/\s+/g, ' ')}`
      : `HTTP 200 ${result.ms}ms events=[${[...new Set(result.events)].join(',')}] usage=${JSON.stringify(result.usage)}`
  console.log(`[${name}]`)
  console.log('   ', kind)
  console.log('    text:', JSON.stringify(result.text))
  console.log()
}
