import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { ViteDevServer } from "vite"
import { installComponentDevHandler } from "../src/server-components/dev-http.ts"

// A real dev server reaches these branches only when a browser happens to leave mid-request, so the
// timing of a hot update decides whether they run. Stage each one directly instead.

type Next = (error?: unknown) => void
type Handler = (req: object, res: FakeResponse, next: Next) => Promise<void>

class FakeResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
  statusCode = 200
  setHeader(): void {}
  end(): void {
    this.writableEnded = true
  }
}

const request = { url: "/", method: "GET", rawHeaders: [], headers: { host: "localhost" } }

function devHandler(createApp: unknown): Handler {
  let installed: Handler | undefined
  const server = {
    middlewares: {
      use: (handler: Handler) => {
        installed = handler
      },
    },
    ssrLoadModule: async () => ({ createApp }),
  }
  installComponentDevHandler(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: the handler reads only middlewares.use and ssrLoadModule, both provided here.
    server as unknown as ViteDevServer,
    { root: "/", adapter: "vue", entries: { client: "./entry.client.ts", ssr: "./entry.ssr.ts" } },
  )
  if (installed === undefined) throw new Error("no dev handler was installed")
  return installed
}

test("a browser that leaves before the app answers gets nothing, and the answer's body is cancelled", async () => {
  const res = new FakeResponse()
  let cancelled = false
  const handler = devHandler(async () => ({
    fetch: async () => {
      res.emit("close")
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
      )
    },
  }))
  let reported = false
  await handler(request, res, () => {
    reported = true
  })
  expect({ cancelled, reported, ended: res.writableEnded }).toEqual({
    cancelled: true,
    reported: false,
    ended: false,
  })
})

test("a request that fails after its browser left raises no error overlay", async () => {
  const res = new FakeResponse()
  const handler = devHandler(async () => ({
    fetch: async () => {
      res.emit("close")
      throw new Error("read aborted")
    },
  }))
  let reported = false
  await handler(request, res, () => {
    reported = true
  })
  expect(reported).toBe(false)
})

test("an SSR entry without createApp reaches the dev server's error handler", async () => {
  let reported: unknown
  await devHandler(undefined)(request, new FakeResponse(), (error) => {
    reported = error
  })
  expect(String(reported)).toContain("The SSR entry must export createApp")
})
