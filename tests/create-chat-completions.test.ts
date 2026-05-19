import { test, expect, mock } from "bun:test"

import { state } from "~/lib/state"
import { completionRoutes } from "~/routes/chat-completions/route"
import {
  createChatCompletions,
  normalizeCompletionTokenParam,
  type ChatCompletionsPayload,
} from "~/services/copilot/create-chat-completions"

state.copilotToken = "test-token"
state.vsCodeVersion = "1.0.0"
state.accountType = "individual"

const fetchMock = mock((_url: string | URL | Request, opts?: RequestInit) =>
  Promise.resolve({
    ok: true,
    json: () => ({ id: "123", object: "chat.completion", choices: [] }),
    headers: opts?.headers,
    body: opts?.body,
  } as unknown as Response),
)
const fetchMockWithPreconnect = Object.assign(fetchMock, {
  preconnect: () => undefined,
})
;(globalThis as unknown as { fetch: typeof fetch }).fetch =
  fetchMockWithPreconnect

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

test("prefers max_completion_tokens for GPT-5 requests", () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4",
    max_tokens: 123,
    max_completion_tokens: 456,
  }

  expect(normalizeCompletionTokenParam(payload)).toEqual({
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4",
    max_completion_tokens: 456,
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
    max_completion_tokens: 256,
  }

  await createChatCompletions(payload)

  const body = getLastRequestBody()
  expect(body.max_tokens).toBeUndefined()
  expect(body.max_completion_tokens).toBe(256)
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

test("route prefers max_completion_tokens for GPT-5 requests", async () => {
  const callCount = fetchMock.mock.calls.length

  const response = await completionRoutes.request("/", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-5.4",
      max_tokens: 128,
      max_completion_tokens: 256,
    }),
    headers: { "Content-Type": "application/json" },
  })

  expect(response.ok).toBe(true)
  expect(fetchMock.mock.calls.length).toBe(callCount + 1)
  const body = getLastRequestBody()
  expect(body.max_tokens).toBeUndefined()
  expect(body.max_completion_tokens).toBe(256)
})

test("route prefers max_tokens for non-GPT-5 requests", async () => {
  const callCount = fetchMock.mock.calls.length

  const response = await completionRoutes.request("/", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-4o",
      max_tokens: 128,
      max_completion_tokens: 256,
    }),
    headers: { "Content-Type": "application/json" },
  })

  expect(response.ok).toBe(true)
  expect(fetchMock.mock.calls.length).toBe(callCount + 1)
  const body = getLastRequestBody()
  expect(body.max_tokens).toBe(128)
  expect(body.max_completion_tokens).toBeUndefined()
})

test("route falls back to max_completion_tokens for non-GPT-5 when max_tokens is null", async () => {
  const callCount = fetchMock.mock.calls.length

  const response = await completionRoutes.request("/", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: "hi" }],
      model: "gpt-4o",
      max_tokens: null,
      max_completion_tokens: 256,
    }),
    headers: { "Content-Type": "application/json" },
  })

  expect(response.ok).toBe(true)
  expect(fetchMock.mock.calls.length).toBe(callCount + 1)
  const body = getLastRequestBody()
  expect(body.max_tokens).toBe(256)
  expect(body.max_completion_tokens).toBeUndefined()
})
