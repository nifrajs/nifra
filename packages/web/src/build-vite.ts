/**
 * `@nifrajs/web/build-vite` — the **Vite/Rollup production build**: the escape hatch, not the default.
 *
 * nifra's production default is Bun (`@nifrajs/web/build`), and stays so - it is faster and Bun-native,
 * which is what nifra competes on. This exists for the one case that default cannot serve: an app whose
 * client depends on a Vite-only transform with no Bun equivalent. For those, `buildClientVite` /
 * `buildServerVite` produce the SAME artifacts as the Bun build - the same `BuildManifest`, the same
 * `ServerBuild` - through Vite instead, and `buildTargetVite` assembles the same per-target deploy dir.
 *
 * Crucially this is NOT a second orchestrator. `buildTarget`'s deploy assembly, server-entry codegen,
 * prerender and size report are bundler-agnostic; they live in `build.ts` behind `buildTargetWith`, which
 * takes a {@link Bundler} strategy. This file only supplies the Vite strategy - the two bundling steps -
 * so a change to how a deploy dir is shaped happens in one place for both pipelines.
 *
 * And it does not arrive without the client-leak guards: `buildClientVite` wires `viteLeakGuard()`, so
 * server-only code or a `node:` builtin reaching the browser fails the Vite build with the identical
 * error the Bun build raises. A second production pipeline without those guards is exactly the hole the
 * bundler-neutral module graph was built to close.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve as resolvePath } from "node:path"
import {
  type BuildClientOptions,
  type BuildManifest,
  type BuildTarget,
  type BuildTargetOptions,
  type BuildTargetResult,
  type Bundler,
  buildTargetWith,
  copyPublicDir,
  publicEnvDefines,
  type ServerBuild,
} from "./build.ts"
import { discoverRoutes } from "./fs.ts"
import { generateClientEntry, generateServerManifest } from "./index.ts"
import { viteLeakGuard } from "./plugins/vite-leak-guard.ts"

// ---------------------------------------------------------------------------------------------------
// Structural Vite typings — no hard `vite` dependency (mirrors vite.ts). Only the build API is used.
// ---------------------------------------------------------------------------------------------------

/** One entry in Vite's `.vite/manifest.json`: its emitted file + transitive CSS + imported chunks. */
interface ViteManifestEntry {
  readonly file: string
  readonly isEntry?: boolean
  readonly css?: readonly string[]
  readonly assets?: readonly string[]
  readonly imports?: readonly string[]
}
type ViteBuildManifest = Readonly<Record<string, ViteManifestEntry>>

interface ViteModule {
  build(config: Record<string, unknown>): Promise<unknown>
}

/** Load the app's Vite. Resolved from `root` so it's the project's copy, not this package's. */
async function loadVite(): Promise<ViteModule> {
  try {
    return (await import("vite")) as unknown as ViteModule
  } catch (cause) {
    // `vite` is an OPTIONAL peer, so a project without it resolves nothing and the raw failure is a
    // bare ERR_MODULE_NOT_FOUND naming neither this build nor the missing dependency. Every caller
    // here is mid-build, so the message has to say which half failed and what to install - an opaque
    // resolution error at this point reads as a broken build rather than a missing optional peer.
    throw new Error(
      "[nifra/web] the Vite production build needs `vite` installed in this project (it is an " +
        "optional peer dependency, so it is not installed for you). Add it, or use the default Bun " +
        `build. Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
  }
}

// Vite derives `isProduction` from the process-global NODE_ENV even when an explicit `mode` is supplied.
// Programmatic builds therefore have to pin it, but two overlapping calls must never observe each other's
// mode. Serialize only this unavoidable Vite window; the previous value is captured after acquiring the
// lock and restored before the next build starts. Rejections release the lock too.
let nodeEnvBuildTail: Promise<void> = Promise.resolve()

async function withSerializedNodeEnv<T>(mode: string, run: () => Promise<T>): Promise<T> {
  const previousBuild = nodeEnvBuildTail
  let release!: () => void
  nodeEnvBuildTail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previousBuild

  const previous = process.env.NODE_ENV
  process.env.NODE_ENV = mode
  try {
    return await run()
  } finally {
    // An env value is always a string when set; `undefined` means the key was absent, so remove it rather
    // than assign `undefined` (which `exactOptionalPropertyTypes` rejects and which would stringify anyway).
    if (previous === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previous
    release()
  }
}

/** Options for {@link buildClientVite} — the Bun {@link BuildClientOptions} minus Bun-plugin specifics,
 * plus the Vite plugin list the app injects for its transforms. */
export interface BuildClientViteOptions extends Omit<BuildClientOptions, "plugins"> {
  /** Vite plugins for the app's client transforms (e.g. `react()`, `vue()`). */
  readonly vitePlugins?: readonly unknown[]
  /** Vite project root (default: the parent of `routesDir`). Manifest keys are relative to it. */
  readonly root?: string
}

/**
 * Build the client bundle with Vite, emitting the SAME {@link BuildManifest} `buildClient` (Bun) does:
 * a content-hashed entry, per-route chunk lists, aggregate + per-route CSS, and copied `public/` files.
 *
 * The route→chunk and route→CSS mappings come from Vite's own `.vite/manifest.json` (`build.manifest`),
 * which records each entry's emitted `file` and its transitive `css` - exactly the two facts the Bun path
 * reconstructs from Bun's metafile. `viteLeakGuard()` runs during the build, so a client leak fails here
 * with the same error as the Bun build rather than shipping.
 */
export async function buildClientVite(options: BuildClientViteOptions): Promise<BuildManifest> {
  const { routesDir, outDir, clientModule } = options
  const root = resolvePath(options.root ?? dirname(routesDir))
  const resolve = options.resolve ?? ((file: string) => `${routesDir}/${file}`)
  const publicPath = options.publicPath ?? "/assets/"
  mkdirSync(outDir, { recursive: true })

  const routeManifest = discoverRoutes(routesDir)
  // The generated bootstrap, written beside the project so its imports resolve the app's deps (same
  // reasoning as buildClient). A unique dir avoids clobbering a user file / colliding with parallel builds.
  const entryDir = mkdtempSync(resolvePath(dirname(routesDir), ".nifra-vite-client-"))
  const entryFile = `${entryDir}/_nifra-entry.ts`
  writeFileSync(
    entryFile,
    `globalThis.process ??= { env: {} };\n${generateClientEntry(routeManifest, { clientModule, resolve })}`,
  )

  // Every unique route/layout/_404 file — each an additional entry so Vite emits a named chunk per file
  // the bootstrap's lazy import dedupes to, giving the per-route chunk + CSS mapping below.
  const routeFiles = [
    ...new Set([
      ...routeManifest.routes.map((r) => r.file),
      ...Object.values(routeManifest.layouts).map((l) => l.file),
      ...(routeManifest.notFound ? [routeManifest.notFound.file] : []),
    ]),
  ].sort()

  // Vite manifest keys are the input path RELATIVE TO ROOT — precompute them so the lookup below is exact
  // (survives same-basename collisions like `index.tsx` + `blog/index.tsx`).
  const keyOf = (absPath: string): string => relative(root, absPath).replaceAll("\\", "/")
  const entryKey = keyOf(entryFile)
  const input: Record<string, string> = { _nifra: entryFile }
  const fileKey = new Map<string, string>() // route/layout file → its manifest key
  for (const file of routeFiles) {
    const abs = resolvePath(resolve(file))
    // FLAT input names (no `/`), so Vite emits `routes_index_tsx-HASH.js` in `outDir` directly, not a
    // nested `routes/…` dir — the deploy assembly + size report map asset URLs by basename and expect a
    // flat layout. The manifest LOOKUP below is keyed by the src path (`keyOf`), independent of this name.
    input[keyOf(abs).replace(/[^\w]/g, "_")] = abs
    fileKey.set(file, keyOf(abs))
  }

  // Pin Vite's MODE to match the NODE_ENV we define. @vitejs/plugin-react picks the JSX runtime by mode -
  // `jsx` (production) vs `jsxDEV` (development) - so if mode and NODE_ENV disagree, the transform emits
  // `jsxDEV` calls while `react/jsx-dev-runtime` guards `jsxDEV` behind `NODE_ENV !== "production"` and
  // leaves it undefined → `jsxDEV is not a function` at SSR. Vite's default mode follows the ambient
  // NODE_ENV (e.g. "test" under `bun test`), so it MUST be set explicitly, not left to default.
  const mode = options.minify === false ? "development" : "production"
  const buildEnv = (typeof Bun !== "undefined" ? Bun.env : undefined) ?? process.env
  const publicDefines = publicEnvDefines(options.publicEnvPrefix ?? "PUBLIC_", buildEnv)
  const vite = await loadVite()
  try {
    await withSerializedNodeEnv(mode, () =>
      vite.build({
        root,
        base: publicPath,
        mode,
        logLevel: "silent",
        // Nifra owns publicDir copying so direct and target builds share symlink confinement and
        // deploy-root placement. Vite's automatic copy would put root files inside /assets.
        publicDir: false,
        define: {
          ...publicDefines,
          "process.env.NODE_ENV": JSON.stringify(mode),
          ...(options.define ?? {}),
        },
        resolve: {
          // Mirror the Bun build's reactDedupePlugin: one physical react/react-dom, or a hook-using route
          // gets a second dispatcher. No-op when the app isn't React.
          dedupe: ["react", "react-dom"],
          ...(options.conditions ? { conditions: [...options.conditions] } : {}),
        },
        plugins: [...(options.vitePlugins ?? [])],
        build: {
          outDir,
          emptyOutDir: false, // buildTargetWith owns outDir lifecycle; never let Vite wipe sibling files
          manifest: true,
          minify: options.minify !== false,
          rollupOptions: {
            // Keep `node:` builtins as external specifiers so the leak guard sees `node:crypto` and can
            // name it. Left to itself, rolldown-vite SILENTLY rewrites a `node:` import to a
            // `__vite-browser-external` stub for "browser compatibility" - the code builds, ships, and the
            // builtin is a no-op at runtime, which is a worse footgun than Bun's polyfill and invisible
            // without this. External here means the guard fails the build (below) with the exact builtin.
            external: [/^node:/],
            input,
            // The leak guard is a Rollup plugin — last, so it sees the final graph.
            plugins: [viteLeakGuard()],
            output: {
              entryFileNames: "[name]-[hash].js",
              chunkFileNames: "[name]-[hash].js",
              assetFileNames: "[name]-[hash][extname]",
            },
          },
        },
      }),
    )
  } finally {
    rmSync(entryDir, { recursive: true, force: true })
  }

  const viteManifestDir = join(outDir, ".vite")
  const viteManifest = JSON.parse(
    readFileSync(join(viteManifestDir, "manifest.json"), "utf8"),
  ) as ViteBuildManifest
  // Vite's source-keyed build manifest is an internal mapping input, not a deploy artifact.
  rmSync(viteManifestDir, { recursive: true, force: true })
  const url = (file: string): string => `${publicPath}${file}`

  const bootstrap = viteManifest[entryKey]
  if (bootstrap === undefined) {
    throw new Error(
      `[nifra/web] Vite build produced no manifest entry for the bootstrap (${entryKey}). ` +
        "The client build did not emit the generated entry.",
    )
  }

  // routes: each route id → its layout chain + own chunk URLs (per-file entry chunks, like the Bun path).
  const chunkFor = (file: string): string | undefined => {
    const key = fileKey.get(file)
    const entry = key !== undefined ? viteManifest[key] : undefined
    return entry !== undefined ? url(entry.file) : undefined
  }
  const chainFiles = (route: (typeof routeManifest.routes)[number]): string[] => [
    ...route.layoutIds.map((id) => routeManifest.layouts[id]?.file ?? ""),
    route.file,
  ]
  const routes: Record<string, string[]> = {}
  for (const route of routeManifest.routes) {
    routes[route.id] = chainFiles(route)
      .map(chunkFor)
      .filter((u): u is string => u !== undefined)
  }
  if (routeManifest.notFound) {
    const c = chunkFor(routeManifest.notFound.file)
    routes._404 = c !== undefined ? [c] : []
  }

  // CSS per route — Vite's manifest `css` is the transitive stylesheet set for that entry.
  const stylesFor = (files: readonly string[]): readonly string[] => {
    const urls = new Set<string>()
    for (const file of files) {
      const key = fileKey.get(file)
      const entry = key !== undefined ? viteManifest[key] : undefined
      for (const css of entry?.css ?? []) urls.add(url(css))
    }
    return [...urls]
  }
  // CSS aggregate — every stylesheet the app emits, the always-safe fallback.
  const allCss = new Set<string>()
  for (const entry of Object.values(viteManifest)) {
    for (const css of entry.css ?? []) allCss.add(url(css))
  }
  const css = [...allCss]
  const routeStyles: Record<string, readonly string[]> = {}
  if (css.length > 0) {
    for (const route of routeManifest.routes) routeStyles[route.id] = stylesFor(chainFiles(route))
    if (routeManifest.notFound) routeStyles._404 = stylesFor([routeManifest.notFound.file])
  }

  // assets — every emitted file + stylesheet across the manifest (chunks, entries, css).
  const assets = new Set<string>()
  for (const entry of Object.values(viteManifest)) {
    assets.add(url(entry.file))
    for (const css of entry.css ?? []) assets.add(url(css))
    for (const asset of entry.assets ?? []) assets.add(url(asset))
  }

  const publicDir = options.publicDir === false ? undefined : (options.publicDir ?? "public")
  const publicFiles =
    publicDir !== undefined && existsSync(publicDir) ? await copyPublicDir(publicDir, outDir) : []

  const manifest: BuildManifest = {
    entry: url(bootstrap.file),
    assets: [...assets],
    routes,
    ...(publicFiles.length > 0 ? { publicFiles } : {}),
    ...(css.length > 0 ? { css } : {}),
    ...(Object.keys(routeStyles).length > 0 ? { routeStyles } : {}),
  }
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2))
  return manifest
}

/** Options for {@link buildServerVite} — the same surface as `buildServer` minus Bun-plugin specifics. */
export interface BuildServerViteOptions {
  readonly routesDir: string
  readonly serverEntry: string
  readonly outDir: string
  readonly clientEntry: string
  readonly styles?: readonly string[] | undefined
  readonly routeStyles?: Readonly<Record<string, readonly string[]>> | undefined
  readonly resolve?: (file: string) => string
  readonly manifestFile?: string
  readonly vitePlugins?: readonly unknown[]
  readonly conditions?: readonly string[]
  readonly define?: Readonly<Record<string, string>>
  readonly minify?: boolean
  /** The runtime the worker targets — mirrors `buildServer`. `browser` = the edge (workerd/edge-light). */
  readonly target?: "browser" | "node" | "bun"
  /** Vite project root (default: the parent of `routesDir`). */
  readonly root?: string
}

interface EdgeBundleChunk {
  readonly type?: string
  readonly imports?: readonly string[]
  readonly dynamicImports?: readonly string[]
  readonly moduleIds?: readonly string[]
}

interface EdgeBuiltinGuardContext {
  getModuleInfo(id: string): {
    readonly importedIds?: readonly string[]
    readonly dynamicallyImportedIds?: readonly string[]
  } | null
  error(message: string): never
}

/** Fail closed if Rollup would leave a Node builtin import in a workerd/edge worker. */
function edgeBuiltinGuard(): {
  readonly name: string
  generateBundle(
    this: EdgeBuiltinGuardContext,
    options: unknown,
    bundle: Readonly<Record<string, EdgeBundleChunk>>,
  ): void
} {
  return {
    name: "nifra:edge-node-builtin-guard",
    generateBundle(_options, bundle) {
      const builtins = new Set<string>()
      const importers = new Set<string>()
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue
        for (const specifier of [...(output.imports ?? []), ...(output.dynamicImports ?? [])]) {
          if (specifier.startsWith("node:")) builtins.add(specifier)
        }
        for (const id of output.moduleIds ?? []) {
          const info = this.getModuleInfo(id)
          const imports = [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])]
          if (imports.some((specifier) => specifier.startsWith("node:"))) importers.add(id)
        }
      }
      if (builtins.size > 0) {
        this.error(
          `[nifra/web] Node built-in(s) reached an edge server bundle: ${[...builtins].sort().join(", ")}. ` +
            `Imported by: ${[...importers].sort().join(", ") || "unknown module"}. ` +
            "Move the import behind a Node/Bun target or replace it with an edge-compatible API.",
        )
      }
    },
  }
}

/**
 * Build the SSR worker with Vite, emitting the SAME {@link ServerBuild} `buildServer` (Bun) does: a
 * self-contained worker bundle whose path is returned as `worker`.
 *
 * Like `buildServer`, it codegens the statically-analyzable `server-manifest` next to the entry (so no
 * `node:fs` route scan runs on a disk-less edge), then bundles. `ssr.noExternal` bundles the app + adapter
 * + `@nifrajs/*` into ONE file (the self-contained worker), while `node:` builtins stay external on the
 * `node`/`bun` targets that provide them. `NIFRA_SSR_BUNDLED` is defined so the web-react adapter uses the
 * bundled, deduped react-dom rather than re-rooting to a disk copy at runtime - the same tag `buildServer`
 * sets, and the reason a bundled SSR output does not hit the dual-React crash.
 *
 * The client-leak guards are deliberately NOT run here: a server bundle's `node:` imports are legitimate.
 */
export async function buildServerVite(options: BuildServerViteOptions): Promise<ServerBuild> {
  const { routesDir, serverEntry, outDir, clientEntry, styles, routeStyles } = options
  const root = resolvePath(options.root ?? dirname(routesDir))
  const entryDir = dirname(serverEntry)
  const manifestFile = options.manifestFile ?? "server-manifest.ts"
  const rel = relative(entryDir, routesDir).replaceAll("\\", "/")
  const resolve = options.resolve ?? ((file: string) => `./${rel}/${file}`)
  mkdirSync(outDir, { recursive: true })

  const target = options.target ?? "browser"
  const edge = target === "browser"
  // Same conditions as buildServer: the edge target needs workerd/edge-light so react-dom resolves its
  // edge server build; node/bun resolve their own via the target condition.
  const conditions = options.conditions ?? (edge ? ["workerd", "edge-light", "browser"] : [target])

  const routeManifest = discoverRoutes(routesDir)
  writeFileSync(
    `${entryDir}/${manifestFile}`,
    generateServerManifest(routeManifest, { resolve, clientEntry, styles, routeStyles }),
  )

  // Pin the mode to match NODE_ENV — the react plugin's JSX runtime (jsx vs jsxDEV) follows it, and a
  // mismatch throws `jsxDEV is not a function` at SSR (see buildClientVite for the full reasoning).
  const mode = options.minify === false ? "development" : "production"
  const vite = await loadVite()
  await withSerializedNodeEnv(mode, () =>
    vite.build({
      root,
      mode,
      logLevel: "silent",
      define: {
        "process.env.NODE_ENV": JSON.stringify(mode),
        // Tag the bundle so @nifrajs/web-react uses the bundled+deduped react-dom (no runtime re-root →
        // no second React core). Layered after any caller define so it cannot be overridden.
        ...(options.define ?? {}),
        "process.env.NIFRA_SSR_BUNDLED": '"1"',
        "globalThis.__NIFRA_EDGE_RUNTIME__": edge ? "true" : "false",
      },
      resolve: {
        dedupe: ["react", "react-dom"],
        conditions: [...conditions],
      },
      plugins: [...(options.vitePlugins ?? [])],
      build: {
        outDir,
        emptyOutDir: false,
        minify: options.minify !== false,
        ssr: serverEntry,
        rollupOptions: {
          // Keep builtins external so Node/Bun use their native implementations. Edge builds add a
          // generateBundle guard below, so an external specifier can never silently ship to workerd.
          external: [/^node:/],
          ...(edge ? { plugins: [edgeBuiltinGuard()] } : {}),
          // ONE self-contained `server.js`. `inlineDynamicImports` forces the ENTRY chunk to absorb
          // every module - the app, the adapter, react/react-dom, @nifrajs/* - so no second chunk is
          // emitted. It is NOT redundant with `ssr.noExternal`: `noExternal` decides what gets bundled,
          // this decides how many files it lands in. Without it the `node` SSR target splits vendor deps
          // (verified: a React app emits `assets/react-<hash>.js`), and the deploy assembly copies only
          // the entry, so the server dies at boot with ERR_MODULE_NOT_FOUND on a path that was never
          // written. bun/deno/edge happen not to split today, which is exactly why the node regression
          // went unnoticed - relying on a bundler's default chunking is not a contract.
          // (Under rolldown-vite this option logs a cosmetic deprecation, silenced by `logLevel: silent`.)
          output: { entryFileNames: "server.js", inlineDynamicImports: true },
        },
        // Bundle the app + adapter + @nifrajs/* into one self-contained worker (like Bun's eager output),
        // rather than externalizing node_modules the way a default Vite SSR build does.
        ssrEmitAssets: false,
      },
      ssr: {
        noExternal: true,
        ...(edge ? { target: "webworker" } : {}),
      },
    }),
  )

  const worker = join(outDir, "server.js")
  if (!existsSync(worker)) {
    throw new Error(`[nifra/web] Vite SSR build produced no ${worker}`)
  }
  return { worker, outputs: [worker] }
}

/**
 * The Vite build STRATEGY — plugged into `buildTargetWith`. `plugins` arriving through the shared
 * orchestrator are the app's Vite plugins (the escape hatch's whole reason), cast to Vite's plugin type.
 */
export const viteBundler: Bundler = {
  buildClient: (input) =>
    buildClientVite({
      routesDir: input.routesDir,
      outDir: input.outDir,
      clientModule: input.clientModule,
      ...(input.plugins ? { vitePlugins: input.plugins } : {}),
      ...(input.conditions ? { conditions: input.conditions } : {}),
      ...(input.define ? { define: input.define } : {}),
      ...(input.publicDir !== undefined ? { publicDir: input.publicDir } : {}),
      ...(input.publicEnvPrefix !== undefined ? { publicEnvPrefix: input.publicEnvPrefix } : {}),
      ...(input.root ? { root: input.root } : {}),
    }),
  buildServer: (input) =>
    buildServerVite({
      routesDir: input.routesDir,
      serverEntry: input.serverEntry,
      outDir: input.outDir,
      clientEntry: input.clientEntry,
      target: input.target,
      ...(input.plugins ? { vitePlugins: input.plugins } : {}),
      ...(input.define ? { define: input.define } : {}),
      ...(input.root ? { root: input.root } : {}),
    }),
}

/**
 * Build a full deploy dir for `target` using the Vite/Rollup pipeline - the escape hatch for apps that
 * need a Vite-only transform in production. Identical output shape to {@link import("./build.ts").buildTarget}
 * (same deploy dir, same server entry, same prerender + size report), because both delegate to the ONE
 * `buildTargetWith` orchestrator; only the two bundling steps differ.
 *
 * Pass the app's Vite plugins via `clientPlugins` / `serverPlugins` (the shared option names) - here they
 * are Vite plugins, not Bun plugins.
 */
export function buildTargetVite(
  target: BuildTarget,
  options: BuildTargetOptions,
): Promise<BuildTargetResult> {
  return buildTargetWith(target, options, viteBundler)
}
