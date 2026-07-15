import { pageMeta } from "../../meta"
import { CodeBlock } from "../../highlight"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — Edge & bindings",
  "Typed platform bindings in Nifra: c.env, Platform<Env>, c.waitUntil, KV/D1 on the edge.",
)

const ENV = `// server<Env>() types the platform env end-to-end — c.env is your Env in every
// handler AND in derive/decorate middleware, with no cast.
interface Env { KV: KVNamespace; DB: D1Database }

const app = server<Env>()
  .get("/u/:id", async (c) => {
    const cached = await c.env.KV.get(c.params.id)   // c.env is typed Env
    return cached ?? "miss"
  })

export default { fetch: (req: Request, env: Env, ctx: ExecutionContext) =>
  app.fetch(req, { env, waitUntil: ctx.waitUntil.bind(ctx) }) }`

const WAIT = `// c.waitUntil keeps background work alive past the response (analytics, cache writes).
app.post("/event", (c) => {
  c.waitUntil(c.env.KV.put("last", Date.now().toString()))
  return { ok: true }   // returns immediately; the put finishes in the background
})`

const CRON = `// doc-check: skip — \`env.KV\` is typed by your app's \`Env\` (the ./app import), supplied by the reader.
import { toFetchHandler } from "@nifrajs/core/server"
import { app } from "./app"

// Export fetch + a cron handler. Wire the schedule in wrangler.toml: [triggers] crons = ["0 * * * *"]
export default toFetchHandler(app, {
  scheduled: (controller, { env, waitUntil }) =>
    waitUntil(env.KV.put("last-run", String(controller.scheduledTime))),
})`

export default function Edge() {
  return (
    <div className="prose">
      <h1 className="page">Edge &amp; bindings</h1>
      <p className="lead">
        On Cloudflare and other edge runtimes, your platform bindings (KV, D1, Durable Objects,
        secrets) reach handlers through a fully-typed <code>c.env</code>.
      </p>

      <h2>Typed c.env</h2>
      <p>
        <code>server&lt;Env&gt;()</code> threads your <code>Env</code> type through the whole app:{" "}
        <code>c.env</code> is <code>Env</code> in every handler <b>and</b> in{" "}
        <code>derive</code>/<code>decorate</code> middleware — read <code>c.env.KV</code> directly, no
        cast. <code>app.fetch(req, {"{ env }"})</code> / <code>toFetchHandler</code> type-check the
        bindings too. In <code>@nifrajs/web</code>, a route's loader/action gets the same typed{" "}
        <code>env</code>.
      </p>
      <CodeBlock code={ENV} />

      <h2>Background work</h2>
      <p>
        <code>c.waitUntil(promise)</code> keeps work alive after the response is sent — cache writes,
        analytics, fan-out — without blocking the user. (Typing is not validation: platform bindings
        are trusted inputs; validate anything untrusted at the boundary.)
      </p>
      <CodeBlock code={WAIT} />

      <h2>Validation on the edge</h2>
      <p>
        Edge runtimes block dynamic code generation (<code>new Function</code>), which trips many
        schema libraries. Nifra's <code>t</code> handles it transparently: it compiles a fast
        validator on Bun and Node, and falls back to an eval-free checker on Cloudflare Workers,
        Vercel Edge, and Deno Deploy — <b>the same routes validate everywhere</b>, with no
        edge-specific schema module. Because core validates any{" "}
        <a href="https://standardschema.dev" rel="external">
          Standard Schema
        </a>
        , you can also bring Zod, Valibot, or ArkType (all eval-free) — only <code>t</code> also
        emits OpenAPI from the same definition.
      </p>

      <h2>Scheduled (cron)</h2>
      <p>
        Pass <code>scheduled</code> to <code>toFetchHandler</code> to also export a Workers cron
        handler for a <code>[triggers]</code> schedule. It gets the platform controller plus the same
        typed <code>env</code> and <code>waitUntil</code> as your request handlers.
      </p>
      <CodeBlock code={CRON} />
    </div>
  )
}
