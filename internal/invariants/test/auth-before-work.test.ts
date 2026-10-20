/**
 * Every integration mounted on a server answers an unauthorized request before it reads the body or
 * runs application code (a resolver, a model, a tool). Each integration runs behind a required
 * server guard, and, when it has its own `authorize`, with that refusing. A positive control sends the
 * same request authorized and requires the application code to run, so a fixture that never reached
 * the integration cannot pass. The registry at the end fails when a new mountable integration or
 * `authorize` option appears without being enrolled here.
 */
import { describe, expect, test } from "bun:test"
import { mountA2A } from "@nifrajs/a2a"
import { mountAgUI } from "@nifrajs/ag-ui"
import type { AgentDefinition, AgentModelPort } from "@nifrajs/agent"
import { mountAgent } from "@nifrajs/agent/mount"
import { type AnyServer, server } from "@nifrajs/core"
import { devtools } from "@nifrajs/devtools"
import { mountGraphql } from "@nifrajs/graphql"
import { defineMcpTool, respondMcpHttp } from "@nifrajs/mcp"
import { bearer } from "@nifrajs/middleware"
import { metrics } from "@nifrajs/otel/metrics"
import { t } from "@nifrajs/schema"
import { GraphQLObjectType, GraphQLSchema, GraphQLString } from "graphql"

const TOKEN = "t".repeat(40)

/** A request whose body records whether anything pulled it. */
function trackedRequest(
  url: string,
  method: string,
  body: string | undefined,
  headers: Record<string, string>,
) {
  let read = false
  const stream =
    body === undefined
      ? undefined
      : new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              read = true
              controller.enqueue(new TextEncoder().encode(body))
              controller.close()
            },
          },
          { highWaterMark: 0 },
        )
  const init: RequestInit & { duplex?: "half" } = { method, headers }
  if (stream !== undefined) {
    init.body = stream
    // Bun and undici require this for a streaming request body.
    init.duplex = "half"
  }
  const request = new Request(url, init)
  return { request, read: () => read }
}

type Authorize = (request: Request) => boolean

interface Integration {
  readonly name: string
  /** The source file that registers the integration's routes or checks its `authorize`. */
  readonly file: string
  /** Mounts the integration; `ran` is called by the application code it hosts. */
  mount(app: AnyServer, ran: () => void, authorize: Authorize | undefined): AnyServer
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: string
  readonly headers?: Record<string, string>
  /** Whether the integration takes its own `authorize` option. */
  readonly ownAuthorize: boolean
  /** Integrations that host no application code: the control only requires an answer. */
  readonly noAppCode?: string
  /** Text the integration serves only to an authorized request. */
  readonly protectedText?: string
  /** Why the integration answers ahead of a server guard, when it does by design. */
  readonly aheadOfGuards?: string
}

const agent: AgentDefinition<
  ReturnType<typeof t.object<{ prompt: ReturnType<typeof t.string> }>>,
  ReturnType<typeof t.object<{ answer: ReturnType<typeof t.string> }>>
> = {
  name: "invariants-agent",
  instruction: "Answer.",
  input: t.object({ prompt: t.string() }),
  output: t.object({ answer: t.string() }),
  tools: [],
}
const model = (ran: () => void): AgentModelPort => ({
  complete: () => {
    ran()
    return { kind: "output", value: { answer: "done" } }
  },
})
const json = { "content-type": "application/json" }

const INTEGRATIONS: readonly Integration[] = [
  {
    name: "mountGraphql (HTTP)",
    file: "packages/graphql/src/index.ts",
    mount: (app, ran, authorize) => {
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: "Query",
          fields: {
            secret: {
              type: GraphQLString,
              resolve: () => {
                ran()
                return "value"
              },
            },
          },
        }),
      })
      mountGraphql(app, authorize === undefined ? { schema } : { schema, authorize })
      return app
    },
    method: "POST",
    path: "/graphql",
    body: JSON.stringify({ query: "{ secret }" }),
    headers: json,
    ownAuthorize: true,
  },
  {
    name: "mountA2A",
    file: "packages/a2a/src/index.ts",
    mount: (app, ran) => {
      mountA2A(app, {
        agent,
        card: { url: "https://example.test/a2a", version: "1.0.0" },
        ports: () => ({ model: model(ran), capabilities: [] }),
      })
      return app
    },
    method: "POST",
    path: "/a2a",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "SendMessage",
      params: {
        message: {
          messageId: "m1",
          role: "ROLE_USER",
          parts: [{ text: "{}" }],
          metadata: { input: { prompt: "hey" } },
        },
      },
    }),
    headers: json,
    ownAuthorize: false,
  },
  {
    name: "mountAgUI",
    file: "packages/ag-ui/src/index.ts",
    mount: (app, ran) => {
      mountAgUI(app, { agent, ports: () => ({ model: model(ran), capabilities: [] }) })
      return app
    },
    method: "POST",
    path: "/agui",
    body: JSON.stringify({
      threadId: "thread-1",
      runId: "run-1",
      forwardedProps: { input: { prompt: "hey" } },
    }),
    headers: json,
    ownAuthorize: false,
  },
  {
    name: "mountAgent",
    file: "packages/agent/src/mount.ts",
    mount: (app, ran) => {
      mountAgent(app, { agent, ports: () => ({ model: model(ran), capabilities: [] }) })
      return app
    },
    method: "POST",
    path: "/agent",
    body: JSON.stringify({ input: { prompt: "hey" } }),
    headers: json,
    ownAuthorize: false,
  },
  {
    name: "respondMcpHttp on a route",
    file: "packages/mcp/src/http.ts",
    mount: (app, ran) => {
      const tool = defineMcpTool({
        name: "probe",
        description: "Records that it ran.",
        handler: () => {
          ran()
          return { text: "ran" }
        },
      })
      return app.post("/mcp", (c) =>
        respondMcpHttp(c.req, [tool], { name: "invariants", version: "0.0.0" }),
      )
    },
    method: "POST",
    path: "/mcp",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "probe", arguments: {} },
    }),
    headers: { ...json, accept: "application/json, text/event-stream" },
    ownAuthorize: false,
  },
  {
    name: "devtools",
    file: "packages/devtools/src/index.ts",
    mount: (app, _ran, authorize) =>
      app.use(devtools(authorize === undefined ? { enabled: true } : { enabled: true, authorize })),
    method: "GET",
    path: "/_nifra/devtools",
    headers: { accept: "text/event-stream" },
    ownAuthorize: true,
    noAppCode: "it streams the server's own events; refusing means no stream opens",
    aheadOfGuards:
      "it answers in onRequest, before route guards, and is held to loopback plus its own authorize",
  },
  {
    name: "metrics",
    file: "packages/otel/src/metrics.ts",
    mount: (app, _ran, authorize) =>
      app.use(metrics(authorize === undefined ? {} : { authorize })).get("/ping", () => "pong"),
    method: "GET",
    path: "/metrics",
    ownAuthorize: true,
    noAppCode: "it renders the server's own counters",
    protectedText: "nifra_http_requests_total",
  },
]

async function exchange(
  integration: Integration,
  guard: boolean,
  authorize: Authorize | undefined,
  headers: Record<string, string>,
) {
  let runs = 0
  let app: AnyServer = server()
  if (guard) app = app.use(bearer({ verify: (token) => (token === TOKEN ? "user" : null) }))
  app = integration.mount(app, () => runs++, authorize)
  const { request, read } = trackedRequest(
    `http://127.0.0.1${integration.path}`,
    integration.method,
    integration.body,
    { ...integration.headers, ...headers },
  )
  const response = await app.fetch(request)
  const contentType = response.headers.get("content-type") ?? ""
  // An agent stream runs the model only as it is read; the devtools stream never ends on its own.
  let text = ""
  if (integration.noAppCode !== undefined && contentType.includes("text/event-stream"))
    await response.body?.cancel()
  else text = await response.text()
  const leaked = integration.protectedText !== undefined && text.includes(integration.protectedText)
  return { status: response.status, read: read(), runs, contentType, leaked }
}

const authorized = { authorization: `Bearer ${TOKEN}` }
const allow: Authorize = (request) => request.headers.get("authorization") === `Bearer ${TOKEN}`

for (const integration of INTEGRATIONS) {
  describe(integration.name, () => {
    const guarded =
      "behind a required guard, an anonymous request is refused before its body is read or app code runs"
    if (integration.aheadOfGuards !== undefined)
      test.skip(`${guarded} - by design: ${integration.aheadOfGuards}`, () => {})
    else
      test(guarded, async () => {
        const refused = await exchange(integration, true, undefined, {})
        expect({
          status: refused.status,
          read: refused.read,
          runs: refused.runs,
          leaked: refused.leaked,
        }).toEqual({ status: 401, read: false, runs: 0, leaked: false })
        const control = await exchange(integration, true, undefined, authorized)
        expect(control.status).not.toBe(401)
        expect(control.status).not.toBe(404)
        if (integration.body !== undefined) expect(control.read).toBe(true)
        if (integration.noAppCode === undefined) expect(control.runs).toBeGreaterThan(0)
      })

    if (integration.ownAuthorize)
      test("its own authorize refusing answers before the body is read or app code runs", async () => {
        const refused = await exchange(integration, false, allow, {})
        expect([401, 403]).toContain(refused.status)
        expect({ read: refused.read, runs: refused.runs, leaked: refused.leaked }).toEqual({
          read: false,
          runs: 0,
          leaked: false,
        })
        expect(refused.contentType).not.toContain("text/event-stream")
        const control = await exchange(integration, false, allow, authorized)
        expect([401, 403, 404]).not.toContain(control.status)
        if (integration.body !== undefined) expect(control.read).toBe(true)
        if (integration.noAppCode === undefined) expect(control.runs).toBeGreaterThan(0)
        if (integration.protectedText !== undefined) {
          const shown = await exchange(integration, false, undefined, {})
          expect(shown.leaked).toBe(true)
        }
      })
  })
}

// Files that match the registry's patterns without being a server-side integration.
const NOT_INTEGRATIONS: Readonly<Record<string, string>> = {
  "packages/core/src/index.ts": "re-exports",
  "packages/core/src/server.ts": "re-exports",
  "packages/core/src/server/server-types.ts":
    "the server's own mount types; covered by the core auth-first suite",
  "packages/core/src/server/server.ts":
    "the server's own mount; covered by the core auth-first suite",
  "packages/graphql/src/http.ts": "the HTTP lane mountGraphql wires",
  "packages/graphql/src/ws.ts":
    "the WebSocket lane; its authorize runs on the upgrade (graphql mount tests)",
  "packages/agent-app/src/transport.ts": "a browser client; its authorize supplies credentials",
  "packages/webmcp/src/index.ts":
    "runs in the browser page; authorize gates a tool the page registers",
  "packages/web/src/islands.ts": "mounts browser islands",
  "packages/web/src/internal/web-app.ts": "the web app's own server; covered by the web auth tests",
  "packages/web-preact/src/client.ts": "browser hydration",
  "packages/web-react/src/client.ts": "browser hydration",
  "packages/web-solid/src/client.ts": "browser hydration",
  "packages/web-svelte/src/client.ts": "browser hydration",
  "packages/web-vue/src/client.ts": "browser hydration",
}

test("every mountable integration or authorize option is enrolled or named as not one", async () => {
  const root = new URL("../../../", import.meta.url).pathname
  const users: string[] = []
  for await (const file of new Bun.Glob("packages/*/src/**/*.ts").scan({ cwd: root })) {
    const source = await Bun.file(`${root}${file}`).text()
    if (
      /MountableApp\b|export function mount[A-Z]|readonly authorize\?:|export async function respond[A-Z]\w*Http\(/.test(
        source,
      )
    )
      users.push(file)
  }
  const enrolled = new Set(INTEGRATIONS.map((integration) => integration.file))
  const unknown = users.filter(
    (file) => !enrolled.has(file) && NOT_INTEGRATIONS[file] === undefined,
  )
  const stale = Object.keys(NOT_INTEGRATIONS).filter((file) => !users.includes(file))
  expect({ unknown: unknown.sort(), stale }).toEqual({ unknown: [], stale: [] })
})
