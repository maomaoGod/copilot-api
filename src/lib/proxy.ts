import consola from "consola"
import { getProxyForUrl } from "proxy-from-env"
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici"

let proxyEnvDispatcher: Dispatcher | undefined

const BUN_PROXY_FETCH = Symbol.for("copilot-api.proxy-env-fetch")

type ProxyCapableRequestInit = RequestInit & {
  proxy?: string
}

type ProxyWrappedFetch = typeof fetch & {
  [BUN_PROXY_FETCH]?: true
}

const copyFetchExtensions = (
  target: ProxyWrappedFetch,
  source: ProxyWrappedFetch,
): void => {
  for (const key of Reflect.ownKeys(source)) {
    if (
      key === "length"
      || key === "name"
      || key === "prototype"
      || key === BUN_PROXY_FETCH
    ) {
      continue
    }

    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (descriptor) {
      Object.defineProperty(target, key, descriptor)
    }
  }
}

export function getProxyEnvDispatcher(): Dispatcher | undefined {
  return proxyEnvDispatcher
}

const getProxyUrl = (url: string): string | undefined => {
  const get = getProxyForUrl as unknown as (u: string) => string | undefined
  const raw = get(url)
  return raw && raw.length > 0 ? raw : undefined
}

const getProxyLabel = (proxyUrl: string): string => {
  try {
    const url = new URL(proxyUrl)
    return `${url.protocol}//${url.host}`
  } catch {
    return proxyUrl
  }
}

const installBunFetchProxy = (): void => {
  const currentFetch = globalThis.fetch as ProxyWrappedFetch
  if (currentFetch[BUN_PROXY_FETCH]) {
    return
  }

  const originalFetch = currentFetch.bind(globalThis)
  const fetchWithProxy = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let requestUrl: URL
    try {
      requestUrl =
        typeof input === "string" ? new URL(input)
        : input instanceof URL ? input
        : new URL(input.url)
    } catch {
      return await originalFetch(input, init)
    }

    const proxyUrl = getProxyUrl(requestUrl.toString())
    if (!proxyUrl) {
      consola.debug(`HTTP proxy bypass: ${requestUrl.hostname}`)
      return await originalFetch(input, init)
    }

    if ((init as ProxyCapableRequestInit | undefined)?.proxy) {
      return await originalFetch(input, init)
    }

    consola.debug(
      `HTTP proxy route: ${requestUrl.hostname} via ${getProxyLabel(proxyUrl)}`,
    )
    return await originalFetch(input, {
      ...(init ?? {}),
      proxy: proxyUrl,
    } as ProxyCapableRequestInit)
  }) as ProxyWrappedFetch

  copyFetchExtensions(fetchWithProxy, currentFetch)
  fetchWithProxy[BUN_PROXY_FETCH] = true
  globalThis.fetch = fetchWithProxy as typeof fetch
}

export function initProxyFromEnv(): void {
  try {
    const direct = new Agent()
    const proxies = new Map<string, ProxyAgent>()

    const dispatcher = {
      dispatch(
        options: Dispatcher.DispatchOptions,
        handler: Dispatcher.DispatchHandler,
      ) {
        try {
          const origin =
            typeof options.origin === "string" ?
              new URL(options.origin)
            : (options.origin as URL)
          const proxyUrl = getProxyUrl(origin.toString())
          if (!proxyUrl) {
            consola.debug(`HTTP proxy bypass: ${origin.hostname}`)
            return (direct as unknown as Dispatcher).dispatch(options, handler)
          }
          let agent = proxies.get(proxyUrl)
          if (!agent) {
            agent = new ProxyAgent(proxyUrl)
            proxies.set(proxyUrl, agent)
          }
          consola.debug(
            `HTTP proxy route: ${origin.hostname} via ${getProxyLabel(proxyUrl)}`,
          )
          return (agent as unknown as Dispatcher).dispatch(options, handler)
        } catch {
          return (direct as unknown as Dispatcher).dispatch(options, handler)
        }
      },
      close() {
        return direct.close()
      },
      destroy() {
        return direct.destroy()
      },
    }

    proxyEnvDispatcher = dispatcher as unknown as Dispatcher

    if (typeof Bun !== "undefined") {
      installBunFetchProxy()
      consola.debug(
        "HTTP/WebSocket proxy configured from environment (per-URL)",
      )
      return
    }

    setGlobalDispatcher(proxyEnvDispatcher)
    consola.debug("HTTP proxy configured from environment (per-URL)")
  } catch (err) {
    consola.debug("Proxy setup skipped:", err)
  }
}
