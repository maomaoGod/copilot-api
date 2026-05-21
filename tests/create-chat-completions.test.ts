import { test, expect, mock } from "bun:test"

import { fetchWithRetry } from "~/lib/fetch"
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

const stringifyUrl = (url: string | URL | Request): string => {
  if (typeof url === "string") {
    return url
  }

  if (url instanceof URL) {
    return url.toString()
  }

  return url.url
}

const fetchMock = mock((url: string | URL | Request, opts?: RequestInit) => {
  const requestUrl = stringifyUrl(url)

  if (requestUrl.endsWith("/responses")) {
    return Promise.resolve({
      ok: true,
      json: () => ({
        id: "resp_123",
        created_at: 123,
        model: "gpt-5.5",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hello" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }),
      headers: opts?.headers,
      body: opts?.body,
    } as unknown as Response)
  }

  return Promise.resolve({
    ok: true,
    json: () => ({ id: "123", object: "chat.completion", choices: [] }),
    headers: opts?.headers,
    body: opts?.body,
  } as unknown as Response)
})
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

function getLastRawRequestBody(): Record<string, unknown> {
  return JSON.parse(
    (fetchMock.mock.calls.at(-1)?.[1] as { body?: string }).body ?? "{}",
  ) as Record<string, unknown>
}

function getLastRequestUrl(): string {
  const url = fetchMock.mock.calls.at(-1)?.[0]
  return url ? stringifyUrl(url) : ""
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

test("maps legacy max_tokens to max_output_tokens for responses-only GPT-5 models", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4-mini",
    max_tokens: 256,
  }

  await createChatCompletions(payload)

  expect(getLastRequestUrl()).toContain("/responses")
  const body = getLastRawRequestBody()
  expect(body.max_output_tokens).toBe(256)
})

test("routes gpt-5.5 requests to /responses", async () => {
  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.5",
    max_tokens: 256,
  }

  const response = await createChatCompletions(payload)

  expect(getLastRequestUrl()).toContain("/responses")
  expect(
    (response as { choices: Array<{ message: { content: string | null } }> })
      .choices[0]?.message.content,
  ).toBe("hello")
})

test("preserves assistant tool calls in responses input", async () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-5.5",
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: {
              name: "lookup_weather",
              arguments: '{"city":"Shanghai"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_123",
        content: "sunny",
      },
    ],
  }

  await createChatCompletions(payload)

  const body = getLastRawRequestBody()
  const input = body.input as Array<Record<string, unknown>>
  expect(
    input.some(
      (item) => item.type === "function_call" && item.call_id === "call_123",
    ),
  ).toBe(true)
  expect(
    input.some(
      (item) =>
        item.type === "function_call_output" && item.call_id === "call_123",
    ),
  ).toBe(true)
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

test("falls back to /responses when chat completions rejects model", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () => ({ error: { code: "unsupported_api_for_model" } }),
        clone() {
          return this
        },
        text: () =>
          JSON.stringify({ error: { code: "unsupported_api_for_model" } }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  const payload: ChatCompletionsPayload = {
    messages: [{ role: "user", content: "hi" }],
    model: "gpt-5.4",
    max_completion_tokens: 256,
  }

  const response = await createChatCompletions(payload)

  expect(
    stringifyUrl(fetchMock.mock.calls.at(-1)?.[0] as string | URL | Request),
  ).toContain("/responses")
  expect(
    (response as { choices: Array<{ message: { content: string | null } }> })
      .choices[0]?.message.content,
  ).toBe("hello")
})

test("retries once when a GET request socket closes before succeeding", async () => {
  fetchMock.mockImplementationOnce(() =>
    Promise.reject(
      new Error("fetch failed", { cause: new Error("other side closed") }),
    ),
  )

  const callStart = fetchMock.mock.calls.length
  const response = await fetchWithRetry("https://example.com/models")
  const newCalls = fetchMock.mock.calls.slice(callStart)

  expect(newCalls).toHaveLength(2)
  expect(response).toMatchObject({
    ok: true,
  })
})

test("retries once when a GET request returns 5xx before succeeding", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => ({ error: { message: "bad gateway" } }),
        text: () => JSON.stringify({ error: { message: "bad gateway" } }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  const callStart = fetchMock.mock.calls.length
  const response = await fetchWithRetry("https://example.com/models")
  const newCalls = fetchMock.mock.calls.slice(callStart)

  expect(newCalls).toHaveLength(2)
  expect(response).toMatchObject({
    ok: true,
  })
})

test("retries once when a POST request with a JSON body socket closes before succeeding", async () => {
  fetchMock.mockImplementationOnce(() =>
    Promise.reject(
      new Error("fetch failed", { cause: new Error("other side closed") }),
    ),
  )

  const requestBody = JSON.stringify({ message: "hi" })
  const callStart = fetchMock.mock.calls.length
  const response = await fetchWithRetry(
    "https://example.com/chat/completions",
    {
      method: "POST",
      body: requestBody,
      headers: { "Content-Type": "application/json" },
    },
  )
  const newCalls = fetchMock.mock.calls.slice(callStart)

  expect(newCalls).toHaveLength(2)
  expect(newCalls[0]?.[1]?.body).toBe(requestBody)
  expect(newCalls[1]?.[1]?.body).toBe(requestBody)
  expect(response).toMatchObject({
    ok: true,
  })
})

test("retries once when a POST request with a JSON body returns 5xx before succeeding", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => ({ error: { message: "bad gateway" } }),
        text: () => JSON.stringify({ error: { message: "bad gateway" } }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  const requestBody = JSON.stringify({ message: "hi" })
  const callStart = fetchMock.mock.calls.length
  const response = await fetchWithRetry(
    "https://example.com/chat/completions",
    {
      method: "POST",
      body: requestBody,
      headers: { "Content-Type": "application/json" },
    },
  )
  const newCalls = fetchMock.mock.calls.slice(callStart)

  expect(newCalls).toHaveLength(2)
  expect(newCalls[0]?.[1]?.body).toBe(requestBody)
  expect(newCalls[1]?.[1]?.body).toBe(requestBody)
  expect(response).toMatchObject({
    ok: true,
  })
})

test("translates responses stream to chat completion chunks", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: true,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"response.output_text.delta","response":{"id":"resp_stream","created_at":123,"model":"gpt-5.5"},"delta":"hello"}\n\n'
                  + 'data: {"type":"response.completed","response":{"id":"resp_stream","created_at":123,"model":"gpt-5.5"}}\n\n',
              ),
            )
            controller.close()
          },
        }),
        headers: opts?.headers,
        bodyUsed: false,
      } as unknown as Response),
  )

  const stream = (await createChatCompletions({
    model: "gpt-5.5",
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  })) as ReadableStream<Uint8Array>

  const text = await new Response(stream).text()

  expect(text).toContain('"object":"chat.completion.chunk"')
  expect(text).toContain('"content":"hello"')
  expect(text).toContain("[DONE]")
})

test("rewrites native web search tools for decision round and final answer", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => ({
          id: "decision_123",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_123",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: '{"query":"latest bun release notes"}',
                    },
                  },
                ],
              },
              logprobs: null,
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => ({
          id: "search_123",
          created_at: 123,
          model: "gpt-5.5",
          output: [
            {
              type: "web_search_call",
              action: { query: "latest bun release notes" },
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "1. Bun v1.2 - https://bun.sh/blog/bun-v1.2",
                },
              ],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => ({
          id: "final_123",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Bun 1.2 adds several improvements.",
              },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  const payload: ChatCompletionsPayload = {
    model: "gpt-4o",
    messages: [
      { role: "user", content: "search the web for latest bun release notes" },
    ],
    tools: [{ type: "web_search_preview" }],
    tool_choice: "auto",
  }

  try {
    process.env.COPILOT_WEB_SEARCH_BACKEND = "copilot-http:gpt-5.5"

    const callStart = fetchMock.mock.calls.length
    const response = await createChatCompletions(payload)
    const newCalls = fetchMock.mock.calls.slice(callStart)

    expect(newCalls).toHaveLength(3)

    const decisionBody = JSON.parse(
      (newCalls[0]?.[1] as { body?: string }).body ?? "{}",
    ) as ChatCompletionsPayload
    expect(decisionBody.stream).toBe(false)
    expect(decisionBody.tools).toEqual([
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web for current or external information.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "The web search query to run.",
              },
            },
            required: ["query"],
            additionalProperties: false,
          },
        },
      },
    ])

    const searchBody = JSON.parse(
      (newCalls[1]?.[1] as { body?: string }).body ?? "{}",
    ) as Record<string, unknown>
    expect(searchBody.tools).toEqual([{ type: "web_search_preview" }])

    const finalBody = JSON.parse(
      (newCalls[2]?.[1] as { body?: string }).body ?? "{}",
    ) as ChatCompletionsPayload
    expect(finalBody.tools).toBeUndefined()
    expect(finalBody.tool_choice).toBeUndefined()
    expect(finalBody.messages.at(-2)).toMatchObject({
      role: "user",
    })
    expect(finalBody.messages.at(-1)).toEqual({
      role: "user",
      content:
        "Answer the user's last request now using the trusted bridge retrieval context. If the user asked for a URL only, output only that URL with no surrounding text.",
    })

    expect(
      (response as { choices: Array<{ message: { content: string | null } }> })
        .choices[0]?.message.content,
    ).toContain("https://bun.sh/blog/bun-v1.2")
    expect(
      (response as { choices: Array<{ message: { content: string | null } }> })
        .choices[0]?.message.content,
    ).toContain("Bun 1.2 adds several improvements.")
  } finally {
    delete process.env.COPILOT_WEB_SEARCH_BACKEND
  }
})

test("streams native web search final answer as chat completion chunks", async () => {
  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => ({
          id: "decision_stream_123",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_stream_123",
                    type: "function",
                    function: {
                      name: "web_search",
                      arguments: '{"query":"latest bun release notes"}',
                    },
                  },
                ],
              },
              logprobs: null,
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => ({
          id: "search_stream_123",
          created_at: 123,
          model: "gpt-5.5",
          output: [
            {
              type: "web_search_call",
              action: { query: "latest bun release notes" },
            },
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: "1. Bun v1.2 - https://bun.sh/blog/bun-v1.2",
                },
              ],
            },
          ],
          usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
        }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  fetchMock.mockImplementationOnce(
    (_url: string | URL | Request, opts?: RequestInit) =>
      Promise.resolve({
        ok: true,
        json: () => ({
          id: "final_stream_123",
          object: "chat.completion",
          created: 123,
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "Bun 1.2 adds several improvements.",
              },
              logprobs: null,
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
        }),
        headers: opts?.headers,
        body: opts?.body,
      } as unknown as Response),
  )

  try {
    process.env.COPILOT_WEB_SEARCH_BACKEND = "copilot-http:gpt-5.5"

    const stream = (await createChatCompletions({
      model: "gpt-4o",
      stream: true,
      messages: [
        {
          role: "user",
          content: "search the web for latest bun release notes",
        },
      ],
      tools: [{ type: "web_search_preview" }],
    })) as ReadableStream<Uint8Array>

    const text = await new Response(stream).text()

    expect(text).toContain('"object":"chat.completion.chunk"')
    expect(text).toContain('"role":"assistant"')
    expect(text).toContain("https://bun.sh/blog/bun-v1.2")
    expect(text).toContain("Bun 1.2 adds several improvements.")
    expect(text.match(/data: /g)?.length).toBeGreaterThan(3)
    expect(text).toContain("[DONE]")
  } finally {
    delete process.env.COPILOT_WEB_SEARCH_BACKEND
  }
})

test("rejects image input on responses-routed models instead of dropping it", () => {
  const payload: ChatCompletionsPayload = {
    model: "gpt-5.5",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this image" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc" },
          },
        ],
      },
    ],
  }

  expect(createChatCompletions(payload)).rejects.toThrow(
    "image_url content is not supported yet for Responses API routing",
  )
})
