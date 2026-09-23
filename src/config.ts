/**
 * Server configuration: tiny JSON file, auto-created on first run with a
 * random client API key (the token agent tools must present as Bearer).
 *
 * @module cmdgo-bridge/config
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './secrets.js'
import { DEFAULT_IMAGE_LIMITS } from './image.js'
import type { ImageLimits } from './image.js'

export interface ServerConfig {
  /** Listen host. Loopback only by default; the /v1 token protects wider binds. */
  host: string
  /** Listen port. */
  port: number
  /** Command Code gateway base URL; `/alpha/generate` is appended. */
  baseURL: string
  /** Client bearer token for the OpenAI-compatible endpoints. */
  apiKey: string
  /** Default per-request output cap. */
  maxTokens: number
  /**
   * Context capacity reported for models whose upstream listing discloses none.
   * Kept on the small side deliberately: under-reporting costs an early
   * compaction, over-reporting hides provider-side truncation.
   */
  defaultContextWindow: number
  /**
   * Extra `Host` header names the console/admin surface may answer to, for
   * deployments reached through a reverse proxy or a LAN name. Loopback names,
   * **all** IP literals (not just loopback ones — see `hostAllowed`) and `host`
   * itself are always accepted; anything else is refused so a DNS-rebound page
   * cannot read the client API key.
   */
  allowedHosts: string[]
  /** Image (`image_url`) intake limits. */
  images: ImageLimits
}

export const DEFAULT_DATA_DIR = join(homedir(), '.cmdgo-bridge')

export function defaultConfig(): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 11435,
    baseURL: 'https://api.commandcode.ai',
    apiKey: randomBytes(24).toString('hex'),
    maxTokens: 64_000,
    defaultContextWindow: 262_144,
    allowedHosts: [],
    images: { ...DEFAULT_IMAGE_LIMITS },
  }
}

/** Environment overrides, applied on top of the config file (ops convenience). */
function applyImageEnv(cfg: ServerConfig, env: NodeJS.ProcessEnv): void {
  const num = (name: string): number | undefined => {
    const raw = env[name]
    if (raw === undefined || raw.trim() === '') return undefined
    const value = Number(raw)
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
  }
  const mb = num('CMDGO_IMAGE_MAX_MB')
  if (mb !== undefined) cfg.images.maxBytes = mb * 1024 * 1024
  const perRequest = num('CMDGO_IMAGE_MAX_PER_REQUEST')
  if (perRequest !== undefined) cfg.images.maxPerRequest = perRequest
  const timeout = num('CMDGO_IMAGE_FETCH_TIMEOUT_MS')
  if (timeout !== undefined) cfg.images.fetchTimeoutMs = timeout
  const flag = env.CMDGO_IMAGE_ALLOW_PRIVATE_NETWORK
  if (flag !== undefined && flag.trim() !== '') {
    cfg.images.allowPrivateNetwork = /^(1|true|yes|on)$/i.test(flag.trim())
  }
  // Deliberately parsed differently from the switch above. That one defaults to
  // `false`, so treating every unrecognized value as "off" is fail-closed and
  // harmless. This one defaults to `true`, so the same rule would let a typo
  // (`CMDGO_IMAGE_ALLOW_REMOTE=y`, `=enabled`) silently disable the switch the
  // operator was trying to set. Here only an explicit off-value turns it off, and an
  // unrecognized value leaves the configured setting alone.
  const remote = env.CMDGO_IMAGE_ALLOW_REMOTE?.trim()
  if (remote !== undefined && remote !== '') {
    if (/^(1|true|yes|on)$/i.test(remote)) cfg.images.allowRemote = true
    else if (/^(0|false|no|off)$/i.test(remote)) cfg.images.allowRemote = false
  }
}

/**
 * Strips a UTF-8 byte-order mark.
 *
 * Hand-editing these files on Windows is a documented flow (see the rotation
 * runbook), and Notepad and PowerShell's `>` / `Out-File` all prepend a BOM by
 * default. `JSON.parse` rejects it, and every caller used to treat that as
 * "corrupt", so a BOM silently cost the operator their config — including the
 * client API key — with no message explaining why.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Reads and parses a JSON object from disk, tolerating a BOM.
 *
 * Returns `undefined` when the file is absent. Throws with the path in the
 * message for unreadable or unparseable content, so a caller can tell "not
 * configured yet" apart from "misconfigured" instead of collapsing both into an
 * empty object.
 */
export async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isNotFound(error)) return undefined
    throw new Error(`${path}: 读取失败：${error instanceof Error ? error.message : String(error)}`)
  }
  let decoded: unknown
  try {
    decoded = JSON.parse(stripBom(raw))
  } catch (error) {
    throw new Error(`${path}: JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error(`${path}: 顶层不是 JSON 对象（实际是 ${Array.isArray(decoded) ? 'array' : typeof decoded}）`)
  }
  return decoded as Record<string, unknown>
}

/** Whether an error is a filesystem "no such file" error. */
export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

export class ConfigStore {
  private readonly file: string
  private readonly dir: string
  private readonly log: (message: string) => void

  constructor(dataDir: string = DEFAULT_DATA_DIR, log: (message: string) => void = () => {}) {
    this.dir = dataDir
    this.file = join(dataDir, 'config.json')
    this.log = log
  }

  get dataDir(): string {
    return this.dir
  }

  async load(): Promise<ServerConfig> {
    // Environment overrides apply on every path, including first run and the
    // corrupt-file recovery below: a return that skipped them would make
    // CMDGO_IMAGE_* silently inert exactly when someone is recovering a service.
    const resolved = await this.readConfigFile()
    applyImageEnv(resolved, process.env)
    return resolved
  }

  private async readConfigFile(): Promise<ServerConfig> {
    let parsed: Record<string, unknown>
    try {
      const decoded = await readJsonObject(this.file)
      if (decoded === undefined) return defaultConfig()
      parsed = decoded
    } catch (error) {
      // Genuinely unreadable (truncated write, transient read error). Preserve
      // the bytes for forensics and start from defaults, exactly as before —
      // but say so, because starting from defaults means a fresh client API key,
      // and the operator's downstream tools will start failing with 401 for a
      // reason nothing else in the logs explains. A BOM never reaches here:
      // `readJsonObject` strips it, which is the case that used to bite.
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      this.log(
        `[cmdgo] config.json 无法解析，已改名为 config.json.corrupt-<时间戳> 并改用默认配置：`
        + `${error instanceof Error ? error.message : String(error)}\n`
        + '[cmdgo] ⚠️ 客户端 API key 已重新随机生成，下游工具需要用新 key（控制台 CONFIG 区可复制）。',
      )
      return defaultConfig()
    }
    const cfg = defaultConfig()
    if (typeof parsed.host === 'string' && parsed.host.length > 0) cfg.host = parsed.host
    if (typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port < 65536) {
      cfg.port = parsed.port
    }
    if (typeof parsed.baseURL === 'string' && parsed.baseURL.length > 0) cfg.baseURL = parsed.baseURL
    if (typeof parsed.apiKey === 'string' && parsed.apiKey.length >= 8) cfg.apiKey = parsed.apiKey
    if (typeof parsed.maxTokens === 'number' && Number.isSafeInteger(parsed.maxTokens) && parsed.maxTokens > 0) {
      cfg.maxTokens = parsed.maxTokens
    }
    if (typeof parsed.defaultContextWindow === 'number' && Number.isSafeInteger(parsed.defaultContextWindow) && parsed.defaultContextWindow > 0) {
      cfg.defaultContextWindow = parsed.defaultContextWindow
    }
    if (Array.isArray(parsed.allowedHosts)) {
      cfg.allowedHosts = parsed.allowedHosts
        .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        .map(name => name.trim().toLowerCase())
    }
    if (typeof parsed.images === 'object' && parsed.images !== null && !Array.isArray(parsed.images)) {
      const raw = parsed.images as Partial<ImageLimits>
      const positive = (value: unknown): number | undefined =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
      const maxBytes = positive(raw.maxBytes)
      if (maxBytes !== undefined) cfg.images.maxBytes = maxBytes
      const maxPerRequest = positive(raw.maxPerRequest)
      if (maxPerRequest !== undefined) cfg.images.maxPerRequest = maxPerRequest
      const fetchTimeoutMs = positive(raw.fetchTimeoutMs)
      if (fetchTimeoutMs !== undefined) cfg.images.fetchTimeoutMs = fetchTimeoutMs
      if (typeof raw.maxRedirects === 'number' && Number.isSafeInteger(raw.maxRedirects) && raw.maxRedirects >= 0) {
        cfg.images.maxRedirects = raw.maxRedirects
      }
      if (typeof raw.allowPrivateNetwork === 'boolean') cfg.images.allowPrivateNetwork = raw.allowPrivateNetwork
      if (typeof raw.allowRemote === 'boolean') cfg.images.allowRemote = raw.allowRemote
    }
    return cfg
  }

  async save(config: ServerConfig): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: SECRET_DIR_MODE })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: SECRET_FILE_MODE })
    await rename(tmp, this.file)
  }
}