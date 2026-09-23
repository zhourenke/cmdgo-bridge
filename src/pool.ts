/**
 * Multi-account credential pool for the Command Code Go bridge.
 *
 * Each OAuth login yields one API key; pooling several keys multiplies the
 * plan quota. Keys live in a small JSON credential store (`credentials.json`)
 * under per-account refs, while `accounts.json` keeps pool metadata — ids,
 * labels, enabled flags, failure cooldowns — across restarts.
 *
 * Scheduling: round-robin over enabled accounts whose cooldown has expired;
 * a failed request puts its account on an exponential cool-down (capped) and
 * the caller fails over to the next pick within the same request.
 *
 * @module cmdgo-bridge/pool
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { SECRET_DIR_MODE, SECRET_FILE_MODE } from './secrets.js'
import { readJsonObject } from './config.js'

/**
 * The account manifest exists but cannot be parsed.
 *
 * Distinct from "no accounts yet": callers must not treat this as an empty
 * pool, because persisting afterwards would overwrite the only copy.
 */
export class ManifestError extends Error {
  override readonly name = 'ManifestError'
}

/** Credential store reference: a plain string naming an entry in the store. */
export type CredentialRef = string

/** One pooled account. The API key itself never appears here — only its ref. */
export interface PoolAccount {
  /** Stable short id (slug + random suffix); also names the credential ref. */
  id: string
  /** Credential store reference holding this account's key. */
  ref: CredentialRef
  userName?: string
  keyName?: string
  addedAt: number
  enabled: boolean
  /** Consecutive failed requests; reset on success. */
  failCount: number
  /** Epoch ms until which the scheduler skips this account. */
  cooldownUntil?: number
  lastError?: string
  lastUsedAt?: number
}

interface Manifest {
  version: 1
  accounts: PoolAccount[]
}

/** First failure cools down for this long; doubles per consecutive failure. */
const COOLDOWN_BASE_MS = 30_000
/** Upper bound for the exponential cool-down. */
const COOLDOWN_MAX_MS = 15 * 60_000

function slug(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 16) : fallback
}

export interface CredentialsSeam {
  resolve(ref: CredentialRef): Promise<{ value: string } | undefined>
  describe(ref: CredentialRef): Promise<{ configured: boolean; source?: string }>
  set(ref: CredentialRef, value: string): Promise<void>
  unset(ref: CredentialRef): Promise<void>
}

export interface PoolOptions {
  /** Base credential ref; per-account refs derive from it. */
  baseRef: string
  /** Directory holding `accounts.json` (pool metadata). */
  dataDir: string
  log?: (message: string) => void
}

/**
 * The account pool. All mutations persist the manifest; all key material is
 * delegated to the credential store.
 */
export class AccountPool {
  private accounts: PoolAccount[] = []
  /** In-flight or completed first load, shared by concurrent callers. */
  private loadPromise: Promise<void> | undefined
  /** Serializes manifest writes; see `persist`. */
  private persistQueue: Promise<void> = Promise.resolve()
  /** Round-robin cursor into the last usable ordering. */
  private cursor = 0
  private readonly baseRef: string
  private readonly dataDir: string
  private readonly log: (message: string) => void

  constructor(options: PoolOptions) {
    this.baseRef = options.baseRef
    this.dataDir = options.dataDir
    this.log = options.log ?? (() => {})
  }

  private get file(): string {
    return join(this.dataDir, 'accounts.json')
  }

  private refFor(id: string): CredentialRef {
    return `${this.baseRef}_${id.toUpperCase().replace(/[^A-Z0-9]/g, '')}` as CredentialRef
  }

  /**
   * Load the manifest once (idempotent, shared across concurrent callers).
   * Public so a caller that picks synchronously can await readiness first.
   */
  ensureLoaded(): Promise<void> {
    // Share one in-flight load. Setting the flag before the await let a second
    // caller through while `accounts` was still empty: `add()` would then
    // persist a manifest containing only its own account, wiping the rest.
    this.loadPromise ??= this.load()
    // A rejected load must not be cached, or every later call re-throws the
    // first failure and repairing the file could never take effect.
    this.loadPromise.catch(() => { this.loadPromise = undefined })
    return this.loadPromise
  }

  private async load(): Promise<void> {
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = await readJsonObject(this.file)
    } catch (error) {
      // Refuse to continue rather than start with an empty pool. An empty pool
      // and a corrupt manifest look identical to every caller, and the first
      // `add`/`toggle`/`reportFailure` would persist that emptiness over the
      // operator's only copy of the account list. A BOM does not land here —
      // `readJsonObject` strips it.
      throw new ManifestError(
        `accounts.json 无法解析：${error instanceof Error ? error.message : String(error)}\n`
        + '  已停止加载以免用空账号池覆盖它。请修复或删除该文件后重启：\n'
        + `    ${this.file}`,
      )
    }
    if (parsed === undefined) {
      this.accounts = []
      return
    }
    if (!Array.isArray(parsed.accounts)) {
      this.accounts = []
      return
    }
    this.accounts = parsed.accounts.filter((a): a is PoolAccount =>
      typeof (a as PoolAccount)?.id === 'string'
      && typeof (a as PoolAccount)?.ref === 'string'
      && typeof (a as PoolAccount)?.addedAt === 'number')
  }

  /**
   * Re-reads the manifest from disk, discarding the in-memory copy.
   *
   * Exposed through `POST /api/reload`: hand-editing `accounts.json` was
   * previously inert until a restart, and the in-memory copy is authoritative
   * afterwards, so an edit made while the bridge runs would be overwritten by
   * the next mutation.
   */
  async reload(): Promise<PoolAccount[]> {
    this.loadPromise = undefined
    await this.ensureLoaded()
    return this.list()
  }

  /**
   * Persist the manifest. The payload is snapshotted at call time and the
   * writes are serialized: `reportFailure` persists without awaiting, and
   * unserialized renames can complete out of order, letting a stale snapshot
   * overwrite a newer one.
   *
   * Never rejects: the write is best-effort, and a rejected promise here would
   * be an unhandled rejection at the fire-and-forget call sites. The failure is
   * logged instead, so a read-only data directory cannot silently discard
   * account state.
   */
  private persist(): Promise<void> {
    const path = this.file
    const payload = JSON.stringify({ version: 1, accounts: this.accounts } satisfies Manifest, null, 2)
    const run = async (): Promise<void> => {
      try {
        await mkdir(dirname(path), { recursive: true, mode: SECRET_DIR_MODE })
        const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
        await writeFile(tmp, payload, { encoding: 'utf8', mode: SECRET_FILE_MODE })
        await rename(tmp, path)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log(`[cmdgo] 账号清单写入失败（不影响本次会话）：${message}`)
        // Stderr as well as the log callback: the account state on disk is now
        // out of step with memory, and a lost manifest is not a routine event.
        console.error(`[cmdgo] 账号清单写入失败：${path} — ${message}`)
      }
    }
    const result = this.persistQueue.then(run, run)
    this.persistQueue = result
    return result
  }

  /**
   * Waits for every queued manifest write to finish.
   *
   * Shutdown calls this so a `toggle` or a cool-down update made a moment before
   * SIGTERM is not lost with the process. Also useful to tests that need the
   * file on disk to reflect a mutation.
   */
  async flush(): Promise<void> {
    // The queue can grow while draining (a write that schedules another), so
    // re-check until it stops moving.
    let seen = this.persistQueue
    await seen
    while (seen !== this.persistQueue) {
      seen = this.persistQueue
      await seen
    }
  }

  async list(): Promise<PoolAccount[]> {
    await this.ensureLoaded()
    return [...this.accounts]
  }

  get size(): number {
    return this.accounts.length
  }

  /** Accounts the scheduler may use right now (enabled, cooldown expired). */
  activeCount(now = Date.now()): number {
    return this.accounts.filter(a => a.enabled && (a.cooldownUntil ?? 0) <= now).length
  }

  /** Whether any stored account already holds exactly this key. */
  async findByKey(credentials: CredentialsSeam, apiKey: string): Promise<PoolAccount | undefined> {
    await this.ensureLoaded()
    for (const account of this.accounts) {
      try {
        const hit = await credentials.resolve(account.ref)
        if (hit !== undefined && hit.value === apiKey) return account
      } catch (_resolveFailure) { /* 下一个 */ }
    }
    return undefined
  }

  /** Store a fresh key as a new account; returns the created record. */
  async add(credentials: CredentialsSeam, info: { apiKey: string; userName?: string; keyName?: string }): Promise<PoolAccount> {
    await this.ensureLoaded()
    let id = slug(info.userName ?? info.keyName, 'acct')
    // Uniqueness must hold for the derived credential ref, not just the id:
    // `refFor` strips non-alphanumerics, so ids `a-b` and `ab` both map to
    // `…_AB` and the second key would silently overwrite the first account's.
    const takenIds = new Set(this.accounts.map(a => a.id))
    const takenRefs = new Set(this.accounts.map(a => a.ref))
    const collides = (candidate: string): boolean =>
      takenIds.has(candidate) || takenRefs.has(this.refFor(candidate))
    if (collides(id)) id = `${id}-${randomBytes(2).toString('hex')}`
    while (collides(id)) id = `${id}${randomBytes(1).toString('hex')}`
    const account: PoolAccount = {
      id,
      ref: this.refFor(id),
      ...(info.userName === undefined ? {} : { userName: info.userName }),
      ...(info.keyName === undefined ? {} : { keyName: info.keyName }),
      addedAt: Date.now(),
      enabled: true,
      failCount: 0,
    }
    await credentials.set(account.ref, info.apiKey)
    this.accounts.push(account)
    await this.persist()
    this.log(`[cmdgo] 账号入池：${id}（${info.userName ?? '?'} · ${info.keyName ?? '?'}），池大小 ${this.accounts.length}`)
    return account
  }

  /** Refresh label metadata when a re-login returns a known key. */
  touchMeta(account: PoolAccount, info: { userName?: string; keyName?: string }): void {
    if (info.userName !== undefined) account.userName = info.userName
    if (info.keyName !== undefined) account.keyName = info.keyName
    void this.persist()
  }

  /** Round-robin pick: enabled, cooled-down accounts first; all-cooling falls back to the least-cooled. */
  pick(now = Date.now()): PoolAccount | undefined {
    const usable = this.accounts.filter(a => a.enabled && (a.cooldownUntil ?? 0) <= now)
    if (usable.length > 0) {
      const picked = usable[this.cursor % usable.length]
      if (picked === undefined) return undefined
      this.cursor = (this.cursor + 1) % usable.length
      picked.lastUsedAt = now
      return picked
    }
    const enabled = this.accounts.filter(a => a.enabled)
    if (enabled.length === 0) return undefined
    return enabled.reduce((soonest, a) =>
      ((a.cooldownUntil ?? 0) < (soonest.cooldownUntil ?? 0) ? a : soonest))
  }

  /** Resolve the API key of one account through the credential store. */
  async keyOf(credentials: CredentialsSeam, account: PoolAccount): Promise<string | undefined> {
    try {
      const hit = await credentials.resolve(account.ref)
      return hit !== undefined && hit.value.length > 0 ? hit.value : undefined
    } catch (_resolveFailure) {
      return undefined
    }
  }

  /** Record a request failure: grow the cool-down exponentially. */
  reportFailure(account: PoolAccount, message: string, now = Date.now()): void {
    account.failCount += 1
    const ms = Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (account.failCount - 1))
    account.cooldownUntil = now + ms
    account.lastError = message.slice(0, 200)
    void this.persist()
    this.log(`[cmdgo] 账号 ${account.id} 请求失败（第 ${account.failCount} 次），冷却 ${Math.round(ms / 1000)}s：${account.lastError}`)
  }

  /** Record a healthy exchange: clear failure bookkeeping. */
  reportSuccess(account: PoolAccount): void {
    if (account.failCount === 0 && account.cooldownUntil === undefined && account.lastError === undefined) return
    account.failCount = 0
    account.cooldownUntil = undefined
    account.lastError = undefined
    void this.persist()
  }

  /**
   * Enable/disable one account and wait for the manifest to be written.
   *
   * Async so the admin endpoint can report a persistence failure instead of
   * returning `{ok:true}` for a change that never reached disk — after a restart
   * the account would silently be enabled again.
   */
  async toggle(id: string, enabled: boolean): Promise<boolean> {
    await this.ensureLoaded()
    const account = this.accounts.find(a => a.id === id)
    if (account === undefined || account.enabled === enabled) return false
    account.enabled = enabled
    if (!enabled) account.cooldownUntil = undefined
    await this.persist()
    return true
  }

  /** Remove one account and delete its stored key. */
  async remove(credentials: CredentialsSeam | undefined, id: string): Promise<boolean> {
    await this.ensureLoaded()
    const index = this.accounts.findIndex(a => a.id === id)
    if (index < 0) return false
    const [gone] = this.accounts.splice(index, 1)
    if (gone === undefined) return false
    if (credentials !== undefined) {
      try { await credentials.unset(gone.ref) } catch (_unsetFailure) { /* 键可能已被外部删除 */ }
    }
    if (this.cursor >= Math.max(1, this.accounts.length)) this.cursor = 0
    await this.persist()
    return true
  }

  /** Remove every pooled account (full wipe). */
  async clear(credentials: CredentialsSeam | undefined): Promise<number> {
    await this.ensureLoaded()
    const count = this.accounts.length
    for (const account of [...this.accounts]) {
      await this.remove(credentials, account.id)
    }
    return count
  }
}