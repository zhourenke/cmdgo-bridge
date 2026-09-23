/**
 * OpenAI-compatible translation: parse `/v1/chat/completions` bodies into the
 * harness-neutral vocabulary, drive the `/alpha/generate` gateway with
 * multi-account failover, and translate gateway events back into OpenAI
 * stream / non-stream shapes.
 *
 * @module cmdgo-bridge/openai
 */

import { randomBytes } from 'node:crypto'
import type { ServerConfig } from './config.js'
import { ImageBudget, ImageError, fetchImage, parseDataUrl } from './image.js'
import type { ImageLimits } from './image.js'
import type { AccountPool, CredentialsSeam, PoolAccount } from './pool.js'
import {
  CC_VERSION,
  DEFAULT_MAX_TOKENS,
  buildRequest,
  gatewayErrorMessage,
  parseEventStream,
} from './protocol.js'
import type { CcStreamEvent } from './protocol.js'
import { CallId } from './types.js'
import type { ContentBlock, GenerateOptions, ImageBlock, Message, ToolSchema } from './types.js'

/** Parsed and normalized chat completion request. */
export interface ChatRequest {
  model: string
  messages: Message[]
  stream: boolean
  maxTokens?: number
  temperature?: number
  topP?: number
  reasoningEffort?: string
  tools?: ToolSchema[]
}

/** Request-side validation failure; mapped to a 4xx JSON error. */
export class ClientError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 400,
    /** OpenAI `error.param`, when the fault is one field. */
    readonly param?: string,
    /** OpenAI `error.code`; defaults to `invalid_request_error`. */
    readonly code = 'invalid_request_error',
  ) {
    super(message)
  }
}

/** Gateway-side failure; carries the HTTP status to surface to the client. */
export class GatewayError extends Error {
  constructor(message: string, readonly httpStatus: number, readonly code: string) {
    super(message)
  }
}

/** Error codes that justify switching to another account within one request. */
const FAILOVER_CODES = new Set(['AUTH', 'RATE_LIMIT', 'SERVER', 'TRANSPORT'])

/** Hard cap on same-request key failovers, even for very large pools. */
const MAX_FAILOVER_ATTEMPTS = 4

/** Total per-request budget for a single upstream exchange. */
export const REQUEST_TIMEOUT_MS = 600_000

/** CLI-shaped session id, mirroring the id the official `cmd` CLI mints. */
const SESSION_ID = `cli-${new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-')}`

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/* ---------------- request parsing ---------------- */

/**
 * Parse one OpenAI content part that carries an image.
 *
 * Inline `data:` URLs are decoded directly; remote URLs are fetched under an
 * SSRF guard. A malformed image is always a hard client error: silently dropping
 * one would reproduce the exact silent-vision-failure this work removes.
 */
async function parseImageUrlPart(
  part: Record<string, unknown>,
  budget: ImageBudget,
  limits: ImageLimits,
  signal?: AbortSignal,
): Promise<ImageBlock> {
  const raw = part.image_url
  const url = typeof raw === 'string'
    ? raw
    : isRecord(raw) ? optionalString(raw.url) : undefined
  if (url === undefined) {
    throw new ClientError('image_url part must carry a "url" (or be a plain string)')
  }
  budget.take()
  let image
  try {
    image = url.startsWith('data:')
      ? parseDataUrl(url, limits)
      : await fetchImage(url, limits, signal)
  } catch (error) {
    if (error instanceof ImageError) throw new ClientError(`invalid image: ${error.message}`)
    throw error
  }
  return { type: 'image', mediaType: image.mediaType, dataBase64: image.dataBase64 }
}

/**
 * OpenAI content → text blocks plus, separately, image blocks.
 *
 * Images are returned as a side channel rather than mixed into the text blocks:
 * `Message.content` feeds `flattenText` and the tool-result/assistant paths,
 * which must stay string-only.
 */
export async function parseContent(
  raw: unknown,
  budget: ImageBudget,
  limits: ImageLimits,
  signal?: AbortSignal,
): Promise<{ blocks: ContentBlock[]; images: ImageBlock[] }> {
  const blocks: ContentBlock[] = []
  const images: ImageBlock[] = []
  if (typeof raw === 'string') {
    if (raw.length > 0) blocks.push({ type: 'text', text: raw })
  } else if (Array.isArray(raw)) {
    for (const part of raw) {
      if (!isRecord(part)) continue
      if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
        blocks.push({ type: 'text', text: part.text })
        continue
      }
      if (part.type === 'image_url' || part.type === 'input_image') {
        images.push(await parseImageUrlPart(part, budget, limits, signal))
        continue
      }
      // `input_image` is handled above; anything else in the audio/video/file
      // families is refused rather than dropped, so a caller cannot believe a
      // transcription happened when the part was silently discarded.
      if (typeof part.type === 'string' && /^(input_)?(audio|video|file)/.test(part.type)) {
        throw new ClientError(`unsupported content part type: "${part.type}"`)
      }
      // Unknown part types stay ignored, matching the previous behaviour.
    }
  } else if (raw !== undefined && raw !== null) {
    throw new ClientError('message "content" must be a string or an array')
  }
  return { blocks, images }
}

/** OpenAI chat messages → harness Message[] (system stays a role; buildRequest merges it). */
export async function convertMessages(
  rawMessages: unknown,
  budget: ImageBudget,
  limits: ImageLimits,
  signal?: AbortSignal,
): Promise<Message[]> {
  if (!Array.isArray(rawMessages)) throw new ClientError('"messages" must be an array')
  const messages: Message[] = []
  for (const raw of rawMessages) {
    if (!isRecord(raw)) throw new ClientError('every message must be an object')
    const role = raw.role
    const { blocks, images } = await parseContent(raw.content, budget, limits, signal)
    // Only user messages can carry pixels upstream (assistant turns are text +
    // reasoning + tool calls, tool turns are results). Refusing the others is
    // deliberate: attaching them and dropping the field would lose content
    // silently, which is the failure mode this feature exists to remove.
    if (images.length > 0 && role !== 'user') {
      throw new ClientError(`image parts are only supported on user messages, not "${String(role)}"`)
    }
    if (role === 'system' || role === 'developer') {
      messages.push({ role: 'system', content: blocks })
      continue
    }
    if (role === 'user') {
      messages.push(images.length === 0 ? { role: 'user', content: blocks } : { role: 'user', content: blocks, extraContent: images })
      continue
    }
    if (role === 'assistant' || role === 'reasoning') {
      const reasoning = role === 'reasoning'
        ? blocks.map(b => b.type === 'text' ? { type: 'reasoning' as const, text: b.text } : b)
        : (optionalString(raw.reasoning_content) === undefined ? [] : [{ type: 'reasoning' as const, text: optionalString(raw.reasoning_content)! }])
      for (const block of reasoning) blocks.push(block)
      if (Array.isArray(raw.tool_calls)) {
        for (const toolCall of raw.tool_calls) {
          if (!isRecord(toolCall)) continue
          const fn = isRecord(toolCall.function) ? toolCall.function : {}
          const name = optionalString(fn.name) ?? ''
          const args = typeof fn.arguments === 'string'
            ? fn.arguments
            : JSON.stringify(fn.arguments ?? {})
          blocks.push({
            type: 'tool-call',
            id: CallId(optionalString(toolCall.id) ?? ''),
            name,
            arguments: args,
          })
        }
      }
      messages.push({ role: 'assistant', content: blocks })
      continue
    }
    if (role === 'tool') {
      const toolCallId = optionalString(raw.tool_call_id)
      if (toolCallId === undefined) throw new ClientError('tool message missing "tool_call_id"')
      messages.push({
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: CallId(toolCallId), content: blocks, isError: false }],
      })
      continue
    }
    throw new ClientError(`unsupported message role: ${String(role)}`)
  }
  return messages
}

function positiveInt(value: unknown, fallback: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * Reads an OpenAI token-limit field, rejecting a malformed value outright.
 *
 * The old `positiveInt` helper silently fell back to the default for anything it
 * did not recognise, so `max_tokens: 0`, `-1`, `"100"` or `1.5` all produced a
 * normal 200 whose length the caller had never asked for. A client that sets a
 * limit and silently gets a different one cannot reason about truncation, and
 * `-1` is a conventional "no limit" that this bridge does not honour — so it
 * has to be an error, not a surprise. OpenAI answers 400 with `param` naming the
 * offending field; the same shape is produced here.
 *
 * A large value like `1e9` is deliberately NOT rejected: it is a safe integer and
 * a legal token count, and callers use big sentinels to mean "as long as
 * possible". Absent and `null` mean "unset" for the same reason.
 */
function requiredPositiveInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ClientError(`${field} must be a positive integer`, 400, field)
  }
  return value
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export interface ParseRequestContext {
  imageLimits: ImageLimits
  /** Client-disconnect signal, so a remote image fetch dies with the request. */
  signal?: AbortSignal
}

export async function parseChatRequest(
  body: unknown,
  ctx: ParseRequestContext,
): Promise<ChatRequest> {
  if (!isRecord(body)) throw new ClientError('request body must be a JSON object')
  const model = optionalString(body.model)
  if (model === undefined) throw new ClientError('missing required field: "model"')
  const rawTools = Array.isArray(body.tools) ? body.tools : undefined
  const tools: ToolSchema[] | undefined = rawTools?.map((raw): ToolSchema => {
    if (isRecord(raw) && isRecord(raw.function)) {
      const fn = raw.function
      const description = optionalString(fn.description)
      return {
        name: optionalString(fn.name) ?? '',
        ...(description === undefined ? {} : { description }),
        parameters: fn.parameters ?? { type: 'object', properties: {} },
      }
    }
    return { name: '', parameters: { type: 'object', properties: {} } }
  }).filter(tool => tool.name.length > 0)
  const maxTokens = requiredPositiveInt(body.max_tokens, 'max_tokens')
    ?? requiredPositiveInt(body.max_completion_tokens, 'max_completion_tokens')
    ?? DEFAULT_MAX_TOKENS
  const budget = new ImageBudget(ctx.imageLimits)
  return {
    model,
    messages: await convertMessages(body.messages, budget, ctx.imageLimits, ctx.signal),
    stream: body.stream === true,
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(optionalNumber(body.temperature) === undefined ? {} : { temperature: optionalNumber(body.temperature) }),
    ...(optionalNumber(body.top_p) === undefined ? {} : { topP: optionalNumber(body.top_p) }),
    ...(optionalString(body.reasoning_effort) === undefined ? {} : { reasoningEffort: optionalString(body.reasoning_effort) }),
    ...(tools === undefined ? {} : { tools }),
  }
}

/* ---------------- gateway call with multi-account failover ---------------- */

export interface CompletionContext {
  cfg: ServerConfig
  pool: AccountPool
  credentials: CredentialsSeam
  /** Optional external abort (e.g. client disconnect). */
  signal?: AbortSignal
  /** Called with the account selected for each attempt (logging). */
  onAccount?: (account: PoolAccount) => void
}

/** Map a gateway HTTP status / error body to a stable failure code. */
function gatewayCode(status: number, body: string): string {
  if (status === 401 || status === 403) {
    // MODEL_NOT_IN_PLAN is a plan/permission failure, not a credential one.
    return body.includes('MODEL_NOT_IN_PLAN') ? 'PERMISSION' : 'AUTH'
  }
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    return /context|token limit|too many tokens|context length/i.test(body) ? 'CONTEXT_WINDOW_EXCEEDED' : 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** Failure code → HTTP status surfaced on the OpenAI side. */
export function clientStatus(code: string): number {
  switch (code) {
    case 'MISSING_CREDENTIAL':
    case 'AUTH':
      return 401
    case 'PERMISSION':
      return 403
    case 'RATE_LIMIT':
      return 429
    case 'CONTEXT_WINDOW_EXCEEDED':
    case 'INVALID_REQUEST':
      return 400
    case 'TIMEOUT':
      return 504
    case 'NO_ENABLED_ACCOUNT':
      return 503
    default:
      return 502
  }
}

function toGenerateOptions(req: ChatRequest): GenerateOptions {
  return {
    model: req.model,
    messages: req.messages,
    ...(req.tools === undefined ? {} : { tools: req.tools }),
    ...(req.maxTokens === undefined ? {} : { maxTokens: req.maxTokens }),
    ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
    ...(req.topP === undefined ? {} : { topP: req.topP }),
    ...(req.reasoningEffort === undefined ? {} : { reasoningEffort: req.reasoningEffort }),
  }
}

/** One guarded upstream exchange; account success clears its failure bookkeeping. */
async function* gatewayStream(
  req: ChatRequest,
  ctx: CompletionContext,
  apiKey: string,
  account: PoolAccount,
): AsyncGenerator<CcStreamEvent> {
  const body = buildRequest(toGenerateOptions(req))
  const totalBudget = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const signal = ctx.signal === undefined ? totalBudget : AbortSignal.any([ctx.signal, totalBudget])
  let response: Response
  try {
    response = await fetch(`${ctx.cfg.baseURL.replace(/\/+$/, '')}/alpha/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // 请求指纹与官方 cmd CLI 对齐：UA 版本与 x-command-code-version 必须一致。
        'user-agent': `commandcode/${CC_VERSION}`,
        'x-command-code-version': CC_VERSION,
        'x-cli-environment': 'production',
        'x-taste-learning': 'false',
        'x-session-id': SESSION_ID,
        'x-project-slug': 'cmdgo-bridge',
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    })
  } catch (error) {
    if (ctx.signal?.aborted) throw error
    if (signal.aborted) throw new GatewayError('Command Code 网关请求超时', 504, 'TIMEOUT')
    throw new GatewayError(
      `Command Code 请求失败：${error instanceof Error ? error.message : String(error)}`,
      502,
      'TRANSPORT',
    )
  }
  if (!response.ok) {
    const raw = await response.text().catch(() => '')
    const message = gatewayErrorMessage(raw) ?? `Command Code API error (HTTP ${response.status})`
    const code = gatewayCode(response.status, raw)
    throw new GatewayError(`${message} [model=${req.model}]`, clientStatus(code), code)
  }
  // 网关已接受该 key：清掉账号上的失败记账。
  ctx.pool.reportSuccess(account)
  if (!response.body) throw new GatewayError('Command Code 网关返回了空响应体', 502, 'EMPTY_RESPONSE')
  yield* parseEventStream(response.body)
}

/**
 * Resolves the pool account and upstream key for one attempt.
 *
 * Shared by {@link openGateway} and {@link preflightAccount} so the streaming
 * path can surface a missing credential *before* committing SSE headers
 * without duplicating — and drifting from — the failover loop's error codes.
 * Errors are `GatewayError`s whose `httpStatus`/`code` the caller passes
 * straight to the client: 401 `MISSING_CREDENTIAL` for an empty pool or a lost
 * key, 503 `NO_ENABLED_ACCOUNT` when every account is switched off.
 */
async function resolveAccount(ctx: CompletionContext): Promise<{ account: PoolAccount; apiKey: string }> {
  const account = ctx.pool.size > 0 ? ctx.pool.pick() : undefined
  if (account === undefined) {
    const empty = ctx.pool.size === 0
    throw new GatewayError(
      empty
        ? '没有可用的 Command Code 账号凭据；请先在控制台完成 OAuth 登录'
        : '账号池中没有任何已启用的账号；请在控制台启用至少一个账号',
      empty ? 401 : 503,
      empty ? 'MISSING_CREDENTIAL' : 'NO_ENABLED_ACCOUNT',
    )
  }
  const apiKey = await ctx.pool.keyOf(ctx.credentials, account)
  if (apiKey === undefined) {
    throw new GatewayError(`账号 ${account.id} 的凭据缺失；请在控制台重新登录`, 401, 'MISSING_CREDENTIAL')
  }
  return { account, apiKey }
}

/**
 * Reports whether a request can reach the gateway at all, without resolving an
 * account or advancing the round-robin cursor.
 *
 * The streaming path calls this before `flushHeaders()`: once SSE headers are
 * on the wire the status code is frozen at 200, so a request that could never
 * start (no account, no key) would otherwise reach the client as a 200 with an
 * empty answer instead of a 401/503 it can act on.
 */
export async function poolState(ctx: CompletionContext): Promise<GatewayError | undefined> {
  await ctx.pool.ensureLoaded()
  if (ctx.pool.size === 0) {
    return new GatewayError('没有可用的 Command Code 账号凭据；请先在控制台完成 OAuth 登录', 401, 'MISSING_CREDENTIAL')
  }
  return undefined
}

/**
 * Stream gateway events for one completion, failing over to the next pool
 * account on pre-first-byte auth / rate-limit / server / transport errors.
 * Once an event has been yielded, errors propagate unchanged — a half-delivered
 * answer must never be silently replayed.
 */
export async function* openGateway(req: ChatRequest, ctx: CompletionContext): AsyncGenerator<CcStreamEvent> {
  // The pool loads lazily from disk while `pick()` reads in-memory state
  // synchronously, so a request arriving before the first load would see an
  // empty pool and be rejected with a bogus MISSING_CREDENTIAL.
  await ctx.pool.ensureLoaded()
  // Resolve once up front so the pre-yield failure path can reuse the exact
  // error the loop would have thrown. `attempts` stays keyed off the pool size,
  // and only the loop below consumes a round-robin cursor slot.
  const preflight = await poolState(ctx)
  if (preflight !== undefined) throw preflight
  const attempts = Math.max(1, Math.min(Math.max(1, ctx.pool.size), MAX_FAILOVER_ATTEMPTS))
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { account, apiKey } = await resolveAccount(ctx)
    ctx.onAccount?.(account)
    let yielded = false
    try {
      for await (const event of gatewayStream(req, ctx, apiKey, account)) {
        yielded = true
        yield event
      }
      return
    } catch (error) {
      if (yielded || attempt >= attempts - 1) throw error
      if (!(error instanceof GatewayError) || !FAILOVER_CODES.has(error.code)) throw error
      ctx.pool.reportFailure(account, error.message)
    }
  }
}

/* ---------------- event accumulation ---------------- */

export interface ToolCallRecord {
  id: string
  name: string
  arguments: string
}

export interface Accumulator {
  content: string
  reasoning: string
  toolCalls: ToolCallRecord[]
  finishReason: string | null
  /**
   * Whether the gateway actually sent a `finish-step`.
   *
   * Distinguishes "the model stopped and said why" from "the stream ended";
   * the latter leaves `finishReason` null rather than inventing `'stop'`.
   */
  finishStepSeen: boolean
  /**
   * Uncached input tokens, disjoint from `cacheReadTokens`.
   *
   * The gateway reports the two halves separately (`noCacheTokens` /
   * `cacheReadTokens`), which is not the OpenAI wire convention: there
   * `prompt_tokens` is the total input and `cached_tokens` a subset of it.
   * The halves are summed only at serialization — see {@link usageObject}.
   */
  uncachedInputTokens: number
  /** Upstream's own `outputTokens`, or undefined when it did not report one. */
  reportedCompletionTokens?: number
  /**
   * Visible-answer characters counted from the deltas themselves, independent of
   * anything the gateway reports.
   *
   * The gateway's counters only arrive with `finish-step`. A stream that ends
   * without one — a normal end, not a failure — would otherwise serialize
   * `completion_tokens: 0` while carrying a complete answer, which downstream
   * books as a free success and under-bills the account. Characters are the
   * proxy rather than words because whitespace tokenisation collapses CJK text
   * to nothing.
   */
  streamedTextChars: number
  /** Gateway-reported visible-answer tokens (`outputTokenDetails.textTokens`). */
  reportedTextTokens?: number
  cacheReadTokens: number
  reasoningTokens: number
}

/** Rough characters-per-token ratio for the synthesized fallback count. */
const CHARS_PER_TOKEN = 4

/**
 * Completion token count for the OpenAI wire.
 *
 * The gateway reports the visible answer (`textTokens`) and the hidden reasoning
 * (`reasoningTokens`) as separate counters, and sometimes reports `outputTokens`
 * as well. The OpenAI contract is that `completion_tokens_details` describes a
 * SUBSET of `completion_tokens`, and several widely used tokenizers derive the
 * visible tokens by subtracting the reasoning count from the total. Reporting
 * upstream's `outputTokens` verbatim — which appears to count only the visible
 * answer, or to omit a trailing reasoning block — put `reasoning_tokens` ABOVE
 * `completion_tokens`, so those consumers clamped the visible count to zero and
 * derived no usage at all.
 *
 * So: trust the explicit total when it is at least the sum of the parts, use the
 * sum when it is larger, and never let the total fall below `reasoning_tokens`.
 * When the gateway reported nothing at all, the synthesized count from the
 * streamed characters is the only evidence of what was delivered.
 */
export function completionTokensOf(
  acc: Pick<Accumulator, 'reportedCompletionTokens' | 'reportedTextTokens' | 'streamedTextChars' | 'reasoningTokens'>,
): number {
  // Every field defaults to 0 individually rather than relying on the caller to
  // supply a whole accumulator: this is exported, and a single missing counter
  // used to turn the whole result into NaN, which then serialized as `null`.
  const reasoning = acc.reasoningTokens ?? 0
  const streamed = acc.streamedTextChars ?? 0
  const reportedParts = (acc.reportedTextTokens ?? 0) + reasoning
  const parts = Math.max(reportedParts, Math.ceil(streamed / CHARS_PER_TOKEN) + reasoning)
  return Math.max(acc.reportedCompletionTokens ?? 0, parts) || 0
}

export function emptyAccumulator(): Accumulator {
  return {
    content: '',
    reasoning: '',
    toolCalls: [],
    finishReason: null,
    finishStepSeen: false,
    uncachedInputTokens: 0,
    reportedCompletionTokens: undefined,
    streamedTextChars: 0,
    reportedTextTokens: undefined,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  }
}

/** Fold one gateway event into the accumulator. */
export function applyEvent(acc: Accumulator, event: CcStreamEvent): void {
  switch (event.type) {
    case 'text-delta': {
      const text = typeof event.text === 'string' ? event.text : ''
      acc.content += text
      // Counted here, not from `finish-step`, so a stream that ends without one
      // still reports the tokens it delivered.
      acc.streamedTextChars += text.length
      break
    }
    case 'reasoning-delta': {
      const text = typeof event.text === 'string' ? event.text : ''
      acc.reasoning += text
      break
    }
    case 'tool-call': {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId
        : typeof event.id === 'string' ? event.id
          : ''
      const name = typeof event.toolName === 'string' ? event.toolName : ''
      const input = event.input ?? event.args ?? event.arguments
      acc.toolCalls.push({
        id,
        name,
        arguments: JSON.stringify(input ?? {}),
      })
      break
    }
    case 'finish-step': {
      acc.finishReason = finishReasonOf(event.finishReason ?? event.rawFinishReason)
      acc.finishStepSeen = true
      const usage = isRecord(event.usage) ? event.usage : undefined
      if (usage !== undefined) {
        const inputDetails = isRecord(usage.inputTokenDetails) ? usage.inputTokenDetails : undefined
        const outputDetails = isRecord(usage.outputTokenDetails) ? usage.outputTokenDetails : undefined
        const cacheRead = optionalNumber(inputDetails?.cacheReadTokens)
        const noCache = optionalNumber(inputDetails?.noCacheTokens)
        const totalInput = optionalNumber(usage.inputTokens)
        acc.uncachedInputTokens = noCache ?? (totalInput !== undefined && cacheRead !== undefined
          ? Math.max(0, totalInput - cacheRead)
          : totalInput) ?? 0
        acc.cacheReadTokens = cacheRead ?? 0
        acc.reportedCompletionTokens = optionalNumber(usage.outputTokens)
        acc.reportedTextTokens = optionalNumber(outputDetails?.textTokens)
        acc.reasoningTokens = optionalNumber(outputDetails?.reasoningTokens) ?? 0
      }
      break
    }
    default:
      break
  }
}

/**
 * Map the gateway finish-reason vocabulary to the OpenAI one.
 *
 * Returns null for anything unrecognised — including a missing field — because
 * `finish_reason` is how a consumer decides whether an answer is complete, and
 * the OpenAI schema allows null for "not applicable". Folding an unknown or
 * absent reason into `'stop'` claims the model chose to end its turn when the
 * bridge does not actually know that.
 */
function finishReasonOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  switch (raw) {
    case 'stop':
    case 'end_turn':
      return 'stop'
    case 'tool_calls':
    case 'tool-calls':
      return 'tool_calls'
    case 'length':
    case 'max_tokens':
    case 'max-output-tokens':
      return 'length'
    default:
      return null
  }
}

/* ---------------- response assembly ---------------- */

export function chatCompletionId(): string {
  return `chatcmpl-${randomBytes(8).toString('hex')}`
}

/**
 * OpenAI-shaped usage for one completion.
 *
 * `prompt_tokens` must be the TOTAL input, with
 * `prompt_tokens_details.cached_tokens` a subset of it
 * (`cached_tokens <= prompt_tokens`). The gateway reports the uncached and
 * cached halves disjointly, so they are summed here.
 *
 * Emitting the uncached half alone puts `cached_tokens` above `prompt_tokens`,
 * and every spec-compliant consumer that derives the uncached remainder by
 * subtraction (`prompt_tokens - cached_tokens` — the harness TokenUsage
 * contract requires exactly that) clamps the result to zero: the uncached
 * count vanishes and the full-rate portion goes unbilled.
 *
 * Exported so the streaming and non-streaming paths cannot drift apart.
 */
export function usageObject(acc: Accumulator): unknown {
  const promptTokens = acc.uncachedInputTokens + acc.cacheReadTokens
  const completionTokens = completionTokensOf(acc)
  // Reasoning is reported as a detail of the completion total, so it must be
  // clamped to it as well; a detail larger than its parent is invalid wire data.
  const reasoningTokens = Math.min(acc.reasoningTokens, completionTokens)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: acc.cacheReadTokens },
    completion_tokens_details: { reasoning_tokens: reasoningTokens },
  }
}

function toolCallsObject(calls: ToolCallRecord[]): unknown[] {
  return calls.map(call => ({
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: call.arguments },
  }))
}

/** Non-streaming chat completion body. */
export function buildNonStream(req: ChatRequest, acc: Accumulator): unknown {
  return {
    id: chatCompletionId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: acc.content,
        ...(acc.reasoning.length > 0 ? { reasoning_content: acc.reasoning } : {}),
        ...(acc.toolCalls.length > 0 ? { tool_calls: toolCallsObject(acc.toolCalls) } : {}),
      },
      // The gateway's own reason when it gave one; null when the stream ended
      // without a recognised `finish-step`. Claiming `'stop'` here would tell a
      // consumer the model finished its turn on evidence the bridge never got.
      finish_reason: acc.finishStepSeen ? acc.finishReason : null,
    }],
    usage: usageObject(acc),
  }
}