/**
 * Standalone harness-neutral type vocabulary: the subset of message/tool
 * shapes the protocol layer needs. Mirrors the dsh-llm shapes the original
 * plugin used, so `buildRequest` translation stays byte-identical.
 *
 * @module cmdgo-bridge/types
 */

/** Opaque tool-call id on the wire. */
export type CallId = string & { readonly __callId?: never }

export function CallId(id: string): CallId {
  return id as CallId
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/**
 * An image attachment on a user message.
 *
 * Kept out of {@link Message.content} on purpose: `content` is the *text*
 * pipeline (it feeds `flattenText`, tool-result bodies and assistant parts),
 * and mirroring images there would put bytes on paths that must stay strings.
 * `Message.extraContent` carries them instead.
 */
export interface ImageBlock {
  type: 'image'
  /** Sniffed, normalized media type: image/png | image/jpeg | image/gif | image/webp. */
  mediaType: string
  /** Standard padded base64 of the decoded bytes. */
  dataBase64: string
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: CallId
  name: string
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: CallId
  content: ContentBlock[]
  isError: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: ContentBlock[]
  /**
   * Images attached to this message, in wire order. Only user messages carry
   * them today. Serialized after the flattened text so a text-only request keeps
   * its exact previous envelope (upstream prompt cache is a *prefix* cache).
   */
  extraContent?: ImageBlock[]
}

export interface ToolSchema {
  name: string
  description?: string
  parameters: unknown
}

/** One harness completion call, protocol-layer view. */
export interface GenerateOptions {
  model: string
  messages: Message[]
  tools?: ToolSchema[]
  system?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  reasoningEffort?: string
}