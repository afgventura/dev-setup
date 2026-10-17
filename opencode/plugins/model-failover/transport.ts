export type Route = { providerID: string; modelID: string }
const retryable = new Set([401, 402, 403, 408, 429, 500, 502, 503, 504])
const key = (route: Route) => `${route.providerID}/${route.modelID}`

/** Retry rejected HTTP requests, not successful or partial responses. */
export async function forward(input: {
  response: Response
  request: Request
  body: string
  routes: Route[]
  start: number
  resolve: (route: Route) => Promise<{ baseURL: string; apiKey: string } | undefined>
  log: (message: string) => void
  fetcher?: typeof fetch
}): Promise<Response> {
  let response = input.response
  const first = input.routes[input.start]
  if (!first || !retryable.has(response.status)) return response
  input.log(`rejected actual=${key(first)} status=${response.status}`)
  for (let offset = 1; offset < input.routes.length; offset++) {
    input.request.signal.throwIfAborted()
    const route = input.routes[(input.start + offset) % input.routes.length]
    if (!route) continue
    const endpoint = await input.resolve(route)
    if (!endpoint) {
      input.log(`skip actual=${key(route)} reason=credential-or-endpoint-unavailable`)
      continue
    }
    const body = JSON.parse(input.body)
    body.model = route.modelID
    const headers = new Headers({ "content-type": "application/json", authorization: `Bearer ${endpoint.apiKey}` })
    if (route.providerID === "opencode-go") {
      input.request.headers.forEach((value, name) => {
        if (name.startsWith("x-opencode-")) headers.set(name, value)
      })
    }
    input.log(`dispatch actual=${key(route)}`)
    let next: Response
    // Bound time-to-headers only. A timeout signal on fetch also aborts the
    // response body, which kills long streams with a TimeoutError.
    const connection = new AbortController()
    const timer = setTimeout(
      () => connection.abort(new DOMException("The operation timed out.", "TimeoutError")),
      120_000,
    )
    try {
      next = await (input.fetcher ?? fetch)(`${endpoint.baseURL.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers, body: JSON.stringify(body),
        signal: AbortSignal.any([input.request.signal, connection.signal]),
      })
    } catch {
      input.request.signal.throwIfAborted()
      input.log(`failed actual=${key(route)} reason=transport`)
      continue
    } finally {
      clearTimeout(timer)
    }
    await response.body?.cancel()
    response = next
    input.log(`response actual=${key(route)} status=${response.status}`)
    if (!retryable.has(response.status)) return response
  }
  return response
}
