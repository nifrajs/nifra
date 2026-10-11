import { createHash } from "node:crypto"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { build } from "vite"
import { unsupportedBuiltin } from "../internal/target-compat.ts"
import type { ComponentPipelineOptions } from "./build.ts"
import { componentBundleImports } from "./bundle-proof.ts"
import { componentServerEntry } from "./server-entry.ts"

export interface ComponentBuildResult {
  readonly outDir: string
  readonly build: string
  readonly target: NonNullable<ComponentPipelineOptions["target"]>
  readonly entry: string
  readonly styles: readonly string[]
  readonly assets: readonly string[]
}

interface Asset {
  readonly file: string
  readonly isEntry?: boolean
  readonly css?: readonly string[]
}
const assetPath = /^assets\/[A-Za-z0-9_./-]+$/
function readAssets(value: unknown): readonly Asset[] {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("[nifra/components] Missing client build manifest")
  return Object.values(value).map((item: unknown) => {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      throw new Error("[nifra/components] Invalid client manifest")
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Manifest object shape, asset paths and optional field types are checked before constructing the target manifest.
    const record = item as Record<string, unknown>
    if (
      typeof record.file !== "string" ||
      !assetPath.test(record.file) ||
      record.file.split("/").includes("..") ||
      (record.isEntry !== undefined && typeof record.isEntry !== "boolean") ||
      (record.css !== undefined &&
        (!Array.isArray(record.css) ||
          record.css.some(
            (css) =>
              typeof css !== "string" || !assetPath.test(css) || css.split("/").includes(".."),
          )))
    )
      throw new Error("[nifra/components] Invalid build asset URL")
    const asset: Asset = { file: record.file }
    if (record.isEntry !== undefined) Object.assign(asset, { isEntry: record.isEntry })
    if (record.css !== undefined) Object.assign(asset, { css: record.css })
    return asset
  })
}

async function files(directory: string): Promise<string[]> {
  const result: string[] = []
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink())
      throw new Error("[nifra/components] Build artifacts cannot be symbolic links")
    const path = resolve(directory, item.name)
    if (item.isDirectory()) result.push(...(await files(path)))
    else if (item.isFile()) result.push(path)
  }
  return result.sort()
}
const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex")

/** Assemble one complete generation before the build orchestrator publishes its directory. */
export async function assembleComponentTarget(
  options: ComponentPipelineOptions,
  generation: string,
): Promise<ComponentBuildResult> {
  const out = resolve(options.root, options.outDir ?? "dist")
  const target = options.target ?? "bun"
  const records = readAssets(
    JSON.parse(await readFile(resolve(out, "client/.vite/manifest.json"), "utf8")),
  )
  const entries = records.filter((record) => record.isEntry)
  if (entries.length !== 1)
    throw new Error("[nifra/components] Exactly one client entry is required")
  const assets = (await files(resolve(out, "client/assets"))).map(
    (file) => `/${relative(resolve(out, "client"), file).replaceAll("\\", "/")}`,
  )
  const entry = `/${entries[0]!.file}`
  const styles = [...new Set(records.flatMap((record) => record.css ?? []))]
    .map((file) => `/${file}`)
    .sort()
  if (!assets.includes(entry) || styles.some((file) => !assets.includes(file)))
    throw new Error("[nifra/components] Missing client generation artifacts")
  const serverDirectory = options.adapter === "react" ? "ssr" : "server"
  const serverEntry = `${serverDirectory}/index.js`
  const staticRoot = target === "vercel" ? resolve(out, "static") : out
  await cp(resolve(out, "client/assets"), resolve(staticRoot, "assets"), { recursive: true })
  await rm(resolve(out, "client"), { recursive: true })
  const metadata = {
    v: 1,
    build: generation,
    adapter: options.adapter,
    target,
    entry,
    styles,
    assets,
  }
  if (target === "cloudflare") {
    const source = componentServerEntry({ ...metadata, serverEntry, platform: "cloudflare" })
    const input = resolve(out, ".nifra-entry.backend.js")
    await writeFile(input, source)
    await build({
      root: out,
      configFile: false,
      publicDir: false,
      ssr: { noExternal: true },
      define: { "process.env.NODE_ENV": '"production"' },
      build: {
        ssr: input,
        outDir: resolve(out, ".nifra-worker"),
        emptyOutDir: true,
        minify: true,
        rollupOptions: { output: { inlineDynamicImports: true, entryFileNames: "index.js" } },
      },
    })
    await cp(resolve(out, ".nifra-worker/index.js"), resolve(out, "_worker.js"))
    const worker = await readFile(resolve(out, "_worker.js"), "utf8")
    if (
      componentBundleImports(worker).some((specifier) => unsupportedBuiltin(specifier, "browser"))
    )
      throw new Error("[nifra/components] Unsupported built-in in the assembled edge worker")
    await rm(input)
    await rm(resolve(out, ".nifra-worker"), { recursive: true })
    await rm(resolve(out, serverDirectory), { recursive: true })
    if (options.adapter === "react") await rm(resolve(out, "rsc"), { recursive: true })
    await writeFile(
      resolve(out, "_routes.json"),
      `${JSON.stringify({ version: 1, include: ["/*"], exclude: ["/assets/*"] })}\n`,
    )
    await writeFile(resolve(out, ".assetsignore"), "*\n!assets/\n!assets/**\n")
  } else {
    const runtimeRoot = target === "vercel" ? resolve(out, "functions/index.func") : out
    await mkdir(runtimeRoot, { recursive: true })
    if (runtimeRoot !== out) {
      await cp(resolve(out, serverDirectory), resolve(runtimeRoot, serverDirectory), {
        recursive: true,
      })
      await rm(resolve(out, serverDirectory), { recursive: true })
      if (options.adapter === "react") {
        await cp(resolve(out, "rsc"), resolve(runtimeRoot, "rsc"), { recursive: true })
        await rm(resolve(out, "rsc"), { recursive: true })
      }
    }
    const privateFiles = await files(resolve(runtimeRoot, serverDirectory))
    if (options.adapter === "react")
      privateFiles.push(...(await files(resolve(runtimeRoot, "rsc"))))
    if (target !== "vercel") privateFiles.push(...(await files(resolve(runtimeRoot, "assets"))))
    const hashes = Object.fromEntries(
      await Promise.all(
        privateFiles.map(async (file) => [
          relative(runtimeRoot, file).replaceAll("\\", "/"),
          digest(await readFile(file)),
        ]),
      ),
    )
    const manifest = `${JSON.stringify({ ...metadata, files: hashes })}\n`
    await writeFile(resolve(runtimeRoot, "component-manifest.json"), manifest)
    await writeFile(
      resolve(runtimeRoot, target === "vercel" ? "index.js" : "server.js"),
      componentServerEntry({
        ...metadata,
        serverEntry,
        platform: target,
        manifestDigest: digest(manifest),
      }),
    )
    await writeFile(resolve(runtimeRoot, "package.json"), '{"type":"module"}\n')
    if (target === "vercel") {
      await writeFile(
        resolve(runtimeRoot, ".vc-config.json"),
        `${JSON.stringify({
          runtime: "nodejs22.x",
          handler: "index.js",
          launcherType: "Nodejs",
          shouldAddHelpers: false,
        })}\n`,
      )
      await writeFile(
        resolve(out, "config.json"),
        `${JSON.stringify({
          version: 3,
          routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }],
        })}\n`,
      )
    }
  }
  await writeFile(resolve(out, "component-build.json"), `${JSON.stringify(metadata)}\n`)
  return { outDir: out, build: generation, target, entry, styles, assets }
}
