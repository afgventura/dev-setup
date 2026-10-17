/** Keep in-flight request bodies across plugin reloads. Weak keys permit collection. */
const stateKey = Symbol.for("opencode.model-failover.requests.v1")
type State = { pending: WeakMap<Request, string> }
const registry = globalThis as typeof globalThis & { [stateKey]?: State }
export const requestState: State = registry[stateKey] ??= { pending: new WeakMap() }
