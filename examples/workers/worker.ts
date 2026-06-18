import { server, toFetchHandler } from "@nifrajs/core"

/**
 * nifra on Cloudflare Workers. `toFetchHandler` adapts the app to the Workers `ExportedHandler`
 * shape; `server<Env>()` makes `c.env` typed (`KV`/`GREETING` here — no cast), and `c.waitUntil`
 * schedules work that outlives the response. `app.fetch` is pure Web-standard, so the same app also
 * runs on Bun (`app.listen`), Node (`@nifrajs/node`), and Deno (`@nifrajs/deno`).
 *
 *   bunx wrangler dev      # local workerd
 *   bunx wrangler deploy   # ship it
 */
interface Env {
  readonly GREETING?: string
  /** A Workers KV namespace binding (declare it in wrangler.toml to use it). */
  readonly CACHE?: { get(key: string): Promise<string | null> }
}

// `server<Env>()` types the platform bindings: `c.env` is `Env` everywhere — read it directly.
const app = server<Env>()
  .get("/", async (c) => {
    // c.env is typed Env — no `as` cast. (Bindings are platform-supplied; a real app still validates
    // any *untrusted* values, but the binding objects themselves are trusted platform inputs.)
    const cached = c.env.CACHE ? await c.env.CACHE.get("greeting") : null
    // Background work that doesn't block the response (analytics, cache warmups, …).
    c.waitUntil(Promise.resolve())
    return { greeting: cached ?? c.env.GREETING ?? "hello", runtime: "cloudflare-workers" }
  })
  .get("/health", () => ({ ok: true }))

// `toFetchHandler`'s `env` argument is typed `Env` too (inferred from the app).
export default toFetchHandler(app)
