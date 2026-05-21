const MAX_FETCH_ATTEMPTS = 2

function getRequestMethod(
  input: string | URL | Request,
  init?: RequestInit,
): string {
  if (init?.method) {
    return init.method.toUpperCase()
  }

  if (input instanceof Request) {
    return input.method.toUpperCase()
  }

  return "GET"
}

function shouldRetryMethod(_method: string): boolean {
  return true
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  let causeMessage = ""
  if (error.cause instanceof Error) {
    causeMessage = error.cause.message.toLowerCase()
  } else if (typeof error.cause === "string") {
    causeMessage = error.cause.toLowerCase()
  }

  return [message, causeMessage].some(
    (value) =>
      value.includes("fetch failed")
      || value.includes("other side closed")
      || value.includes("socket")
      || value.includes("econnreset")
      || value.includes("und_err_socket"),
  )
}

function shouldRetryResponse(response: Response): boolean {
  return response.status >= 500 && response.status <= 599
}

export async function fetchWithRetry(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const method = getRequestMethod(input, init)
  if (!shouldRetryMethod(method)) {
    return await fetch(input, init)
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetch(input, init)
      if (!shouldRetryResponse(response) || attempt === MAX_FETCH_ATTEMPTS) {
        return response
      }
    } catch (error) {
      lastError = error
      if (!isRetryableFetchError(error) || attempt === MAX_FETCH_ATTEMPTS) {
        throw error
      }
    }
  }

  throw lastError
}
