import { docsMeta } from "../../meta"

// Pure content page - no React interactivity (TOC/copy/search are the layout enhancer +
// the Nira island), so ship zero framework JS and avoid hydrating the inline-script DOM.
export const hydrate = false

export const meta = docsMeta(
  "/docs/security-comparison",
  "Nifra security posture vs Hono, Fastify, Express, Elysia",
  "A dimension-by-dimension security comparison of Nifra against the current releases of Hono, Fastify, Express, and Elysia - which hardening each framework ships by default, which is opt-in, and which is left to third-party packages.",
)

export default function SecurityComparison() {
  return (
    <div className="prose">
      <h1 className="page">Security posture, compared</h1>
      <p className="lead">
        Which hardening each framework actually ships. A dimension-by-dimension read of Nifra&rsquo;s
        security defaults against the <b>current releases</b> of Hono, Fastify, Express, and Elysia -
        what is on by default, what is opt-in, and what is left to a third-party package. For how each
        Nifra primitive works, see <a href="/docs/security">Security &amp; hardening</a>.
      </p>

      <h2>The honest verdict</h2>
      <p>
        Nifra is <b>at or above parity on every dimension where a comparison is meaningful</b>, and
        ahead of all four on several:
      </p>
      <ul>
        <li>
          <b>Ahead of all four:</b> CORS misconfiguration resistance, redirect safety, WebSocket
          origin policy, rate-limiter safe-by-construction design, route-level security evidence
          (<code>nifra assure</code>), response over-exposure enforcement, upload content
          verification, env-independent error responses, client-IP trust model.
        </li>
        <li>
          <b>Par with the best-in-class:</b> body limits (Fastify class), JSON prototype-poisoning
          rejection (par Fastify, default-on), schema validation (par Fastify/Elysia), CSRF (par
          Fastify), security headers (par Hono, first-party), cookie prefixes (par Hono), sessions,
          JWT hardening, static serving, supply chain (par Hono&rsquo;s zero-dependency core).
        </li>
      </ul>
      <p className="caveat">
        <b>One caveat no capability table removes.</b> Hono, Fastify, and Express have orders of
        magnitude more production exposure and more external researchers looking at them. Nifra&rsquo;s
        protections are implementation-verified and unit-tested, but have not had that volume of
        adversarial attention or a third-party audit. Ongoing scrutiny is the part only time buys.
      </p>

      <h2>How this was measured</h2>
      <p>
        Nifra side: an implementation-level read of every security-relevant module across{" "}
        <code>core</code>, <code>middleware</code>, <code>auth</code>, <code>node</code>,{" "}
        <code>web</code>, <code>uploads</code>, and <code>cli</code> - defaults and failure modes, not
        marketing claims. Competitor side: current official documentation for defaults, verified as of
        August 2026 against Hono 4.12.x, Fastify 5.x, Express 5.1 / 4.21.x, and Elysia 1.4.x. The
        comparison unit is what a developer gets <b>by default</b> and what the framework makes{" "}
        <b>impossible to get wrong</b>, not what a maximally careful expert could configure - because
        most real-world security incidents are misconfiguration-by-default.
      </p>

      <h2>Summary matrix</h2>
      <p>
        Legend: <b>B</b> built-in and on by default, <b>b</b> built-in opt-in, <b>O</b> official
        add-on package, <b>3</b> third-party / community, <b>-</b> absent. The verdict column is Nifra
        relative to the field.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Dimension</th>
              <th>Nifra</th>
              <th>Hono</th>
              <th>Fastify</th>
              <th>Express</th>
              <th>Elysia</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            <tr className="hl">
              <td>Default body-size cap</td>
              <td>B 1 MB</td>
              <td>- (opt-in mw)</td>
              <td>B 1 MiB</td>
              <td>- (needs body-parser)</td>
              <td>- (runtime cap only)</td>
              <td>par Fastify; ahead of the rest</td>
            </tr>
            <tr>
              <td>Bounded streaming reads</td>
              <td>B</td>
              <td>b</td>
              <td>B</td>
              <td>O</td>
              <td>-</td>
              <td>par-plus</td>
            </tr>
            <tr>
              <td>Body cap on delivered bytes (not the claimed length)</td>
              <td>B</td>
              <td>- (keys on Content-Length)</td>
              <td>b</td>
              <td>-</td>
              <td>-</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>Proto-pollution-inert parsers (query / cookie / form / params)</td>
              <td>B null-proto</td>
              <td>B</td>
              <td>B</td>
              <td>B (5.x simple parser)</td>
              <td>B</td>
              <td>par</td>
            </tr>
            <tr className="hl">
              <td>JSON proto-key rejection</td>
              <td>B (reject default)</td>
              <td>-</td>
              <td>B (proto + constructor)</td>
              <td>-</td>
              <td>b (schema-strip)</td>
              <td>par Fastify</td>
            </tr>
            <tr>
              <td>Route ReDoS surface</td>
              <td>B none (strict grammar)</td>
              <td>B</td>
              <td>B (find-my-way)</td>
              <td>B (path-to-regexp)</td>
              <td>B</td>
              <td>par</td>
            </tr>
            <tr>
              <td>Input schema validation</td>
              <td>B per-route Standard Schema</td>
              <td>b (validator mw)</td>
              <td>B ajv</td>
              <td>-</td>
              <td>B TypeBox</td>
              <td>par with best</td>
            </tr>
            <tr>
              <td>Response over-exposure prevention</td>
              <td>B contract warn/enforce</td>
              <td>-</td>
              <td>b (serializer)</td>
              <td>-</td>
              <td>B normalize</td>
              <td>ahead (with Elysia)</td>
            </tr>
            <tr>
              <td>Error responses leak-free by construction</td>
              <td>B env-independent flat 500</td>
              <td>B</td>
              <td>B (mostly)</td>
              <td>b (dev leaks stacks)</td>
              <td>B (mostly)</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>CORS safe-by-construction</td>
              <td>B fail-loud ctor</td>
              <td>b (reflect-with-creds configurable)</td>
              <td>O</td>
              <td>O</td>
              <td>O</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>CSRF</td>
              <td>B two layers (origin + signed double-submit)</td>
              <td>b (origin heuristic)</td>
              <td>O token-based</td>
              <td>3 (csurf deprecated)</td>
              <td>-</td>
              <td>ahead; par Fastify</td>
            </tr>
            <tr className="hl">
              <td>Security headers (first-party)</td>
              <td>b (nosniff/XFO/RP on; COOP/COEP/CORP/PP/CSP/HSTS opt-in)</td>
              <td>b (broader default set once added)</td>
              <td>O helmet</td>
              <td>3 helmet</td>
              <td>3</td>
              <td>par Hono; ahead of the helmet-dependent ones</td>
            </tr>
            <tr>
              <td>Cookie signing + safe serialization</td>
              <td>B</td>
              <td>b</td>
              <td>O</td>
              <td>O</td>
              <td>B</td>
              <td>par-plus</td>
            </tr>
            <tr className="hl">
              <td>
                <code>__Host-</code>/<code>__Secure-</code> prefix enforcement
              </td>
              <td>B (throws on violation)</td>
              <td>B (throws on violation)</td>
              <td>O</td>
              <td>O</td>
              <td>-</td>
              <td>par Hono</td>
            </tr>
            <tr>
              <td>Sessions (HttpOnly, SameSite, fixation, fail-closed)</td>
              <td>B</td>
              <td>-</td>
              <td>O</td>
              <td>3 (express-session)</td>
              <td>3</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>JWT hardening (alg allowlist, none-reject, exp required)</td>
              <td>B</td>
              <td>b (no allowlist, exp optional)</td>
              <td>O (fast-jwt)</td>
              <td>3</td>
              <td>O (jose)</td>
              <td>par-plus</td>
            </tr>
            <tr>
              <td>Rate limiting</td>
              <td>B forced-decision ctor</td>
              <td>3</td>
              <td>O</td>
              <td>3</td>
              <td>3</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>Client IP / proxy trust</td>
              <td>B explicit, fail-closed</td>
              <td>b (per-runtime helpers)</td>
              <td>B (trustProxy)</td>
              <td>B (manual trust proxy)</td>
              <td>-</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>Reverse-proxy hop-by-hop hygiene</td>
              <td>B (strips both directions)</td>
              <td>b (proxy helper)</td>
              <td>O (http-proxy)</td>
              <td>3</td>
              <td>-</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>Load shedding / overload</td>
              <td>B admission (in-flight + loop lag)</td>
              <td>-</td>
              <td>O under-pressure</td>
              <td>-</td>
              <td>-</td>
              <td>ahead; par Fastify</td>
            </tr>
            <tr>
              <td>Static serving traversal defense</td>
              <td>B 7-layer + dotfile deny</td>
              <td>3</td>
              <td>O (send-based)</td>
              <td>O (send-based)</td>
              <td>O</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>Redirect safety (open-redirect + CRLF)</td>
              <td>B same-origin default</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>ahead (unique)</td>
            </tr>
            <tr>
              <td>WebSocket origin check</td>
              <td>B same-origin default</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>ahead (unique)</td>
            </tr>
            <tr>
              <td>Upload content verification (magic bytes, EXIF strip)</td>
              <td>B package</td>
              <td>-</td>
              <td>O limits only</td>
              <td>3 (multer)</td>
              <td>b (t.File type/size)</td>
              <td>ahead</td>
            </tr>
            <tr>
              <td>Constant-time webhook verification</td>
              <td>B (multi-key rotation)</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>ahead (unique)</td>
            </tr>
            <tr>
              <td>Idempotency-key replay</td>
              <td>B (atomic-claim store)</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>ahead (unique)</td>
            </tr>
            <tr>
              <td>Supply chain (runtime deps in core)</td>
              <td>0</td>
              <td>0</td>
              <td>~dozen</td>
              <td>many</td>
              <td>few</td>
              <td>par with Hono</td>
            </tr>
            <tr>
              <td>Machine-checkable route security evidence</td>
              <td>
                B (<code>nifra assure</code>)
              </td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>unique</td>
            </tr>
            <tr>
              <td>Security lint (fail-open, non-constant-time, PII logs)</td>
              <td>B (NF-S001..007)</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>-</td>
              <td>unique</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Dimension detail</h2>

      <h3>Body limits and bounded reads</h3>
      <p>
        Nifra applies a 1 MB default cap to the schema lane and to{" "}
        <code>c.boundedBody</code>/<code>c.boundedJson</code>: an over-cap <code>Content-Length</code>{" "}
        is rejected before buffering (413), a malformed one is a 400, and a chunked or length-less
        body is drained through a true streaming byte counter that cancels at the cap. The cap is
        charged on the bytes actually <b>delivered</b>, never on the number a caller wrote in the
        header - so an adapter that rebuilds a request from an event envelope cannot smuggle a large
        payload behind a small declared length. Fastify enforces its 1 MiB default on real bytes and
        is the gold standard among the four; Nifra matches it. Hono&rsquo;s <code>bodyLimit</code> is
        an opt-in middleware that keys on <code>Content-Length</code>; Express relies on
        body-parser&rsquo;s 100 KB default only if you mount it; Elysia inherits the runtime cap
        (Bun&rsquo;s 128 MB).
      </p>

      <h3>Prototype pollution</h3>
      <p>
        Every hand-rolled parser (query, cookies, form, route params) produces null-prototype objects,
        so <code>__proto__</code>/<code>constructor</code> keys are inert there by construction. The
        JSON body lane <b>rejects</b> the poisoning shape by default - an own <code>__proto__</code>{" "}
        key, or a <code>constructor</code> carrying a <code>prototype</code> - answering the same flat
        400 as malformed JSON, with <code>&quot;strip&quot;</code> and <code>&quot;ignore&quot;</code>{" "}
        as alternatives. That matches Fastify, whose <code>onProtoPoisoning</code> and{" "}
        <code>onConstructorPoisoning</code> both default to <code>&apos;error&apos;</code>. Hono and
        Express do not reject proto keys in the JSON body; Elysia strips undeclared keys only on a
        validated route via its schema normalization.
      </p>

      <h3>Validation and response contracts</h3>
      <p>
        Nifra does per-route Standard Schema validation for body/query/params, and - the
        differentiating half - <b>response</b> schemas as an enforced upper bound:{" "}
        <code>&quot;warn&quot;</code> logs undeclared fields, <code>&quot;enforce&quot;</code> strips
        them. That kills the <code>passwordHash</code>-in-the-response class at the framework layer.
        Fastify offers the same protection through a declared response schema (opt-in); Elysia&rsquo;s
        exactMirror normalization strips undeclared response fields and is its strongest default.
        Hono&rsquo;s validator is opt-in with no response-side story, and Express ships nothing.
      </p>

      <h3>CORS, CSRF, and error handling</h3>
      <p>
        Nifra&rsquo;s <code>cors()</code> throws at construction when <code>credentials: true</code>{" "}
        meets <code>origin: &quot;*&quot;</code>, never reflects an origin by default with credentials,
        and lands headers on error responses too - it is <b>the only one of the five where the
        dangerous configuration is a construction-time error</b>. The other four leave
        reflect-with-credentials configurable. CSRF is two independent layers (Origin/Referer check
        plus a signed double-submit token, timing-safe); Hono&rsquo;s CSRF is an Origin /
        Sec-Fetch-Site heuristic, Fastify&rsquo;s official token package is comparable, Express&rsquo;s
        csurf is deprecated, and Elysia ships none in-tree. Uncaught errors become a flat 500
        unconditionally - not env-gated - so no configuration leaks a stack to the wire; Express&rsquo;s
        dev handler printing stacks when <code>NODE_ENV</code> is unset is the perennial
        counter-example.
      </p>

      <h3>Headers, cookies, sessions, JWT</h3>
      <p>
        Both Nifra and Hono ship a first-party security-headers middleware you add with{" "}
        <code>use()</code>. Nifra&rsquo;s turns on nosniff, <code>X-Frame-Options: DENY</code>, and{" "}
        <code>Referrer-Policy: no-referrer</code>, and keeps the headers that can break a working app
        (COOP/COEP/CORP, Permissions-Policy, CSP, HSTS) opt-in by design; Hono&rsquo;s covers a broader
        list on by default once added, HSTS included. Cookie serialization enforces RFC 6265 name
        tokens, caps at 4096 bytes, and enforces <code>__Host-</code>/<code>__Secure-</code> prefix
        preconditions at serialization time, throwing on a violation - the same behavior Hono&rsquo;s
        cookie helper has, and stricter than a silent browser drop. Sessions are always HMAC-signed,
        HttpOnly, SameSite=Lax, fail-closed, with <code>regenerate()</code> for fixation - no
        competitor ships sessions in-tree. JWT verification demands an algorithm allowlist, rejects{" "}
        <code>alg: none</code>, blocks algorithm confusion at the key level, and requires{" "}
        <code>exp</code> by default; Hono&rsquo;s JWT middleware takes a single required algorithm with
        no enforced allowlist and treats <code>exp</code> as optional, so Nifra is stricter there.
      </p>

      <h3>Static serving, redirects, uploads, proxying</h3>
      <p>
        Static serving runs seven layers - decode with 400 on malformed input, NUL rejection,
        segment-precise <code>..</code> rejection, backslash rejection, containment via{" "}
        <code>resolve</code>+<code>relative</code>, a <code>realpath</code> symlink re-check, and a
        default <b>dotfile deny</b> (a served <code>.env</code>/<code>.git</code> answers 404).{" "}
        <code>redirect()</code> requires a same-origin path by default and rejects CR/LF - Nifra is the
        only one of the five with a safe-by-default redirect. Uploads verify the real type by magic
        bytes and strip EXIF/GPS by re-encode, where the others do size limits at best.{" "}
        <code>@nifrajs/proxy</code> strips the RFC 9110 hop-by-hop set - plus every{" "}
        <code>Connection</code>-nominated header - in <b>both</b> directions by default.
      </p>

      <h3>Rate limiting, IP trust, load shedding</h3>
      <p>
        The rate limiter&rsquo;s constructor refuses to run until you choose a key source, so the
        &ldquo;trust proxy = spoofable keys&rdquo; footgun is a construction-time error;{" "}
        <code>X-Forwarded-For</code> is ignored at the default and counted from the right only when you
        declare trusted proxies. <code>c.clientIp</code> is the socket peer unless you pass an explicit
        trust config, and short chains fail closed. Admission sheds on live capacity evidence
        (in-flight count plus event-loop lag). Fastify&rsquo;s under-pressure is the only peer for load
        shedding; nothing else in the field forces the key decision or fails closed on IP trust.
      </p>

      <h2>Beyond parity - what none of the four ship</h2>
      <ul>
        <li>
          <b>Route assurance evidence.</b> Middleware publishes machine-checkable per-route claims
          (<code>AUTHENTICATED</code>, <code>BODY_BOUNDED</code>, <code>CSRF</code>,{" "}
          <code>RATE_LIMITED</code>, <code>IP_RESTRICTED</code>, <code>SECURITY_HEADERS</code>,{" "}
          <code>IDEMPOTENCY_KEY</code>), and <code>nifra assure</code> fails CI when a policy is unmet.
          Evidence is honest: an escape hatch suppresses its own claim.
        </li>
        <li>
          <b>Security lint rules</b> - fail-open gate detection, non-constant-time secret comparison,
          sensitive values in log calls, and more, running in <code>nifra check</code>.
        </li>
        <li>
          <b>Fail-loud constructors as a design norm</b> - CORS credentials+wildcard, rate-limit
          missing key decision, CSRF short secrets, in-memory stores in production - all
          construction-time errors, not runtime surprises.
        </li>
        <li>
          <b>Response-contract enforce mode, admission load-shedding, idempotency keys, magic-byte +
          EXIF-strip uploads, and constant-time webhook verification</b> - each exists somewhere as a
          third-party add-on for the others; Nifra ships them first-party with assurance integration.
        </li>
      </ul>

      <h2>Where each alternative is still the right call</h2>
      <p>
        This is a security read, not a blanket &ldquo;pick Nifra&rdquo;. Hono&rsquo;s run-anywhere
        minimalism and its zero-dependency core are genuinely excellent; Fastify&rsquo;s maturity,
        ecosystem, and years of adversarial attention are real advantages a young framework cannot
        claim; Express&rsquo;s ubiquity means every hire already knows it. Nifra&rsquo;s argument is
        narrower and honest: it makes the dangerous configurations <i>unrepresentable</i>, ships the
        hardening primitives first-party, and lets <code>nifra assure</code> prove in CI that every
        route is guarded. For the full capability and throughput comparison, see{" "}
        <a href="/docs/comparison">vs other frameworks</a> and the{" "}
        <a href="/compare">per-framework pages</a>.
      </p>
    </div>
  )
}
