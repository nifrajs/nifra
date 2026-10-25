/**
 * Host-scoped surfaces: which pages and files each host may serve.
 *
 * An app that answers on more than one host often must not show all of itself on each: a domain
 * someone else points at the app should not render its sign-in page under that domain's certificate.
 * A gate that knows only page paths gets the files wrong instead, because a page is not just its path:
 * its document pulls the client bundle, its stylesheets and whatever `public/` files it links, and a
 * gate that refuses those serves the page unstyled and never hydrates it. So a rule names its pages by
 * route pattern and takes the build's own files by token: `buildAssets` is the exact set the build
 * emitted (`buildAssets` from the generated server manifest), never a guess at its naming scheme.
 *
 * Pure and runtime-free, so the same policy can refuse a soft navigation in the browser.
 */
import { Router as CoreRouter } from "@nifrajs/core/router"
import type { Middleware, NodeRequestContext } from "@nifrajs/core/server"
import { requestPattern } from "./internal/route-path.ts"

/** The files a build emitted, by request path: the generated server manifest's `buildAssets`. */
export interface BuildAssetSet {
  has(pathname: string): boolean
}

/** One host's surface. A request on a host no rule names is not restricted. */
export interface HostPolicyRule {
  /**
   * The hosts this rule restricts: names compared without case, port or trailing dot, or a predicate
   * given that lowercase name (`(host) => !ownHosts.has(host)` for "every host that is not ours").
   */
  readonly hosts: readonly string[] | ((hostname: string) => boolean)
  /** Page routes these hosts render, as route patterns (`/`, `/p/:id`, `/share/*`). */
  readonly pages: readonly string[]
  /**
   * Serve the build's own files on these hosts (default `true`): the client bundle and the files the
   * build copied from `public/`, exactly as the build emitted them.
   */
  readonly buildAssets?: boolean
  /** Other paths these hosts serve, as route patterns: an API the pages call, a server function. */
  readonly paths?: readonly string[]
}

export interface HostPolicyOptions {
  readonly rules: readonly HostPolicyRule[]
  /**
   * The answer to a path a rule refuses. Default: a bare `404` with `cache-control: no-store`, so a
   * restricted host does not even confirm the refused page exists.
   */
  readonly refuse?: (refused: { readonly host: string; readonly pathname: string }) => Response
}

export interface HostPolicy {
  readonly rules: readonly HostPolicyRule[]
  /**
   * Whether `pathname` (as requested, percent-encoded, without the query) may be served on `host` (a
   * Host header value; its port and case are ignored). `buildAssets` is the build's file set; without
   * it a rule's `buildAssets` matches nothing.
   */
  allows(host: string, pathname: string, buildAssets?: BuildAssetSet): boolean
  /** The refusal for `pathname` on `host`, or `undefined` to serve it. */
  refusal(host: string, pathname: string, buildAssets?: BuildAssetSet): Response | undefined
  /** {@link HostPolicy.refusal} for a request: its Host header (else its URL's host) and path. */
  check(request: Request, buildAssets?: BuildAssetSet): Response | undefined
}

const HOST_POLICY = Symbol.for("nifra.web.host-policy")

interface CompiledRule {
  readonly covers: (hostname: string) => boolean
  readonly matches: (pathname: string) => boolean
  readonly buildAssets: boolean
}

/** A Host header value's name: lowercase, without its port, IPv6 brackets or trailing dots. */
export function hostnameOf(host: string): string {
  const name = host.trim().toLowerCase()
  if (name.startsWith("[")) {
    const end = name.indexOf("]")
    return end === -1 ? name.slice(1) : name.slice(1, end)
  }
  const colon = name.lastIndexOf(":")
  const bare = colon === -1 || name.indexOf(":") !== colon ? name : name.slice(0, colon)
  // `partner.example.` is the same host as `partner.example`; kept, it escapes the rule listing it.
  let end = bare.length
  while (end > 0 && bare.charCodeAt(end - 1) === 46 /* . */) end--
  return end === bare.length ? bare : bare.slice(0, end)
}

function compilePatterns(
  patterns: readonly string[],
  label: string,
): (pathname: string) => boolean {
  const router = new CoreRouter<true>()
  for (const pattern of patterns) {
    if (typeof pattern !== "string" || !pattern.startsWith("/")) {
      throw new TypeError(
        `[nifra/web] hostPolicy: ${label} entries are route patterns starting with "/", got ${JSON.stringify(pattern)}`,
      )
    }
    router.add("GET", requestPattern(pattern), true)
  }
  return (pathname) => router.find("GET", pathname).found
}

function compileRule(rule: HostPolicyRule, index: number): CompiledRule {
  const label = `rules[${index}]`
  if (typeof rule !== "object" || rule === null) {
    throw new TypeError(`[nifra/web] hostPolicy: ${label} must be an object`)
  }
  let covers: (hostname: string) => boolean
  if (typeof rule.hosts === "function") {
    covers = rule.hosts
  } else if (Array.isArray(rule.hosts) && rule.hosts.every((host) => typeof host === "string")) {
    const names = new Set(rule.hosts.map(hostnameOf))
    covers = (hostname) => names.has(hostname)
  } else {
    throw new TypeError(
      `[nifra/web] hostPolicy: ${label}.hosts must be a list of host names or a predicate`,
    )
  }
  if (!Array.isArray(rule.pages)) {
    throw new TypeError(
      `[nifra/web] hostPolicy: ${label}.pages must list the page routes the hosts serve`,
    )
  }
  const pages = compilePatterns(rule.pages, `${label}.pages`)
  const paths = rule.paths === undefined ? undefined : compilePatterns(rule.paths, `${label}.paths`)
  return {
    covers,
    matches: paths === undefined ? pages : (pathname) => pages(pathname) || paths(pathname),
    buildAssets: rule.buildAssets !== false,
  }
}

const notFound = (): Response =>
  new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  })

/**
 * Declare which pages and files each host serves. Hand the result to `createWebApp({ hostPolicy })`
 * (or export it as `hostPolicy` from the framework module, which `nifra build`'s server entry reads):
 * it is evaluated before the build's static files, the prerendered pages, the mounts and every page.
 * On Vercel the CDN answers the build's files before the function runs, so there it covers the rest.
 * A hand-written entry calls `check(request, buildAssets)` first, before its own static handler.
 *
 * ```ts
 * export const hostPolicy = createHostPolicy({
 *   rules: [{
 *     hosts: (host) => !OWN_HOSTS.has(host),
 *     pages: ["/", "/p/:id", "/share/*"],
 *     paths: ["/api/submissions/*"],
 *   }],
 * })
 * ```
 */
export function createHostPolicy(options: HostPolicyOptions): HostPolicy {
  if (typeof options !== "object" || options === null || !Array.isArray(options.rules)) {
    throw new TypeError("[nifra/web] createHostPolicy takes { rules: [...] }")
  }
  const rules = options.rules.map(compileRule)
  const refuse = options.refuse ?? notFound
  const allows = (host: string, pathname: string, buildAssets?: BuildAssetSet): boolean => {
    const hostname = hostnameOf(host)
    const rule = rules.find((candidate) => candidate.covers(hostname))
    if (rule === undefined) return true
    if (rule.buildAssets && buildAssets?.has(pathname) === true) return true
    return rule.matches(pathname)
  }
  const refusal = (host: string, pathname: string, buildAssets?: BuildAssetSet) =>
    allows(host, pathname, buildAssets) ? undefined : refuse({ host: hostnameOf(host), pathname })
  const policy: HostPolicy = {
    rules: Object.freeze([...options.rules]),
    allows,
    refusal,
    check(request, buildAssets) {
      const url = new URL(request.url)
      return refusal(request.headers.get("host") ?? url.host, url.pathname, buildAssets)
    },
  }
  Object.defineProperty(policy, HOST_POLICY, { value: true })
  return Object.freeze(policy)
}

/** Whether `value` came from {@link createHostPolicy}. */
export function isHostPolicy(value: unknown): value is HostPolicy {
  return typeof value === "object" && value !== null && HOST_POLICY in value
}

/** The path of a Node view's URL, `<protocol>://<host><target>`: the adapter has refused a host
 * holding `/`, `?`, `#` or `@` and resolved the target's dot segments, so it starts at the first `/`
 * after the scheme and ends where core's routing ends it. */
const targetPath = (url: string): string => {
  const start = url.indexOf("/", url.indexOf("://") + 3)
  if (start === -1) return ""
  let end = url.length
  for (let i = start; i < end; i++) {
    const c = url.charCodeAt(i)
    if (c === 63 /* ? */ || c === 35 /* # */) end = i
  }
  return url.slice(start, end)
}

/** A host policy as request middleware, for `createWebApp`: header-only, so its Node twin keeps the
 * direct lane. It refuses pages of every method, so Bun's route table, which skips request hooks,
 * must not serve an app that has one. */
export function hostPolicyGate(
  policy: HostPolicy,
  buildAssets: BuildAssetSet | undefined,
): Middleware {
  return {
    name: "nifra-host-policy",
    onRequest: (request) => policy.check(request, buildAssets),
    onNodeRequest: (request: NodeRequestContext) =>
      policy.refusal(request.header("host") ?? "", targetPath(request.url), buildAssets),
  }
}
