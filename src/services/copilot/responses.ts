import consola from "consola"
import { randomUUID } from "node:crypto"

import { copilotBaseUrl, copilotHeaders } from "~/lib/api-config"
import { HTTPError } from "~/lib/error"
import { fetchWithRetry } from "~/lib/fetch"
import { state } from "~/lib/state"

import type {
  ChatCompletionResponse,
  ChatCompletionsPayload,
  Tool,
} from "./create-chat-completions"

const RESPONSES_ONLY_MODEL_PATTERN =
  /^(?:gpt-5\.5|gpt-5\.4-mini|gpt-5\.3-codex|gpt-5\.2-codex)(?:-|$)/i

interface ResponsesRequestPayload {
  input: Array<ResponsesInputItem>
  max_output_tokens?: number | null
  model: string
  stream?: boolean | null
  temperature?: number | null
  text?: {
    format: { type: "json_object" }
  }
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; name: string }
    | { type: "web_search" }
    | { type: "web_search_preview" }
  tools?: Array<ResponsesTool>
  top_p?: number | null
  user?: string | null
}

interface ResponsesInputMessage {
  content: Array<{ text: string; type: "input_text" }>
  role: "user" | "assistant" | "system"
  type: "message"
}

interface ResponsesInputFunctionCall {
  arguments: string
  call_id: string
  name: string
  type: "function_call"
}

interface ResponsesInputFunctionCallOutput {
  call_id: string
  output: string
  type: "function_call_output"
}

type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesInputFunctionCall
  | ResponsesInputFunctionCallOutput

type ResponsesTool = ResponsesFunctionTool | ResponsesHostedTool

interface ResponsesFunctionTool {
  description?: string
  name: string
  parameters: Record<string, unknown>
  type: "function"
}

interface ResponsesHostedTool {
  type: "web_search" | "web_search_preview"
}

interface ResponsesApiResponse {
  created_at: number
  id: string
  model: string
  output: Array<ResponsesOutputItem>
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
}

type ResponsesOutputItem =
  | ResponsesMessageOutputItem
  | ResponsesFunctionCallOutputItem

interface ResponsesMessageOutputItem {
  content: Array<{ text: string; type: "output_text" }>
  role: "assistant"
  type: "message"
}

interface ResponsesFunctionCallOutputItem {
  arguments: string
  call_id: string
  name: string
  type: "function_call"
}

interface ResponseTranslationState {
  createdAt: number
  model: string
  outputTextByIndex: Record<number, string>
  responseId: string
  started: boolean
  toolArgumentsByIndex: Record<number, string>
  toolStartedByIndex: Record<number, boolean>
}

interface ChatCompletionChunk {
  choices: Array<{
    delta: Record<string, unknown>
    finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null
    index: number
    logprobs: null
  }>
  created: number
  id: string
  model: string
  object: "chat.completion.chunk"
}

interface ResponseStreamEventMessage {
  data?: string
}

export function shouldUseResponsesApiForModel(model: string): boolean {
  return RESPONSES_ONLY_MODEL_PATTERN.test(model)
}

export function buildResponsesRequestPayload(
  payload: ChatCompletionsPayload,
): ResponsesRequestPayload {
  return {
    model: payload.model,
    input: translateMessagesToResponsesInput(payload.messages),
    stream: payload.stream,
    max_output_tokens:
      payload.max_completion_tokens ?? payload.max_tokens ?? undefined,
    temperature: payload.temperature,
    top_p: payload.top_p,
    user: payload.user,
    tools: translateTools(payload.tools),
    tool_choice: translateToolChoice(payload.tool_choice),
    text:
      payload.response_format?.type === "json_object" ?
        { format: { type: "json_object" } }
      : undefined,
  }
}

export async function createResponses(
  payload: ChatCompletionsPayload,
  headers: Record<string, string>,
) {
  const response = await fetchWithRetry(`${copilotBaseUrl(state)}/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify(buildResponsesRequestPayload(payload)),
  })

  if (!response.ok) {
    throw new HTTPError("Failed to create responses", response)
  }

  if (payload.stream) {
    return translateResponsesStreamToChatCompletionStream(response)
  }

  return translateResponsesToChatCompletion(
    (await response.json()) as ResponsesApiResponse,
  )
}

export function translateResponsesToChatCompletion(
  response: ResponsesApiResponse,
): ChatCompletionResponse {
  const assistantMessages = response.output.filter(
    (item): item is ResponsesMessageOutputItem => item.type === "message",
  )
  const functionCalls = response.output.filter(
    (item): item is ResponsesFunctionCallOutputItem =>
      item.type === "function_call",
  )

  const content = assistantMessages
    .flatMap((item) => item.content)
    .map((part) => part.text)
    .join("")

  return {
    id: response.id,
    object: "chat.completion",
    created: response.created_at,
    model: response.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: content || null,
          ...(functionCalls.length > 0 && {
            tool_calls: functionCalls.map((toolCall) => ({
              id: toolCall.call_id,
              type: "function" as const,
              function: {
                name: toolCall.name,
                arguments: toolCall.arguments,
              },
            })),
          }),
        },
        logprobs: null,
        finish_reason: functionCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: response.usage?.input_tokens ?? 0,
      completion_tokens: response.usage?.output_tokens ?? 0,
      total_tokens: response.usage?.total_tokens ?? 0,
    },
  }
}

export async function shouldRetryWithResponses(
  response: Response,
): Promise<boolean> {
  try {
    const errorBody = (await response.clone().json()) as {
      error?: {
        code?: string
      }
    }

    return errorBody.error?.code === "unsupported_api_for_model"
  } catch {
    return false
  }
}

function translateMessagesToResponsesInput(
  messages: ChatCompletionsPayload["messages"],
): Array<ResponsesInputItem> {
  if (containsImageContent(messages)) {
    throw new Error(
      "image_url content is not supported yet for Responses API routing",
    )
  }

  const input: Array<ResponsesInputItem> = []

  for (const message of messages) {
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id ?? "",
        output: stringifyMessageContent(message.content),
      })
      continue
    }

    if (message.role === "developer") {
      input.push({
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: stringifyMessageContent(message.content),
          },
        ],
      })
      continue
    }

    const textContent = stringifyMessageContent(message.content)
    if (textContent) {
      input.push({
        type: "message",
        role: message.role,
        content: [{ type: "input_text", text: textContent }],
      })
    }

    if (message.role === "assistant" && message.tool_calls?.length) {
      input.push(
        ...message.tool_calls.map((toolCall) => ({
          type: "function_call" as const,
          call_id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        })),
      )
    }
  }

  return input
}

function stringifyMessageContent(
  content: ChatCompletionsPayload["messages"][number]["content"],
): string {
  if (typeof content === "string") return content
  if (!content) return ""

  return content
    .map((part) => {
      if (part.type === "text") return part.text
      return ""
    })
    .join("")
}

function containsImageContent(
  messages: ChatCompletionsPayload["messages"],
): boolean {
  return messages.some(
    (message) =>
      Array.isArray(message.content)
      && message.content.some((part) => part.type === "image_url"),
  )
}

function translateResponsesStreamToChatCompletionStream(
  response: Response,
): ReadableStream<Uint8Array> {
  return createSseStream(translateResponsesEvents(response))
}

async function* translateResponsesEvents(
  response: Response,
): AsyncGenerator<ResponseStreamEventMessage> {
  const state: ResponseTranslationState = {
    responseId: randomUUID(),
    createdAt: Math.floor(Date.now() / 1000),
    model: "",
    started: false,
    outputTextByIndex: {},
    toolArgumentsByIndex: {},
    toolStartedByIndex: {},
  }

  for await (const rawEvent of iterateResponseStream(response)) {
    if (!rawEvent.data || rawEvent.data === "[DONE]") {
      continue
    }

    try {
      const event = JSON.parse(rawEvent.data) as ResponsesStreamEvent
      consola.debug("Responses raw stream event:", JSON.stringify(event))
      applyResponseMetadata(state, event)

      const translatedEvents = translateResponsesEvent(state, event)
      for (const translatedEvent of translatedEvents) {
        yield translatedEvent
      }

      if (event.type === "response.completed") {
        return
      }
    } catch (error: unknown) {
      consola.error("Failed to translate responses stream event", error)
      throw error
    }
  }
}

function translateResponsesEvent(
  state: ResponseTranslationState,
  event: ResponsesStreamEvent,
): Array<ResponseStreamEventMessage> {
  if (event.type === "response.output_item.added") {
    const chunk = handleOutputItemAdded(state, event)
    return chunk ? [createSseEvent(chunk)] : []
  }

  if (event.type === "response.output_item.done") {
    return handleOutputItemDone(state, event).map((chunk) =>
      createSseEvent(chunk),
    )
  }

  if (event.type === "response.output_text.delta") {
    return processOutputTextDelta(state, event).map((chunk) =>
      createSseEvent(chunk),
    )
  }

  if (event.type === "response.output_text.done") {
    return processOutputTextDone(state, event).map((chunk) =>
      createSseEvent(chunk),
    )
  }

  if (event.type === "response.function_call_arguments.delta") {
    return processFunctionCallArgumentsDelta(state, event).map((chunk) =>
      createSseEvent(chunk),
    )
  }

  if (event.type === "response.function_call_arguments.done") {
    return processFunctionCallArgumentsDone(state, event).map((chunk) =>
      createSseEvent(chunk),
    )
  }

  if (event.type === "response.completed") {
    return [
      createSseEvent(
        createChunk(state, {}, hasFunctionCalls(event) ? "tool_calls" : "stop"),
      ),
      { data: "[DONE]" },
    ]
  }

  return []
}

function createSseStream(
  events: AsyncGenerator<ResponseStreamEventMessage>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next()
      if (next.done) {
        controller.close()
        return
      }

      controller.enqueue(
        sseEncoder.encode(`data: ${next.value.data ?? ""}\n\n`),
      )
    },
    async cancel() {
      await events.return(undefined)
    },
  })
}

async function* iterateResponseStream(
  response: Response,
): AsyncGenerator<ResponseStreamEventMessage> {
  const decoder = new TextDecoder()
  const reader = response.body?.getReader()

  if (!reader) {
    return
  }

  let buffer = ""

  while (true) {
    const frame = getNextFrame(buffer)
    if (frame) {
      buffer = frame.rest
      for (const data of frame.value
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())) {
        yield { data }
      }
      continue
    }

    const readResult = await reader.read()
    if (readResult.done) {
      return
    }

    buffer += decoder.decode(readResult.value as Uint8Array, { stream: true })
  }
}

const sseEncoder = new TextEncoder()

function createSseEvent(
  chunk: ChatCompletionChunk,
): ResponseStreamEventMessage {
  return { data: JSON.stringify(chunk) }
}

function hasFunctionCalls(event: ResponsesStreamEvent) {
  return (event.response?.output ?? []).some(
    (item) => item.type === "function_call",
  )
}

function getNextFrame(buffer: string) {
  const crlfBoundary = buffer.indexOf("\r\n\r\n")
  if (crlfBoundary !== -1) {
    return {
      value: buffer.slice(0, crlfBoundary),
      rest: buffer.slice(crlfBoundary + 4),
    }
  }

  const lfBoundary = buffer.indexOf("\n\n")
  if (lfBoundary === -1) {
    return undefined
  }

  return {
    value: buffer.slice(0, lfBoundary),
    rest: buffer.slice(lfBoundary + 2),
  }
}

function applyResponseMetadata(
  state: ResponseTranslationState,
  event: ResponsesStreamEvent,
) {
  if (event.response?.id) state.responseId = event.response.id
  if (event.response?.created_at) state.createdAt = event.response.created_at
  if (event.response?.model) state.model = event.response.model
}

function processOutputTextDelta(
  state: ResponseTranslationState,
  event: ResponsesStreamEvent,
) {
  const outputIndex = event.output_index ?? 0
  state.outputTextByIndex[outputIndex] = `${
    state.outputTextByIndex[outputIndex] ?? ""
  }${event.delta ?? ""}`
  return [
    createRoleChunk(state),
    createChunk(state, { content: event.delta }, null),
  ].filter(Boolean) as Array<ChatCompletionChunk>
}

function processOutputTextDone(
  state: ResponseTranslationState,
  event: ResponsesStreamEvent,
) {
  const outputIndex = event.output_index ?? 0
  const content = getMissingSuffix(
    state.outputTextByIndex[outputIndex] ?? "",
    event.text,
  )
  if (!content) {
    return []
  }

  state.outputTextByIndex[outputIndex] = `${
    state.outputTextByIndex[outputIndex] ?? ""
  }${content}`
  return [createRoleChunk(state), createChunk(state, { content }, null)].filter(
    Boolean,
  ) as Array<ChatCompletionChunk>
}

function processFunctionCallArgumentsDelta(
  state: ResponseTranslationState,
  event: ResponsesStreamEvent,
) {
  if (event.output_index === undefined) {
    return []
  }

  state.toolArgumentsByIndex[event.output_index] = `${
    state.toolArgumentsByIndex[event.output_index] ?? ""
  }${event.delta ?? ""}`
  return [
    createRoleChunk(state),
    createChunk(
      state,
      {
        tool_calls: [
          {
            index: event.output_index,
            type: "function",
            function: {
              arguments: event.delta ?? "",
            },
          },
        ],
      },
      null,
    ),
  ].filter(Boolean) as Array<ChatCompletionChunk>
}

function processFunctionCallArgumentsDone(
  state: ResponseTranslationState,
  event: ResponsesStreamEvent,
) {
  if (event.output_index === undefined) {
    return []
  }

  const content = getMissingSuffix(
    state.toolArgumentsByIndex[event.output_index] ?? "",
    event.arguments,
  )
  if (!content) {
    return []
  }

  state.toolArgumentsByIndex[event.output_index] = `${
    state.toolArgumentsByIndex[event.output_index] ?? ""
  }${content}`
  return [
    createRoleChunk(state),
    createChunk(
      state,
      {
        tool_calls: [
          {
            index: event.output_index,
            type: "function",
            function: {
              arguments: content,
            },
          },
        ],
      },
      null,
    ),
  ].filter(Boolean) as Array<ChatCompletionChunk>
}

function handleOutputItemAdded(
  state: ResponseTranslationState,
  event: ResponsesStreamEvent,
) {
  if (
    event.item?.type === "function_call"
    && event.output_index !== undefined
  ) {
    const initialArguments = event.item.arguments ?? ""
    state.started = true
    state.toolStartedByIndex[event.output_index] = true
    state.toolArgumentsByIndex[event.output_index] = initialArguments
    return createChunk(
      state,
      {
        role: "assistant",
        tool_calls: [
          {
            index: event.output_index,
            id: event.item.call_id,
            type: "function",
            function: {
              name: event.item.name,
              arguments: initialArguments,
            },
          },
        ],
      },
      null,
    )
  }

  if (event.item?.type === "message") {
    return createRoleChunk(state)
  }
}

function handleOutputItemDone(
  state: ResponseTranslationState,
  event: ResponsesStreamEvent,
): Array<ChatCompletionChunk> {
  if (event.item?.type === "message") {
    const outputIndex = event.output_index ?? 0
    const fullText = getMessageOutputText(event.item.content)
    const content = getMissingSuffix(
      state.outputTextByIndex[outputIndex] ?? "",
      fullText,
    )
    if (!content) {
      return []
    }

    state.outputTextByIndex[outputIndex] = `${
      state.outputTextByIndex[outputIndex] ?? ""
    }${content}`
    return [
      createRoleChunk(state),
      createChunk(state, { content }, null),
    ].filter(Boolean) as Array<ChatCompletionChunk>
  }

  if (
    event.item?.type === "function_call"
    && event.output_index !== undefined
  ) {
    const outputIndex = event.output_index

    if (!state.toolStartedByIndex[outputIndex]) {
      const initialArguments = event.item.arguments ?? ""
      state.started = true
      state.toolStartedByIndex[outputIndex] = true
      state.toolArgumentsByIndex[outputIndex] = initialArguments
      return [
        createChunk(
          state,
          {
            role: "assistant",
            tool_calls: [
              {
                index: outputIndex,
                id: event.item.call_id,
                type: "function",
                function: {
                  name: event.item.name,
                  arguments: initialArguments,
                },
              },
            ],
          },
          null,
        ),
      ]
    }

    const content = getMissingSuffix(
      state.toolArgumentsByIndex[outputIndex] ?? "",
      event.item.arguments,
    )
    if (!content) {
      return []
    }

    state.toolArgumentsByIndex[outputIndex] = `${
      state.toolArgumentsByIndex[outputIndex] ?? ""
    }${content}`
    return [
      createRoleChunk(state),
      createChunk(
        state,
        {
          tool_calls: [
            {
              index: outputIndex,
              type: "function",
              function: { arguments: content },
            },
          ],
        },
        null,
      ),
    ].filter(Boolean) as Array<ChatCompletionChunk>
  }

  return []
}

function createRoleChunk(state: ResponseTranslationState) {
  if (state.started) {
    return undefined
  }

  state.started = true
  return createChunk(state, { role: "assistant" }, null)
}

function createChunk(
  state: ResponseTranslationState,
  delta: Record<string, unknown>,
  finishReason: "stop" | "length" | "tool_calls" | "content_filter" | null,
): ChatCompletionChunk {
  return {
    id: state.responseId,
    object: "chat.completion.chunk",
    created: state.createdAt,
    model: state.model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
  }
}

function getMessageOutputText(
  content: Array<{ text: string; type: "output_text" }> | undefined,
) {
  const text = content?.map((part) => part.text).join("")
  return text || undefined
}

function getMissingSuffix(alreadySent: string, finalValue: string | undefined) {
  if (!finalValue) {
    return undefined
  }

  if (!alreadySent) {
    return finalValue
  }

  if (!finalValue.startsWith(alreadySent)) {
    return undefined
  }

  const suffix = finalValue.slice(alreadySent.length)
  return suffix || undefined
}

interface ResponsesStreamEvent {
  arguments?: string
  delta?: string
  item?: {
    arguments?: string
    call_id: string
    content?: Array<{ text: string; type: "output_text" }>
    name: string
    type: string
  }
  output_index?: number
  response?: {
    created_at: number
    id: string
    model: string
    output?: Array<ResponsesOutputItem>
  }
  text?: string
  type: string
}

function translateTools(
  tools: Array<Tool> | null | undefined,
): Array<ResponsesTool> | undefined {
  if (!tools?.length) return undefined

  return tools.map((tool) =>
    tool.type === "function" ?
      {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      }
    : {
        type: tool.type,
      },
  )
}

function translateToolChoice(
  toolChoice: ChatCompletionsPayload["tool_choice"],
): ResponsesRequestPayload["tool_choice"] {
  if (!toolChoice) return undefined
  if (typeof toolChoice === "string") return toolChoice
  if (toolChoice.type === "function") {
    return {
      type: "function",
      name: toolChoice.function.name,
    }
  }

  return {
    type: toolChoice.type,
  }
}

export function buildCopilotHeaders(
  enableVision: boolean,
  initiator: "agent" | "user",
): Record<string, string> {
  return {
    ...copilotHeaders(state, enableVision),
    "X-Initiator": initiator,
  }
}
