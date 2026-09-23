/**
 * File-backed credential store implementing the pool's CredentialsSeam:
 * a flat JSON map of ref → key in the data directory.
 *
 * @module cmdgo-bridge/credentials
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readJsonObject } from './config.js'
import type { CredentialRef, CredentialsSeam } from './pool.js'

type StoreShape = Record<string, { value: string; source?: string }>

export class FileCredentials implements CredentialsSeam {
  private readonly file: string
  private readonly log: (message: string) => void
  private cache: StoreShape | undefined
  /** Why the file could not be used, for `/api/status` and the startup log. */
  private lastError: string | undefined
  /** Serializes mutations so concurrent set/unset cannot interleave. */
  private queue: Promise<void> = Promise.resolve()

  constructor(dataDir: string, log: (message: string) => void = () => {}) {
    this.file = join(dataDir, 'credentials.json')
    this.log = log
  }

  private async read(): Promise<StoreShape> {
    if (this.cache !== undefined) return this.cache
    try {
      const parsed = await readJsonObject(this.file)
      this.cache = (parsed ?? {}) as StoreShape
      this.lastError = undefined
    } catch (error) {
      // Keep the file in place: unlike config.json this is never rewritten on
      // load, and a parse error here used to present as "no account configured"
      // — indistinguishable from a fresh install, and with no hint that the
      // bytes on disk were the problem. Say so instead of swallowing it.
      this.cache = {}
      this.lastError = error instanceof Error ? error.message : String(error)
      this.log(
        `[cmdgo] ⚠️ credentials.json 无法解析，本次按"未配置凭据"处理（文件保持原样，未删除）：${this.lastError}\n`
        + '[cmdgo]    常见原因：编辑器写入了 UTF-8 BOM 或文件被截断。修好后可 POST /api/reload 热加载，无需重启。',
      )
    }
    return this.cache
  }

  /** Last parse/read failure, or undefined when the file was usable. */
  diagnose(): { error?: string } {
    return this.lastError === undefined ? {} : { error: this.lastError }
  }

  /**
   * Drops the in-memory copy so the next read comes from disk.
   *
   * Lets an operator repair a BOM-mangled file and have it take effect without
   * a restart; see `POST /api/reload`.
   */
  invalidate(): void {
    this.cache = undefined
    this.lastError = undefined
  }

  private async write(store: StoreShape): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
    await rename(tmp, this.file)
  }

  /**
   * Apply one mutation, committing it to the in-memory cache only after the
   * write lands. Mutating the cache first left memory and disk disagreeing
   * whenever the write failed (read-only directory, full disk), so later reads
   * reported a credential that had never been persisted.
   */
  private mutate(apply: (store: StoreShape) => StoreShape | undefined): Promise<void> {
    const run = async (): Promise<void> => {
      const current = await this.read()
      const next = apply({ ...current })
      if (next === undefined) return
      await this.write(next)
      this.cache = next
    }
    const result = this.queue.then(run, run)
    this.queue = result.catch(() => {})
    return result
  }

  async resolve(ref: CredentialRef): Promise<{ value: string } | undefined> {
    const store = await this.read()
    const entry = store[ref]
    return entry !== undefined && entry.value.length > 0 ? { value: entry.value } : undefined
  }

  async describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string }> {
    const store = await this.read()
    const entry = store[ref]
    const configured = entry !== undefined && entry.value.length > 0
    return {
      configured,
      ...(configured ? { source: entry.source ?? 'file' } : {}),
    }
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    await this.mutate((store) => {
      store[ref] = { value, ...(store[ref]?.source === undefined ? {} : { source: store[ref].source }) }
      return store
    })
  }

  async unset(ref: CredentialRef): Promise<void> {
    await this.mutate((store) => {
      if (store[ref] === undefined) return undefined
      delete store[ref]
      return store
    })
  }
}