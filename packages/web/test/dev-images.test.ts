import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { imageBunPlugin } from "@nifrajs/image/plugins"
import { createDevServer } from "../src/dev.ts"

const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
)

test("native dev serves separately compiled images through GET/HEAD and content-addresses edits", async () => {
  const root = mkdtempSync(`${import.meta.dir}/.tmp-dev-images-`)
  for (const dir of ["routes", "frontend", "shared"]) mkdirSync(join(root, dir))
  writeFileSync(join(root, "routes/index.tsx"), "export default () => null")
  writeFileSync(join(root, "frontend/client.ts"), "export function mountRouter() {}")
  writeFileSync(
    join(root, "frontend/image-entry.ts"),
    'import image from "../shared/hero.png?image"; console.log(image)',
  )
  writeFileSync(join(root, "shared/hero.png"), png)
  const server = await createDevServer({
    routesDir: join(root, "routes"),
    outDir: join(root, "dist"),
    clientModule: join(root, "frontend/client.ts"),
    port: 0,
    guardLeaks: false,
    createApp: () => ({ fetch: () => new Response("app") }),
  })
  try {
    const plugin = imageBunPlugin({ root })
    const compile = async () => {
      const result = await Bun.build({
        entrypoints: [join(root, "frontend/image-entry.ts")],
        target: "browser",
        plugins: [plugin],
      })
      expect(result.success).toBe(true)
      const asset = plugin.nifraStaticAssets()[0]
      if (asset === undefined) throw new Error("missing image asset")
      return `http://127.0.0.1:${server.port}/assets/${asset.fileName}`
    }
    const first = await compile()
    const get = await fetch(first)
    expect(get.status).toBe(200)
    expect(get.headers.get("content-type")).toBe("image/png")
    expect(get.headers.get("cache-control")).toContain("immutable")
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(png)
    const head = await fetch(first, { method: "HEAD" })
    expect(head.headers.get("content-length")).toBe(String(png.length))
    expect(await head.text()).toBe("")
    writeFileSync(join(root, "shared/hero.png"), new Uint8Array([...png, 0]))
    const next = await compile()
    expect(next).not.toBe(first)
    expect(new Uint8Array(await (await fetch(next)).arrayBuffer())).toEqual(
      new Uint8Array([...png, 0]),
    )
  } finally {
    server.stop()
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
