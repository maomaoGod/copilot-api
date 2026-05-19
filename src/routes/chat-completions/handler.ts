import type { Context } from "hono"

import consola from "consola"

import { awaitApproval } from "~/lib/approval"
import { checkRateLimit } from "~/lib/rate-limit"
import {
  setRequestModel,
  setResolvedModel,
  setResponseModel,
} from "~/lib/request-logger"
import { state } from "~/lib/state"
import { getTokenCount } from "~/lib/tokenizer"
import { isNullish } from "~/lib/utils"
import {
  createChatCompletions,
  type ChatCompletionResponse,
  type ChatCompletionsPayload,
  usesMaxCompletionTokens,
} from "~/services/copilot/create-chat-completions"

export async function handleCompletion(c: Context) {
  await checkRateLimit(state)

  let payload = await c.req.json<ChatCompletionsPayload>()
  setRequestModel(c, payload.model)
  setResolvedModel(c, payload.model)
  consola.debug("Request payload:", JSON.stringify(payload).slice(-400))

  const selectedModel = state.models?.data.find(
    (model) => model.id === payload.model,
  )

  try {
    if (selectedModel) {
      const tokenCount = await getTokenCount(payload, selectedModel)
      consola.info("Current token count:", tokenCount)
    } else {
      consola.warn("No model selected, skipping token count calculation")
    }
  } catch (error) {
    consola.warn("Failed to calculate token count:", error)
  }

  if (state.manualApprove) await awaitApproval()

  const useMaxCompletionTokens = usesMaxCompletionTokens(payload.model)
  let resolvedMaxTokens = selectedModel?.capabilities.limits.max_output_tokens

  if (useMaxCompletionTokens && !isNullish(payload.max_completion_tokens)) {
    resolvedMaxTokens = payload.max_completion_tokens
  } else if (!isNullish(payload.max_tokens)) {
    resolvedMaxTokens = payload.max_tokens
  } else if (!isNullish(payload.max_completion_tokens)) {
    resolvedMaxTokens = payload.max_completion_tokens
  }

  payload =
    useMaxCompletionTokens ?
      {
        ...payload,
        max_tokens: undefined,
        max_completion_tokens: resolvedMaxTokens,
      }
    : {
        ...payload,
        max_tokens: resolvedMaxTokens,
        max_completion_tokens: undefined,
      }

  consola.debug("Set output token limit to:", JSON.stringify(resolvedMaxTokens))
  consola.debug(
    "Set max_completion_tokens to:",
    JSON.stringify(payload.max_completion_tokens),
  )

  const response = await createChatCompletions(payload)

  if (isNonStreaming(response)) {
    setResponseModel(c, response.model)
    consola.debug("Non-streaming response:", JSON.stringify(response))
    return c.json(response)
  }

  consola.debug("Streaming response")
  return new Response(response, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}

const isNonStreaming = (
  response: Awaited<ReturnType<typeof createChatCompletions>>,
): response is ChatCompletionResponse => Object.hasOwn(response, "choices")
