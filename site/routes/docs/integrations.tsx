import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

export const hydrate = false

export const meta = pageMeta(
  "Nifra - Integrations (Stripe, and any npm library)",
  "Third-party libraries work in nifra as-is - handlers are plain TypeScript. The Stripe recipe end-to-end: SDK calls in a route, constant-time webhook verification, and idempotent processing.",
)

const SDK = `// doc-check: skip - fragment: \`env\` and your price ids are your application's.
import { server } from "@nifrajs/core/server"
import { t } from "@nifrajs/schema"
import Stripe from "stripe"

// The Stripe SDK, exactly as its own docs show it. No adapter, no wrapper, no plugin.
const stripe = new Stripe(env.STRIPE_SECRET_KEY)

export const billing = server().post(
  "/api/checkout",
  { body: t.object({ priceId: t.string({ minLength: 1 }) }) },
  async (c) => {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: c.body.priceId, quantity: 1 }],
      success_url: "https://app.example.com/billing?done=1",
      cancel_url: "https://app.example.com/billing",
    })
    return { url: session.url }
  },
)`

const WEBHOOK = `// doc-check: skip - fragment: \`app\`, \`env\`, and \`StripeEvent\` are your application's.
import { verifyWebhook } from "@nifrajs/core/webhook"

app.post("/webhooks/stripe", async (c) => {
  // Bounded raw-body read + constant-time HMAC check, BEFORE any parsing.
  const r = await verifyWebhook(c.req, env.STRIPE_WEBHOOK_SECRET, { provider: "stripe" })
  if (!r.ok) { c.set.status = 400; return { ok: false, error: r.reason } }

  const event = StripeEvent.parse(JSON.parse(r.payload)) // validate at the trust boundary
  // …fulfil the event…
  return { ok: true }
})`

const REPLAY = `// doc-check: skip - fragment: \`app\` and \`fulfil\` are your application's.
import { idempotency, MemoryIdempotencyStore } from "@nifrajs/middleware"

// Stripe redelivers webhooks and clients retry checkouts. With the idempotency
// middleware, a retried request with the same Idempotency-Key replays the FIRST
// response - the side effect runs once. Use a shared store (Redis) in production.
app.use(idempotency({ store: new MemoryIdempotencyStore() }))`

export default function Integrations() {
  return (
    <div className="prose">
      <h1 className="page">Integrations</h1>
      <p className="lead">
        The most important thing on this page: <strong>you rarely need it</strong>. A nifra handler
        is plain TypeScript running on Bun, Node, Deno, or the edge - the npm ecosystem works
        as-is. Stripe, OpenAI, Resend, Drizzle, Prisma, AWS SDKs: import them and call them, the
        way their own documentation shows.
      </p>

      <h2>When you need nothing at all</h2>
      <p>
        If a library is called from your code - an SDK, a database client, a date library - there is
        no integration step. It does not know or care that nifra is serving the request. The one
        rule that still applies is nifra's own: anything crossing a trust boundary (a request body,
        a webhook payload, a third-party response you act on) goes through a schema first.
      </p>

      <h2>The Stripe recipe</h2>
      <p>Three parts, each already covered by something the framework ships.</p>

      <h3>1. Calling the SDK</h3>
      <CodeBlock code={SDK} lang="ts" />
      <p>
        Ordinary route, ordinary SDK call. The body schema is doing real work: a checkout endpoint
        is a public POST, and <code>c.body.priceId</code> arrives validated and typed.
      </p>

      <h3>2. Receiving webhooks</h3>
      <CodeBlock code={WEBHOOK} lang="ts" />
      <p>
        This is the part teams hand-roll incorrectly. <code>verifyWebhook</code> reads the raw body
        bounded (DoS guard), verifies the signature in constant time, checks the timestamp
        tolerance, and only then hands you the payload. Presets exist for Stripe and GitHub, and a
        generic header/encoding form covers any other provider - including key rotation via an
        array of secrets. Details in <a href="/docs/security">security</a>.
      </p>

      <h3>3. Processing exactly once</h3>
      <CodeBlock code={REPLAY} lang="ts" />
      <p>
        Stripe redelivers; users double-click. The <code>idempotency</code> middleware replays the
        first response for a retried key instead of re-running the charge, and rejects a concurrent
        duplicate while the first is in flight.
      </p>

      <h2>When to write a plugin</h2>
      <p>
        Reach for <a href="/docs/plugins">a plugin</a> only when a library should participate in
        the framework itself: contribute typed context to every handler (<code>c.stripe</code>, a
        session, a tenant), mount routes of its own, or hook the request lifecycle. That is{" "}
        <code>definePlugin</code> - a few lines, typed end-to-end. For everything else, an import
        at the top of the file is the whole integration.
      </p>
    </div>
  )
}
