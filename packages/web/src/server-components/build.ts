import { createHash, randomBytes } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rename, rm } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createBuilder,
  createServer,
  loadEnv,
  type Plugin,
  type PluginOption,
  type UserConfig,
  version as viteVersion,
} from "vite"
import { codeUnitOrder } from "../internal/code-unit-order.ts"
import { assertDisposableDir } from "../internal/disposable-dir.ts"
import { publicEnvDefines } from "../internal/public-env.ts"
import { buildEnvironment } from "../internal/secret-scan.ts"
import { vitePublicEnvPrefix } from "../internal/server-boundary.ts"
import { unsupportedBuiltin } from "../internal/target-compat.ts"
import {
  viteAssetUrlGuard,
  viteBareBuiltinExternal,
  viteLeakGuard,
  viteServerZoneGuard,
} from "../plugins/vite-leak-guard.ts"
import { viteServerFnStub } from "../plugins/vite-server-fn.ts"
import { viteZoneGuard } from "../plugins/vite-zone-guard.ts"
import { assembleComponentTarget, type ComponentBuildResult } from "./build-target.ts"
import { componentBundleImports } from "./bundle-proof.ts"
import { installComponentDevHandler } from "./dev-http.ts"
import { serverComponentsPlugin } from "./vite.ts"

const sourceProofs = new WeakMap<UserConfig, ReadonlyMap<string, string>>()

function compilerGeneration(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const hash = createHash("sha256").update(viteVersion)
  // Compiler-only modules do not enter the application graph, but their changes invalidate its ABI.
  for (const name of ["build", "vite", "source", "build-target", "bundle-proof", "server-entry"])
    hash.update(readFileSync(fileURLToPath(new URL(`./${name}.${extension}`, import.meta.url))))
  return hash.digest("hex")
}

export interface ComponentPipelineOptions {
  readonly root: string
  readonly adapter: "react" | "vue" | "svelte" | "solid" | "preact"
  readonly entries: { readonly client: string; readonly ssr: string; readonly rsc?: string }
  readonly plugins?: readonly PluginOption[]
  readonly outDir?: string
  readonly port?: number
  readonly publicEnvPrefix?: string
  /** The deployment target (default `"bun"`, as `nifra build`'s): compiled for and assembled as one. */
  readonly target?: "bun" | "node" | "deno" | "cloudflare" | "vercel"
}

/** One content-derived generation for every environment; no payloads or paths are published. */
export function componentBuildId(root: string, outDir = "dist"): string {
  const digest = createHash("sha256").update("nifra-components-v1")
  const output = resolve(root, outDir)
  let count = 0
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      codeUnitOrder(a.name, b.name),
    )) {
      if (entry.name.startsWith(".") || ["node_modules", "dist", "build"].includes(entry.name))
        continue
      const file = resolve(directory, entry.name)
      if (file === output) continue
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|vue|svelte|css|json|lock)$/.test(entry.name)) {
        if (++count > 10000)
          throw new Error("[nifra/components] Component source graph exceeds 10000 files")
        digest
          .update(relative(root, file).replaceAll("\\", "/"))
          .update("\0")
          .update(readFileSync(file))
          .update("\0")
      }
    }
  }
  walk(resolve(root))
  return `c_${digest.digest("hex")}`
}

/** Coordinated Vite 8 build/dev configuration with the ordinary Nifra boundary guards. */
export async function serverComponentsConfig(
  options: ComponentPipelineOptions,
  generationId?: string,
): Promise<UserConfig> {
  const root = resolve(options.root)
  if (
    !["react", "vue", "svelte", "solid", "preact"].includes(options.adapter) ||
    (options.target !== undefined &&
      !["bun", "node", "deno", "cloudflare", "vercel"].includes(options.target))
  )
    throw new Error("[nifra/components] Unsupported component adapter or deployment target")
  const out = resolve(root, options.outDir ?? "dist")
  if (out === root)
    throw new Error("[nifra/components] The output directory must differ from the application root")
  const entries = Object.fromEntries(
    Object.entries(options.entries).map(([name, file]) => [name, resolve(root, file)]),
  )
  if (
    typeof entries.client !== "string" ||
    typeof entries.ssr !== "string" ||
    Object.values(entries).some((file) => !existsSync(file))
  )
    throw new Error(
      "[nifra/components] Declare existing client and SSR entries; the SSR entry must export createApp(clientEntry, assets)",
    )
  let build = generationId ?? componentBuildId(root, options.outDir)
  const sources = new Map<string, string>()
  const target = options.target ?? "bun"
  const edge = target === "cloudflare"
  const generatedFiles = Object.values(entries)
  const guards = {
    appRoot: root,
    root,
    generatedFiles: [entries.client!],
    publicEnvPrefix: options.publicEnvPrefix ?? "PUBLIC_",
  }
  const compiler = serverComponentsPlugin({ root, adapter: options.adapter })
  // Vite reads `.env.production` too; a value only there is still the app's secret to keep.
  const client = viteLeakGuard({
    ...guards,
    outDir: resolve(out, "client"),
    secrets: { env: { ...loadEnv("production", root, ""), ...buildEnvironment() } },
  })
  const server = viteServerZoneGuard({
    ...guards,
    generatedFiles,
    componentModules: compiler.api.componentModules,
  })
  const generation: Plugin & { api: { readonly componentSources: ReadonlyMap<string, string> } } = {
    api: { componentSources: sources },
    name: "nifra:component-generation",
    config(_config, env) {
      if (env.command === "serve") build = `d_${randomBytes(16).toString("hex")}`
      const config: UserConfig = {
        define: {
          ...publicEnvDefines(
            options.publicEnvPrefix ?? "PUBLIC_",
            loadEnv(env.mode, root, options.publicEnvPrefix ?? "PUBLIC_"),
          ),
          "process.env.NODE_ENV": JSON.stringify(
            env.command === "build" ? "production" : "development",
          ),
        },
      }
      // Vue's Node entry reexports CommonJS; native loading preserves its development SSR runtime.
      if (env.command === "serve" && options.adapter === "vue")
        config.ssr = { external: ["vue", "@vue/server-renderer"] }
      return config
    },
    configEnvironment(name) {
      return {
        define: {
          __NIFRA_COMPONENT_BROWSER__: JSON.stringify(name === "client"),
          __NIFRA_COMPONENT_BUILD__: JSON.stringify(build),
        },
      }
    },
    resolveId(source) {
      if (source === "virtual:nifra-component-build") return "\0nifra-component-build"
      return null
    },
    load(id) {
      if (id === "\0nifra-component-build")
        return `export const componentBuild = ${JSON.stringify(build)}`
      return null
    },
    transform(source, id) {
      const file = id.split("?")[0]!
      if (!file.startsWith("\0") && existsSync(file)) {
        if (sources.size >= 10000 && !sources.has(file))
          throw new Error("[nifra/components] Component source graph exceeds 10000 modules")
        sources.set(file, createHash("sha256").update(readFileSync(file)).digest("hex"))
      }
      if (id.split("?")[0] === entries.ssr && this.environment.name === "ssr")
        return {
          code:
            source +
            '\nexport { componentBuild as __nifraComponentBuild } from "@nifrajs/web/server-components/build-info";\n',
          map: null,
        }
      return null
    },
    async handleHotUpdate(context) {
      // Recreate all environments together so no warm module retains an earlier generation.
      context.server.ws.send({ type: "full-reload" })
      await context.server.restart()
      return []
    },
  }
  const proof: Plugin = {
    name: "nifra:component-build-proof",
    generateBundle(output, bundle) {
      const guard = this.environment.name === "client" ? client : server
      guard.generateBundle.call(this, output, bundle)
      if (this.environment.name !== "client")
        for (const chunk of Object.values(bundle)) {
          if (chunk.type === "chunk")
            for (const specifier of componentBundleImports(chunk.code)) {
              if (
                unsupportedBuiltin(specifier, edge ? "browser" : target === "bun" ? "bun" : "node")
              ) {
                const importers = [...this.getModuleIds()].filter((id) =>
                  this.getModuleInfo(id)?.importedIds.includes(specifier),
                )
                throw new Error(
                  `[nifra/components] ${specifier} is unsupported on ${target}; imported by ${importers.join(", ") || chunk.fileName}`,
                )
              }
            }
        }
    },
  }
  const builtinGuard: Plugin = {
    name: "nifra:component-client-builtins",
    enforce: "pre",
    resolveId(source, importer) {
      if (this.environment.name === "client" && source.startsWith("node:"))
        throw new Error(
          `[nifra/components] ${source} may not reach the browser; imported by ${importer ?? "the client entry"}`,
        )
      return null
    },
  }
  const plugins: UserConfig["plugins"] = [
    compiler,
    generation,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The shared compiler guards implement Vite hooks; the shim differs only in optional hook metadata.
    viteServerFnStub() as Plugin,
    builtinGuard,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The shared compiler guards implement Vite hooks; the shim differs only in optional hook metadata.
    viteBareBuiltinExternal() as Plugin,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The shared compiler guards implement Vite hooks; the shim differs only in optional hook metadata.
    viteAssetUrlGuard(guards) as Plugin,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The shared compiler guards implement Vite hooks; the shim differs only in optional hook metadata.
    viteZoneGuard({ ...guards, componentReferences: true }) as Plugin,
    ...(options.plugins ?? []),
    proof,
  ]
  if (options.adapter === "react") {
    if (entries.rsc === undefined) throw new Error("[nifra/components] React requires an RSC entry")
    const { default: rsc } = await import("@vitejs/plugin-rsc")
    plugins.push(rsc({ entries: { client: entries.client!, ssr: entries.ssr!, rsc: entries.rsc } }))
  } else if (entries.rsc !== undefined)
    throw new Error("[nifra/components] Only React uses an RSC environment")
  const serverConditions = edge
    ? ["module", "workerd", "edge-light", "node", "development|production"]
    : ["module", "node", "development|production"]
  const config: UserConfig = {
    root,
    plugins,
    publicDir: false,
    cacheDir: resolve(root, ".nifra/cache/components-vite"),
    // Without it Vite inlines every `VITE_*` value from the app's .env files into client code.
    envPrefix: vitePublicEnvPrefix(options.publicEnvPrefix),
    define: {
      "process.env.NIFRA_SSR_BUNDLED": '"1"',
      "globalThis.__NIFRA_EDGE_RUNTIME__": edge ? "true" : "false",
      __NIFRA_COMPONENT_BUILD__: JSON.stringify(build),
    },
    resolve: {
      dedupe: [
        "react",
        "react-dom",
        "react-server-dom-webpack",
        "vue",
        "svelte",
        "solid-js",
        "preact",
        "@nifrajs/web",
        "@nifrajs/core",
      ],
    },
    ssr: {
      noExternal: true,
      target: edge ? "webworker" : "node",
      resolve: { conditions: serverConditions },
    },
    ...(options.adapter === "preact"
      ? { oxc: { jsx: { runtime: "automatic", importSource: "preact" } } }
      : { esbuild: { jsx: "automatic" } }),
    build: { outDir: out, sourcemap: false, manifest: true, minify: true },
    environments: {
      client: {
        consumer: "client",
        build: { outDir: resolve(out, "client"), manifest: true, emptyOutDir: true },
      },
      ssr: {
        consumer: "server",
        build: {
          outDir: resolve(out, options.adapter === "react" ? "ssr" : "server"),
          emptyOutDir: true,
        },
      },
    },
    server: { host: "127.0.0.1", port: options.port ?? 3000, strictPort: true },
  }
  // These environments were constructed above; only the compiler's selected entry lane adds inputs.
  const environments = config.environments!
  if (edge) environments.ssr!.resolve = { conditions: serverConditions }
  // Rune modules need the native TS transform before Svelte compiles them; prebundling skips it.
  if (options.adapter === "svelte") config.optimizeDeps = { exclude: ["@nifrajs/web-svelte"] }
  if (options.adapter === "react") {
    environments.rsc = { build: { outDir: resolve(out, "rsc"), emptyOutDir: true } }
  } else {
    environments.client!.build!.rollupOptions = { input: entries.client! }
    Object.assign(environments.ssr!.build!, {
      ssr: entries.ssr!,
      rollupOptions: { output: { entryFileNames: "index.js" } },
    })
    config.builder = {
      async buildApp(builder) {
        await builder.build(builder.environments.client!)
        await builder.build(builder.environments.ssr!)
      },
    }
  }
  sourceProofs.set(config, sources)
  return config
}

export async function buildServerComponents(
  options: ComponentPipelineOptions,
): Promise<ComponentBuildResult> {
  const out = resolve(options.root, options.outDir ?? "dist")
  const root = resolve(options.root)
  assertDisposableDir("outDir", out, [
    root,
    process.cwd(),
    ...Object.values(options.entries).map((file) => resolve(root, file)),
  ])
  const parent = resolve(out, "..")
  const { mkdir } = await import("node:fs/promises")
  await mkdir(parent, { recursive: true })
  const stage = await mkdtemp(resolve(parent, ".nifra-components-"))
  const backup = `${stage}-previous`
  let previous = false
  try {
    const buildId = componentBuildId(options.root, options.outDir)
    const compilerId = compilerGeneration()
    let config = await serverComponentsConfig({ ...options, outDir: stage }, buildId)
    await (await createBuilder({ ...config, configFile: false })).buildApp()
    const snapshot = (value: UserConfig): ReadonlyMap<string, string> => {
      const sources = sourceProofs.get(value)
      if (sources === undefined) throw new Error("[nifra/components] Missing generation proof")
      return sources
    }
    const graphId = (modules: ReadonlyMap<string, string>): string => {
      const digest = createHash("sha256")
        .update(buildId)
        .update(compilerId)
        .update(
          JSON.stringify({
            adapter: options.adapter,
            target: options.target ?? "bun",
            env: publicEnvDefines(
              options.publicEnvPrefix ?? "PUBLIC_",
              loadEnv("production", root, options.publicEnvPrefix ?? "PUBLIC_"),
            ),
          }),
        )
      for (const [file, hash] of [...modules].sort(([a], [b]) => codeUnitOrder(a, b)))
        digest.update(relative(options.root, file).replaceAll("\\", "/")).update("\0").update(hash)
      return `c_${digest.digest("hex")}`
    }
    const modules = snapshot(config)
    const generationId = graphId(modules)
    // The analysis output is never published. Compile again with the complete dependency graph's generation.
    config = await serverComponentsConfig({ ...options, outDir: stage }, generationId)
    await (await createBuilder({ ...config, configFile: false })).buildApp()
    if (
      graphId(snapshot(config)) !== generationId ||
      [...modules].some(
        ([file, hash]) => createHash("sha256").update(readFileSync(file)).digest("hex") !== hash,
      )
    )
      throw new Error("[nifra/components] Sources changed during the coordinated build")
    if (buildId !== componentBuildId(options.root, options.outDir))
      throw new Error(
        "[nifra/components] Sources changed during the build; rebuild one complete generation",
      )
    if (compilerId !== compilerGeneration())
      throw new Error(
        "[nifra/components] Compiler changed during the build; rebuild one complete generation",
      )
    const result = await assembleComponentTarget({ ...options, outDir: stage }, generationId)
    if (existsSync(out)) {
      await rename(out, backup)
      previous = true
    }
    try {
      await rename(stage, out)
    } catch (error) {
      if (previous) await rename(backup, out)
      throw error
    }
    if (previous) await rm(backup, { recursive: true, force: true })
    return { ...result, outDir: out }
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}
export async function devServerComponents(
  options: ComponentPipelineOptions,
): Promise<Awaited<ReturnType<typeof createServer>>> {
  const config = await serverComponentsConfig(options)
  config.plugins = [
    ...(config.plugins ?? []),
    {
      name: "nifra:component-dev-handler",
      configureServer(server) {
        installComponentDevHandler(server, options)
      },
    },
  ]
  const server = await createServer({ ...config, configFile: false })
  await server.listen()
  return server
}
