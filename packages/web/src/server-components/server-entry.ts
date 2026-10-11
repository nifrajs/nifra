export interface ComponentEntryOptions {
  readonly build: string
  readonly entry: string
  readonly styles: readonly string[]
  readonly assets: readonly string[]
  readonly serverEntry: string
  readonly platform: "bun" | "node" | "deno" | "cloudflare" | "vercel"
  readonly manifestDigest?: string
}

/** Only validated, build-owned paths and tokens become generated source. */
export function componentServerEntry(options: ComponentEntryOptions): string {
  const local = options.platform !== "cloudflare"
  const setup = local
    ? [
        'import { readFile } from "node:fs/promises"',
        'import { createHash } from "node:crypto"',
        'const manifestBytes = await readFile(new URL("./component-manifest.json", import.meta.url))',
        `if (createHash("sha256").update(manifestBytes).digest("hex") !== ${JSON.stringify(options.manifestDigest)}) throw new Error("component_version")`,
        'const manifest = JSON.parse(manifestBytes.toString("utf8"))',
        "for (const [file, hash] of Object.entries(manifest.files)) {",
        '  if (!["server", "ssr", "rsc", "assets"].includes(file.split("/")[0]) || file.split("/").some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "..") || createHash("sha256").update(await readFile(new URL(file, import.meta.url))).digest("hex") !== hash) throw new Error("component_version")',
        "}",
        `const module = await import(${JSON.stringify(`./${options.serverEntry}`)})`,
      ]
    : [`import * as module from ${JSON.stringify(`./${options.serverEntry}`)}`]
  const factory = [
    `if (module.__nifraComponentBuild !== ${JSON.stringify(options.build)} || typeof module.createApp !== "function") throw new Error("component_version")`,
    `const app = await module.createApp(${JSON.stringify(options.entry)}, ${JSON.stringify({ styles: options.styles, assets: options.assets, build: options.build })})`,
    'if (typeof app?.fetch !== "function") throw new Error("component_contract")',
    "export const fetch = (request, env, context) => app.fetch(request, { env, ...(context?.waitUntil ? { waitUntil: context.waitUntil.bind(context) } : {}) })",
  ]
  if (!local) return `${[...setup, ...factory, "export default { fetch }"].join("\n")}\n`
  const assets = options.platform === "vercel" ? [] : options.assets
  const serving = [
    `const assets = new Set(${JSON.stringify(assets)})`,
    "const serve = async (request) => {",
    "  const path = new URL(request.url).pathname",
    '  if (assets.has(path) && ["GET", "HEAD"].includes(request.method)) {',
    '    const bytes = await readFile(new URL("." + path, import.meta.url))',
    '    const type = path.endsWith(".css") ? "text/css" : path.endsWith(".js") ? "text/javascript" : path.endsWith(".svg") ? "image/svg+xml" : "application/octet-stream"',
    '    return new Response(request.method === "HEAD" ? null : bytes, { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } })',
    "  }",
    "  return fetch(request)",
    "}",
  ]
  if (options.platform === "bun")
    return `${[
      ...setup,
      ...factory,
      ...serving,
      "Bun.serve({ port: Number(process.env.PORT ?? 3000), fetch: serve })",
    ].join("\n")}\n`
  if (options.platform === "deno")
    return `${[
      ...setup,
      ...factory,
      ...serving,
      'Deno.serve({ port: Number(Deno.env.get("PORT") ?? 3000) }, serve)',
    ].join("\n")}\n`
  const http = [
    'import { createServer } from "node:http"',
    'import { Readable } from "node:stream"',
    'import { pipeline } from "node:stream/promises"',
    "const handle = async (req, res) => {",
    "  const abort = new AbortController()",
    "  const close = () => { if (!res.writableEnded) abort.abort() }",
    '  res.on("close", close)',
    "  try {",
    "    const headers = new Headers()",
    "    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])",
    // Resolving the target against a base reads `//evil.example/admin` as a host; the origin comes
    // from a validated Host header, and an absolute-form target is routed by its path.
    '    const host = req.headers.host ?? "localhost"',
    "    if (!/^[\\w.:[\\]-]+$/.test(host)) { res.writeHead(400); res.end(); return }",
    '    const target = req.url.startsWith("/") ? req.url : ((url) => url.pathname + url.search)(new URL(req.url))',
    '    const request = new Request("http://" + host + target, { method: req.method, headers, signal: abort.signal, ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Readable.toWeb(req), duplex: "half" }) })',
    "    const response = await serve(request)",
    "    res.statusCode = response.status",
    '    for (const [name, value] of response.headers) if (name !== "set-cookie") res.setHeader(name, value)',
    "    const cookies = response.headers.getSetCookie()",
    '    if (cookies.length) res.setHeader("set-cookie", cookies)',
    '    if (response.body && req.method !== "HEAD") await pipeline(Readable.fromWeb(response.body), res)',
    "    else res.end()",
    '  } catch { if (!res.headersSent) res.writeHead(500); res.end("component_failed") }',
    '  finally { res.off("close", close) }',
    "}",
  ]
  return `${[
    ...setup,
    ...factory,
    ...serving,
    ...http,
    options.platform === "vercel"
      ? "export default handle"
      : 'createServer(handle).listen(Number(process.env.PORT ?? 3000), "0.0.0.0")',
  ].join("\n")}\n`
}
