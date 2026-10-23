import type { BunPlugin } from "bun"

/**
 * Serves a fixture page for the adapters' structural-sharing browser tests: `entry` bundled for the
 * browser (workspace packages from source, as `bun` resolves them) behind `markup`, the server render
 * the client mount takes over.
 */
export async function serveFixture(options: {
  readonly entry: string
  readonly markup?: string
  readonly plugins?: readonly BunPlugin[]
}): Promise<{ readonly url: string; readonly stop: () => void }> {
  const built = await Bun.build({
    entrypoints: [options.entry],
    target: "browser",
    conditions: ["bun", "browser"],
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [...(options.plugins ?? [])],
  })
  if (!built.success) throw new Error(built.logs.map(String).join("\n"))
  const [output] = built.outputs
  if (output === undefined) throw new Error("[test] the fixture bundle is empty")
  const script = await output.text()
  const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root">${options.markup ?? ""}</div><script type="module" src="/entry.js"></script></body></html>`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/entry.js"
        ? new Response(script, { headers: { "content-type": "text/javascript" } })
        : new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }),
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}

/** A list page's data: `count` rows, each labelled `row <id>` unless `labels` names it. */
export const listData = (labels: Readonly<Record<number, string>> = {}, count = 20) => ({
  title: "List",
  items: Array.from({ length: count }, (_, id) => ({ id, label: labels[id] ?? `row ${id}` })),
})
