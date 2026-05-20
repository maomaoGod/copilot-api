export interface ModelCapability {
  id: string
  fallback?: "chat-completions"
}

const MODEL_CAPABILITIES: ReadonlyArray<ModelCapability> = [
  { id: "gpt-5.5" },
  { id: "gpt-5.4" },
  { id: "gpt-5.4-mini" },
  { id: "gpt-5.3-codex" },
  { id: "gpt-5.2" },
  { id: "gpt-5.2-codex" },
  { id: "gpt-5-mini" },
  { id: "claude-opus-4.7", fallback: "chat-completions" },
  { id: "claude-opus-4.6", fallback: "chat-completions" },
  { id: "claude-opus-4.5", fallback: "chat-completions" },
  { id: "claude-sonnet-4.6", fallback: "chat-completions" },
  { id: "claude-sonnet-4.5", fallback: "chat-completions" },
  { id: "claude-sonnet-4", fallback: "chat-completions" },
  { id: "claude-haiku-4.5", fallback: "chat-completions" },
  { id: "gemini-3.1-pro-preview", fallback: "chat-completions" },
  { id: "gemini-3-flash-preview", fallback: "chat-completions" },
  { id: "gemini-2.5-pro", fallback: "chat-completions" },
  { id: "gpt-4.1", fallback: "chat-completions" },
  { id: "gpt-4o", fallback: "chat-completions" },
]

const CAPABILITY_BY_ID = new Map(
  MODEL_CAPABILITIES.map((capability) => [capability.id, capability] as const),
)

export function getModelCapability(
  modelId: string,
): ModelCapability | undefined {
  return CAPABILITY_BY_ID.get(modelId)
}
