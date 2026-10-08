import { describe, expect, test } from "bun:test"
import { type AnyServer, server, type WebSocketUpgradeOutcome } from "@nifrajs/core"
import { websocket } from "@nifrajs/core/ws"
import { apiKey, basicAuth, bearer, type JwtClaims, jwt } from "../src/index.ts"

/**
 * A socket registered after an auth middleware is guarded by it, exactly as an HTTP `GET` there is:
 * a required guard refuses a handshake without credentials with the same status and challenge, an
 * optional one lets it through without a principal, and `upgrade()` reads the principal the guard
 * verified.
 */

const SECRET = "0123456789abcdef0123456789abcdef"
const ENC = new TextEncoder()
const NOW = 1_900_000_000

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  for (const b of view) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

async function hmacToken(claims: JwtClaims): Promise<string> {
  const head = b64url(ENC.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })))
  const body = b64url(ENC.encode(JSON.stringify(claims)))
  const key = await crypto.subtle.importKey(
    "raw",
    ENC.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, ENC.encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(sig)}`
}

interface Guard {
  readonly app: AnyServer
  readonly credentials: () => Promise<Record<string, string>>
  readonly principal: unknown
}

/** An HTTP route and a socket registered together after `app`'s guard, both reporting `who`. */
const withSocket = (app: AnyServer, who: (req: Request) => unknown): AnyServer =>
  app
    .get("/http", (c) => ({ who: who(c.req) }))
    .ws("/socket", { upgrade: (c) => ({ who: who(c.req) }) })

const base = () => server().use(websocket())
const basic = `Basic ${btoa("ada:pw")}`
const jwtCredentials = async (): Promise<string> => hmacToken({ sub: "ada", exp: 2_000_000_000 })

const GUARDS: ReadonlyArray<readonly [string, (optional: boolean) => Guard]> = [
  [
    "basicAuth",
    (optional) => {
      const auth = basicAuth({ username: "ada", password: "pw", optional })
      return {
        app: withSocket(base().use(auth), (req) => auth.principal(req)),
        credentials: async () => ({ authorization: basic }),
        principal: "ada",
      }
    },
  ],
  [
    "bearer",
    (optional) => {
      const auth = bearer({ verify: (token) => (token === "good" ? "ada" : null), optional })
      return {
        app: withSocket(base().use(auth), (req) => auth.principal(req)),
        credentials: async () => ({ authorization: "Bearer good" }),
        principal: "ada",
      }
    },
  ],
  [
    "apiKey",
    (optional) => {
      const auth = apiKey({ keys: ["k-123"], optional })
      return {
        app: withSocket(base().use(auth), (req) => auth.principal(req)),
        credentials: async () => ({ "x-api-key": "k-123" }),
        principal: "k-123",
      }
    },
  ],
  [
    "jwt via header",
    (optional) => {
      const auth = jwt({ key: SECRET, algorithms: ["HS256"], now: () => NOW, optional })
      return {
        app: withSocket(base().use(auth), (req) => auth.claims(req)),
        credentials: async () => ({ authorization: `Bearer ${await jwtCredentials()}` }),
        principal: { sub: "ada", exp: 2_000_000_000 },
      }
    },
  ],
  [
    "jwt via cookie",
    (optional) => {
      const auth = jwt({
        key: SECRET,
        algorithms: ["HS256"],
        now: () => NOW,
        cookie: "at",
        optional,
      })
      return {
        app: withSocket(base().use(auth), (req) => auth.claims(req)),
        credentials: async () => ({ cookie: `at=${await jwtCredentials()}` }),
        principal: { sub: "ada", exp: 2_000_000_000 },
      }
    },
  ],
]

async function handshake(
  app: AnyServer,
  headers: Record<string, string>,
): Promise<WebSocketUpgradeOutcome> {
  return await app.resolveWebSocketUpgrade(
    new Request("http://t/socket", { headers: { upgrade: "websocket", ...headers } }),
  )
}

describe("first-party auth guards a socket registered after it", () => {
  for (const [name, make] of GUARDS) {
    test(`${name}, required: refused like the HTTP route, opened with the verified principal`, async () => {
      const guard = make(false)
      const app = guard.app
      const http = await app.fetch(new Request("http://t/http"))
      const refused = await handshake(app, {})
      if (refused.kind !== "reject") throw new Error(`expected a rejection, got ${refused.kind}`)
      expect(http.status).toBe(401)
      expect(refused.response.status).toBe(401)
      expect(refused.response.headers.get("www-authenticate")).toBe(
        http.headers.get("www-authenticate"),
      )

      const opened = await handshake(app, await guard.credentials())
      if (opened.kind !== "upgrade") throw new Error(`expected an upgrade, got ${opened.kind}`)
      expect(opened.data).toEqual({ who: guard.principal })
    })

    test(`${name}, optional: an anonymous handshake opens without a principal`, async () => {
      const guard = make(true)
      const app = guard.app
      const anonymous = await handshake(app, {})
      if (anonymous.kind !== "upgrade")
        throw new Error(`expected an upgrade, got ${anonymous.kind}`)
      expect(anonymous.data).toEqual({ who: null })
      const signedIn = await handshake(app, await guard.credentials())
      if (signedIn.kind !== "upgrade") throw new Error(`expected an upgrade, got ${signedIn.kind}`)
      expect(signedIn.data).toEqual({ who: guard.principal })
    })
  }
})
