import { server, toFetchHandler } from "@nifrajs/core/server"
import { websocket } from "@nifrajs/core/ws"
import { t } from "@nifrajs/schema"
import { createWebSocketHub } from "../../src/index.ts"

interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

interface DurableObjectStorageLike {
  get<T>(key: string): Promise<T | undefined>
  put(key: string, value: unknown): Promise<void>
}

interface HubStateLike {
  storage: DurableObjectStorageLike
  waitUntil?(promise: Promise<unknown>): void
}

interface Env {
  NIFRA_WS_HUB: DurableObjectNamespaceLike
}

let publish: ((topic: string, data: unknown) => void) | undefined

const app = server<Env>()
  .use(websocket())
  .get("/lab/users/:id", (c) => ({
    id: c.params.id,
    tags: new URL(c.req.url).searchParams.getAll("tag"),
    lab: c.req.headers.get("x-lab"),
  }))
  .post(
    "/lab/echo",
    { body: t.object({ message: t.string({ minLength: 1 }), count: t.number() }) },
    (c) => c.body,
  )
  .get("/lab/created", () => {
    return new Response("created", { status: 201, headers: { "content-type": "text/plain" } })
  })
  .get("/state", (c) => stateRequest(c.env.NIFRA_WS_HUB, c.req))
  .post("/state", (c) => stateRequest(c.env.NIFRA_WS_HUB, c.req))
  .ws("/room", {
    open: (ws) => ws.subscribe("lobby"),
    message: (_ws, data) => {
      publish?.("lobby", data)
    },
  })

publish = (topic, data) => app.publish(topic, data as string)

function stateRequest(namespace: DurableObjectNamespaceLike, request: Request): Promise<Response> {
  const id = namespace.idFromName("nifra-ws-hub")
  return namespace.get(id).fetch(request)
}

const Hub = createWebSocketHub<Env>(app)

export class NifraWebSocketHub extends Hub {
  readonly #storage: DurableObjectStorageLike

  constructor(state: HubStateLike, env: Env) {
    super(state, env)
    this.#storage = state.storage
  }

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/state") {
      if (request.method === "POST") {
        const body = (await request.json()) as { value?: unknown }
        const value = typeof body.value === "string" ? body.value : ""
        await this.#storage.put("value", value)
        return Response.json({ value })
      }
      return Response.json({ value: (await this.#storage.get<string>("value")) ?? null })
    }
    return super.fetch(request)
  }
}

export default toFetchHandler(app, {
  webSocketHub: (env: Env) => env.NIFRA_WS_HUB,
})
