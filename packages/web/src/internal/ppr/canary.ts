import { MAX_SHELL_AFTER_REQUESTS } from "./options.ts"

/** Where a canary value went into the request whose shell carried it. */
export type CanaryCarrier = "cookie" | "authorization" | "header" | "query"

export interface ShellCanaryFinding {
  readonly path: string
  readonly via: CanaryCarrier
  /** The shared hole whose frame carried it; absent when the shell did. */
  readonly hole?: string
}

export interface ShellCanaryOptions {
  /** The origin the requests are made against. Default `http://canary.invalid`. */
  readonly origin?: string
}

const CARRIERS: readonly CanaryCarrier[] = ["cookie", "authorization", "header", "query"]

/** Where a streamed document's per-response part starts: everything before it is the shared shell. */
const REQUEST_SCRIPT = '<script type="application/json" id="nifra-ppr-req">'
const SCRIPT_END = "</script>"

/** Requests per path: enough for a shell to be built, then for each shared hole's entry. */
const MAX_ATTEMPTS = 2 * MAX_SHELL_AFTER_REQUESTS

/** The JSON text of the inert script element opened by `opener`, or `undefined` without one. */
const scriptText = (html: string, opener: string): string | undefined => {
  const start = html.indexOf(opener)
  if (start === -1) return undefined
  const end = html.indexOf(SCRIPT_END, start + opener.length)
  return end === -1 ? undefined : html.slice(start + opener.length, end)
}

const parsed = (text: string | undefined): unknown => {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The shared holes' frames a response carries, by name, when every one carries its entry. */
function sharedFrames(html: string): ReadonlyMap<string, string> | undefined {
  const request = parsed(scriptText(html, REQUEST_SCRIPT))
  const names =
    typeof request === "object" && request !== null ? Reflect.get(request, "shared") : undefined
  const frames = new Map<string, string>()
  if (!Array.isArray(names)) return frames
  for (const name of names) {
    if (typeof name !== "string") return undefined
    const text = scriptText(html, `<script type="application/json" id="nifra-ppr:${name}">`)
    const frame = parsed(text)
    // An error frame holds nothing built: the entry is not there yet.
    if (text === undefined || typeof frame !== "object" || frame === null) return undefined
    if (Reflect.get(frame, "error") === true) return undefined
    frames.set(name, text)
  }
  return frames
}

const randomHex = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")

/**
 * The canary check. Each path is requested through the app's own middleware and gates with a
 * unique value in a cookie, an `Authorization` header, a custom header and the query, until a
 * response carries a shell (`shellAfterRequests` decides which request builds it) and a built frame
 * for each shared hole, and those are scanned for every value the path's requests carried. It
 * catches visitor data the app keeps in module state, which no import check sees. Run it against a
 * fresh app before it serves traffic: a shell or frame already cached was built without the canaries.
 */
export async function checkShellCanaries(
  app: { fetch(request: Request): Response | Promise<Response> },
  paths: readonly string[],
  options: ShellCanaryOptions = {},
): Promise<readonly ShellCanaryFinding[]> {
  const findings: ShellCanaryFinding[] = []
  for (const path of paths) {
    const sent: Array<Record<CanaryCarrier, string>> = []
    // A route that renders whole every time reports nothing.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const values: Record<CanaryCarrier, string> = {
        cookie: `nifra-canary-${randomHex()}`,
        authorization: `nifra-canary-${randomHex()}`,
        header: `nifra-canary-${randomHex()}`,
        query: `nifra-canary-${randomHex()}`,
      }
      sent.push(values)
      const url = new URL(path, options.origin ?? "http://canary.invalid")
      url.searchParams.set("nifra_canary", values.query)
      const response = await app.fetch(
        new Request(url.href, {
          headers: {
            cookie: `nifra_canary=${values.cookie}`,
            authorization: `Bearer ${values.authorization}`,
            "x-nifra-canary": values.header,
          },
        }),
      )
      const html = await response.text()
      const end = html.indexOf(REQUEST_SCRIPT)
      // No shared shell yet: this request rendered whole, so nothing it saw is shared.
      if (end === -1) continue
      const frames = sharedFrames(html)
      // A shared hole whose entry is still being built: a later request gets it.
      if (frames === undefined && attempt < MAX_ATTEMPTS - 1) continue
      const shell = html.slice(0, end)
      const carried = (text: string, via: CanaryCarrier): boolean =>
        sent.some((earlier) => text.includes(earlier[via]))
      for (const via of CARRIERS) if (carried(shell, via)) findings.push({ path, via })
      for (const [hole, frame] of frames ?? []) {
        for (const via of CARRIERS) if (carried(frame, via)) findings.push({ path, via, hole })
      }
      break
    }
  }
  return findings
}
