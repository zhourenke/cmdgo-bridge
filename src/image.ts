/**
 * Image-part handling for the OpenAI-compatible surface.
 *
 * The upstream `/alpha/generate` envelope is not text-only after all: it accepts
 * message content blocks shaped like
 *
 *   { type: 'image', source: { type: 'base64', media_type, data } }
 *
 * as verified against the live gateway (see `test/upstream-image-probe*.mjs`).
 * This module turns OpenAI's `image_url` parts into that shape: inline `data:`
 * URLs are decoded directly, `http(s)` URLs are fetched under an SSRF guard.
 *
 * Two properties are load-bearing here:
 *
 *  1. **Determinism.** The same image bytes must always produce byte-identical
 *     base64, because the upstream prompt cache is a prefix cache. Re-encoding
 *     would invalidate every cached token from the image onward.
 *  2. **Budgeting.** Images are capped per part and per request before the
 *     gateway sees them, so a pathological body cannot exhaust the 8 MiB
 *     request budget or the model's context window.
 *
 * @module cmdgo-bridge/image
 */

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Media types accepted inline. SVG is deliberately excluded: it is script-bearing. */
export const ALLOWED_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

export interface ImageLimits {
  /** Per-image decoded byte cap. */
  maxBytes: number
  /** Per-request cap across all messages. */
  maxPerRequest: number
  /** Remote-URL fetch timeout. */
  fetchTimeoutMs: number
  /** Remote redirects followed before giving up. */
  maxRedirects: number
  /** Permit remote URLs that resolve to loopback / private / link-local addresses. */
  allowPrivateNetwork: boolean
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxBytes: 8 * 1024 * 1024,
  maxPerRequest: 12,
  fetchTimeoutMs: 15_000,
  maxRedirects: 3,
  allowPrivateNetwork: false,
}

/** An image carried on a user message, normalized to base64. */
export interface ImagePart {
  mediaType: string
  /** Standard padded base64, no newlines — byte-identical for identical bytes. */
  dataBase64: string
}

export class ImageError extends Error {}

/**
 * Shared per-request budget. Instances are created per chat request and threaded
 * through content parsing so the cap is global, not per message.
 */
export class ImageBudget {
  private used = 0

  constructor(private readonly limits: ImageLimits) {}

  get remaining(): number {
    return Math.max(0, this.limits.maxPerRequest - this.used)
  }

  /** Reserve one slot; throws when the request is already at its image cap. */
  take(): void {
    if (this.used >= this.limits.maxPerRequest) {
      throw new ImageError(
        `too many images in one request (max ${this.limits.maxPerRequest})`,
      )
    }
    this.used += 1
  }
}

/* ---------------- byte-level sniffing ---------------- */

interface Sniffed {
  mediaType: string
}

/**
 * Identify image bytes from their magic number. Guards against a `data:` URL
 * whose declared media type disagrees with its payload — some providers reject
 * that outright, and a mislabelled part otherwise fails far from its cause.
 */
export function sniffImageMediaType(bytes: Uint8Array): Sniffed | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return { mediaType: 'image/png' }
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mediaType: 'image/jpeg' }
  }
  if (bytes.length >= 6) {
    const ascii = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!)
    if (ascii === 'GIF87a' || ascii === 'GIF89a') return { mediaType: 'image/gif' }
  }
  if (bytes.length >= 12
    && String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!) === 'RIFF'
    && String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!) === 'WEBP') {
    return { mediaType: 'image/webp' }
  }
  return undefined
}

/** Normalize a declared media type; strip parameters such as `; charset=...`. */
function normalizeMediaType(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const base = raw.split(';')[0]?.trim().toLowerCase() ?? ''
  return base.length > 0 ? base : undefined
}

/**
 * Validate a decoded image and return its normalized part.
 *
 * `declaredImageType` is the type the source *declared*, which may be a generic
 * binary type that claims nothing (`application/octet-stream`). A concrete
 * non-image type is refused by the caller before this point. When a real image
 * claim disagrees with the bytes, the bytes win: the payload is authoritative
 * and the label is advisory.
 */
function finalize(
  bytes: Uint8Array,
  declaredImageType: string | undefined,
  limits: ImageLimits,
  origin: string,
): ImagePart {
  if (bytes.length === 0) throw new ImageError(`${origin}: image is empty`)
  if (bytes.length > limits.maxBytes) {
    throw new ImageError(
      `${origin}: image is ${bytes.length} bytes, over the ${limits.maxBytes}-byte limit`,
    )
  }
  const sniffed = sniffImageMediaType(bytes)
  if (sniffed === undefined) {
    throw new ImageError(`${origin}: unrecognized image format (expected png/jpeg/gif/webp)`)
  }
  // An image claim that disagrees with the bytes loses to the bytes.
  const claimed = declaredImageType?.startsWith('image/') === true ? declaredImageType : undefined
  const mediaType = claimed === sniffed.mediaType ? claimed : sniffed.mediaType
  return {
    mediaType,
    dataBase64: Buffer.from(bytes).toString('base64'),
  }
}

/* ---------------- data: URLs ---------------- */

/**
 * Base64 character -> 6-bit value, indexed by char code; `-1` for everything else.
 *
 * Used only to check the unused bits of an unpadded final character. `Buffer`'s
 * decoder ignores those bits, so `AAAB` and `AAAA` decode to the same bytes and
 * a caller who corrupted one character would never hear about it.
 */
const B64_INDEX: number[] = (() => {
  const table = new Array<number>(128).fill(-1)
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < alphabet.length; i++) table[alphabet.charCodeAt(i)] = i
  return table
})()

/**
 * Split `data:<mediatype>[;params],<payload>`.
 *
 * Hand-parsed rather than matched with a regex: the parameters section may hold
 * bare flags (`;base64`) as well as `k=v` pairs, and a regex that insists on `=`
 * silently classifies the common `data:image/png;base64,...` form as malformed.
 */
export function parseDataUrl(url: string, limits: ImageLimits): ImagePart {
  if (!url.toLowerCase().startsWith('data:')) throw new ImageError('malformed data: URL')
  const comma = url.indexOf(',')
  if (comma === -1) throw new ImageError('malformed data: URL (missing comma)')
  const header = url.slice('data:'.length, comma)
  const payload = url.slice(comma + 1)
  const segments = header.split(';')
  const declared = normalizeMediaType(segments.shift())
  const params = segments.map(segment => segment.trim().toLowerCase())
  if (declared !== undefined && declared !== '' && !declared.startsWith('image/')) {
    throw new ImageError(`data: URL media type "${declared}" is not an image`)
  }
  if (declared !== undefined && declared !== '' && !ALLOWED_IMAGE_MEDIA_TYPES.has(declared)) {
    throw new ImageError(`unsupported image media type "${declared}" (png/jpeg/gif/webp only)`)
  }
  if (!params.includes('base64')) {
    throw new ImageError('only base64-encoded data: URLs are supported')
  }
  // The declared length bounds what we decode, so an oversized image is refused
  // before base64 decoding allocates anything.
  const declaredBytes = Math.floor((payload.length * 3) / 4)
  if (declaredBytes > limits.maxBytes + 2) {
    throw new ImageError(
      `data: URL image is about ${declaredBytes} bytes, over the ${limits.maxBytes}-byte limit`,
    )
  }
  // Validate the payload BEFORE handing it to the decoder.
  //
  // `Buffer.from(payload, 'base64')` never throws: Node silently DROPS every
  // character outside the base64 alphabet. The `catch` that used to wrap it was
  // therefore dead code, and the comment claiming it rejected invalid base64 was
  // wrong. The input was still safe — garbage decodes to garbage bytes, which the
  // magic-number sniff then refuses — but it was refused as "unrecognized image
  // format", sending whoever pasted a truncated or URL-encoded blob looking for a
  // format problem that did not exist.
  const normalized = payload.replace(/\s+/g, '')
  let invalid: string | undefined
  if (normalized.length === 0) {
    invalid = 'payload is empty'
  } else if ((normalized.match(/=/g) ?? []).length > 2) {
    invalid = 'more than two padding characters'
  } else if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    invalid = 'invalid character outside A-Za-z0-9+/ (or padding in the middle)'
  } else {
    // A single leftover character cannot encode a byte in any base64 framing.
    const quantum = normalized.length % 4
    if (quantum === 1) invalid = 'truncated final quantum (length leaves one dangling character)'
    // When the length is not a multiple of 4 the input is unpadded, which many
    // encoders emit and every decoder accepts — but only when the unused bits of
    // the final character are zero. `AAAA` padded is canonical; `AAAB` claims bits
    // that no byte can carry, and Node would silently decode it as if they were 0.
    else if (quantum === 2 && (B64_INDEX[normalized.charCodeAt(normalized.length - 1)] ?? 0) % 16 !== 0) {
      invalid = 'non-canonical trailing bits (last character carries data beyond the final byte)'
    } else if (quantum === 3 && (B64_INDEX[normalized.charCodeAt(normalized.length - 1)] ?? 0) % 4 !== 0) {
      invalid = 'non-canonical trailing bits (last character carries data beyond the final byte)'
    }
  }
  if (invalid !== undefined) {
    throw new ImageError(`data: URL payload is not valid base64 (${invalid})`)
  }
  // Decode the NORMALIZED string: the declared-size check above measured the raw
  // payload, and whitespace would otherwise count toward the decoded length.
  const bytes = Buffer.from(normalized, 'base64')
  return finalize(bytes, declared, limits, 'data: URL')
}

/* ---------------- remote URLs ---------------- */

/** IPv4 ranges that must never be reachable through a user-supplied URL. */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split('.').map(part => Number(part))
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) return false
  const [a = 0, b = 0] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 192 && b === 0) return true
  if (a >= 224) return true
  return false
}

function isPrivateIPv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('::ffff:')) return isPrivateIPv4(lower.slice('::ffff:'.length))
  return false
}

/** True when `address` names a loopback / private / link-local / multicast host. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPrivateIPv4(address)
  if (version === 6) return isPrivateIPv6(address)
  return false
}

async function assertPublicHost(hostname: string, limits: ImageLimits): Promise<void> {
  if (limits.allowPrivateNetwork) return
  if (isPrivateAddress(hostname)) {
    throw new ImageError(`image URL host "${hostname}" is a private address`)
  }
  let addresses: { address: string }[]
  try {
    addresses = await lookup(hostname, { all: true })
  } catch {
    throw new ImageError(`image URL host "${hostname}" does not resolve`)
  }
  if (addresses.length === 0) throw new ImageError(`image URL host "${hostname}" does not resolve`)
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ImageError(`image URL host "${hostname}" resolves to a private address`)
    }
  }
}

/**
 * Read a response body, refusing to buffer past `cap`.
 *
 * On overflow the reader is cancelled (which also releases the lock and drops the
 * connection) and nothing further is read. `cancel()` is the single teardown
 * point: calling `releaseLock()` afterwards is redundant and can throw on an
 * already-released reader.
 */
async function readCapped(body: ReadableStream<Uint8Array>, cap: number): Promise<Buffer> {
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    size += value.byteLength
    if (size > cap) {
      await reader.cancel().catch(() => {})
      throw new ImageError(`remote image is larger than the ${cap}-byte limit`)
    }
    chunks.push(Buffer.from(value))
  }
  reader.releaseLock()
  return Buffer.concat(chunks)
}

export async function fetchImage(
  rawUrl: string,
  limits: ImageLimits,
  signal?: AbortSignal,
): Promise<ImagePart> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ImageError(`invalid image URL: ${rawUrl.slice(0, 120)}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ImageError(`unsupported image URL protocol "${url.protocol}" (http/https only)`)
  }

  let current = url
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    await assertPublicHost(current.hostname, limits)
    const timeout = AbortSignal.timeout(limits.fetchTimeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response: Response
    try {
      response = await fetch(current, {
        redirect: 'manual',
        signal: combined,
        headers: { accept: 'image/png,image/jpeg,image/gif,image/webp' },
      })
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) throw new ImageError(`timed out fetching image after ${limits.fetchTimeoutMs}ms`)
      throw new ImageError(`failed to fetch image: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      await response.body?.cancel().catch(() => {})
      if (location === null) throw new ImageError(`image fetch got HTTP ${response.status} with no Location`)
      try {
        current = new URL(location, current)
      } catch {
        throw new ImageError(`image redirect target is not a valid URL`)
      }
      continue
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new ImageError(`image fetch got HTTP ${response.status}`)
    }
    const declaredHeader = normalizeMediaType(response.headers.get('content-type') ?? undefined)
    // A generic binary type is not evidence of a non-image: object stores and
    // CDNs routinely serve real images as application/octet-stream, so those fall
    // through to byte sniffing. A specific non-image type (text/html, ...) is a
    // genuine misconfiguration and is refused before the body is read.
    const genericBinary = declaredHeader === 'application/octet-stream'
      || declaredHeader === 'binary/octet-stream'
    if (declaredHeader !== undefined && !declaredHeader.startsWith('image/') && !genericBinary) {
      await response.body?.cancel().catch(() => {})
      throw new ImageError(`image URL served "${declaredHeader}", not an image`)
    }
    if (response.body === null) throw new ImageError('image response had no body')
    // The body read happens inside the same guard as the request: an abort raised
    // mid-stream (the timeout usually fires here, not during the handshake) must
    // surface as an ImageError, not as a bare TimeoutError from the platform.
    let bytes: Buffer
    try {
      bytes = await readCapped(response.body, limits.maxBytes)
    } catch (error) {
      if (signal?.aborted) throw error
      if (timeout.aborted) throw new ImageError(`timed out fetching image after ${limits.fetchTimeoutMs}ms`)
      if (error instanceof ImageError) throw error
      throw new ImageError(
        `failed to read image body: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return finalize(bytes, declaredHeader, limits, `image URL ${current.hostname}`)
  }
  throw new ImageError(`too many redirects fetching image (max ${limits.maxRedirects})`)
}
