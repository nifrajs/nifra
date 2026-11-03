export interface StaticResponseDefinition {
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
}

const definitions = new WeakMap<object, StaticResponseDefinition>()

/** Declare a bodyless response with a status and headers that never vary. */
export function staticResponse(init?: ResponseInit): () => Response {
  const normalized = new Response(null, init)
  for (const name of ["content-length", "transfer-encoding"]) {
    if (normalized.headers.has(name)) {
      throw new TypeError(`staticResponse cannot set the framing header "${name}"`)
    }
  }
  const definition: StaticResponseDefinition = Object.freeze({
    status: normalized.status,
    statusText: normalized.statusText,
    headers: new Headers(normalized.headers),
  })
  const handler = (): Response => createStaticResponse(definition)
  definitions.set(handler, definition)
  return Object.freeze(handler)
}

export function staticResponseDefinition(handler: unknown): StaticResponseDefinition | undefined {
  return typeof handler === "function" ? definitions.get(handler) : undefined
}

export function createStaticResponse(definition: StaticResponseDefinition): Response {
  return new Response(null, definition)
}
