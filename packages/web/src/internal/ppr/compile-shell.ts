import { resolve } from "node:path"
import type { Manifest, RouteEntry } from "../../manifest.ts"
import { type BunMetafileLike, fromBunMetafile } from "../../module-graph.ts"

/**
 * Which routes passed the shell check for one deployment. The server shares a shell only for a route
 * listed here under its own deployment; anything else renders blocking (fail closed).
 */
export interface ShellCheckRecord {
  readonly v: 1
  readonly deployment: string
  /** Route id to the sha256 of the checked shell bundle. */
  readonly routes: Readonly<Record<string, string>>
}

export class ShellCheckError extends Error {
  override readonly name = "ShellCheckError"
  constructor(
    readonly routeId: string,
    readonly chain: readonly string[],
  ) {
    super(
      `[nifra/web] ppr: the shell of route "${routeId}" reaches request-scoped module "${chain.at(-1)}" through ${chain.join(" -> ")}. Move that read into a dynamic boundary's loader`,
    )
  }
}

export interface CompileShellsOptions {
  readonly routesDir: string
  readonly manifest: Manifest
  /** The deployment the record is for: the server refuses a record made for another one. */
  readonly deployment: string
  /** True for a module (absolute path, `/` separators) whose code reads the visitor's request. */
  readonly requestScoped: (moduleId: string) => boolean
  /** Called for each route that fails; the route is left out of the record. Default: rethrow. */
  readonly onFailure?: (routeId: string, error: unknown) => void
  /** Bun plugins the server build uses for route files, such as `svelteBunPlugin("ssr")`. */
  readonly plugins?: readonly import("bun").BunPlugin[]
}

const NAMESPACE = "nifra-ppr-shell"

const toPosix = (path: string): string => path.replaceAll("\\", "/")

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * nifra's own modules that read the visitor's request from async context. Packages stay external in
 * the shell bundle, so these are bundled in instead: the output graph then shows whether shell code
 * calls them, not merely whether a module beside it imports them.
 */
const NIFRA_REQUEST_SCOPED: readonly string[] = ["@nifrajs/middleware/context-storage"]
const NIFRA_REQUEST_SCOPED_FILTER = new RegExp(
  `^(?:${NIFRA_REQUEST_SCOPED.map(escapeRegExp).join("|")})$`,
)

/** The import chain from `root` to the first request-scoped module it reaches, breadth first. */
function requestScopedChain(
  root: string,
  next: ReadonlyMap<string, readonly string[]>,
  scoped: ReadonlySet<string>,
): string[] | undefined {
  const parent = new Map<string, string | undefined>([[root, undefined]])
  const queue = [root]
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const module = queue[cursor]
    if (module === undefined) break
    if (scoped.has(module)) {
      const chain: string[] = []
      for (let at: string | undefined = module; at !== undefined; at = parent.get(at))
        chain.push(at)
      return chain.reverse()
    }
    for (const child of next.get(module) ?? []) {
      if (!parent.has(child)) {
        parent.set(child, module)
        queue.push(child)
      }
    }
  }
  return undefined
}

/**
 * Bundle each route's shell (its page, its backend `shellLoader` and its layouts, and nothing else)
 * and refuse it when the emitted code reaches a request-scoped module. A module counts only
 * when its code reached the output, so an import only a hole loader uses is not a leak. Routes whose
 * backend half has no `shellLoader` are skipped. Bun only.
 */
export async function compileShells(options: CompileShellsOptions): Promise<ShellCheckRecord> {
  const dir = resolve(options.routesDir)
  const routes: Record<string, string> = {}
  for (const route of options.manifest.routes) {
    if (route.backend === undefined) continue
    try {
      const hash = await compileShell(
        dir,
        options.manifest,
        route,
        route.backend,
        options.requestScoped,
        options.plugins ?? [],
      )
      if (hash !== undefined) routes[route.id] = hash
    } catch (error) {
      if (options.onFailure === undefined) throw error
      options.onFailure(route.id, error)
    }
  }
  return { v: 1, deployment: options.deployment, routes }
}

interface SourceModule {
  readonly path: string
  readonly loader: "ts" | "tsx"
  readonly source: string
  /** The names it exports, read from its source without running it. */
  readonly exports: readonly string[]
}

async function readModule(dir: string, file: string): Promise<SourceModule> {
  const path = toPosix(resolve(dir, file))
  const loader = /\.[cm]?tsx$|\.jsx$/.test(path) ? "tsx" : "ts"
  const source = await Bun.file(path).text()
  return { path, loader, source, exports: new Bun.Transpiler({ loader }).scan(source).exports }
}

async function compileShell(
  dir: string,
  manifest: Manifest,
  route: RouteEntry,
  backend: string,
  requestScoped: (moduleId: string) => boolean,
  plugins: readonly import("bun").BunPlugin[],
): Promise<string | undefined> {
  const backendModule = await readModule(dir, backend)
  if (!backendModule.exports.includes("shellLoader")) return undefined
  // A gate's loader runs for its redirect or refusal and its data never reaches the shell; any other
  // layout loader reads the request for data the shell would show every visitor.
  for (const id of route.layoutIds) {
    const layoutBackend = manifest.layouts[id]?.backend
    if (layoutBackend === undefined) continue
    const names = (await readModule(dir, layoutBackend)).exports
    if (names.includes("loader") && !names.includes("gate")) {
      throw new Error(
        `[nifra/web] ppr: route "${route.id}" has a shellLoader, but its layout "${id}" has a loader that is not a gate. Its output would be in a shell shared by every visitor; move that data into a dynamic boundary, or mark the layout \`gate\` if it loads only to redirect or refuse`,
      )
    }
  }
  const at = (file: string): string => JSON.stringify(toPosix(resolve(dir, file)))
  const lines = [
    `export { shellLoader } from ${at(backend)}`,
    `export { default as page } from ${at(route.file)}`,
  ]
  route.layoutIds.forEach((id, index) => {
    const layout = manifest.layouts[id]
    if (layout !== undefined)
      lines.push(`export { default as layout${index} } from ${at(layout.file)}`)
  })
  const nifraScoped = new Set<string>()
  const result = await Bun.build({
    // Bun reads a `/` in an entry name as a directory, and route ids have them.
    entrypoints: [`${NAMESPACE}:${encodeURIComponent(route.id)}`],
    target: "bun",
    packages: "external",
    metafile: true,
    throw: false,
    plugins: [
      // Ours first: its resolve and load hooks claim the entry and the backend half before theirs.
      {
        name: NAMESPACE,
        setup(build) {
          build.onResolve({ filter: new RegExp(`^${NAMESPACE}:`) }, (args) => ({
            path: args.path,
            namespace: NAMESPACE,
          }))
          build.onLoad({ filter: /.*/, namespace: NAMESPACE }, () => ({
            loader: "ts",
            contents: lines.join("\n"),
          }))
          build.onResolve({ filter: NIFRA_REQUEST_SCOPED_FILTER }, (args) => {
            let path: string
            try {
              path = toPosix(Bun.resolveSync(args.path, args.resolveDir))
            } catch {
              // Not installed, so no shell code can call it.
              return undefined
            }
            nifraScoped.add(path)
            return { path }
          })
          // The backend half's other exports are not shell code. A hole loader's `output: t.object()`
          // is a call into a package, which the bundler must keep, and with it every import the
          // hole uses. Eliminating them first scopes the check to `shellLoader`; their imports stay
          // as bare imports, so a module with top-level effects still counts.
          build.onLoad({ filter: new RegExp(`^${escapeRegExp(backendModule.path)}$`) }, () => ({
            loader: "js",
            contents: new Bun.Transpiler({
              loader: backendModule.loader,
              trimUnusedImports: true,
              exports: {
                eliminate: backendModule.exports.filter((name) => name !== "shellLoader"),
              },
            }).transformSync(backendModule.source),
          }))
        },
      },
      ...plugins,
    ],
  })
  if (!result.success) {
    throw new AggregateError(
      result.logs,
      `[nifra/web] ppr: the shell of "${route.id}" failed to build`,
    )
  }
  // biome-ignore lint/plugin/noChainedTypeAssertions: Bun returns the metafile when `metafile: true`; @types/bun does not name it yet, and fromBunMetafile fails closed on a missing one.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Bun returns the metafile when `metafile: true`; @types/bun does not name it yet, and fromBunMetafile fails closed on a missing one.
  const meta = (result as unknown as { readonly metafile?: BunMetafileLike }).metafile
  const graph = fromBunMetafile(meta)
  const entry = Object.values(meta?.outputs ?? {}).find((output) =>
    output.entryPoint?.startsWith(`${NAMESPACE}:`),
  )
  if (entry === undefined)
    throw new Error(`[nifra/web] ppr: no output for the shell of "${route.id}"`)
  // Re-exports and the virtual entry have zero bytes too, so every edge stays and only the
  // request-scoped test reads bytes.
  const emitted = (id: string): boolean => {
    const input = entry.inputs?.[id]
    return (
      typeof input === "object" &&
      input !== null &&
      "bytesInOutput" in input &&
      typeof input.bytesInOutput === "number" &&
      input.bytesInOutput > 0
    )
  }
  const absolute = (id: string): string =>
    id.startsWith(`${NAMESPACE}:`) ? id : toPosix(resolve(id))
  const next = new Map<string, string[]>()
  const scoped = new Set<string>()
  let root: string | undefined
  for (const [id, module] of Object.entries(graph.modules)) {
    const from = absolute(id)
    if (id.startsWith(`${NAMESPACE}:`)) root = from
    if (emitted(id) && (nifraScoped.has(from) || requestScoped(from))) scoped.add(from)
    next.set(
      from,
      module.imports.flatMap((edge) => (edge.path === undefined ? [] : [absolute(edge.path)])),
    )
  }
  if (root === undefined) throw new Error(`[nifra/web] ppr: no entry module for "${route.id}"`)
  const chain = requestScopedChain(root, next, scoped)
  if (chain !== undefined) throw new ShellCheckError(route.id, chain.slice(1))
  const output = result.outputs.find((artifact) => artifact.kind === "entry-point")
  if (output === undefined)
    throw new Error(`[nifra/web] ppr: no bundle for the shell of "${route.id}"`)
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(await output.text())),
  )
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
