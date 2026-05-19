import { test, expect, mock } from "bun:test"

import { state } from "~/lib/state"
import {
  createChatCompletions,
  normalizeCompletionTokenParam,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock(
  (_url: string, opts: { headers: Record<string, string>; body?: string }) => {
    return {
      ok: true,
      json: () => ({ id: "123", object: "chat.completion", choices: [] }),
      headers: opts.headers,
      body: opts.body,
    }
  },
)
;(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock

function getLastRequestBody(): ChatCompletionsPayload {
  return JSON.parse(
    (fetchMock.mock.calls.at(-1)?.[1] as { body?: string }).body ?? "{}",
  ) as ChatCompletionsPayload
}

test("sets X-Initiator to agent if tool/assistant present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "tool", content: "tool call" },
    ],
    model: "gpt-test",
  }

  await createChatCompletions(payload)

  expect(fetchMock).toHaveBeenCalled()
  const lastCall = fetchMock.mock.calls.at(-1)
  const headers = (lastCall?.[1] as { headers: Record<string, string> }).headers
  expect(headers["X-Initiator"]).toBe("agent")
})

test("sets X-Initiator to user if only user present", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [
      { role: "user", content: "hi" },
      { role: "user", content: "hello again" },
    ],
    model: "gpt-test",
  }

  await createChatCompletions(payload)

  expect(fetchMock).toHaveBeenCalled()
  const lastCall = fetchMock.mock.calls.at(-1)
  const headers = (lastCall?.[1] as { headers: Record<string, string> }).headers
  expect(headers["X-Initiator"]).toBe("user")
})

test("normalizes GPT-5 requests to max_completion_tokens", () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4",
    max_tokens: 123,
  }

  expect(normalizeCompletionTokenParam(payload)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4",
    max_completion_tokens: 123,
  })
})

test("normalizes non-GPT-5 requests to max_tokens", () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
    max_completion_tokens: 321,
  }

  expect(normalizeCompletionTokenParam(payload)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
    max_tokens: 321,
  })
})

test("forwards max_completion_tokens for gpt-5.4 models", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4",
    max_tokens: 128,
    max_completion_tokens: 128,
  }

  await createChatCompletions(payload)

  const body = getLastRequestBody()
  expect(body.max_tokens).toBeUndefined()
  expect(body.max_completion_tokens).toBe(128)
})

test("maps legacy max_tokens to max_completion_tokens for gpt-5.4 models", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4-mini",
    max_tokens: 256,
  }

  await createChatCompletions(payload)

  const body = getLastRequestBody()
  expect(body.max_tokens).toBeUndefined()
  expect(body.max_completion_tokens).toBe(256)
})

test("keeps max_tokens for non-GPT-5 models", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-4o",
    max_completion_tokens: 512,
  }

  await createChatCompletions(payload)

  const body = getLastRequestBody()
  expect(body.max_tokens).toBe(512)
  expect(body.max_completion_tokens).toBeUndefined()
})
