import { CodeBlock } from "../../highlight"
import { docsMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = docsMeta(
  "/docs/security",
  "Nifra - security & hardening",
  "Bounded request bodies, JSON prototype-poisoning defense, magic-byte file-upload validation, constant-time webhook verification, security response headers, and idempotency-key replay - the hardening primitives every production app needs, built in.",
)

const RESPONSE_CONTRACT = `import { server } from "@nifrajs/core/server"
import { responseContract } from "@nifrajs/core/response-contract"
import { t } from "@nifrajs/schema"

const PublicUser = t.object({ id: t.string(), name: t.string() })

// "warn" logs and changes nothing; "enforce" makes the contract the upper bound too.
// Not installing the plugin is "off" - and keeps the lane out of your bundle entirely.
export const app = server().use(responseContract("enforce")).get(
  "/me",
  { response: PublicUser },
  async () => {
    // Every column, including the ones the contract never declared.
    const user = { id: "u1", name: "Ada", email: "a@b.c", passwordHash: "..." }
    return user
  },
)

// off      -> {"id":"u1","name":"Ada","email":"a@b.c","passwordHash":"..."}
// enforce  -> {"id":"u1","name":"Ada"}`

const BOUNDED = `import { server } from "@nifrajs/core/server"

const app = server()

// A schema route is ALREADY bounded - the validated read enforces \`maxBodyBytes\`.
// But a raw-body / file / BYO-validation route reads the body directly, which
// \`maxBodyBytes\` does not cover. \`c.boundedBody\` caps that read:
app.post("/import", async (c) => {
  const bytes = await c.boundedBody(5 * 1024 * 1024) // cap THIS route at 5 MiB
  // Over-cap throws a flat 413; a malformed Content-Length a 400 - as control-flow
  // Responses (caught by the lifecycle like \`throw redirect()\`), so a handler can't
  // accidentally ignore the cap. The over-cap length is rejected BEFORE buffering;
  // a chunked / length-less body is aborted mid-stream once it crosses the cap.
  return { received: bytes.byteLength } // a returned object is serialized as JSON 200
})

app.post("/rpc", async (c) => {
  const body = await c.boundedJson<{ method: string }>() // default: the server's maxBodyBytes
  // …bad JSON → 400. Then validate \`body\` with your schema before trusting it.
  return { method: body.method }
})`

const PROTO = `import { server } from "@nifrajs/core/server"

// Default is "reject". A JSON body with an own \`__proto__\` key - or a \`constructor\`
// carrying a \`prototype\` - is the exact shape that turns a later innocent { ...body }
// merge or Object.assign into prototype pollution. It answers the SAME flat 400 as
// malformed JSON, so an attacker learns nothing from the response.
const app = server({ protoPoisoning: "reject" }) // "strip" | "ignore" also available

app.post("/profile", async (c) => {
  const body = await c.boundedJson<{ name: string }>() // and the schema-route path
  // Reached only for a clean payload. Under "strip" the offending keys are deleted and
  // the handler sees the cleaned object; under "ignore" the body passes through as-is.
  return { name: body.name }
})`

const SECURITY_HEADERS = `import { server } from "@nifrajs/core/server"
import { securityHeaders } from "@nifrajs/middleware"

// Always on (covering errors and 404s too): X-Content-Type-Options: nosniff,
// X-Frame-Options: DENY, Referrer-Policy: no-referrer. The rest are opt-in - each is a
// deliberate cross-origin decision, so nifra never turns them on behind your back:
const app = server().use(securityHeaders({
  crossOriginOpenerPolicy: "same-origin",      // isolate the browsing-context group
  crossOriginResourcePolicy: "same-origin",    // block cross-origin embedding of your responses
  crossOriginEmbedderPolicy: "require-corp",   // enable crossOriginIsolated (SharedArrayBuffer, …)
  permissionsPolicy: "camera=(), geolocation=()",
  contentSecurityPolicy: "default-src 'self'",
  hsts: { maxAge: 63072000, includeSubDomains: true, preload: true }, // opt in once HTTPS-only
}))`

const UPLOADS = `// doc-check: skip - fragment: \`app\`, \`save\`, \`id\`, and \`env\` are your application's.
import { validateUpload, signDownloadUrl } from "@nifrajs/uploads"

app.post("/avatar", async (c) => {
  const form = await c.req.formData()
  const file = form.get("file")
  if (!(file instanceof Blob)) { c.set.status = 400; return { ok: false, error: "no_file" } }

  // Size cap + REAL type by magic bytes - a .exe renamed .png (or a spoofed
  // Content-Type) is caught, because the bytes win. An oversized Blob is rejected
  // by its .size BEFORE it's buffered into memory.
  const result = await validateUpload(file, {
    maxBytes: 2_000_000,
    accept: ["image/png", "image/jpeg"], // exact, or "image/*"
  })
  if (!result.ok) { c.set.status = 400; return { ok: false, error: result.reason } }
  //  reason: "too_large" | "empty" | "unrecognized" | "type_not_allowed"

  await save(result.bytes, \`\${id}.\${result.ext}\`) // result.mime / .ext are trustworthy

  // Hand back a short-TTL, tamper-evident URL (HMAC over path + expiry):
  const url = await signDownloadUrl(\`/files/\${id}\`, env.FILE_SECRET, { expiresInSeconds: 300 })
  return { ok: true, url } // a returned object is serialized as JSON 200
})`

const STRIP = `// doc-check: skip - fragment: continues the upload handler above (\`result.bytes\`).
import { stripImageMetadata } from "@nifrajs/uploads"
import { bunImageBackend } from "@nifrajs/image/backends"

// Drop EXIF/GPS by re-encoding through any @nifrajs/image backend. @nifrajs/uploads keeps
// ZERO dependency on @nifrajs/image - the backend is passed in (structural type), so this
// also works with sharpImageBackend(sharp) on Node or wasmImageBackend(...) on the edge.
const clean = await stripImageMetadata(result.bytes, bunImageBackend())`

const WEBHOOK = `// doc-check: skip - fragment: \`app\`, \`env\`, \`StripeEvent\`, and the rotation keys are your application's.
import { verifyWebhook } from "@nifrajs/core/webhook"

app.post("/webhooks/stripe", async (c) => {
  // Reads the raw body BOUNDED (DoS guard), verifies the HMAC CONSTANT-TIME, and only
  // then returns the payload. Never JSON.parse a webhook before the signature checks out.
  const r = await verifyWebhook(c.req, env.STRIPE_WEBHOOK_SECRET, { provider: "stripe" })
  if (!r.ok) { c.set.status = 400; return { ok: false, error: r.reason } }
  //  reason: "missing_signature" | "invalid_signature" | "timestamp_out_of_tolerance"
  //        | "malformed_signature" | "payload_too_large" | "invalid_content_length"

  const event = StripeEvent.parse(JSON.parse(r.payload)) // validate at the trust boundary
  // …handle event… (pair with idempotency below so a redelivery doesn't double-process)
  return { ok: true }
})

// GitHub (sha256=…hex), or any provider via the generic preset:
await verifyWebhook(c.req, env.GH_SECRET, { provider: "github" })
await verifyWebhook(c.req, [next, current], {            // an array accepts either during a rotation
  header: "x-signature", encoding: "base64", prefix: "v1=",
})`

const IDEMPOTENCY = `// doc-check: skip - fragment: \`app\`, \`chargeCard\`, and \`id\` are your application's.
import { idempotency, MemoryIdempotencyStore } from "@nifrajs/middleware"

// Dev / single-instance. In production use a SHARED store (Redis, etc.) with an atomic
// claim - MemoryIdempotencyStore throws under NODE_ENV=production unless you opt in.
app.use(idempotency({ store: new MemoryIdempotencyStore() }))

app.post("/charge", async (c) => {
  await chargeCard(/* … */) // the side effect
  return { ok: true, id }
})

// A client retrying POST /charge with the same \`Idempotency-Key\` header gets the FIRST
// response replayed (\`Idempotent-Replayed: true\`) - the charge runs once. A concurrent
// retry, while the first is still in flight, gets 409 { error: "idempotency_in_progress" }.
// Transient 5xx are NOT cached (a failed call stays retryable).`

const GATING = `import { server } from "@nifrajs/core/server"
import { jwt, csrf, ipRestriction, bodyLimit } from "@nifrajs/middleware"

const app = server()
  // JWT: the algorithm allowlist is REQUIRED; alg:none and RSA/HMAC confusion are rejected; exp enforced.
  .use(jwt({ key: process.env.JWT_SECRET!, algorithms: ["HS256"], issuer: "my-app" }))
  // Signed double-submit CSRF (HMAC) + Origin/Referer check on unsafe methods. Secret must be >= 32 bytes.
  .use(csrf({ secret: process.env.CSRF_SECRET! }))
  // Allow/deny by IPv4/IPv6 + CIDR. FAILS CLOSED with no trusted client IP; X-Forwarded-For is ignored
  // unless trustedProxies > 0 (set it to the number of proxies you actually run in front of the app).
  .use(ipRestriction({ allow: ["10.0.0.0/8", "::1"], trustedProxies: 1 }))
  // Reject oversized bodies at the EDGE by Content-Length, before routing - fails closed (411) on a
  // length-less body. (The schema / c.boundedBody cap is the read-time guard; this is the cheap pre-filter.)
  .use(bodyLimit({ maxBytes: 1_000_000 }))`

const ASSURANCE = `// doc-check: skip - configuration file imports your application backend.
// nifra.assurance.ts
import { defineAssuranceConfig, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import { app } from "./backend.ts"

export default defineAssuranceConfig({
  source: app,
  policy: {
    // First match owns the route: put narrow exceptions before broad defaults.
    rules: [
      { name: "health", match: { paths: ["/health"] }, require: [],
        forbid: [NIFRA_ASSURANCE.AUTHENTICATED] },
      { name: "mutation", match: { methods: ["POST", "PUT", "PATCH", "DELETE"] },
        require: [NIFRA_ASSURANCE.AUTHENTICATED, NIFRA_ASSURANCE.CSRF,
          NIFRA_ASSURANCE.BODY_BOUNDED] },
      { name: "read", match: { methods: ["GET", "HEAD"] },
        require: [NIFRA_ASSURANCE.AUTHENTICATED] },
    ],
  },
})

// CI: nifra assure              # human diagnostics
// CI: nifra assure --json       # complete machine-readable report`

const CAPABILITIES = `// doc-check: skip - combines route and assurance-config excerpts.
// route: exact effect declaration + correlated execution at the owned adapter seam
import { executeCapability } from "@nifrajs/core/capabilities"

app.aroundCapability(async (effect, next) => {
  // Ask an entitlement service or short-lived approval gate using token-only metadata.
  // effect.signal aborts on request cancellation or the interceptor timeout.
  if (!policyAllows(effect.capability, effect.target)) return // deny fail-closed
  await next()
}, { timeoutMs: 5_000 })

app.post("/orders", { capabilities: ["db.write"] }, async (c) => {
  return executeCapability(
    c,
    "db.write",
    { target: "repo:orders" },
    ({ signal }) => orders.write(c.body, { signal }),
  )
})

// in nifra.assurance.ts, alongside policy:
capabilities: {
  definitions: [
    { id: "db.read", zone: "domain", access: "read" },
    { id: "db.write", zone: "domain", access: "write", idempotency: "request" },
    { id: "telemetry.write", zone: "operational", access: "write" },
  ],
  provenance: {
    // Use effect-specific facades. A broad module that mixes reads/writes cannot prove either.
    imports: [
      { specifier: "@app/db/read", capabilities: ["db.read"] },
      { specifier: "@app/db/write", capabilities: ["db.write"] },
    ],
    forbiddenImports: [
      { specifier: "postgres", reason: "use the tenant-scoped DB facade" },
    ],
  },
}

// developer: nifra capabilities snapshot
// CI:        nifra check && nifra assure && nifra capabilities check`

const DURABLE_EFFECTS = `// doc-check: skip - durable store implementations are deployment-specific.
import {
  createApprovalCoordinator,
  createDurableEffectJournal,
  createSagaEngine,
} from "@nifrajs/core/durable-execution"
import { effectTracing } from "@nifrajs/otel/effects"

const effects = effectTracing({ exporter })
app.use(effects)

const approval = createApprovalCoordinator({
  store: durableApprovalStore, // must declare durability: "durable"
  secret: approvalHmacKey,     // 32+ random bytes, stored separately
})
const journal = createDurableEffectJournal({ store: durableEffectStore })

await executeCapability(c, "payments.charge", {
  target: "provider:stripe",
  digest,
  journal,
  approval: {
    gate: approval,
    tenantId: c.principal.tenantId,
    principalId: c.principal.userId,
    resumeToken,
  },
}, ({ effectId, signal }) => payments.charge(input, { idempotencyKey: effectId, signal }))

const sagas = createSagaEngine({
  store: durableSagaStore,
  observer: effects.observer,
})`

const LOGGING = `import { server, jsonLogger, commonSecretPatterns } from "@nifrajs/core/server"

// Key-name redaction is always on; valuePatterns adds opt-in value + message scanning.
const app = server({
  logger: jsonLogger(undefined, { valuePatterns: commonSecretPatterns }),
})

// logger.error("auth failed for user@example.com with Bearer abc.def")
//   → { ...,"message":"auth failed for [REDACTED] with [REDACTED]" }
// Add your own: { valuePatterns: [...commonSecretPatterns, /\\bord_[a-z0-9]+/g] }`

export default function Security() {
  return (
    <div className="prose">
      <h1 className="page">Security &amp; hardening</h1>
      <p className="lead">
        The pieces every production endpoint needs - a body-size cap for raw routes, real file-type
        validation, constant-time webhook verification, and idempotent retries - ship as first-party
        primitives. All are <b>edge-safe</b> (WebCrypto, no <code>node:crypto</code>) and run unchanged
        on Bun, Node, Deno, and Workers.
      </p>

      <h2>Responses that cannot leak more than they declare</h2>
      <p>
        A <code>response</code> schema is a <strong>lower</strong> bound: it says &ldquo;at least these
        fields&rdquo;, never &ldquo;only these&rdquo;. A handler returning a database row that satisfies
        it also ships every other column, and nothing points at it - TypeScript&rsquo;s
        excess-property check does not reach a handler&rsquo;s return position, and the client&rsquo;s
        type reports the contract rather than the bytes. So the leak is invisible from both ends, and it
        can appear with no code change at all: add a column, and the next deploy ships it to browsers.
      </p>
      <CodeBlock code={RESPONSE_CONTRACT} lang="ts" />
      <p>
        Not installing the plugin is &ldquo;off&rdquo;, which is exactly today&rsquo;s behaviour and
        keeps the lane out of your bundle rather than shipping a disabled branch to everyone.{" "}
        <code>&quot;warn&quot;</code> checks every response, logs the undeclared fields by name, and
        serves the payload <strong>unchanged</strong> - so turning it on in staging can never be the
        thing that broke production. <code>&quot;enforce&quot;</code> serializes the validated value
        instead of the raw result. Install it before the routes it should cover: like{" "}
        <code>idempotency()</code>, the decision is made per route at registration.
      </p>
      <p>
        Enforcement follows your schema&rsquo;s own semantics, because Standard Schema exposes{" "}
        <code>validate</code> and no way to enumerate declared keys. A <em>stripping</em> schema (Zod,
        Valibot) yields a cleaned value, so the extra fields are dropped. A <em>strict</em> one
        (<code>@nifrajs/schema</code>&rsquo;s <code>t.object</code>) reports them as issues, so the
        response becomes a 500 and the detail goes to the logger, never to the caller. Both are what you
        already declared about extra fields.
      </p>
      <p>
        The check itself is essentially free: with a compiled validator it measures in the
        ~100ns-per-response range, and a realistic middleware-carrying route benchmarks within noise
        of the same route with no contract at all, on Bun and Node alike. What a contracted route
        does give up is the bare-route fused lane - the check needs the handler&rsquo;s value before
        it becomes bytes - and a route with any middleware, derive, or lifecycle hook has already
        left that lane. If a route looks like production, the contract costs nothing: declare it.
      </p>

      <h2>Bounded request bodies</h2>
      <p>
        Nifra caps the body of any <b>schema-validated</b> route at <code>maxBodyBytes</code> - an over-cap{" "}
        <code>Content-Length</code> is rejected before buffering, and a chunked body is aborted mid-stream.
        But a route that reads the body <i>directly</i> (raw bodies, file uploads, your own validation)
        bypasses that read path. <code>c.boundedBody(maxBytes?)</code> and{" "}
        <code>c.boundedJson&lt;T&gt;(maxBytes?)</code> extend the <b>same</b> cap to those routes.
      </p>
      <CodeBlock code={BOUNDED} />
      <p>
        Over-cap throws a flat <code>413</code>, a malformed <code>Content-Length</code> a <code>400</code>,
        bad JSON a <code>400</code> - thrown as control-flow <code>Response</code>s the lifecycle catches,
        so the cap can't be silently skipped. Pass a larger <code>maxBytes</code> for an upload route, a
        smaller one to tighten an endpoint.
      </p>
      <p>
        The cap is enforced on the bytes actually <b>delivered</b>, never on the number the caller wrote in{" "}
        <code>Content-Length</code>. That distinction is the whole defense: an adapter that rebuilds a
        request from an event envelope, or any code assembling a <code>Request</code> by hand, can carry a
        header claiming 5 bytes over a payload of five megabytes. A runtime HTTP parser cannot lie that way,
        because it framed the body at the declared length itself, so nifra's ingress adapters mark their
        requests as runtime-framed and skip the recount entirely:{" "}
        <code>listen()</code> on Bun, <code>toFetchHandler(app)</code> on Workers and edge,{" "}
        <code>@nifrajs/deno</code>, and <code>@nifrajs/node</code> (which reads exact byte counts in the
        first place). Nothing to configure on any of them.
      </p>
      <p>
        Only a request arriving through a path nifra ships no adapter for pays the extra pass over the body.
        If you serve an edge runtime by exporting the app directly rather than through{" "}
        <code>toFetchHandler</code>, <code>server({"{ trustBodyFraming: true }"})</code> asserts that every{" "}
        <code>app.fetch</code> request came from the platform's own parser. It is an assertion about
        deployment topology, so do not set it on an app whose <code>fetch</code> is also called with
        requests built from untrusted input. It trusts the <i>frame</i>, never the cap: an over-cap declared
        length is still a <code>413</code>, and a body with no <code>Content-Length</code> still goes
        through the streaming guard.
      </p>

      <h2>Prototype-poisoning defense</h2>
      <p>
        Every JSON body nifra parses - the schema-validated route and <code>c.boundedJson</code>
        alike - is screened for the prototype-pollution shape: an own <code>__proto__</code> key, or
        a <code>constructor</code> whose value carries a <code>prototype</code>. <code>JSON.parse</code>
        creates these as ordinary data properties, and the damage lands later, when innocent code does{" "}
        <code>{"{ ...body }"}</code>, <code>Object.assign(target, body)</code>, or a deep merge and
        walks that key onto a real prototype. The screen is on by default.
      </p>
      <CodeBlock code={PROTO} lang="ts" />
      <p>
        <code>protoPoisoning</code> is a server option with three settings.
        <code> &quot;reject&quot;</code> (the default) answers the same flat <code>400</code> as
        malformed JSON - indistinguishable on the wire, so a probe learns nothing.{" "}
        <code>&quot;strip&quot;</code> deletes the offending keys and hands the handler the cleaned
        value, siblings intact. <code>&quot;ignore&quot;</code> parses as-is, for a route you are sure
        never merges body input into another object. A string <i>value</i> of <code>&quot;__proto__&quot;</code>{" "}
        is legal data and never triggers - only an own key of that name does.
      </p>
      <p>
        The check is sound against escape smuggling: a <code>__proto__</code>-spelled key
        parses to the same own property, so it is caught the same way. And it is cheap on the common
        path - a clean body pays a substring pre-scan only; the deep walk runs solely when the raw text
        actually contains a suspect token, so an honest payload is never charged for the tree it does
        not have.
      </p>

      <h2>File uploads - <code>@nifrajs/uploads</code></h2>
      <p>
        A dependency-free package for the upload-hardening basics. <code>validateUpload</code> enforces a
        size cap and sniffs the <b>real</b> type from magic bytes - never the client-set{" "}
        <code>Content-Type</code>, which is trivially forged - against an optional allow-list. An oversized{" "}
        <code>Blob</code> is rejected by its <code>.size</code> before it's ever buffered.
      </p>
      <CodeBlock code={UPLOADS} />
      <p>
        Pair it with <code>c.boundedBody</code> to also bound the <i>read</i>: cap the read, then validate
        the buffered bytes. <code>detectFileType(bytes)</code> is exposed standalone too (returns{" "}
        <code>{`{ mime, ext }`}</code> or <code>null</code>), covering common image / A-V / archive types.
      </p>
      <p>
        <code>signDownloadUrl</code> / <code>verifyDownloadUrl</code> mint short-TTL, tamper-evident
        download links (HMAC-SHA256 over the path + expiry, constant-time verify). And{" "}
        <code>stripImageMetadata</code> drops EXIF/GPS by re-encoding the image - through any{" "}
        <a href="/docs/images">@nifrajs/image</a> backend, with no dependency on it:
      </p>
      <CodeBlock code={STRIP} />

      <h2>Webhooks - <code>verifyWebhook</code></h2>
      <p>
        The cardinal webhook rule: <b>verify before you parse</b>. A handler that{" "}
        <code>JSON.parse</code>s the body before checking the signature is acting on an unauthenticated
        payload. <code>verifyWebhook</code> reads the raw body bounded, verifies the HMAC, and hands back
        the verified text for you to parse with your own schema.
      </p>
      <CodeBlock code={WEBHOOK} />
      <p>
        Verification is <b>constant-time</b> - the provider's signature goes straight into{" "}
        <code>crypto.subtle.verify</code>, so a wrong signature can't be discovered byte-by-byte through
        timing. Presets cover <b>Stripe</b> (parses <code>t=…,v1=…</code> and enforces a 5-minute replay
        window on the signed timestamp) and <b>GitHub</b> (<code>sha256=…</code>); the <code>generic</code>{" "}
        preset takes an explicit header, encoding, and prefix for anything else. Pass an array of secrets to
        accept either during a key rotation.
      </p>

      <h2>Idempotency - <code>idempotency()</code> middleware</h2>
      <p>
        A dropped connection or an impatient double-tap shouldn't double-charge a card. With an{" "}
        <code>Idempotency-Key</code> header, a retried unsafe request replays the first response instead of
        re-running the side effect. It short-circuits in <code>onRequest</code>, <i>before</i> the handler.
      </p>
      <CodeBlock code={IDEMPOTENCY} />
      <ul>
        <li>
          <b>Production needs a shared store.</b> <code>MemoryIdempotencyStore</code> is per-instance and{" "}
          refuses to start under <code>NODE_ENV=production</code> unless you pass{" "}
          <code>{`{ allowInProduction: true }`}</code>. Implement <code>IdempotencyStore</code> over Redis
          (etc.) with an <b>atomic</b> claim (<code>SET key NX PX</code>) so two retries can't both proceed.
        </li>
        <li>
          <b>Pair it with a DB uniqueness constraint.</b> The middleware stops the <i>retry</i>; the
          constraint is the source of truth for genuinely-concurrent <i>distinct</i> requests. Belt and
          braces - the constraint is the belt.
        </li>
        <li>
          <b><code>Set-Cookie</code> is never cached or replayed.</b> A session cookie is caller-specific;
          replaying it to a second caller (key collision or abuse) would leak/fixate a session. The first
          caller still gets their cookie - replays just don't carry it.
        </li>
        <li>
          Caching buffers the response body, so apply it to JSON/API routes, not streaming SSR responses.
          Transient <code>5xx</code> aren't cached, so a failed call stays retryable.
        </li>
      </ul>

      <h2>Edge gating - <code>jwt</code>, <code>csrf</code>, <code>ipRestriction</code>, <code>bodyLimit</code></h2>
      <p>
        <code>@nifrajs/middleware</code> ships the request-gating set, applied with <code>app.use()</code>.
        Every one is constant-time where it compares secrets and <b>fails closed</b> by default.
      </p>
      <CodeBlock code={GATING} />
      <ul>
        <li>
          <code>jwt</code> - WebCrypto verification with a <b>required</b> <code>algorithms</code> allowlist;{" "}
          <code>alg:none</code> and RSA/HMAC confusion are rejected, <code>exp</code>/<code>nbf</code>/
          <code>iss</code>/<code>aud</code> are checked. Rotating keys via <code>jwks({`{ url }`})</code>{" "}
          (HTTPS-only, cached). Read claims with <code>auth.requireClaims(c.req)</code>.
        </li>
        <li>
          <code>csrf</code> - signed double-submit token (HMAC, secret ≥ 32 bytes) plus an Origin/Referer
          check on unsafe methods; both the token match and signature are verified constant-time.
        </li>
        <li>
          <code>ipRestriction</code> - IPv4/IPv6 exact + CIDR allow/deny. It <b>fails closed</b> when no
          trustworthy client IP can be derived, and never trusts <code>X-Forwarded-For</code> unless you set{" "}
          <code>trustedProxies</code> to the number of proxies in front of the app.
        </li>
        <li>
          <code>bodyLimit</code> - a cheap <code>Content-Length</code> pre-filter that rejects oversized
          bodies before routing (fails closed with <code>411</code> on a length-less body). The read-time
          guard above (<code>c.boundedBody</code> / schema cap) remains the source of truth.
        </li>
      </ul>

      <h2>Security response headers - <code>securityHeaders</code></h2>
      <p>
        <code>securityHeaders()</code> sets a safe-by-default response header set on every response,
        errors and 404s included. Three are always on - <code>X-Content-Type-Options: nosniff</code>,{" "}
        <code>X-Frame-Options: DENY</code>, and <code>Referrer-Policy: no-referrer</code>. The
        cross-origin isolation headers (<code>COOP</code>/<code>COEP</code>/<code>CORP</code>),{" "}
        <code>Permissions-Policy</code>, <code>Content-Security-Policy</code>, and <code>HSTS</code> are
        opt-in, because each one can break a working app (embedding, popups, HTTP) and so is a
        deliberate choice, never a silent default.
      </p>
      <CodeBlock code={SECURITY_HEADERS} lang="ts" />
      <p>
        Every value is fixed at construction, so the headers are declared statically rather than
        written by a response hook - an app whose response middleware is only this keeps the fused
        native response lanes. A route that sets one of these names itself keeps its own value.
      </p>

      <h2>Route assurance - prove every route is guarded</h2>
      <p>
        Installing security middleware is not the same as proving it covers every route. Nifra&apos;s
        official auth, CSRF, body-limit, rate-limit, idempotency, IP-restriction, and security-header
        modules publish reflection-safe evidence at the hook where they enforce it. A policy then
        classifies every route and fails closed when evidence is missing or forbidden.
      </p>
      <CodeBlock code={ASSURANCE} />
      <p>
        Evidence follows real lifecycle semantics: pre-routing and response hooks cover the whole app,
        while authentication and other order-scoped hooks cover only routes registered after them.
        Method and path filters prevent a narrow guard from claiming broader coverage. The evaluation
        runs only through reflection or <code>nifra assure</code>, so requests pay no assurance cost.
      </p>

      <h2>Effect assurance - declared capability versus provenance</h2>
      <p>
        Authentication does not reveal what a route can do. Capability assurance compares an exact
        route declaration against every approved effect import reachable through that route&apos;s local
        module graph. Static, dynamic, <code>require</code>, and re-export edges are scanned; raw provider
        imports fail <code>nifra check</code>. Runtime beacons add denial at owned adapters, but are never
        treated as a substitute for static provenance.
      </p>
      <CodeBlock code={CAPABILITIES} />
      <p>
        Domain writes on <code>GET</code>/<code>HEAD</code> are hard violations. Each write definition may
        require request idempotency or durable command/provider-key evidence. The lockfile contains only
        method, path, and capability tokens-no payloads or tenant data-and CI never rewrites it.
      </p>

      <h2>Durable approval, compensation, and reconciliation</h2>
      <p>
        The durable execution subpath turns the capability boundary into a crash-visible workflow.
        Approval resumes are HMAC-signed, expire, bind to the tenant, principal, capability, target, and
        digest, and are consumed atomically once. The effect journal marks execution before the provider
        call, so a crash after an external commit remains <code>ambiguous</code> for reconciliation instead
        of being retried blindly. Typed sagas persist compensation arguments separately from the sealed
        token-only ledger and compensate committed steps in reverse order with retry/backoff state.
      </p>
      <CodeBlock code={DURABLE_EFFECTS} />

      <h2>Already built in</h2>
      <p>
        These add to Nifra's standing defaults: strict-by-default schema validation (unknown fields
        rejected), SSR serialization that escapes every inline-script value,{" "}
        <code>__Host-</code>/<code>__Secure-</code> cookie-prefix enforcement (a cookie whose
        attributes violate its prefix contract fails at serialization rather than being silently
        dropped by the browser), signed-cookie sessions + CSRF + route guards
        (<a href="/docs/auth">@nifrajs/auth</a>), bearer/apiKey auth + a shared-store rate
        limiter (<a href="/docs/plugins">@nifrajs/middleware</a>), and a hardened image-resize endpoint
        (<a href="/docs/images">@nifrajs/image/server</a>).
      </p>

      <h2>Redacting logs</h2>
      <p>
        The built-in <code>jsonLogger</code> redacts values under sensitive <b>keys</b>{" "}
        (<code>password</code>, <code>authorization</code>, <code>token</code>, …) by default. For
        secrets that land in a <b>value</b> or the message itself (e.g. an <code>err.message</code> that
        embeds a token), pass opt-in <code>valuePatterns</code> - <code>commonSecretPatterns</code> covers
        bearer tokens, JWTs, emails, and a few well-known key formats, or supply your own:
      </p>
      <CodeBlock code={LOGGING} />
    </div>
  )
}
