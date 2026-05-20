import consola from "consola"

import { createChatCompletionStreamFromResponse } from "~/bridges/claude/web-search"
import {
  buildFinalPayloadWithWebSearchContext,
  createCodexNativeWebSearchDecisionPayload,
  createCodexWebSearchExecution,
  hasCodexNativeWebSearch,
  isCodexNativeWebSearchRequested,
  mergeWebSearchIntoChatCompletion,
} from "~/bridges/codex/web-search"
import { copilotBaseUrl } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/fetch"
import { getModelCapability } from "~/lib/model-capabilities"
import { state } from "~/lib/state"

import {
  buildCopilotHeaders,
  createResponses,
  shouldRetryWithResponses,
  shouldUseResponsesApiForModel,
} from "./responses"

const GPT_5_MODEL_PATTERN =
  /(?:^|[^a-z0-9])gpt[-_.]?5(?:[-_.][a-z0-9]+)*(?:$|[^a-z0-9])/i

export const createChatCompletions = async (
  payload: ChatCompletionsPayload,
) => {
  if (!state.copilotToken) throw new Error("Copilot token not found")

  if (hasCodexNativeWebSearch(payload)) {
    return await createChatCompletionWithWebSearch(payload)
  }

  const normalizedPayload = normalizeCompletionTokenParam(payload)
  let upstreamTokenField: "max_completion_tokens" | "max_tokens" | null = null
  if (normalizedPayload.max_completion_tokens !== undefined) {
    upstreamTokenField = "max_completion_tokens"
  } else if (normalizedPayload.max_tokens !== undefined) {
    upstreamTokenField = "max_tokens"
  }

  consola.debug("Upstream token parameter routing:", {
    model: payload.model,
    inputMaxTokens: payload.max_tokens,
    inputMaxCompletionTokens: payload.max_completion_tokens,
    upstreamTokenField,
    upstreamMaxTokens: normalizedPayload.max_tokens,
    upstreamMaxCompletionTokens: normalizedPayload.max_completion_tokens,
  })

  const enableVision = normalizedPayload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  // Agent/user check for X-Initiator header
  // Determine if any message is from an agent ("assistant" or "tool")
  const isAgentCall = normalizedPayload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const initiator = isAgentCall ? "agent" : "user"
  const headers = buildCopilotHeaders(enableVision, initiator)

  if (shouldUseResponsesApiForModel(normalizedPayload.model)) {
    return await createResponses(normalizedPayload, headers)
  }

  const response = await fetchWithRetry(
    `${copilotBaseUrl(state)}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(normalizedPayload),
    },
  )

  if (!response.ok) {
    if (
      getModelCapability(normalizedPayload.model)?.fallback
        !== "chat-completions"
      && (await shouldRetryWithResponses(response))
    ) {
      return await createResponses(normalizedPayload, headers)
    }

    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  if (normalizedPayload.stream) {
    return response.body as ReadableStream
  }

  return (await response.json()) as ChatCompletionResponse
}

async function createChatCompletionWithWebSearch(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse | ReadableStream<Uint8Array>> {
  const decisionPayload = createCodexNativeWebSearchDecisionPayload(payload)
  const decisionResponse =
    await createChatCompletionsWithoutWebSearch(decisionPayload)

  if (
    !isCodexNativeWebSearchRequested(payload)
    && !decisionResponse.choices[0]?.message.tool_calls?.some(
      (toolCall) => toolCall.function.name === "web_search",
    )
  ) {
    return payload.stream ?
        createChatCompletionStreamFromResponse(decisionResponse)
      : decisionResponse
  }

  const search = await createCodexWebSearchExecution(payload)
  const finalPayload = buildFinalPayloadWithWebSearchContext(payload, search)
  const finalResponse =
    await createChatCompletionsWithoutWebSearch(finalPayload)
  const mergedResponse = mergeWebSearchIntoChatCompletion(finalResponse, search)
  return payload.stream ?
      createChatCompletionStreamFromResponse(mergedResponse)
    : mergedResponse
}

async function createChatCompletionsWithoutWebSearch(
  payload: ChatCompletionsPayload,
): Promise<ChatCompletionResponse> {
  const normalizedPayload = normalizeCompletionTokenParam(payload)
  let upstreamTokenField: "max_completion_tokens" | "max_tokens" | null = null
  if (normalizedPayload.max_completion_tokens !== undefined) {
    upstreamTokenField = "max_completion_tokens"
  } else if (normalizedPayload.max_tokens !== undefined) {
    upstreamTokenField = "max_tokens"
  }

  consola.debug("Upstream token parameter routing:", {
    model: payload.model,
    inputMaxTokens: payload.max_tokens,
    inputMaxCompletionTokens: payload.max_completion_tokens,
    upstreamTokenField,
    upstreamMaxTokens: normalizedPayload.max_tokens,
    upstreamMaxCompletionTokens: normalizedPayload.max_completion_tokens,
  })

  const enableVision = normalizedPayload.messages.some(
    (x) =>
      typeof x.content !== "string"
      && x.content?.some((x) => x.type === "image_url"),
  )

  const isAgentCall = normalizedPayload.messages.some((msg) =>
    ["assistant", "tool"].includes(msg.role),
  )

  const initiator = isAgentCall ? "agent" : "user"
  const headers = buildCopilotHeaders(enableVision, initiator)

  if (shouldUseResponsesApiForModel(normalizedPayload.model)) {
    return (await createResponses(
      normalizedPayload,
      headers,
    )) as ChatCompletionResponse
  }

  const response = await fetchWithRetry(
    `${copilotBaseUrl(state)}/chat/completions`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(normalizedPayload),
    },
  )

  if (!response.ok) {
    if (
      getModelCapability(normalizedPayload.model)?.fallback
        !== "chat-completions"
      && (await shouldRetryWithResponses(response))
    ) {
      return (await createResponses(
        normalizedPayload,
        headers,
      )) as ChatCompletionResponse
    }

    consola.error("Failed to create chat completions", response)
    throw new HTTPError("Failed to create chat completions", response)
  }

  return (await response.json()) as ChatCompletionResponse
}

export function normalizeCompletionTokenParam(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  const normalizedPayload = { ...payload }

  if (usesMaxCompletionTokens(normalizedPayload.model)) {
    const resolvedMaxTokens =
      normalizedPayload.max_completion_tokens ?? normalizedPayload.max_tokens

    if (resolvedMaxTokens !== undefined) {
      normalizedPayload.max_completion_tokens = resolvedMaxTokens
    } else {
      delete normalizedPayload.max_completion_tokens
    }
    delete normalizedPayload.max_tokens
    return normalizedPayload
  }

  const resolvedMaxTokens =
    normalizedPayload.max_tokens ?? normalizedPayload.max_completion_tokens

  if (resolvedMaxTokens !== undefined) {
    normalizedPayload.max_tokens = resolvedMaxTokens
  } else {
    delete normalizedPayload.max_tokens
  }
  delete normalizedPayload.max_completion_tokens

  return normalizedPayload
}

export function usesMaxCompletionTokens(modelId: string): boolean {
  const resolvedModelId =
    state.models?.data.find((model) => model.id === modelId)?.id ?? modelId

  return GPT_5_MODEL_PATTERN.test(resolvedModelId)
}

// Streaming types

export interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<Choice>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
    completion_tokens_details?: {
      accepted_prediction_tokens: number
      rejected_prediction_tokens: number
    }
  }
}

interface Delta {
  content?: string | null
  role?: "user" | "assistant" | "system" | "tool"
  reasoning_text?: string | null
  reasoning_opaque?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: "function"
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

interface Choice {
  index: number
  delta: Delta
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
  logprobs: object | null
}

// Non-streaming types

export interface ChatCompletionResponse {
  id: string
  object: "chat.completion"
  created: number
  model: string
  choices: Array<ChoiceNonStreaming>
  system_fingerprint?: string
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_tokens_details?: {
      cached_tokens: number
    }
  }
}

interface ResponseMessage {
  role: "assistant"
  content: string | null
  tool_calls?: Array<ToolCall>
}

interface ChoiceNonStreaming {
  index: number
  message: ResponseMessage
  logprobs: object | null
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter"
}

// Payload types

export interface ChatCompletionsPayload {
  messages: Array<Message>
  model: string
  temperature?: number | null
  top_p?: number | null
  max_tokens?: number | null
  max_completion_tokens?: number | null
  stop?: string | Array<string> | null
  n?: number | null
  stream?: boolean | null

  frequency_penalty?: number | null
  presence_penalty?: number | null
  logit_bias?: Record<string, number> | null
  logprobs?: boolean | null
  response_format?: { type: "json_object" } | null
  seed?: number | null
  tools?: Array<Tool> | null
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } }
    | { type: "web_search" }
    | { type: "web_search_preview" }
    | null
  user?: string | null
}

export type Tool = FunctionTool | WebSearchTool

export interface FunctionTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface WebSearchTool {
  type: "web_search" | "web_search_preview"
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool" | "developer"
  content: string | Array<ContentPart> | null

  name?: string
  tool_calls?: Array<ToolCall>
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type ContentPart = TextPart | ImagePart

export interface TextPart {
  type: "text"
  text: string
}

export interface ImagePart {
  type: "image_url"
  image_url: {
    url: string
    detail?: "low" | "high" | "auto"
  }
}
