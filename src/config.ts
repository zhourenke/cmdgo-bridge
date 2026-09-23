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
   * IP literals and `host` itself are always accepted; anything else is refused
   * so a DNS-rebound page cannot read the client API key.
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
}

export class ConfigStore {
  private readonly file: string
  private readonly dir: string

  constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dir = dataDir
    this.file = join(dataDir, 'config.json')
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
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      // Absent (first run) or unreadable: start fresh with a new client key.
      return defaultConfig()
    }
    let parsed: Partial<ServerConfig>
    try {
      const decoded: unknown = JSON.parse(raw)
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        throw new Error('config root is not an object')
      }
      parsed = decoded as Partial<ServerConfig>
    } catch {
      // Preserve the unreadable file. The caller saves immediately after load,
      // so returning defaults outright would silently discard baseURL and the
      // client API key on a truncated write or a transient read error.
      await rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
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
    }
    return cfg
  }

  async save(config: ServerConfig): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(config, null, 2), 'utf8')
    await rename(tmp, this.file)
  }
}