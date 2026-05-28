import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const { HTTPError } = await import("../src/lib/error")
const {
  copilotBootstrapDependencies,
  ensureCopilotBootstrapped,
  getRefreshDeadlineMs,
  getRefreshPollDelayMs,
  stopCopilotRefreshLoop,
} = await import("../src/lib/token")
const { state } = await import("../src/lib/state")

const readGitHubToken = mock<() => Promise<string | null>>(() =>
  Promise.resolve(null),
)
const getGitHubUser = mock(() => Promise.resolve({ login: "tester" }))
const getCopilotUsage = mock(() =>
  Promise.resolve({
    endpoints: {
      api: "https://copilot-proxy.githubusercontent.com",
      telemetry: "https://copilot-telemetry.githubusercontent.com",
    },
    login: "tester",
  }),
)
const getCopilotToken = mock(() =>
  Promise.resolve({ token: "copilot-token", refresh_in: 3600 }),
)
const cacheModels = mock(() => Promise.resolve())

const defaultCopilotBootstrapDependencies = {
  ...copilotBootstrapDependencies,
}

beforeEach(() => {
  readGitHubToken.mockReset()
  readGitHubToken.mockImplementation(() => Promise.resolve(null))
  getGitHubUser.mockReset()
  getGitHubUser.mockImplementation(() => Promise.resolve({ login: "tester" }))
  getCopilotUsage.mockReset()
  getCopilotUsage.mockImplementation(() =>
    Promise.resolve({
      endpoints: {
        api: "https://copilot-proxy.githubusercontent.com",
        telemetry: "https://copilot-telemetry.githubusercontent.com",
      },
      login: "tester",
    }),
  )
  getCopilotToken.mockReset()
  getCopilotToken.mockImplementation(() =>
    Promise.resolve({ token: "copilot-token", refresh_in: 3600 }),
  )
  cacheModels.mockReset()
  cacheModels.mockImplementation(() => Promise.resolve())

  Object.assign(copilotBootstrapDependencies, {
    cacheModels,
    getCopilotToken,
    getCopilotUsage,
    getGitHubUser,
    readGitHubToken,
  })

  stopCopilotRefreshLoop()
  state.githubToken = undefined
  state.userName = undefined
  state.copilotApiUrl = undefined
  state.copilotToken = undefined
  state.models = undefined
  state.showToken = false
})

afterEach(() => {
  Object.assign(
    copilotBootstrapDependencies,
    defaultCopilotBootstrapDependencies,
  )
  stopCopilotRefreshLoop()
})

describe("token refresh timing", () => {
  test("builds refresh deadline from refresh_in and local time", () => {
    const nowMs = 1_000_000

    expect(getRefreshDeadlineMs(1_800, nowMs)).toBe(nowMs + 1_740_000)
  })

  test("clamps refresh deadline to avoid a hot loop", () => {
    const nowMs = 1_000_000

    expect(getRefreshDeadlineMs(30, nowMs)).toBe(nowMs + 1_000)
  })

  test("caps poll delay at 15 seconds while waiting", () => {
    const nowMs = 1_000_000

    expect(getRefreshPollDelayMs(nowMs + 120_000, nowMs)).toBe(15_000)
  })

  test("uses remaining delay when refresh is close", () => {
    const nowMs = 1_000_000

    expect(getRefreshPollDelayMs(nowMs + 8_000, nowMs)).toBe(8_000)
  })

  test("returns zero when refresh is already due", () => {
    const nowMs = 1_000_000

    expect(getRefreshPollDelayMs(nowMs - 1, nowMs)).toBe(0)
  })
})

describe("lazy Copilot bootstrap", () => {
  test("returns a 401-style HTTPError when no stored GitHub token exists", async () => {
    readGitHubToken.mockImplementation(() => Promise.resolve(null))

    let caughtError: unknown
    try {
      await ensureCopilotBootstrapped()
    } catch (error: unknown) {
      caughtError = error
    }

    expect(caughtError).toBeInstanceOf(HTTPError)

    if (!(caughtError instanceof HTTPError)) {
      throw new Error("Expected HTTPError")
    }

    expect(caughtError.response.status).toBe(401)
    expect(await caughtError.response.text()).toBe(
      "GitHub token not found. Run `copilot-api auth login` first.",
    )
  })

  test("reloads the GitHub token from disk after a failed bootstrap", async () => {
    readGitHubToken.mockImplementationOnce(() => Promise.resolve("stale-token"))
    getGitHubUser.mockImplementationOnce(() =>
      Promise.reject(new Error("stale token rejected")),
    )

    let caughtError: unknown
    try {
      await ensureCopilotBootstrapped()
    } catch (error: unknown) {
      caughtError = error
    }

    expect((caughtError as Error).message).toBe("stale token rejected")
    expect(state.githubToken).toBeUndefined()

    readGitHubToken.mockImplementationOnce(() => Promise.resolve("fresh-token"))
    getGitHubUser.mockImplementationOnce(() =>
      Promise.resolve({ login: "fresh" }),
    )
    getCopilotUsage.mockImplementationOnce(() =>
      Promise.resolve({
        endpoints: {
          api: "https://copilot-proxy.githubusercontent.com",
          telemetry: "https://copilot-telemetry.githubusercontent.com",
        },
        login: "fresh",
      }),
    )

    await ensureCopilotBootstrapped()

    expect(readGitHubToken).toHaveBeenCalledTimes(2)
    expect(state.githubToken).toBe("fresh-token")
    expect(state.userName).toBe("fresh")
    expect(state.copilotToken).toBe("copilot-token")
  })

  test("rolls back derived Copilot state when token setup fails", async () => {
    state.userName = "previous-user"
    state.copilotApiUrl = "https://previous.example.com"
    state.copilotToken = undefined

    readGitHubToken.mockImplementationOnce(() => Promise.resolve("next-token"))
    getGitHubUser.mockImplementationOnce(() =>
      Promise.resolve({ login: "next-user" }),
    )
    getCopilotUsage.mockImplementationOnce(() =>
      Promise.resolve({
        endpoints: {
          api: "https://next.example.com",
          telemetry: "https://copilot-telemetry.githubusercontent.com",
        },
        login: "next-user",
      }),
    )
    getCopilotToken.mockImplementationOnce(() =>
      Promise.reject(new Error("token setup failed")),
    )

    let caughtError: unknown
    try {
      await ensureCopilotBootstrapped()
    } catch (error: unknown) {
      caughtError = error
    }

    expect((caughtError as Error).message).toBe("token setup failed")
    expect(state.githubToken).toBeUndefined()
    expect(state.userName).toBe("previous-user")
    expect(state.copilotApiUrl).toBe("https://previous.example.com")
    expect(state.copilotToken).toBeUndefined()
  })

  test("deduplicates concurrent model loading during cold start", async () => {
    readGitHubToken.mockImplementation(() => Promise.resolve("github-token"))
    cacheModels.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, 0)
        }),
    )

    await Promise.all([
      ensureCopilotBootstrapped({ loadModels: true }),
      ensureCopilotBootstrapped({ loadModels: true }),
      ensureCopilotBootstrapped({ loadModels: true }),
    ])

    expect(cacheModels).toHaveBeenCalledTimes(1)
    expect(getGitHubUser).toHaveBeenCalledTimes(1)
    expect(getCopilotToken).toHaveBeenCalledTimes(1)
  })
})
