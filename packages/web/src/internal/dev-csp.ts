/**
 * Vite dev adds its own tags to each SSR'd page: the HMR client, a framework's refresh preamble (an
 * inline script), and at runtime a `<style>` per imported stylesheet. A page whose CSP admits scripts
 * by nonce or hash refuses all of them, so the app would not boot in dev. Dev gives every such tag one
 * nonce - the page's own, or a fresh one for a hash-only page - and names it in each directive that
 * governs them.
 */

const POLICY_HEADERS = ["content-security-policy", "content-security-policy-report-only"] as const

/** Directives that govern each element kind, most specific first: the first present one applies. */
const GOVERNING = [
  ["script-src-elem", "script-src", "default-src"],
  ["style-src-elem", "style-src", "default-src"],
] as const

const NONCE_SOURCE = /'nonce-([^']+)'/

/** True when a directive admits every inline element: `'unsafe-inline'`, not voided by a nonce or hash. */
const allowsInline = (sources: readonly string[]): boolean =>
  sources.includes("'unsafe-inline'") &&
  !sources.some((source) => /^'(?:nonce|sha256|sha384|sha512)-/.test(source))

/** One header value (comma-separated policies), with `'nonce-<nonce>'` added where it is needed. */
function admitNonce(value: string, nonce: string): string {
  const token = `'nonce-${nonce}'`
  return value
    .split(",")
    .map((policy) => {
      const directives = policy
        .split(";")
        .map((directive) => directive.trim())
        .filter((directive) => directive !== "")
        .map((directive) => directive.split(/\s+/))
      for (const names of GOVERNING) {
        const governing = names
          .map((name) => directives.find(([directive]) => directive?.toLowerCase() === name))
          .find((directive) => directive !== undefined)
        if (governing === undefined) continue
        const sources = governing.slice(1)
        if (sources.includes(token) || sources.includes("'none'") || allowsInline(sources)) continue
        governing.push(token)
      }
      return directives.map((directive) => directive.join(" ")).join("; ")
    })
    .join(", ")
}

const RAW_TEXT_START = /<(script|style)\b([^>]*)>/gi

/** `html` with `nonce` on each `<script>` / `<style>` that has none; their bodies are left as written. */
function nonceTags(html: string, nonce: string): string {
  let out = ""
  let at = 0
  const lower = html.toLowerCase()
  RAW_TEXT_START.lastIndex = 0
  for (let match = RAW_TEXT_START.exec(html); match !== null; match = RAW_TEXT_START.exec(html)) {
    const [tag, name = "", attrs = ""] = match
    out += html.slice(at, match.index)
    out += /\snonce\s*=/i.test(attrs) ? tag : `<${name} nonce="${nonce}"${attrs}>`
    const close = lower.indexOf(`</${name.toLowerCase()}`, RAW_TEXT_START.lastIndex)
    at = close === -1 ? html.length : close
    out += html.slice(RAW_TEXT_START.lastIndex, at)
    RAW_TEXT_START.lastIndex = at
  }
  return out + html.slice(at)
}

/**
 * Let a dev page's CSP admit what Vite injected. Rewrites the policy headers in `headers` and returns
 * the page with the nonce on its script and style tags, plus the `csp-nonce` meta Vite's client reads
 * to nonce the styles it adds at runtime. A page with no CSP is returned as it is.
 */
export function admitViteTags(
  html: string,
  headers: Headers,
  generate: () => string = () => crypto.randomUUID().replaceAll("-", ""),
): string {
  const policies = POLICY_HEADERS.map((name) => [name, headers.get(name)] as const)
  if (policies.every(([, value]) => value === null)) return html
  const nonce =
    policies.map(([, value]) => NONCE_SOURCE.exec(value ?? "")?.[1]).find((n) => n !== undefined) ??
    generate()
  for (const [name, value] of policies) {
    if (value !== null) headers.set(name, admitNonce(value, nonce))
  }
  const tagged = nonceTags(html, nonce)
  if (tagged.includes(`property="csp-nonce"`)) return tagged
  const meta = `<meta property="csp-nonce" nonce="${nonce}">`
  const head = /<head\b[^>]*>/i.exec(tagged)
  return head === null
    ? meta + tagged
    : tagged.slice(0, head.index + head[0].length) +
        meta +
        tagged.slice(head.index + head[0].length)
}

const SCRIPT_DIRECTIVES = GOVERNING[0]
const CONNECT_DIRECTIVES = ["connect-src", "default-src"] as const

/** Whether `sources` already let the page reach `url` (a same-origin absolute URL). */
const reaches = (sources: readonly string[], url: URL): boolean =>
  sources.some((source) => {
    const lower = source.toLowerCase()
    return (
      lower === "'self'" ||
      lower === "*" ||
      lower === `${url.protocol}` ||
      lower === url.origin ||
      lower === `${url.origin}/` ||
      lower === url.href
    )
  })

/**
 * Admit nifra's own inline dev script, by `hash`, and its POSTs to `connect`, in each policy header.
 * Without a `hash` the caller nonces the script itself. Returns false when a policy forbids scripts
 * outright (`'none'`): such a page runs no code, so there is nothing to capture and the script stays
 * out. A directive that already admits every inline script is left alone, because adding a hash would
 * switch its `'unsafe-inline'` off.
 */
export function admitInlineScript(
  headers: Headers,
  hash: string | undefined,
  connect: URL,
): boolean {
  const updates: [string, string][] = []
  let allowed = true
  for (const name of POLICY_HEADERS) {
    const value = headers.get(name)
    if (value === null) continue
    const next = value
      .split(",")
      .map((policy) => {
        const directives = policy
          .split(";")
          .map((directive) => directive.trim())
          .filter((directive) => directive !== "")
          .map((directive) => directive.split(/\s+/))
        const governing = (names: readonly string[]): string[] | undefined =>
          names
            .map((n) => directives.find(([directive]) => directive?.toLowerCase() === n))
            .find((directive) => directive !== undefined)
        const script = governing(SCRIPT_DIRECTIVES)
        if (script !== undefined) {
          const sources = script.slice(1)
          if (sources.includes("'none'")) allowed = false
          else if (hash !== undefined && !sources.includes(hash) && !allowsInline(sources))
            script.push(hash)
        }
        const connectDirective = governing(CONNECT_DIRECTIVES)
        if (connectDirective !== undefined && !reaches(connectDirective.slice(1), connect)) {
          const none = connectDirective.indexOf("'none'")
          if (none === -1) connectDirective.push(connect.href)
          else connectDirective.splice(none, 1, connect.href)
        }
        return directives.map((directive) => directive.join(" ")).join("; ")
      })
      .join(", ")
    updates.push([name, next])
  }
  if (!allowed) return false
  for (const [name, value] of updates) headers.set(name, value)
  return true
}
