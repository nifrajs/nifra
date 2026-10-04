import { existsSync, statSync } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { defineReplayFile } from "@nifrajs/core/replay"
import { type AppLike, runApp } from "@nifrajs/runner"
import { createWebApp, type RenderAdapter } from "@nifrajs/web"
import { type BuildManifest, buildClient } from "@nifrajs/web/build"
import { discoverRoutes } from "@nifrajs/web/fs"
import type { BunPlugin } from "bun"
import { collectDoctorResult } from "./doctor.ts"
import { loadApp, resolvePlugins } from "./load.ts"
import { CHILD_OUTPUT_MAX_BYTES, joinHeadTail, readBoundedStream, readHeadTail } from "./mcp-io.ts"
import { frameworkWebAppOptions } from "./web-app-options.ts"

const HYDRATION_ASSURANCE = Symbol.for("nifra.hydration.assurance")
const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,vue,svelte,mdx}"
const IGNORED = /(^|\/)(node_modules|dist|build|coverage|\.git|\.nifra)\//

export interface HydrationResult {
  readonly diagnostics: readonly import("./diagnostics.ts").Diagnostic[]
  readonly skipReason?: string
  /** Relative replay files, one for every route that produced a failure. */
  readonly replays?: readonly string[]
}

export interface HydrationOptions {
  readonly routes?: readonly string[]
  readonly interact?: boolean
  readonly seed?: string
}

function seedNumber(seed: string): number {
  let value = 0x811c9dc5
  for (const character of seed) {
    value ^= character.charCodeAt(0)
    value = Math.imul(value, 0x01000193)
  }
  return value >>> 0
}

/** Freeze the small nondeterministic surface that can make SSR and CSR disagree by luck. */
function installDeterministicRuntime(seed: string): void {
  let randomState = seedNumber(seed) || 1
  const epoch = 1_700_000_000_000 + (seedNumber(`${seed}:clock`) % 86_400_000)
  Date.now = () => epoch
  Math.random = () => {
    randomState = Math.imul(randomState, 1_664_525) + 1_013_904_223
    return (randomState >>> 0) / 4_294_967_296
  }

  const realSetTimeout = globalThis.setTimeout.bind(globalThis)
  const realSetInterval = globalThis.setInterval.bind(globalThis)
  globalThis.setTimeout = ((
    handler: Parameters<typeof setTimeout>[0],
    timeout?: number,
    ...args: unknown[]
  ) =>
    realSetTimeout(
      handler,
      Number.isFinite(timeout) ? Math.max(0, timeout ?? 0) : 0,
      ...args,
    )) as typeof setTimeout
  globalThis.setInterval = ((
    handler: Parameters<typeof setInterval>[0],
    timeout?: number,
    ...args: unknown[]
  ) =>
    realSetInterval(
      handler,
      Number.isFinite(timeout) ? Math.max(0, timeout ?? 0) : 0,
      ...args,
    )) as typeof setInterval
}

interface BuiltHydrationApp {
  readonly app: AppLike
  readonly client: BuildManifest
  readonly outputDir: string
  readonly framework: string
}

function diagnostic(
  code: "NF-H001" | "NF-H002" | "NF-H003" | "NF-H004",
  message: string,
  file?: string,
  evidence?: readonly string[],
  severity: "error" | "info" = "error",
): import("./diagnostics.ts").Diagnostic {
  return Object.freeze({
    code,
    severity,
    message,
    ...(file === undefined ? {} : { file }),
    ...(evidence === undefined ? {} : { evidence }),
    verify: "nifra assure --hydration --strict --json",
  })
}

function frameworkName(clientModule: string): string {
  if (clientModule.includes("web-react")) return "react"
  if (clientModule.includes("web-vue")) return "vue"
  if (clientModule.includes("web-svelte")) return "svelte"
  if (clientModule.includes("web-solid")) return "solid"
  if (clientModule.includes("web-preact")) return "preact"
  return "custom"
}

function routePath(pattern: string): string {
  const path = pattern
    .replace(/\[\.\.\.([^\]]+)\]/g, "probe")
    .replace(/\[([^\]]+)\]/g, "probe")
    .replace(/:([A-Za-z0-9_]+)/g, "probe")
    .replace(/\*([A-Za-z0-9_]+)?/g, "probe")
  return path === "" ? "/" : path.startsWith("/") ? path : `/${path}`
}

async function digest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
  return [...hash].map((item) => item.toString(16).padStart(2, "0")).join("")
}

async function writeReplay(
  cwd: string,
  route: string,
  seed: string,
  inputs: unknown,
): Promise<string> {
  const inputsDigest = await digest(inputs)
  const replay = defineReplayFile({
    gate: "hydration",
    case: route,
    seed,
    inputsDigest,
    meta:
      inputs !== null &&
      typeof inputs === "object" &&
      typeof (inputs as { framework?: unknown }).framework === "string"
        ? { framework: (inputs as { framework: string }).framework }
        : {},
  })
  const relative = `.nifra/replays/hydration-${inputsDigest.slice(0, 16)}.json`
  const path = resolve(cwd, relative)
  await mkdir(join(cwd, ".nifra", "replays"), { recursive: true })
  await writeFile(path, `${JSON.stringify(replay, null, 2)}\n`, "utf8")
  return relative
}

async function loadOptionalDom(cwd: string): Promise<
  | {
      readonly Window: new (options?: { url?: string }) => unknown
    }
  | undefined
> {
  try {
    const entry = Bun.resolveSync("happy-dom", cwd)
    const loaded = (await import(pathToFileURL(entry).href)) as {
      readonly Window?: new (options?: { url?: string }) => unknown
    }
    return loaded.Window === undefined ? undefined : { Window: loaded.Window }
  } catch {
    return undefined
  }
}

async function buildHydrationApp(cwd: string): Promise<BuiltHydrationApp | { skipReason: string }> {
  const loaded = await loadApp(cwd, "dist")
  if (loaded.framework.clientModule.trim() === "")
    return { skipReason: "no client bundle configured" }

  const workDir = await mkdtemp(join(tmpdir(), "nifra-hydration-"))
  try {
    const clientOutput = join(workDir, "assets")
    const plugins = await resolvePlugins(loaded.framework.clientPlugins)
    const client = await buildClient({
      routesDir: loaded.routesDir,
      outDir: clientOutput,
      // The runner imports the entry from disk, where a `/assets/` chunk URL is a filesystem path.
      publicPath: `${pathToFileURL(clientOutput).href}/`,
      clientModule: loaded.framework.clientModule,
      ...(plugins.length === 0 ? {} : { plugins: plugins as BunPlugin[] }),
      ...(loaded.framework.conditions === undefined
        ? {}
        : { conditions: loaded.framework.conditions }),
      ...(loaded.framework.define === undefined ? {} : { define: loaded.framework.define }),
      publicDir: false,
      ...(loaded.framework.publicEnvPrefix === undefined
        ? {}
        : { publicEnvPrefix: loaded.framework.publicEnvPrefix }),
      ...(loaded.framework.secretExemptions === undefined
        ? {}
        : { secretExemptions: loaded.framework.secretExemptions }),
    })
    if (client.entry.trim() === "" || client.assets.length === 0) {
      await rm(workDir, { recursive: true, force: true })
      return { skipReason: "client build emitted no browser assets" }
    }
    const serverPlugins = await resolvePlugins(loaded.framework.serverPlugins)
    if (serverPlugins.length > 0) {
      const { plugin } = await import("bun")
      for (const item of serverPlugins) plugin(item as BunPlugin)
    }
    const webApp = createWebApp({
      adapter: loaded.framework.adapter as RenderAdapter,
      manifest: discoverRoutes(loaded.routesDir),
      clientEntry: client.entry,
      ...frameworkWebAppOptions(loaded.framework, loaded.backend),
    }) as unknown as AppLike
    return {
      app: webApp,
      client,
      outputDir: clientOutput,
      framework: frameworkName(loaded.framework.clientModule),
    }
  } catch (error) {
    await rm(workDir, { recursive: true, force: true })
    throw error
  }
}

function sourceBranch(content: string): boolean {
  return /typeof\s+window\s*!==?\s*["']undefined["']/.test(content)
}

async function sourceFiles(cwd: string): Promise<Array<{ file: string; content: string }>> {
  const files: Array<{ file: string; content: string }> = []
  for await (const rawFile of new Bun.Glob(SOURCE_GLOB).scan({
    cwd,
    onlyFiles: true,
    dot: false,
  })) {
    const file = rawFile.replaceAll("\\", "/")
    if (IGNORED.test(file)) continue
    files.push({ file, content: await readFile(join(cwd, file), "utf8") })
  }
  return files
}

/** How long a route may take to mark itself hydrated before the gate fails it. */
const HYDRATION_TIMEOUT_MS = 5_000
let entryCopies = 0

function outputPath(outputDir: string, entry: string): string {
  return join(outputDir, basename(entry))
}

async function runDomHydration(
  cwd: string,
  built: BuiltHydrationApp,
  html: string,
  path: string,
  interact: boolean,
): Promise<import("./diagnostics.ts").Diagnostic[]> {
  const domModule = await loadOptionalDom(cwd)
  if (domModule === undefined) return []
  const windowValue = new domModule.Window({ url: `http://nifra.test${path}` }) as Record<
    string,
    unknown
  >
  const documentValue = windowValue.document as Record<string, unknown>
  const globals = globalThis as unknown as Record<string, unknown>
  const globalRecord = globalThis as unknown as Record<PropertyKey, unknown>
  const runtimeKey = Symbol.for("nifra.hydration.runtime")
  const previous = new Map<string, unknown>()
  const names = [
    "window",
    "document",
    "navigator",
    "location",
    "history",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "requestAnimationFrame",
    "cancelAnimationFrame",
  ]
  for (const name of names) {
    previous.set(name, globals[name])
    if (name === "window") globals[name] = windowValue
    else if (name === "document") globals[name] = documentValue
    else if (name === "requestAnimationFrame")
      globals[name] = (callback: () => void) => setTimeout(callback, 0)
    else if (name === "cancelAnimationFrame") globals[name] = (id: number) => clearTimeout(id)
    else globals[name] = windowValue[name]
  }
  // Framework runtimes reach for more DOM globals (Vue's `SVGElement`, `Text`, `Comment`). Lend every
  // one the runtime does not define itself, so its own `fetch`, `URL` and timers stay in place.
  for (const name of Object.getOwnPropertyNames(windowValue)) {
    if (name in globals) continue
    let value: unknown
    try {
      value = windowValue[name]
    } catch {
      continue
    }
    previous.set(name, undefined)
    globals[name] =
      typeof value === "function" && !/^[A-Z]/.test(name) ? value.bind(windowValue) : value
  }
  const windowRecord = windowValue as Record<string, unknown>
  windowRecord.console = console
  const errors: string[] = []
  const recover = (error: unknown, info?: unknown): void => {
    errors.push(`${String(error)}${info === undefined ? "" : ` ${String(info)}`}`)
  }
  const assuranceRecord = globalRecord[HYDRATION_ASSURANCE]
  const runtimeRecord = globalRecord[runtimeKey]
  globalRecord[HYDRATION_ASSURANCE] = { onRecoverableError: recover }
  delete globalRecord[runtimeKey]
  try {
    const write = documentValue.write as ((value: string) => void) | undefined
    if (write === undefined) throw new Error("DOM runner does not implement document.write")
    write.call(documentValue, html)
    const beforeRoot = (
      documentValue.querySelector as (selector: string) => { innerHTML?: unknown } | null
    )("#root")
    const before = String(beforeRoot?.innerHTML ?? "")
    // Bun evaluates a file module once per path, query or not, so each route imports its own copy.
    // A fresh directory each time: Bun's resolver caches a directory's listing once it has read it.
    const copyDir = join(built.outputDir, `route-${++entryCopies}`)
    await mkdir(copyDir)
    const entry = join(copyDir, basename(built.client.entry))
    await copyFile(outputPath(built.outputDir, built.client.entry), entry)
    const originalError = console.error
    const originalWarn = console.warn
    console.error = (...args) => {
      const message = args.map(String).join(" ")
      if (/hydr|mismatch|server|client|expected|recover/i.test(message)) errors.push(message)
      originalError(...args)
    }
    console.warn = (...args) => {
      const message = args.map(String).join(" ")
      if (/hydr|mismatch|server|client|expected|recover/i.test(message)) errors.push(message)
      originalWarn(...args)
    }
    // A render that throws on the client surfaces from a scheduler task, not from the import.
    const uncaught = (error: unknown): void => {
      errors.push(`uncaught: ${error instanceof Error ? error.message : String(error)}`)
    }
    process.on("uncaughtException", uncaught)
    process.on("unhandledRejection", uncaught)
    let hydrated = false
    try {
      await import(pathToFileURL(entry).href)
      // The entry marks <html> once the adapter has mounted the route. `Date.now` is pinned by the
      // deterministic runtime, so the bound is measured with `performance.now`.
      const marked = documentValue.documentElement as { hasAttribute(name: string): boolean }
      const started = performance.now()
      for (;;) {
        hydrated = marked.hasAttribute("data-nifra-hydrated")
        if (hydrated || errors.length > 0 || performance.now() - started >= HYDRATION_TIMEOUT_MS)
          break
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 1))
      }
      // The framework commits the hydration in its own scheduler tasks after the marker's frame.
      for (let tick = 0; tick < 10; tick++) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 0))
      }
    } finally {
      process.off("uncaughtException", uncaught)
      process.off("unhandledRejection", uncaught)
      console.error = originalError
      console.warn = originalWarn
    }
    const afterRoot = (
      documentValue.querySelector as (selector: string) => { innerHTML?: unknown } | null
    )("#root")
    const after = String(afterRoot?.innerHTML ?? "")
    const diagnostics: import("./diagnostics.ts").Diagnostic[] = []
    if (!hydrated && errors.length === 0) {
      diagnostics.push(
        diagnostic(
          "NF-H001",
          `client hydration did not complete within ${HYDRATION_TIMEOUT_MS / 1000}s`,
          undefined,
          [built.framework],
        ),
      )
    }
    if (errors.length > 0 || before !== after) {
      diagnostics.push(
        diagnostic("NF-H001", "client hydration reported a recoverable mismatch", undefined, [
          built.framework,
          ...errors.slice(0, 3),
        ]),
      )
    }
    const runtime = globalRecord[runtimeKey] as
      | { framework?: unknown; identities?: unknown[] }
      | undefined
    if (
      runtime !== undefined &&
      Array.isArray(runtime.identities) &&
      runtime.identities.length !== 1
    ) {
      diagnostics.push(
        diagnostic(
          "NF-H002",
          "hydration loaded more than one framework runtime identity",
          undefined,
          [built.framework, `identities=${runtime.identities.length}`],
        ),
      )
    }
    if (interact) {
      const probes = documentValue.querySelectorAll as
        | ((selector: string) => { length: number; [index: number]: { click?: () => void } })
        | undefined
      const elements = probes?.call(documentValue, "[data-nifra-hydration-probe]")
      if (elements !== undefined && elements.length > 0) {
        const first = elements[0]
        if (first?.click !== undefined) first.click()
        const hydrated = documentValue.documentElement as {
          hasAttribute?: (name: string) => boolean
        }
        if (hydrated.hasAttribute?.("data-nifra-hydrated") !== true)
          diagnostics.push(
            diagnostic("NF-H004", "hydration probe did not become interactive", undefined, [
              built.framework,
            ]),
          )
      }
    }
    return diagnostics
  } finally {
    if (assuranceRecord === undefined) delete globalRecord[HYDRATION_ASSURANCE]
    else globalRecord[HYDRATION_ASSURANCE] = assuranceRecord
    if (runtimeRecord === undefined) delete globalRecord[runtimeKey]
    else globalRecord[runtimeKey] = runtimeRecord
    for (const [name, value] of previous) {
      if (value === undefined) delete globals[name]
      else globals[name] = value
    }
  }
}

async function runHydrationProof(cwd: string, options: HydrationOptions): Promise<HydrationResult> {
  const files = await sourceFiles(cwd)
  const diagnostics: import("./diagnostics.ts").Diagnostic[] = []
  const replays: string[] = []
  const seed = options.seed ?? "nifra-hydration-1"
  installDeterministicRuntime(seed)
  const existingDist = join(cwd, "dist")
  const latestSource = Math.max(...files.map((file) => statSync(join(cwd, file.file)).mtimeMs), 0)
  if (existsSync(existingDist) && latestSource > statSync(existingDist).mtimeMs) {
    const replay = await writeReplay(cwd, "dist", seed, {
      latestSource,
      dist: statSync(existingDist).mtimeMs,
    })
    replays.push(replay)
    diagnostics.push(
      diagnostic(
        "NF-H003",
        "client build output is older than the route source; rebuild before hydrating",
        "dist",
        [replay],
      ),
    )
  }

  let built: BuiltHydrationApp | { skipReason: string }
  try {
    built = await buildHydrationApp(cwd)
  } catch (error) {
    const replay = await writeReplay(cwd, "build", seed, {
      message: error instanceof Error ? error.message : String(error),
    })
    replays.push(replay)
    return {
      diagnostics: [
        diagnostic(
          "NF-H001",
          `hydration client build failed: ${error instanceof Error ? error.message : String(error)}`,
          undefined,
          [replay],
        ),
      ],
      replays,
    }
  }
  if ("skipReason" in built)
    return {
      diagnostics,
      ...(diagnostics.length === 0 ? { skipReason: built.skipReason } : {}),
      replays,
    }

  const framework = built.framework
  const cleanup = async (): Promise<void> => {
    await rm(resolve(built.outputDir, ".."), { recursive: true, force: true })
  }
  const doctor = await collectDoctorResult(cwd)
  const duplicate = doctor.duplicateInstalls.filter((finding) => finding.package === framework)
  if (duplicate.length > 0) {
    const replay = await writeReplay(cwd, framework, seed, {
      framework,
      copies: duplicate.map((item) => item.copies.length),
    })
    replays.push(replay)
    diagnostics.push(
      diagnostic(
        "NF-H002",
        `multiple ${framework} runtime installations reached the client build`,
        undefined,
        [framework, replay],
      ),
    )
  }
  for (const file of files) {
    if (!sourceBranch(file.content)) continue
    const replay = await writeReplay(cwd, file.file, seed, { framework, source: file.file })
    replays.push(replay)
    // Advisory only: `typeof window` guards are the standard SSR-safe idiom and most of them never
    // touch render output. The DOM before/after comparison below is the authoritative mismatch proof.
    diagnostics.push(
      diagnostic(
        "NF-H001",
        "source branches on window state; confirm render output is identical before hydration",
        file.file,
        [framework, replay],
        "info",
      ),
    )
  }

  const manifest = discoverRoutes(join(cwd, "routes"))
  const requested = options.routes?.length
    ? [...options.routes]
    : manifest.routes.slice(0, 20).map((route) => routePath(route.pattern))
  const requests = requested.length === 0 ? [{ path: "/" }] : requested.map((path) => ({ path }))
  const results: unknown[] = []
  for (const request of requests) {
    installDeterministicRuntime(`${seed}:${request.path}`)
    const [result] = await runApp(built.app, [request])
    results.push(result)
  }
  const domModule = await loadOptionalDom(cwd)
  if (domModule === undefined) {
    await cleanup()
    return diagnostics.length === 0
      ? {
          diagnostics,
          skipReason: "no happy-dom dependency configured for DOM hydration execution",
        }
      : { diagnostics, replays }
  }
  try {
    for (let index = 0; index < results.length; index++) {
      const result = results[index] as { status?: number; body?: unknown }
      if (result.status !== 200 || typeof result.body !== "string") continue
      const route = requested[index] ?? "/"
      try {
        // SSR and CSR for one route start from the same deterministic clock, random stream, and timer
        // surface. A route that reads one of them therefore either matches exactly or reports NF-H001.
        installDeterministicRuntime(`${seed}:${route}`)
        const pageDiagnostics = await runDomHydration(
          cwd,
          built,
          result.body,
          route,
          options.interact === true,
        )
        if (pageDiagnostics.length > 0) {
          const replay = await writeReplay(cwd, route, seed, {
            framework,
            route,
            assets: built.client.assets,
          })
          replays.push(replay)
          diagnostics.push(
            ...pageDiagnostics.map((item) => ({
              ...item,
              evidence: [...(item.evidence ?? []), replay],
            })),
          )
        }
      } catch (error) {
        const replay = await writeReplay(cwd, route, seed, {
          framework,
          route,
          assets: built.client.assets,
        })
        replays.push(replay)
        diagnostics.push(
          diagnostic(
            "NF-H001",
            `hydration execution failed: ${error instanceof Error ? error.message : String(error)}`,
            undefined,
            [framework, replay],
          ),
        )
      }
    }
    return { diagnostics, ...(replays.length === 0 ? {} : { replays }) }
  } finally {
    await cleanup()
  }
}

/** How long one hydration run may take: it builds the client and renders every route. */
const HYDRATION_RUN_TIMEOUT_MS = 300_000

/** Bounds on a hydration run beyond its {@link HydrationOptions}. */
export interface HydrationRunControl {
  readonly signal?: AbortSignal
  /** Default 300000 (five minutes). */
  readonly timeoutMs?: number
}

/** Run hydration in a fresh process so the project's current client and framework modules are isolated. */
export async function runHydrationAssurance(
  cwd: string,
  options: HydrationOptions = {},
  control: HydrationRunControl = {},
): Promise<HydrationResult> {
  const failed = (reason: string): HydrationResult => ({
    diagnostics: [diagnostic("NF-H001", `hydration runner failed: ${reason}`)],
  })
  if (control.signal?.aborted) return failed("cancelled")
  const root = resolve(cwd)
  const entry = fileURLToPath(import.meta.url)
  // The answer line carries this token, so whatever project code prints cannot be read as the result.
  const token = crypto.randomUUID()
  const proc = Bun.spawn(
    [process.execPath, entry, root, "--nifra-hydration-child", JSON.stringify(options)],
    {
      cwd: root,
      // Explicit: without `env`, Bun passes the environment it started with, missing `--env-file` values.
      env: process.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  let stopped: string | undefined
  const stop = (reason: string): void => {
    stopped ??= reason
    proc.kill()
  }
  const onAbort = (): void => stop("cancelled")
  control.signal?.addEventListener("abort", onAbort, { once: true })
  const timeoutMs = control.timeoutMs ?? HYDRATION_RUN_TIMEOUT_MS
  const timer = setTimeout(() => stop(`timed out after ${timeoutMs} ms`), timeoutMs)
  try {
    try {
      proc.stdin.write(`${token}\n`)
      await proc.stdin.end()
    } catch {
      // The child exited before reading its token; its stderr says why.
    }
    const [stdout, stderr] = await Promise.all([
      readBoundedStream(proc.stdout, CHILD_OUTPUT_MAX_BYTES, () =>
        stop(`output exceeded ${CHILD_OUTPUT_MAX_BYTES} bytes`),
      ),
      readHeadTail(proc.stderr, 2048, 2048),
      proc.exited,
    ])
    if (stopped !== undefined) return failed(stopped)
    const prefix = `${token} `
    const answer = stdout.text.split("\n").find((line) => line.startsWith(prefix))
    if (answer !== undefined) {
      try {
        return JSON.parse(answer.slice(prefix.length)) as HydrationResult
      } catch {
        // A truncated answer line falls through to the stderr report.
      }
    }
    return failed(joinHeadTail(stderr).trim() || "no result")
  } finally {
    clearTimeout(timer)
    control.signal?.removeEventListener("abort", onAbort)
  }
}

if (import.meta.main && process.argv.includes("--nifra-hydration-child")) {
  // Bound before project code loads, so a `console.log` in a config or loader goes to stderr and
  // never reaches the answer channel.
  const stdout = process.stdout.write.bind(process.stdout)
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((arg) => String(arg)).join(" ")}\n`)
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  const token = (await readBoundedStream(Bun.stdin.stream(), 256)).text.trim()
  const cwd = process.argv[2] ?? process.cwd()
  const rawOptions = process.argv[4]
  let result: HydrationResult
  try {
    process.chdir(cwd)
    const options = rawOptions === undefined ? {} : (JSON.parse(rawOptions) as HydrationOptions)
    result = await runHydrationProof(cwd, options)
  } catch (error) {
    result = {
      diagnostics: [diagnostic("NF-H001", error instanceof Error ? error.message : String(error))],
    }
  }
  await new Promise<void>((done) => stdout(`${token} ${JSON.stringify(result)}\n`, () => done()))
  process.exit(0)
}
