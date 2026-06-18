import { definePlugin, type NifraPlugin } from "@nifrajs/core"
import {
  decodeBase64,
  jsonError,
  type MaybePromise,
  quotedHeaderValue,
  sha256,
  timingSafeEqualBytes,
} from "./_utils.ts"

export type BasicAuthPlugin<P> = NifraPlugin & {
  principal(request: Request): P | null
  requirePrincipal(request: Request): P
}

export interface BasicAuthStaticOptions<P = string> {
  readonly username: string
  readonly password: string
  readonly principal?: P
  readonly realm?: string
  readonly optional?: boolean
}

export interface BasicAuthVerifyOptions<P> {
  readonly verify: (username: string, password: string) => MaybePromise<P | null | undefined>
  readonly realm?: string
  readonly optional?: boolean
}

const UTF8 = new TextDecoder("utf-8", { fatal: true })

function challenge(realm: string): string {
  return `Basic realm="${quotedHeaderValue(realm)}", charset="UTF-8"`
}

function reject(realm: string): Response {
  return jsonError(401, "unauthorized", { "www-authenticate": challenge(realm) })
}

function credentials(request: Request): { username: string; password: string } | null {
  const header = request.headers.get("authorization")
  if (header?.startsWith("Basic ") !== true) return null
  const raw = decodeBase64(header.slice(6).trim())
  if (raw === null) return null
  let decoded: string
  try {
    decoded = UTF8.decode(raw)
  } catch {
    return null
  }
  const colon = decoded.indexOf(":")
  if (colon < 0) return null
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

async function staticVerifier<P>(
  username: string,
  password: string,
  principal: P,
): Promise<(u: string, p: string) => Promise<P | null>> {
  const [expectedUser, expectedPass] = await Promise.all([sha256(username), sha256(password)])
  return async (u, p) => {
    const [gotUser, gotPass] = await Promise.all([sha256(u), sha256(p)])
    const userOk = timingSafeEqualBytes(gotUser, expectedUser)
    const passOk = timingSafeEqualBytes(gotPass, expectedPass)
    return userOk && passOk ? principal : null
  }
}

/**
 * HTTP Basic authentication. Prefer short-lived Basic Auth for internal tools and staging gates, not
 * public user login. Static credentials are compared in constant time after SHA-256 hashing; the
 * callback form is available for external stores.
 */
export function basicAuth(options: BasicAuthStaticOptions): BasicAuthPlugin<string>
export function basicAuth<P>(options: BasicAuthStaticOptions<P>): BasicAuthPlugin<P>
export function basicAuth<P>(options: BasicAuthVerifyOptions<P>): BasicAuthPlugin<P>
export function basicAuth<P>(
  options: BasicAuthStaticOptions<P> | BasicAuthVerifyOptions<P>,
): BasicAuthPlugin<P | string> {
  const realm = options.realm ?? "api"
  const optional = options.optional === true
  const store = new WeakMap<Request, P | string>()
  const verifyPromise =
    "verify" in options
      ? Promise.resolve(options.verify)
      : staticVerifier(options.username, options.password, options.principal ?? options.username)

  const plugin = definePlugin("basicAuth", (app) =>
    app.beforeHandle(async (c: { readonly req: Request }) => {
      const parsed = credentials(c.req)
      const principal =
        parsed === null ? null : await (await verifyPromise)(parsed.username, parsed.password)
      if (principal !== null && principal !== undefined) {
        store.set(c.req, principal)
        return undefined
      }
      return optional ? undefined : reject(realm)
    }),
  )
  return Object.assign(plugin, {
    principal: (request: Request): P | string | null => store.get(request) ?? null,
    requirePrincipal: (request: Request): P | string => {
      const principal = store.get(request)
      if (principal === undefined) throw reject(realm)
      return principal
    },
  }) as BasicAuthPlugin<P | string>
}
