import { afterEach, beforeEach, expect, mock, test } from "bun:test"

import type { ModelsResponse } from "../src/services/copilot/get-models"

const createModel = (
  id: string,
  modelPickerEnabled: boolean,
  type: string = "chat",
) => ({
  capabilities: {
    family: "test",
    limits: {},
    object: "capabilities",
    supports: {},
    tokenizer: "test-tokenizer",
    type,
  },
  id,
  model_picker_enabled: modelPickerEnabled,
  name: id,
  object: "model",
  preview: false,
  vendor: "github",
  version: "1",
})

let modelsResponse: ModelsResponse = {
  data: [
    createModel("claude-opus-4-7", false),
    createModel("gpt-5", true),
    createModel("text-embedding-3-small", false, "embeddings"),
  ],
  object: "list",
}

const getCopilotModels = mock(() => Promise.resolve(modelsResponse))

await mock.module("~/services/copilot/get-models", () => ({
  getModels: getCopilotModels,
}))

const { state } = await import("../src/lib/state")
const { cacheModels } = await import("../src/lib/utils")

const originalModels = state.models

beforeEach(() => {
  getCopilotModels.mockClear()
  state.models = undefined
  modelsResponse = {
    data: [
      createModel("claude-opus-4-7", false),
      createModel("gpt-5", true),
      createModel("text-embedding-3-small", false, "embeddings"),
    ],
    object: "list",
  }
})

afterEach(() => {
  state.models = originalModels
})

test("cacheModels preserves hidden upstream models", async () => {
  await cacheModels()

  expect(getCopilotModels).toHaveBeenCalledTimes(1)
  expect(state.models?.data.map((model) => model.id)).toEqual([
    "claude-opus-4-7",
    "gpt-5",
    "text-embedding-3-small",
  ])
})
