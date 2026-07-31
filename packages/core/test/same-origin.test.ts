import { describe, expect, test } from "bun:test"
import { isSameOriginRequest } from "../src/internal/same-origin.ts"

/**
 * The rule this encodes, and why it is not just "compare the origins".
 *
 * A server behind a TLS-terminating proxy - Cloudflare, a tunnel, an ingress, which is how almost
 * everything is deployed - sees a plain HTTP socket. `request.url` therefore says `http:` while the
 * browser correctly reports an `https:` page. Comparing full origins rejects that, and it was measured
 * rather than argued: every server-function POST came back 403 behind a terminating proxy, while the
 * cross-origin attacker the comparison was aimed at had already been rejected on the host alone.
 *
 * So the scheme is compared as a RANK, not for equality: the Origin may be as strong as the request's
 * or stronger, never weaker. That keeps the proxy working and still refuses the downgrade.
 *
 * Nifra does not read `X-Forwarded-Proto` to reconcile the two, and that is deliberate: a forwarded
 * header is attacker-controlled unless something upstream is proven to overwrite it, so trusting one
 * by default would hand every unproxied deployment a spoofable origin check.
 */

const check = (origin: string, url: string): boolean =>
  isSameOriginRequest(origin, new Request(url))

describe("isSameOriginRequest", () => {
  test("a TLS-terminating proxy is same-origin: https page, http socket", () => {
    expect(check("https://app.example", "http://app.example/_nifra/fn/a/b")).toBe(true)
    expect(check("https://app.example:8443", "http://app.example:8443/x")).toBe(true)
  })

  test("the ordinary cases still hold", () => {
    expect(check("https://app.example", "https://app.example/x")).toBe(true)
    expect(check("http://localhost:3000", "http://localhost:3000/x")).toBe(true)
  })

  test("a downgrade is not same-origin", () => {
    // Nifra terminated TLS itself here, so a plaintext page on the same host is what an attacker
    // would need and what no real deployment produces.
    expect(check("http://app.example", "https://app.example/x")).toBe(false)
  })

  test("host, including port, must match exactly", () => {
    expect(check("https://evil.example", "http://app.example/x")).toBe(false)
    expect(check("https://app.example.evil.test", "http://app.example/x")).toBe(false)
    expect(check("https://app.example:8443", "http://app.example/x")).toBe(false)
    expect(check("https://app.example", "http://app.example:8080/x")).toBe(false)
  })

  test("anything that is not a browser page origin is refused", () => {
    // `Origin: null` from a sandboxed frame, a file:// document, a webview scheme. An app that must
    // accept one says so through its allowlist rather than through a hole here.
    for (const origin of [
      "null",
      "",
      "file://app.example",
      "capacitor://app.example",
      "not a url",
    ]) {
      expect(check(origin, "http://app.example/x")).toBe(false)
    }
  })
})

/**
 * One owner, checked. These are two different packages reading the same helper, and before they did
 * they disagreed: a browser could open a WebSocket and be told its POST was cross-origin.
 */
describe("both browser-facing seams share it", () => {
  test("the WebSocket handshake and the server-function mount agree", async () => {
    const [{ server }, { websocket }, { serverFn, serverFunctions }, { t }] = await Promise.all([
      import("../src/index.ts"),
      import("../src/ws.ts"),
      import("@nifrajs/web/fn"),
      import("@nifrajs/schema"),
    ])

    const app = server()
      .use(websocket())
      .ws("/live", { message: () => {} })
      .use(serverFunctions("app", { echo: serverFn({ input: t.object({}) }, async () => ({})) }))

    // The shape a terminating proxy produces. Both seams must admit it.
    const proxied = (path: string, init?: RequestInit): Request =>
      new Request(`http://app.example${path}`, {
        headers: { origin: "https://app.example", ...(init?.headers as Record<string, string>) },
        ...init,
      })

    const fn = await app.fetch(
      proxied("/_nifra/fn/app/echo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    )
    expect(fn.status).not.toBe(403)

    // The upgrade is refused for lacking WebSocket headers, never for its origin.
    const ws = await app.fetch(proxied("/live"))
    expect(ws.status).not.toBe(403)
  })
})
