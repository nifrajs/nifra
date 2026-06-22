import { CodeBlock } from "../../highlight"
import { pageMeta } from "../../meta"

// Pure content page — no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = pageMeta(
  "Nifra — security & hardening",
  "Bounded request bodies, magic-byte file-upload validation, constant-time webhook verification, and idempotency-key replay — the hardening primitives every production app needs, built in.",
)

const BOUNDED = `import { server } from "@nifrajs/core"

const app = server()

// A schema route is ALREADY bounded — the validated read enforces \`maxBodyBytes\`.
// But a raw-body / file / BYO-validation route reads the body directly, which
// \`maxBodyBytes\` does not cover. \`c.boundedBody\` caps that read:
app.post("/import", async (c) => {
  const bytes = await c.boundedBody(5 * 1024 * 1024) // cap THIS route at 5 MiB
  // Over-cap throws a flat 413; a malformed Content-Length a 400 — as control-flow
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

const UPLOADS = `// doc-check: skip — fragment: \`app\`, \`save\`, \`id\`, and \`env\` are your application's.
import { validateUpload, signDownloadUrl } from "@nifrajs/uploads"

app.post("/avatar", async (c) => {
  const form = await c.req.formData()
  const file = form.get("file")
  if (!(file instanceof Blob)) { c.set.status = 400; return { ok: false, error: "no_file" } }

  // Size cap + REAL type by magic bytes — a .exe renamed .png (or a spoofed
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

const STRIP = `// doc-check: skip — fragment: continues the upload handler above (\`result.bytes\`).
import { stripImageMetadata } from "@nifrajs/uploads"
import { bunImageBackend } from "@nifrajs/image/backends"

// Drop EXIF/GPS by re-encoding through any @nifrajs/image backend. @nifrajs/uploads keeps
// ZERO dependency on @nifrajs/image — the backend is passed in (structural type), so this
// also works with sharpImageBackend(sharp) on Node or wasmImageBackend(...) on the edge.
const clean = await stripImageMetadata(result.bytes, bunImageBackend())`

const WEBHOOK = `// doc-check: skip — fragment: \`app\`, \`env\`, \`StripeEvent\`, and the rotation keys are your application's.
import { verifyWebhook } from "@nifrajs/core"

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

const IDEMPOTENCY = `// doc-check: skip — fragment: \`app\`, \`chargeCard\`, and \`id\` are your application's.
import { idempotency, MemoryIdempotencyStore } from "@nifrajs/middleware"

// Dev / single-instance. In production use a SHARED store (Redis, etc.) with an atomic
// claim — MemoryIdempotencyStore throws under NODE_ENV=production unless you opt in.
app.use(idempotency({ store: new MemoryIdempotencyStore() }))

app.post("/charge", async (c) => {
  await chargeCard(/* … */) // the side effect
  return { ok: true, id }
})

// A client retrying POST /charge with the same \`Idempotency-Key\` header gets the FIRST
// response replayed (\`Idempotent-Replayed: true\`) — the charge runs once. A concurrent
// retry, while the first is still in flight, gets 409 { error: "idempotency_in_progress" }.
// Transient 5xx are NOT cached (a failed call stays retryable).`

const GATING = `import { server } from "@nifrajs/core"
import { jwt, csrf, ipRestriction, bodyLimit } from "@nifrajs/middleware"

const app = server()
  // JWT: the algorithm allowlist is REQUIRED; alg:none and RSA/HMAC confusion are rejected; exp enforced.
  .use(jwt({ key: process.env.JWT_SECRET!, algorithms: ["HS256"], issuer: "my-app" }))
  // Signed double-submit CSRF (HMAC) + Origin/Referer check on unsafe methods. Secret must be >= 32 bytes.
  .use(csrf({ secret: process.env.CSRF_SECRET! }))
  // Allow/deny by IPv4/IPv6 + CIDR. FAILS CLOSED with no trusted client IP; X-Forwarded-For is ignored
  // unless trustedProxies > 0 (set it to the number of proxies you actually run in front of the app).
  .use(ipRestriction({ allow: ["10.0.0.0/8", "::1"], trustedProxies: 1 }))
  // Reject oversized bodies at the EDGE by Content-Length, before routing — fails closed (411) on a
  // length-less body. (The schema / c.boundedBody cap is the read-time guard; this is the cheap pre-filter.)
  .use(bodyLimit({ maxBytes: 1_000_000 }))`

const LOGGING = `import { server, jsonLogger, commonSecretPatterns } from "@nifrajs/core"

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
        The pieces every production endpoint needs — a body-size cap for raw routes, real file-type
        validation, constant-time webhook verification, and idempotent retries — ship as first-party
        primitives. All are <b>edge-safe</b> (WebCrypto, no <code>node:crypto</code>) and run unchanged
        on Bun, Node, Deno, and Workers.
      </p>

      <h2>Bounded request bodies</h2>
      <p>
        Nifra caps the body of any <b>schema-validated</b> route at <code>maxBodyBytes</code> — an over-cap{" "}
        <code>Content-Length</code> is rejected before buffering, and a chunked body is aborted mid-stream.
        But a route that reads the body <i>directly</i> (raw bodies, file uploads, your own validation)
        bypasses that read path. <code>c.boundedBody(maxBytes?)</code> and{" "}
        <code>c.boundedJson&lt;T&gt;(maxBytes?)</code> extend the <b>same</b> cap to those routes.
      </p>
      <CodeBlock code={BOUNDED} />
      <p>
        Over-cap throws a flat <code>413</code>, a malformed <code>Content-Length</code> a <code>400</code>,
        bad JSON a <code>400</code> — thrown as control-flow <code>Response</code>s the lifecycle catches,
        so the cap can't be silently skipped. Pass a larger <code>maxBytes</code> for an upload route, a
        smaller one to tighten an endpoint.
      </p>

      <h2>File uploads — <code>@nifrajs/uploads</code></h2>
      <p>
        A dependency-free package for the upload-hardening basics. <code>validateUpload</code> enforces a
        size cap and sniffs the <b>real</b> type from magic bytes — never the client-set{" "}
        <code>Content-Type</code>, which is trivially forged — against an optional allow-list. An oversized{" "}
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
        <code>stripImageMetadata</code> drops EXIF/GPS by re-encoding the image — through any{" "}
        <a href="/docs/images">@nifrajs/image</a> backend, with no dependency on it:
      </p>
      <CodeBlock code={STRIP} />

      <h2>Webhooks — <code>verifyWebhook</code></h2>
      <p>
        The cardinal webhook rule: <b>verify before you parse</b>. A handler that{" "}
        <code>JSON.parse</code>s the body before checking the signature is acting on an unauthenticated
        payload. <code>verifyWebhook</code> reads the raw body bounded, verifies the HMAC, and hands back
        the verified text for you to parse with your own schema.
      </p>
      <CodeBlock code={WEBHOOK} />
      <p>
        Verification is <b>constant-time</b> — the provider's signature goes straight into{" "}
        <code>crypto.subtle.verify</code>, so a wrong signature can't be discovered byte-by-byte through
        timing. Presets cover <b>Stripe</b> (parses <code>t=…,v1=…</code> and enforces a 5-minute replay
        window on the signed timestamp) and <b>GitHub</b> (<code>sha256=…</code>); the <code>generic</code>{" "}
        preset takes an explicit header, encoding, and prefix for anything else. Pass an array of secrets to
        accept either during a key rotation.
      </p>

      <h2>Idempotency — <code>idempotency()</code> middleware</h2>
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
          braces — the constraint is the belt.
        </li>
        <li>
          <b><code>Set-Cookie</code> is never cached or replayed.</b> A session cookie is caller-specific;
          replaying it to a second caller (key collision or abuse) would leak/fixate a session. The first
          caller still gets their cookie — replays just don't carry it.
        </li>
        <li>
          Caching buffers the response body, so apply it to JSON/API routes, not streaming SSR responses.
          Transient <code>5xx</code> aren't cached, so a failed call stays retryable.
        </li>
      </ul>

      <h2>Edge gating — <code>jwt</code>, <code>csrf</code>, <code>ipRestriction</code>, <code>bodyLimit</code></h2>
      <p>
        <code>@nifrajs/middleware</code> ships the request-gating set, applied with <code>app.use()</code>.
        Every one is constant-time where it compares secrets and <b>fails closed</b> by default.
      </p>
      <CodeBlock code={GATING} />
      <ul>
        <li>
          <code>jwt</code> — WebCrypto verification with a <b>required</b> <code>algorithms</code> allowlist;{" "}
          <code>alg:none</code> and RSA/HMAC confusion are rejected, <code>exp</code>/<code>nbf</code>/
          <code>iss</code>/<code>aud</code> are checked. Rotating keys via <code>jwks({`{ url }`})</code>{" "}
          (HTTPS-only, cached). Read claims with <code>auth.requireClaims(c.req)</code>.
        </li>
        <li>
          <code>csrf</code> — signed double-submit token (HMAC, secret ≥ 32 bytes) plus an Origin/Referer
          check on unsafe methods; both the token match and signature are verified constant-time.
        </li>
        <li>
          <code>ipRestriction</code> — IPv4/IPv6 exact + CIDR allow/deny. It <b>fails closed</b> when no
          trustworthy client IP can be derived, and never trusts <code>X-Forwarded-For</code> unless you set{" "}
          <code>trustedProxies</code> to the number of proxies in front of the app.
        </li>
        <li>
          <code>bodyLimit</code> — a cheap <code>Content-Length</code> pre-filter that rejects oversized
          bodies before routing (fails closed with <code>411</code> on a length-less body). The read-time
          guard above (<code>c.boundedBody</code> / schema cap) remains the source of truth.
        </li>
      </ul>

      <h2>Already built in</h2>
      <p>
        These add to Nifra's standing defaults: strict-by-default schema validation (unknown fields
        rejected), SSR serialization that escapes every inline-script value, signed-cookie sessions + CSRF
        + route guards (<a href="/docs/auth">@nifrajs/auth</a>), bearer/apiKey auth + a shared-store rate
        limiter (<a href="/docs/plugins">@nifrajs/middleware</a>), and a hardened image-resize endpoint
        (<a href="/docs/images">@nifrajs/image/server</a>).
      </p>

      <h2>Redacting logs</h2>
      <p>
        The built-in <code>jsonLogger</code> redacts values under sensitive <b>keys</b>{" "}
        (<code>password</code>, <code>authorization</code>, <code>token</code>, …) by default. For
        secrets that land in a <b>value</b> or the message itself (e.g. an <code>err.message</code> that
        embeds a token), pass opt-in <code>valuePatterns</code> — <code>commonSecretPatterns</code> covers
        bearer tokens, JWTs, emails, and a few well-known key formats, or supply your own:
      </p>
      <CodeBlock code={LOGGING} />
    </div>
  )
}
