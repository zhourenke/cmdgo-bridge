/**
 * Command Code Go wire protocol: serialize a completion call into the private
 * `/alpha/generate` gateway envelope and parse its line-delimited JSON stream
 * back into events.
 *
 * Message content carries text, but user messages may also carry image parts
 * (`{ type: 'image', source: { type: 'base64', media_type, data } }`), which the
 * gateway validates and the models do read — see `test/upstream-image-probe.mjs`
 * for the envelope shapes that were probed and rejected. A message without
 * images still serializes to a plain string so existing conversations keep
 * their upstream prompt-cache prefix.
 *
 * The Go plan is the only Command Code plan without Provider-API access, so
 * the standard OpenAI-compatible endpoints answer 403 `upgrade_required` for
 * a Go subscription. The CLI gateway at `POST /alpha/generate` is the
 * transport every Go-plan request must use.
 *
 * The request envelope shape mirrors the `cmd` CLI (`command-code` npm
 * package): `config.environment` is a plain string (`<os>-<arch>`), not an
 * object; gateway compatibility rides on the `x-command-code-version` header.
 *
 * @module cmdgo-bridge/protocol
 * @see https://github.com/MAXeaglet/commandcode-proxy
 * @see https://github.com/synthetic-coworkers/cmdcode2api
 */

import { platform, arch } from 'node:os'
import type { ContentBlock, GenerateOptions, Message, ToolSchema } from './types.js'

/**
 * Gateway version pinned to a known-good Command Code CLI release. The gateway
 * checks the `x-command-code-version` header against the `User-Agent` version,
 * so both must track the same CLI release (v1.31.0 — envelope verified
 * unchanged against the CLI in use when the reference plugin was written).
 */
export const CC_VERSION = '1.31.0'

/** Last-resort output cap when a request carries no maxTokens. */
export const DEFAULT_MAX_TOKENS = 64_000

/** Line-delimited JSON stream: one JSON object per line (not SSE `data:` framing). */
export interface CcStreamEvent {
  type: string
  [key: string]: unknown
}

export interface CcUsage {
  inputTokens?: number
  outputTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
  }
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
}

/** Tool call inside an assistant message, as the gateway wants it. */
interface CcToolCallContent {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
}

/** Tool result inside a tool-role message. */
interface CcToolResultContent {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: { type: 'text' | 'error-text'; value: string }
}

/** Image content block, as verified against the live gateway. */
interface CcImageContent {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

/** Text content block inside a user-message part array. */
interface CcTextContent {
  type: 'text'
  text: string
}

type CcUserContent = string | Array<CcTextContent | CcImageContent>

type CcMessage =
  | { role: 'user'; content: CcUserContent }
  | { role: 'assistant'; content: Array<{ type: 'text'; text: string } | { type: 'reasoning'; text: string } | CcToolCallContent> }
  | { role: 'tool'; content: CcToolResultContent[] }

interface CcTool {
  type: 'function'
  name: string
  description?: string
  input_schema: unknown
}

interface CcRequestEnvelope {
  config: {
    workingDir: string
    date: string
    environment: string
    structure: unknown[]
    isGitRepo: boolean
    currentBranch: string
    mainBranch: string
    gitStatus: string
    recentCommits: unknown[]
  }
  memory: string
  taste: string
  skills: null
  permissionMode: string
  params: {
    model: string
    messages: CcMessage[]
    tools: CcTool[]
    system: string
    max_tokens: number
    stream: true
    temperature?: number
    top_p?: number
    reasoning_effort?: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The flattened text of a message's content blocks. */
function flattenText(blocks: ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function toolResultOutput(
  result: Extract<ContentBlock, { type: 'tool-result' }>,
): CcToolResultContent['output'] {
  const value = flattenText(result.content)
  return result.isError
    ? { type: 'error-text', value: value || 'Execution denied' }
    : { type: 'text', value: value || '(no output)' }
}

function serializeAssistant(message: Message): Extract<CcMessage, { role: 'assistant' }> {
  const parts: Extract<CcMessage, { role: 'assistant' }>['content'] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoning') {
      parts.push({ type: 'reasoning', text: block.text })
    } else if (block.type === 'tool-call') {
      parts.push({
        type: 'tool-call',
        toolCallId: block.id,
        toolName: block.name,
        input: safeParseJson(block.arguments),
      })
    }
  }
  return { role: 'assistant', content: parts }
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Serialize a user/tool message.
 *
 * Cache-critical: a message with no images serializes to exactly the string
 * content it always has. The upstream prompt cache is a *prefix* cache, so
 * switching text-only requests to a part array would invalidate every cached
 * token of every existing conversation. Images therefore switch the shape only
 * for messages that actually carry them.
 */
function serializeUser(message: Message): CcMessage {
  const toolResults = message.content.filter(
    (block): block is Extract<ContentBlock, { type: 'tool-result' }> => block.type === 'tool-result',
  )
  const text = flattenText(message.content)
  const images = message.extraContent ?? []
  if (images.length > 0) {
    // Text first, then images: the model reads the instruction before the pixels,
    // and appending keeps the text prefix identical to the text-only case.
    const parts: Array<CcTextContent | CcImageContent> = []
    if (text.length > 0) parts.push({ type: 'text', text })
    for (const image of images) {
      parts.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.dataBase64 },
      })
    }
    return { role: 'user', content: parts }
  }
  if (text.length > 0 || toolResults.length === 0) {
    return { role: 'user', content: text }
  }
  return {
    role: 'tool',
    content: toolResults.map(result => ({
      type: 'tool-result' as const,
      toolCallId: result.toolCallId,
      toolName: 'unknown',
      output: toolResultOutput(result),
    })),
  }
}

/** Build the gateway request envelope for one completion call. */
export function buildRequest(options: GenerateOptions): CcRequestEnvelope {
  let system = options.system ?? ''
  const messages: CcMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      system += (system ? '\n\n' : '') + flattenText(message.content)
      continue
    }
    messages.push(message.role === 'assistant' ? serializeAssistant(message) : serializeUser(message))
  }

  const tools: CcTool[] = (options.tools ?? [])
    .map((tool: ToolSchema) => ({
      type: 'function' as const,
      name: tool.name,
      ...tool.description === undefined ? {} : { description: tool.description },
      input_schema: tool.parameters,
    }))

  const params: CcRequestEnvelope['params'] = {
    model: options.model,
    messages,
    tools,
    system,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  }
  if (options.temperature !== undefined) params.temperature = options.temperature
  if (options.topP !== undefined) params.top_p = options.topP
  // `reasoning_effort` is normalized, not pattern-matched.
  //
  // The gateway treats the field as optional, so "do not reason" is expressed by
  // OMITTING it. Hardcoding one spelling of that (`'off'`) meant every other
  // spelling — `'OFF'`, `'none'`, `'disabled'` — was forwarded verbatim, and an
  // upstream that rejects unknown effort values would then answer 400 to a
  // request that only ever meant "no reasoning please". Casefolding and accepting
  // the spellings that unambiguously mean off keeps that intent without asking the
  // client to guess ours. Anything else is passed through lowercased: the value
  // set is the gateway's to define (`minimal`/`low`/`medium`/`high` today).
  const effort = options.reasoningEffort?.trim().toLowerCase()
  if (effort !== undefined && effort !== '' && effort !== 'off' && effort !== 'none' && effort !== 'disabled') {
    params.reasoning_effort = effort
  }

  return {
    config: {
      workingDir: process.cwd(),
      date: new Date().toISOString().split('T')[0] ?? '',
      environment: `${platform()}-${arch()}`,
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
    params,
  }
}

function parseEventLine(line: string): CcStreamEvent | undefined {
  if (line.length === 0 || line.startsWith(':')) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  return isRecord(parsed) && typeof parsed.type === 'string' ? parsed as unknown as CcStreamEvent : undefined
}

/**
 * Parse a line-delimited JSON byte stream from `/alpha/generate` into events.
 * Lines are bare JSON objects (the gateway sends no `data:` SSE prefix).
 */
export async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<CcStreamEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += done ? '' : decoder.decode(value, { stream: !done })
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        const event = parseEventLine(line)
        if (event !== undefined) yield event
      }
      if (done) {
        const tail = buffer.trim()
        const event = parseEventLine(tail)
        if (event !== undefined) yield event
        return
      }
    }
  } finally {
    // Cancel before releasing the lock. Callers stop reading as soon as they
    // see `finish-step` and return the generator, which does NOT close the
    // underlying stream: `releaseLock()` alone leaves the upstream response
    // body unconsumed, stranding the HTTP connection for every streamed
    // request. Cancelling aborts the body so the socket can be reused.
    try {
      await reader.cancel()
    } catch {
      // Already errored or closed; nothing left to release.
    }
    reader.releaseLock()
  }
}

/** Extract the human message from a gateway error body, when present. */
export function gatewayErrorMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    if (isRecord(parsed) && isRecord(parsed.error)) {
      const message = parsed.error.message
      if (typeof message === 'string' && message.length > 0) return message
    }
  } catch {
    // Not JSON; caller falls back to the HTTP status.
  }
  return undefined
}