import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bunImageBackend } from "@nifrajs/image/backends"
import { imageBunPlugin, imageVitePlugin } from "@nifrajs/image/plugins"
import type { BunPlugin } from "bun"
import { buildTargetWith, bunBundler } from "../src/build.ts"
import { viteBundler } from "../src/build-vite.ts"

const png = Uint8Array.fromBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
)
let root: string
beforeEach(() => {
  root = mkdtempSync(`${import.meta.dir}/.tmp-build-images-`)
  for (const dir of ["routes", "shared", "frontend", "backend"]) mkdirSync(join(root, dir))
  writeFileSync(join(root, "shared/hero.png"), png)
  writeFileSync(join(root, "backend/server.png"), new Uint8Array([...png, 0]))
  writeFileSync(
    join(root, "routes/index.tsx"),
    'import hero from "../shared/hero.png?image"; export default function Home() { return hero }',
  )
  writeFileSync(
    join(root, "routes/index.backend.ts"),
    'import { t } from "@nifrajs/schema"; import hero from "../backend/server.png?image"; export const prerender = true; export const loaderOutput = t.object({src:t.string(),width:t.number(),height:t.number()}); export const loader = () => ({src:hero.src,width:hero.width,height:hero.height})',
  )
  writeFileSync(join(root, "frontend/client.ts"), "export function mountRouter() {}")
  writeFileSync(
    join(root, "backend/adapter.ts"),
    `export const adapter = {
    renderToStream: (_chain, props) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify(props.data))); c.close() } }),
    hydrationHead: () => ""
  }`,
  )
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

for (const pipeline of ["bun", "vite"] as const) {
  test(`${pipeline}: emits imported client and SSR-only images with complete manifests`, async () => {
    const options = { root, widths: [1], backend: bunImageBackend() }
    const clientPlugin = pipeline === "bun" ? imageBunPlugin(options) : imageVitePlugin(options)
    const serverPlugin = pipeline === "bun" ? imageBunPlugin(options) : imageVitePlugin(options)
    const outDir = join(root, `dist-${pipeline}`)
    const result = await buildTargetWith(
      "cloudflare",
      {
        routesDir: join(root, "routes"),
        outDir,
        workDir: join(root, ".work"),
        clientModule: join(root, "frontend/client.ts"),
        adapterImport: join(root, "backend/adapter.ts"),
        publicDir: false,
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: buildTargetWith forwards plugins unchanged to the selected matching bundler; its shared options use BunPlugin even for Vite hooks.
        clientPlugins: [clientPlugin] as BunPlugin[],
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: serverPlugin is created for the same pipeline passed to buildTargetWith; Vite consumes its own hooks, not Bun.setup.
        serverPlugins: [serverPlugin] as BunPlugin[],
      },
      pipeline === "bun" ? bunBundler : viteBundler,
    )
    const images = result.client.assets.filter((path) => path.startsWith("/assets/_images/"))
    expect(images.length).toBeGreaterThanOrEqual(3)
    // The size report is about code: image bytes are neither read for it nor added to its totals.
    expect(result.size.chunks.some((chunk) => /\.(?:png|jpg|webp|gif)$/.test(chunk.name))).toBe(
      false,
    )
    for (const path of images) expect(existsSync(join(outDir, path))).toBe(true)
    expect(JSON.parse(readFileSync(join(outDir, "assets/manifest.json"), "utf8")).assets).toEqual(
      result.client.assets,
    )
    const worker = (await import(join(outDir, "_worker.js"))).default
    const response = await worker.fetch(new Request("https://example.com/"), {})
    expect(response.status).toBe(200)
    const html = await response.text()
    for (const asset of serverPlugin.nifraStaticAssets()) {
      expect(result.client.assets).toContain(`/assets/${asset.fileName}`)
    }
    expect(html).toContain('"width":1')
    expect(html).toContain("/assets/_images/")
    const browser = result.client.assets
      .filter((path) => path.endsWith(".js"))
      .map((path) => readFileSync(join(outDir, path), "utf8"))
      .join("\n")
    expect(browser).toContain("/assets/_images/")
    expect(browser).not.toContain("node:fs")
    expect(browser).not.toContain("createImageAssets")
    expect(browser).not.toContain("sharp")
  }, 60_000)
}

test("static output deploys imported files alongside prerendered HTML", async () => {
  writeFileSync(join(root, "routes/index.backend.ts"), "export const prerender = true")
  const outDir = join(root, "dist-static")
  const plugin = imageBunPlugin({ root })
  const result = await buildTargetWith(
    "static",
    {
      routesDir: join(root, "routes"),
      outDir,
      workDir: join(root, ".work"),
      clientModule: join(root, "frontend/client.ts"),
      adapterImport: join(root, "backend/adapter.ts"),
      clientPlugins: [plugin],
      publicDir: false,
      prerenderApp: (client) => ({
        fetch: () =>
          new Response(`<img src="${client.assets.find((path) => path.includes("/_images/"))}">`, {
            headers: { "content-type": "text/html" },
          }),
      }),
    },
    bunBundler,
  )
  const src = result.client.assets.find((path) => path.includes("/_images/"))
  expect(src).toBeDefined()
  expect(readFileSync(join(outDir, "index.html"), "utf8")).toContain(src ?? "missing image")
  expect(readFileSync(join(outDir, src ?? "missing image"))).toEqual(Buffer.from(png))
}, 60_000)
