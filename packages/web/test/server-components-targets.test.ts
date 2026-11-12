import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { connect } from "node:net"
import { resolve } from "node:path"
import { assembleComponentTarget } from "../src/server-components/build-target.ts"

async function stage(manifest: unknown, adapter = "vue") {
  const base = resolve(import.meta.dirname, "../../../.nifra-components-fixtures")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(resolve(base, "target-proof-"))
  await mkdir(resolve(root, "client/.vite"), { recursive: true })
  await mkdir(resolve(root, "client/assets"), { recursive: true })
  await mkdir(resolve(root, adapter === "react" ? "ssr" : "server"))
  await writeFile(resolve(root, "client/.vite/manifest.json"), JSON.stringify(manifest))
  await writeFile(resolve(root, "client/assets/entry.js"), "export const publicValue = 1")
  await writeFile(resolve(root, "client/assets/style.css"), "p { color: black }")
  await writeFile(
    resolve(root, adapter === "react" ? "ssr/index.js" : "server/index.js"),
    'export const __nifraComponentBuild = "build_1"; export function createApp() { return { fetch: () => new Response("Public") } }',
  )
  if (adapter === "react") {
    await mkdir(resolve(root, "rsc"))
    await writeFile(resolve(root, "rsc/index.js"), 'export const marker = "private_rsc_artifact"')
  }
  return root
}
const manifest = { main: { file: "assets/entry.js", isEntry: true, css: ["assets/style.css"] } }
const options = (root: string) => ({
  root,
  outDir: root,
  adapter: "vue" as const,
  entries: { client: "unused.frontend.ts", ssr: "unused.backend.ts" },
})

test("every generated target confines private artifacts and emits one sealed asset generation", async () => {
  for (const target of ["bun", "node", "deno", "vercel", "cloudflare"] as const) {
    const adapter = target === "vercel" || target === "cloudflare" ? "react" : "vue"
    const root = await stage(manifest, adapter)
    try {
      const result = await assembleComponentTarget({ ...options(root), target, adapter }, "build_1")
      expect(result.entry).toBe("/assets/entry.js")
      expect(result.styles).toEqual(["/assets/style.css"])
      if (target === "cloudflare") {
        expect(JSON.parse(await readFile(resolve(root, "_routes.json"), "utf8"))).toEqual({
          version: 1,
          include: ["/*"],
          exclude: ["/assets/*"],
        })
        expect(await readFile(resolve(root, ".assetsignore"), "utf8")).toBe(
          "*\n!assets/\n!assets/**\n",
        )
        expect(await readFile(resolve(root, "_worker.js"), "utf8")).toContain("build_1")
        await expect(readFile(resolve(root, "ssr/index.js"))).rejects.toMatchObject({
          code: "ENOENT",
        })
        await expect(readFile(resolve(root, "rsc/index.js"))).rejects.toMatchObject({
          code: "ENOENT",
        })
      } else {
        const directory = target === "vercel" ? resolve(root, "functions/index.func") : root
        const metadata = JSON.parse(
          await readFile(resolve(directory, "component-manifest.json"), "utf8"),
        )
        const entry = await readFile(
          resolve(directory, target === "vercel" ? "index.js" : "server.js"),
          "utf8",
        )
        expect(entry).toContain("component-manifest.json")
        expect(metadata.build).toBe("build_1")
        expect(metadata.files[adapter === "react" ? "ssr/index.js" : "server/index.js"]).toBe(
          createHash("sha256")
            .update(
              await readFile(
                resolve(directory, adapter === "react" ? "ssr/index.js" : "server/index.js"),
              ),
            )
            .digest("hex"),
        )
        if (target === "vercel") {
          expect(Object.keys(metadata.files)).toContain("rsc/index.js")
          expect(Object.keys(metadata.files).some((name) => name.startsWith("assets/"))).toBe(false)
          expect(
            JSON.parse(await readFile(resolve(directory, ".vc-config.json"), "utf8")).runtime,
          ).toBe("nodejs22.x")
          expect(await readFile(resolve(root, "static/assets/style.css"), "utf8")).toContain(
            "black",
          )
        } else expect(Object.keys(metadata.files)).toContain("assets/entry.js")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 30000)

test("target assembly rejects malformed manifests, missing assets and symbolic links", async () => {
  for (const value of [
    null,
    [],
    { main: null },
    { main: { file: "../private.js" } },
    { main: { file: "assets/entry.js", isEntry: "yes" } },
    { main: { file: "assets/entry.js", css: ["assets/../private.css"] } },
    { main: { file: "assets/entry.js" } },
    { main: { file: "assets/missing.js", isEntry: true } },
  ]) {
    const root = await stage(value)
    try {
      await expect(assembleComponentTarget(options(root), "build_1")).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
  const root = await stage(manifest)
  try {
    await symlink(resolve(root, "server/index.js"), resolve(root, "client/assets/private.js"))
    await expect(assembleComponentTarget(options(root), "build_1")).rejects.toThrow(
      "symbolic links",
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("the generated Node handler takes the origin from Host, never from a target that starts with //", async () => {
  const root = await stage(manifest, "react")
  try {
    await writeFile(
      resolve(root, "ssr/index.js"),
      'export const __nifraComponentBuild = "build_1"; export function createApp() { return { fetch: (request) => new Response(request.url) } }',
    )
    await assembleComponentTarget(
      { ...options(root), target: "vercel", adapter: "react" },
      "build_1",
    )
    const { default: handle } = await import(resolve(root, "functions/index.func/index.js"))
    const server = createServer(handle)
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
    const address = server.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const send = (target: string, host: string) =>
      new Promise<string>((answered) => {
        let raw = ""
        const socket = connect(port, "127.0.0.1", () =>
          socket.write(`GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`),
        )
        socket.on("data", (chunk) => {
          raw += chunk
        })
        socket.on("end", () => answered(raw))
      })
    try {
      expect(await send("//evil.example/admin", "app.example")).toContain(
        "\r\nhttp://app.example//evil.example/admin\r\n",
      )
      expect(await send("http://evil.example/admin?x=1", "app.example")).toContain(
        "\r\nhttp://app.example/admin?x=1\r\n",
      )
      expect(await send("/admin", "evil.example/x?")).toStartWith("HTTP/1.1 400")
    } finally {
      server.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("component target emits image-plugin assets before sealing the generation", async () => {
  const root = await stage(manifest)
  try {
    const source = Uint8Array.fromBase64(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
    )
    const fileName = `_images/${createHash("sha256").update(source).digest("hex")}.png`
    const plugin = { name: "image-fixture", nifraStaticAssets: () => [{ fileName, source }] }
    const result = await assembleComponentTarget(
      { ...options(root), target: "vercel", plugins: [plugin] },
      "build_1",
    )
    expect(result.assets).toContain(`/assets/${fileName}`)
    expect(new Uint8Array(await readFile(resolve(root, "static/assets", fileName)))).toEqual(source)
    expect(
      JSON.parse(await readFile(resolve(root, "component-build.json"), "utf8")).assets,
    ).toContain(`/assets/${fileName}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
