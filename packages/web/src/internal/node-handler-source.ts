/** Shared Node HTTP bridge source for ordinary SSR and component entry generators.
 * The Node adapter exposes only serve() (which listens), not a serverless handler seam. */
export function nodeHandlerSource(options: {
  readonly fetch: string
  readonly failure: string
  readonly protocol?: "http" | "https"
}): string[] {
  return [
    'import { Readable } from "node:stream"',
    'import { pipeline } from "node:stream/promises"',
    "const handle = async (req, res) => {",
    "  const abort = new AbortController()",
    "  const close = () => { if (!res.writableEnded) abort.abort() }",
    "  const aborted = () => abort.abort()",
    '  res.on("close", close)',
    '  req.on("aborted", aborted)',
    "  if (req.aborted || res.destroyed) abort.abort()",
    "  try {",
    "    const headers = new Headers()",
    "    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])",
    '    const host = req.headers.host ?? "localhost"',
    "    let url",
    "    try {",
    '      if (!/^[\\w.:[\\]-]+$/.test(host)) throw new Error("host")',
    `      const origin = ${JSON.stringify(`${options.protocol ?? "http"}://`)} + host`,
    // Never resolve //evil.example against a base: it is a path, not another authority.
    '      const rawTarget = req.url ?? "/"',
    '      const target = rawTarget.startsWith("/") ? rawTarget : ((absolute) => {',
    '        if (!["http:", "https:"].includes(absolute.protocol)) throw new Error("target")',
    "        return absolute.pathname + absolute.search",
    "      })(new URL(rawTarget))",
    "      url = new URL(origin + target)",
    "    } catch { res.writeHead(400); res.end(); return }",
    '    const request = new Request(url, { method: req.method, headers, signal: abort.signal, ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: "half" }) })',
    `    const response = await ${options.fetch}`,
    "    res.statusCode = response.status",
    '    for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value)',
    "    const cookies = response.headers.getSetCookie()",
    '    if (cookies.length) res.setHeader("set-cookie", cookies)',
    '    if (response.body && req.method !== "HEAD") await pipeline(Readable.fromWeb(response.body), res, { signal: abort.signal })',
    "    else {",
    "      if (response.body) await response.body.cancel()",
    "      res.end()",
    "    }",
    `  } catch { if (!res.headersSent) { res.writeHead(500); res.end(${JSON.stringify(options.failure)}) } else res.destroy() }`,
    '  finally { res.off("close", close); req.off("aborted", aborted) }',
    "}",
  ]
}
