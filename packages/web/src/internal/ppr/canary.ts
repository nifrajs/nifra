/** Where a canary value went into the request whose shell carried it. */
export type CanaryCarrier = "cookie" | "authorization" | "header" | "query"

export interface ShellCanaryFinding {
  readonly path: string
  readonly via: CanaryCarrier
}

export interface ShellCanaryOptions {
  /** The origin the requests are made against. Default `http://canary.invalid`. */
  readonly origin?: string
}

const CARRIERS: readonly CanaryCarrier[] = ["cookie", "authorization", "header", "query"]

/** Where a streamed document's per-response part starts: everything before it is the shared shell. */
const REQUEST_SCRIPT = '<script type="application/json" id="nifra-ppr-req">'

const randomHex = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")

/**
 * The canary check. Each path is requested once through the app's own middleware and gates
 * with a unique value in a cookie, an `Authorization` header, a custom header and the query, and the
 * shell that request built is scanned for every value. It catches visitor data the app keeps in
 * module state, which no import check sees. Run it against a fresh app before it serves traffic: a
 * shell already cached was built without the canaries.
 */
export async function checkShellCanaries(
  app: { fetch(request: Request): Response | Promise<Response> },
  paths: readonly string[],
  options: ShellCanaryOptions = {},
): Promise<readonly ShellCanaryFinding[]> {
  const findings: ShellCanaryFinding[] = []
  for (const path of paths) {
    const values: Record<CanaryCarrier, string> = {
      cookie: `nifra-canary-${randomHex()}`,
      authorization: `nifra-canary-${randomHex()}`,
      header: `nifra-canary-${randomHex()}`,
      query: `nifra-canary-${randomHex()}`,
    }
    const url = new URL(path, options.origin ?? "http://canary.invalid")
    url.searchParams.set("nifra_canary", values.query)
    const response = await app.fetch(
      new Request(url, {
        headers: {
          cookie: `nifra_canary=${values.cookie}`,
          authorization: `Bearer ${values.authorization}`,
          "x-nifra-canary": values.header,
        },
      }),
    )
    const html = await response.text()
    const end = html.indexOf(REQUEST_SCRIPT)
    // No shared shell: the route rendered whole, so nothing is shared to leak.
    if (end === -1) continue
    const shell = html.slice(0, end)
    for (const via of CARRIERS) if (shell.includes(values[via])) findings.push({ path, via })
  }
  return findings
}
