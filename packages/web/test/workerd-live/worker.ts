/**
 * The live hub on a real workerd, driven by scripts/check-workerd-live.ts: an app Worker, its hub
 * Durable Object, and a probe Durable Object that measures the platform behavior the hub relies on
 * (attachment and value sizes, alarms, heartbeat auto-responses).
 */
import { toFetchHandler } from "@nifrajs/core/server"
import { createWebApp, type Manifest, type RenderAdapter } from "../../src/index.ts"
import type { LiveHubNamespace } from "../../src/live/hub-protocol.ts"
import { live } from "../../src/live.ts"
import { type LiveHubState, type LiveHubWebSocket, liveHub } from "../../src/live-hub.ts"

const SECRET = "workerd-live-fixture-secret-0123456789"
const APP_ID = "workerd-live"
const ALARM_IN_MS = 500

interface Env {
  readonly LIVE_HUB: LiveHubNamespace
  readonly PROBE: LiveHubNamespace
}

/** The hub, with its instance id exposed so the check can tell a wake from a warm call. */
export class LiveHub extends liveHub(() => ({ secret: SECRET, appId: APP_ID })) {
  private readonly instance = crypto.randomUUID()

  override async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === "/__instance") return new Response(this.instance)
    return super.fetch(req)
  }
}

const empty = (): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(c) {
      c.close()
    },
  })

const adapter: RenderAdapter = { renderToStream: empty, hydrationHead: () => "" }

const manifest: Manifest = {
  routes: [
    {
      id: "posts/[id]",
      pattern: "/posts/:id",
      layoutIds: [],
      layoutParams: [],
      file: "posts/[id].tsx",
      load: async () => ({
        default: "post",
        loader: (ctx: { params: Record<string, string>; live(...keys: string[]): void }) => {
          ctx.live(`post:${ctx.params.id}`)
          return { id: ctx.params.id }
        },
      }),
    },
  ],
  layouts: {},
  notFound: { file: "_404.tsx", load: async () => ({ default: "nf" }) },
}

function deploy(env: Env) {
  const runtime = live({
    secret: SECRET,
    appId: APP_ID,
    subject: (ctx) => ctx.request.headers.get("x-user"),
    hub: env.LIVE_HUB,
  })
  const app = createWebApp({ adapter, manifest, clientEntry: "/c.js", live: runtime })
  return { runtime, handler: toFetchHandler(app) }
}

let deployed: ReturnType<typeof deploy> | undefined

type ExecutionContextOf = Parameters<ReturnType<typeof toFetchHandler>["fetch"]>[2]

const stubOf = (namespace: LiveHubNamespace, name: string) =>
  namespace.get(namespace.idFromName(name))

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContextOf): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === "/__nifra_ready__") return new Response("ready")
    if (url.pathname === "/__instance")
      return stubOf(env.LIVE_HUB, `nifra-live:${APP_ID}`).fetch(req)
    if (url.pathname.startsWith("/__probe")) return stubOf(env.PROBE, "probe").fetch(req)
    deployed ??= deploy(env)
    if (url.pathname === "/__publish" && req.method === "POST") {
      await deployed.runtime.publish(url.searchParams.get("key") ?? "")
      return new Response("published")
    }
    return deployed.handler.fetch(req, env, ctx)
  },
}

/** The platform behavior the hub relies on, measured from inside a Durable Object. */
export class Probe {
  constructor(private readonly state: LiveHubState) {
    const Pair: unknown = Reflect.get(globalThis, "WebSocketRequestResponsePair")
    if (typeof Pair === "function")
      state.setWebSocketAutoResponse(Reflect.construct(Pair, ["p", "p"]))
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === "/__probe/socket") {
      const [client, server] = pairOf()
      this.state.acceptWebSocket(server)
      const init = { status: 101, webSocket: client }
      return new Response(null, init)
    }
    if (path === "/__probe/beat") {
      const socket = this.state.getWebSockets()[0]
      const at = socket === undefined ? null : this.state.getWebSocketAutoResponseTimestamp(socket)
      return Response.json({ beat: at?.getTime() ?? null })
    }
    if (path === "/__probe/limits") return Response.json(await this.limits())
    if (path === "/__probe/alarm") {
      await this.state.storage.put({ fired: null })
      await this.state.storage.setAlarm(Date.now() + ALARM_IN_MS)
      return Response.json({ set: true })
    }
    if (path === "/__probe/alarm-fired") {
      return Response.json({
        fired: (await this.state.storage.get(["fired"])).get("fired") ?? null,
      })
    }
    return new Response("not found", { status: 404 })
  }

  async alarm(): Promise<void> {
    await this.state.storage.put({ fired: Date.now() })
  }

  /** The largest attachment the runtime takes, and whether a 30 KB value round-trips. */
  private async limits(): Promise<{ attachmentBytes: number; recordBytes: number }> {
    const [, server] = pairOf()
    this.state.acceptWebSocket(server)
    let attachmentBytes = 0
    for (const size of [256, 512, 1024, 2048, 4096, 16_384]) {
      try {
        server.serializeAttachment("x".repeat(size - 2))
        attachmentBytes = size
      } catch {
        break
      }
    }
    server.close(1000, "probe")
    const record = "y".repeat(30_720)
    await this.state.storage.put({ record })
    const back = (await this.state.storage.get(["record"])).get("record")
    return { attachmentBytes, recordBytes: typeof back === "string" ? back.length : 0 }
  }
}

function pairOf(): [unknown, LiveHubWebSocket] {
  const Pair: unknown = Reflect.get(globalThis, "WebSocketPair")
  if (typeof Pair !== "function") throw new Error("[fixture] not on workerd")
  const pair: unknown = Reflect.construct(Pair, [])
  const client: unknown = Reflect.get(Object(pair), 0)
  const server: unknown = Reflect.get(Object(pair), 1)
  if (!isSocket(server)) throw new Error("[fixture] WebSocketPair gave no server socket")
  return [client, server]
}

function isSocket(value: unknown): value is LiveHubWebSocket {
  return (
    typeof value === "object" &&
    value !== null &&
    "serializeAttachment" in value &&
    typeof value.serializeAttachment === "function"
  )
}
