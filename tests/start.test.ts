import { beforeEach, describe, expect, mock, test } from "bun:test"

const actualConfigModule = await import("../src/lib/config")
const actualOpencodeModule = await import("../src/lib/opencode")
const actualPathsModule = await import("../src/lib/paths")
const actualUtilsModule = await import("../src/lib/utils")
const actualTokenModule = await import("../src/lib/token")

const mergeConfigWithDefaults = mock(() => ({ eagerCopilotBootstrap: false }))
const initOpencodeVersion = mock(() => Promise.resolve())
const ensurePaths = mock(() => Promise.resolve())
const cacheVSCodeVersion = mock(() => Promise.resolve())
const cacheMacMachineId = mock(() => {})
const cacheVsCodeSessionId = mock(() => {})
const cacheVsCodeDeviceId = mock(() => Promise.resolve())
const setupGitHubToken = mock(() => Promise.resolve())
const logUser = mock(() => Promise.resolve())
const setupCopilotToken = mock(() => Promise.resolve())
const cacheModels = mock(() => Promise.resolve())
const serve = mock(() => {})

await mock.module("../src/lib/config", () => ({
  ...actualConfigModule,
  mergeConfigWithDefaults,
}))
await mock.module("../src/lib/opencode", () => ({
  ...actualOpencodeModule,
  initOpencodeVersion,
}))
await mock.module("../src/lib/paths", () => ({
  ...actualPathsModule,
  ensurePaths,
}))
await mock.module("../src/lib/utils", () => ({
  ...actualUtilsModule,
  cacheVSCodeVersion,
  cacheMacMachineId,
  cacheVsCodeSessionId,
  cacheVsCodeDeviceId,
  cacheModels,
}))
await mock.module("../src/lib/token", () => ({
  ...actualTokenModule,
  setupGitHubToken,
  logUser,
  setupCopilotToken,
}))
await mock.module("../src/server", () => ({
  server: {
    fetch: mock(() => new Response("ok")),
  },
}))
await mock.module("srvx", () => ({
  serve,
}))

const { runServer, shouldBootstrapCopilotAtStartup } = await import(
  "../src/start"
)

describe("startup bootstrap behavior", () => {
  beforeEach(() => {
    mergeConfigWithDefaults.mockReset()
    mergeConfigWithDefaults.mockImplementation(() => ({
      eagerCopilotBootstrap: false,
    }))
    initOpencodeVersion.mockClear()
    ensurePaths.mockClear()
    cacheVSCodeVersion.mockClear()
    cacheMacMachineId.mockClear()
    cacheVsCodeSessionId.mockClear()
    cacheVsCodeDeviceId.mockClear()
    setupGitHubToken.mockReset()
    setupGitHubToken.mockImplementation(() => Promise.resolve())
    logUser.mockClear()
    setupCopilotToken.mockReset()
    setupCopilotToken.mockImplementation(() => Promise.resolve())
    cacheModels.mockReset()
    cacheModels.mockImplementation(() => Promise.resolve())
    serve.mockClear()
  })

  test("skips Copilot bootstrap when eagerCopilotBootstrap is disabled", async () => {
    const result = await runServer({
      port: 4141,
      verbose: false,
      accountType: "individual",
      manual: false,
      rateLimitWait: false,
      claudeCode: false,
      showToken: false,
      proxyEnv: false,
    })

    expect(result).toBeUndefined()

    expect(setupGitHubToken).not.toHaveBeenCalled()
    expect(logUser).not.toHaveBeenCalled()
    expect(setupCopilotToken).not.toHaveBeenCalled()
    expect(cacheModels).not.toHaveBeenCalled()
    expect(serve).toHaveBeenCalledTimes(1)
  })

  test("bootstraps Copilot eagerly by default", async () => {
    mergeConfigWithDefaults.mockImplementation(() => ({
      eagerCopilotBootstrap: true,
    }))
    setupCopilotToken.mockImplementation(() => Promise.resolve())
    cacheModels.mockImplementation(() => Promise.resolve())

    const result = await runServer({
      port: 4141,
      verbose: false,
      accountType: "individual",
      manual: false,
      rateLimitWait: false,
      githubToken: "github-token",
      claudeCode: false,
      showToken: false,
      proxyEnv: false,
    })

    expect(result).toBeUndefined()

    expect(logUser).toHaveBeenCalledTimes(1)
    expect(setupCopilotToken).toHaveBeenCalledTimes(1)
    expect(cacheModels).toHaveBeenCalledTimes(1)
    expect(serve).toHaveBeenCalledTimes(1)
  })

  test("still bootstraps Copilot for claudeCode mode", () => {
    expect(
      shouldBootstrapCopilotAtStartup({ eagerCopilotBootstrap: false }, true),
    ).toBeTrue()
    expect(shouldBootstrapCopilotAtStartup({}, false)).toBeTrue()
    expect(
      shouldBootstrapCopilotAtStartup({ eagerCopilotBootstrap: false }, false),
    ).toBeFalse()
  })
})
