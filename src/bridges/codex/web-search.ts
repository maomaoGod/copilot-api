import { randomUUID } from "node:crypto"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

import {
  buildOpenAIWebSearchContextMessage,
  buildOpenAIWebSearchDecisionPayload,
  buildOpenAIWebSearchFinalInstructionMessage,
  createWebSearchExecution,
  getWebSearchResultText,
  type SearchExecutionResult,
} from "~/bridges/claude/web-search"

interface ResponsesOutputTextPart {
  annotations: []
  text: string
  type: "output_text"
}

type CodexWebSearchOutputItem =
  | {
      action: {
        query: string
        type: "search"
      }
      id: string
      status: "completed"
      type: "web_search_call"
    }
  | {
      content: Array<ResponsesOutputTextPart>
      id: string
      role: "assistant"
      status: "completed"
      type: "message"
    }

interface CodexWebSearchResponse {
  created_at: number
  id: string
  model: string
  object: "response"
  output: Array<CodexWebSearchOutputItem>
  status: "completed"
  usage: {
    input_tokens: number
    output_tokens: number
    total_tokens: number
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const isCodexNativeWebSearchTool = (tool: unknown): boolean => {
  if (!isRecord(tool)) {
    return false
  }

  return tool.type === "web_search" || tool.type === "web_search_preview"
}

const isCodexNativeWebSearchToolChoice = (toolChoice: unknown): boolean => {
  if (!isRecord(toolChoice)) {
    return false
  }

  return (
    toolChoice.type === "web_search" || toolChoice.type === "web_search_preview"
  )
}

const hasOnlyCodexNativeWebSearchTools = (
  tools: ChatCompletionsPayload["tools"],
): boolean => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return false
  }

  return tools.every((tool) => isCodexNativeWebSearchTool(tool))
}

export const hasCodexNativeWebSearch = (
  payload: ChatCompletionsPayload,
): boolean =>
  payload.tools?.some((tool) => isCodexNativeWebSearchTool(tool)) ?? false

export const isCodexNativeWebSearchRequested = (
  payload: ChatCompletionsPayload,
): boolean => {
  if (!hasCodexNativeWebSearch(payload)) {
    return false
  }

  if (isCodexNativeWebSearchToolChoice(payload.tool_choice)) {
    return true
  }

  return (
    payload.tool_choice === "required"
    && hasOnlyCodexNativeWebSearchTools(payload.tools)
  )
}

export function createCodexNativeWebSearchDecisionPayload(
  payload: ChatCompletionsPayload,
): ChatCompletionsPayload {
  return buildOpenAIWebSearchDecisionPayload(payload)
}

function textFromMessageContent(
  content: ChatCompletionsPayload["messages"][number]["content"],
): string {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return ""
  }

  return content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
}

function getRequestedQuery(payload: ChatCompletionsPayload): string {
  const lastUserMessage = [...payload.messages]
    .reverse()
    .find((message) => message.role === "user")
  const rawText =
    lastUserMessage ? textFromMessageContent(lastUserMessage.content) : ""
  const cleaned = rawText
    .replaceAll(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replaceAll(/ +/g, " ")
    .trim()
  const searchPrefixes = ["search the web for ", "search for ", "search "]
  const lowered = cleaned.toLowerCase()
  const matchedPrefix = searchPrefixes.find((prefix) =>
    lowered.startsWith(prefix),
  )
  const extractedQuery =
    matchedPrefix ? cleaned.slice(matchedPrefix.length).trim() : ""

  return extractedQuery || cleaned || "web search"
}

function buildSearchInput(
  _payload: ChatCompletionsPayload,
  requestedQuery: string,
): string {
  return [
    "You are fulfilling an OpenAI chat-completions web_search hosted tool request.",
    "Search the web using the configured bridge web-search backend.",
    "Return useful search results as plain text lines in this exact shape:",
    "1. Title - https://example.com/page",
    "Include only real source URLs from the search results.",
    `Search query:\n${requestedQuery}`,
  ].join("\n\n")
}

export async function createCodexWebSearchExecution(
  payload: ChatCompletionsPayload,
  requestedQuery?: string,
): Promise<SearchExecutionResult> {
  const query = requestedQuery?.trim() || getRequestedQuery(payload)

  return await createWebSearchExecution(
    {
      clientName: "Codex",
      configurationHint:
        "Set COPILOT_WEB_SEARCH_BACKEND to a search backend such as gpt-5.5, searxng, or copilot-cli.",
      maxOutputTokens: payload.max_completion_tokens ?? payload.max_tokens,
      requestedQuery: query,
      searchInput: buildSearchInput(payload, query),
      temperature: payload.temperature,
      topP: payload.top_p,
    },
    {
      backend: process.env.COPILOT_WEB_SEARCH_BACKEND,
      copilotCliModel: payload.model,
    },
  )
}

export function createCodexWebSearchCallOutputItem(
  search: SearchExecutionResult,
): CodexWebSearchOutputItem {
  return {
    id: `ws_${randomUUID()}`,
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: search.query },
  }
}

export function createCodexWebSearchResponse(
  payload: ChatCompletionsPayload,
  search: SearchExecutionResult,
): CodexWebSearchResponse {
  const text = getWebSearchResultText(search)
  const output: Array<CodexWebSearchOutputItem> = [
    createCodexWebSearchCallOutputItem(search),
    {
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ]

  return {
    id: search.id.startsWith("resp_") ? search.id : `resp_${randomUUID()}`,
    object: "response",
    status: "completed",
    created_at: Math.floor(Date.now() / 1000),
    model: payload.model,
    output,
    usage: {
      input_tokens: search.inputTokens,
      output_tokens: search.outputTokens,
      total_tokens: search.inputTokens + search.outputTokens,
    },
  }
}

export function buildFinalPayloadWithWebSearchContext(
  payload: ChatCompletionsPayload,
  search: SearchExecutionResult,
): ChatCompletionsPayload {
  return {
    ...payload,
    stream: false,
    tools: undefined,
    tool_choice: undefined,
    messages: [
      ...payload.messages,
      buildOpenAIWebSearchContextMessage(search),
      buildOpenAIWebSearchFinalInstructionMessage(),
    ],
  }
}

export function mergeWebSearchIntoChatCompletion(
  response: ChatCompletionResponse,
  search: SearchExecutionResult,
): ChatCompletionResponse {
  const content =
    `${getWebSearchResultText(search)}\n\n${response.choices[0]?.message.content ?? ""}`.trim()

  return {
    ...response,
    choices: response.choices.map((choice, index) =>
      index === 0 ?
        {
          ...choice,
          message: {
            ...choice.message,
            content,
          },
        }
      : choice,
    ),
    usage: {
      prompt_tokens: search.inputTokens + (response.usage?.prompt_tokens ?? 0),
      completion_tokens:
        search.outputTokens + (response.usage?.completion_tokens ?? 0),
      total_tokens:
        search.inputTokens
        + search.outputTokens
        + (response.usage?.total_tokens ?? 0),
    },
  }
}
