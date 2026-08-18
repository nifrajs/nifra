/**
 * Runtime-neutral HTTP contract witnesses.
 *
 * The witness set is deliberately made only of Web `Request`/`Response` values. Runtime suites provide
 * the handler under test - the full Bun server, the compact edge server, or a native Node/Deno adapter -
 * and this module compares the wire contract without importing any runtime-specific implementation.
 */

export interface ContractLabHandler {
  fetch(request: Request): Response | Promise<Response>
}

export interface ContractLabServer {
  readonly origin: string
  stop(): void | Promise<void>
}

export interface ContractLabRuntimeAdapter {
  start(app: ContractLabHandler): ContractLabServer | Promise<ContractLabServer>
}

export interface ContractLabWitness {
  readonly id: string
  readonly request: {
    readonly method: string
    readonly path: string
    readonly headers?: Readonly<Record<string, string>>
    readonly body?: string
  }
  readonly expected: {
    readonly status: number
    readonly contentType: "json" | "text"
    readonly headers?: Readonly<Record<string, string>>
    readonly body: unknown
  }
}

/** The shared cross-runtime wire contract. Keep this list small and stable: it is evidence, not a load test. */
export const contractLabWitnesses: readonly ContractLabWitness[] = Object.freeze([
  {
    id: "params-query-header",
    request: {
      method: "GET",
      path: "/lab/users/alice?tag=one&tag=two",
      headers: { "x-lab": "yes" },
    },
    expected: {
      status: 200,
      contentType: "json",
      body: { id: "alice", tags: ["one", "two"], lab: "yes" },
    },
  },
  {
    id: "json-body",
    request: {
      method: "POST",
      path: "/lab/echo",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", count: 2 }),
    },
    expected: {
      status: 200,
      contentType: "json",
      body: { message: "hello", count: 2 },
    },
  },
  {
    id: "response-bridge",
    request: { method: "GET", path: "/lab/created" },
    expected: { status: 201, contentType: "text", body: "created" },
  },
  {
    id: "not-found",
    request: { method: "GET", path: "/lab/missing" },
    expected: { status: 404, contentType: "json", body: { ok: false, error: "not_found" } },
  },
  {
    id: "method-not-allowed",
    request: { method: "POST", path: "/lab/users/alice" },
    expected: {
      status: 405,
      contentType: "json",
      headers: { allow: "GET, HEAD" },
      body: { ok: false, error: "method_not_allowed" },
    },
  },
])

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function witnessRequest(origin: string, witness: ContractLabWitness): Request {
  return new Request(`${origin}${witness.request.path}`, {
    method: witness.request.method,
    headers: witness.request.headers,
    ...(witness.request.body === undefined ? {} : { body: witness.request.body }),
  })
}

async function assertWitnessResponse(
  witness: ContractLabWitness,
  response: Response,
): Promise<void> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0] ?? ""
  const actual =
    witness.expected.contentType === "json" ? await response.json() : await response.text()
  const expectedContentType =
    witness.expected.contentType === "json" ? "application/json" : "text/plain"
  const headersMatch = Object.entries(witness.expected.headers ?? {}).every(
    ([name, value]) => response.headers.get(name) === value,
  )
  if (
    response.status !== witness.expected.status ||
    contentType !== expectedContentType ||
    !headersMatch ||
    canonical(actual) !== canonical(witness.expected.body)
  ) {
    throw new Error(
      `contract witness ${witness.id} failed: expected ${witness.expected.status} ` +
        `${expectedContentType} ${canonical(witness.expected.body)}, got ${response.status} ` +
        `${contentType || "(missing content type)"} ${canonical(actual)}`,
    )
  }
}

/** Execute every witness against one runtime and throw a bounded, replayable mismatch. */
export async function runContractLab(
  handler: ContractLabHandler,
  origin = "http://nifra-contract-lab.invalid",
): Promise<void> {
  for (const witness of contractLabWitnesses) {
    await assertWitnessResponse(witness, await handler.fetch(witnessRequest(origin, witness)))
  }
}

/** Execute the same shared witnesses through a real HTTP origin. */
export async function runContractLabOverHttp(
  origin: string,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<void> {
  for (const witness of contractLabWitnesses) {
    await assertWitnessResponse(witness, await fetcher(witnessRequest(origin, witness)))
  }
}

/** Run the shared witnesses through a real HTTP adapter and always release its server. */
export async function runContractLabThroughAdapter(
  adapter: ContractLabRuntimeAdapter,
  app: ContractLabHandler = createReferenceContractLabHandler(),
): Promise<void> {
  const server = await adapter.start(app)
  try {
    await runContractLabOverHttp(server.origin)
  } finally {
    await server.stop()
  }
}

/** A reference Web handler for adapter-only suites. Core and edge suites use their real routers instead. */
export function createReferenceContractLabHandler(): ContractLabHandler {
  return {
    async fetch(request) {
      const url = new URL(request.url)
      const user = /^\/lab\/users\/([^/]+)$/.exec(url.pathname)
      if (request.method === "GET" && user !== null) {
        return Response.json({
          id: decodeURIComponent(user[1] ?? ""),
          tags: url.searchParams.getAll("tag"),
          lab: request.headers.get("x-lab"),
        })
      }
      if (request.method === "POST" && url.pathname === "/lab/echo") {
        return Response.json(await request.json())
      }
      if (request.method === "GET" && url.pathname === "/lab/created") {
        return new Response("created", { status: 201, headers: { "content-type": "text/plain" } })
      }
      if (url.pathname === "/lab/users/alice") {
        return Response.json(
          { ok: false, error: "method_not_allowed" },
          { status: 405, headers: { allow: "GET, HEAD" } },
        )
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 })
    },
  }
}
