import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

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
const serve = mock(
  () => undefined as unknown as ReturnType<typeof startDependencies.serve>,
)

const { runServer, shouldBootstrapCopilotAtStartup, startDependencies } =
  await import("../src/start")
const { state } = await import("../src/lib/state")

const createLoadServerResult = () => {
  return {
    server: {
      fetch: mock(() => new Response("ok")),
    },
  } as unknown as Awaited<ReturnType<typeof startDependencies.loadServer>>
}

const loadServer = mock(() => Promise.resolve(createLoadServerResult()))

const defaultStartDependencies = { ...startDependencies }

const createStateSnapshot = () => ({
  accountType: state.accountType,
  githubToken: state.githubToken,
  manualApprove: state.manualApprove,
  rateLimitSeconds: state.rateLimitSeconds,
  rateLimitWait: state.rateLimitWait,
  showToken: state.showToken,
  verbose: state.verbose,
})

let stateSnapshot = createStateSnapshot()

describe("startup bootstrap behavior", () => {
  beforeEach(() => {
    stateSnapshot = createStateSnapshot()

    startDependencies.mergeConfigWithDefaults = mergeConfigWithDefaults
    startDependencies.initOpencodeVersion = initOpencodeVersion
    startDependencies.ensurePaths = ensurePaths
    startDependencies.cacheVSCodeVersion = cacheVSCodeVersion
    startDependencies.cacheMacMachineId = cacheMacMachineId
    startDependencies.cacheVsCodeSessionId = cacheVsCodeSessionId
    startDependencies.cacheVsCodeDeviceId = cacheVsCodeDeviceId
    startDependencies.setupGitHubToken = setupGitHubToken
    startDependencies.loadServer = loadServer
    startDependencies.logUser = logUser
    startDependencies.serve = serve
    startDependencies.setupCopilotToken = setupCopilotToken
    startDependencies.cacheModels = cacheModels

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
    loadServer.mockReset()
    loadServer.mockImplementation(() =>
      Promise.resolve(createLoadServerResult()),
    )
    serve.mockClear()
  })

  afterEach(() => {
    Object.assign(startDependencies, defaultStartDependencies)
    Object.assign(state, stateSnapshot)
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
