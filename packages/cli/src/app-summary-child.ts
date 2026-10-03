/**
 * The subprocess `nifra mcp` evaluates `nifra.config.ts` in. The parent (`app-summary.ts`) spawns a
 * fresh one per load: it imports and validates the config the way `loadApp` does, prints the fields
 * that survive a process boundary and exits, so nothing the config runs at import time happens in
 * the long-lived server.
 *
 * Protocol: one JSON request on stdin; the answer on stdout as one line prefixed with the request's
 * token, so anything the config prints cannot be read as an answer.
 */

import { type AppSummary, detectMonorepo, loadAppConfig } from "./load.ts"
import { CHILD_INPUT_MAX_BYTES, readBoundedStream } from "./mcp-io.ts"

/** `app`: the config's part of an {@link AppSummary}. `monorepo`: the root config's `apps`. */
export interface AppSummaryRequest {
  readonly kind: "app" | "monorepo"
}

/** What the config contributes to an {@link AppSummary}. */
export type AppConfigFacts = Pick<AppSummary, "configPath" | "framework" | "resolvedPlugins">

export type AppSummaryAnswer =
  | { readonly ok: true; readonly config: AppConfigFacts }
  | { readonly ok: true; readonly apps: Readonly<Record<string, string>> | null }
  | { readonly ok: false; readonly message: string }

const describePlugins = (plugins: readonly unknown[]): Array<{ readonly name?: string }> =>
  plugins.map((plugin) =>
    typeof plugin === "object" &&
    plugin !== null &&
    "name" in plugin &&
    typeof plugin.name === "string"
      ? { name: plugin.name }
      : {},
  )

/** The framework fields an {@link AppSummary} keeps, from the loaded config or its answer. */
export function frameworkFacts(source: {
  readonly clientModule: string
  readonly apiPrefix?: unknown
  readonly apiStrip?: unknown
}): AppSummary["framework"] {
  const facts: { clientModule: string; apiPrefix?: string; apiStrip?: boolean } = {
    clientModule: source.clientModule,
  }
  if (typeof source.apiPrefix === "string") facts.apiPrefix = source.apiPrefix
  if (typeof source.apiStrip === "boolean") facts.apiStrip = source.apiStrip
  return facts
}

/** Answer `request` for `cwd`. A config that fails to load answers `ok: false` with `loadApp`'s message. */
export async function answerAppSummary(
  cwd: string,
  request: AppSummaryRequest,
): Promise<AppSummaryAnswer> {
  try {
    if (request.kind === "monorepo") {
      return { ok: true, apps: (await detectMonorepo(cwd))?.apps ?? null }
    }
    const { configPath, framework, resolvedPlugins } = await loadAppConfig(cwd)
    return {
      ok: true,
      config: {
        configPath,
        framework: frameworkFacts(framework),
        resolvedPlugins: {
          vitePlugins: describePlugins(resolvedPlugins.vitePlugins),
          clientPlugins: describePlugins(resolvedPlugins.clientPlugins),
          serverPlugins: describePlugins(resolvedPlugins.serverPlugins),
        },
      },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function parseRequest(text: string): (AppSummaryRequest & { readonly token: string }) | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null || !("token" in value) || !("kind" in value))
    return undefined
  const { token, kind } = value
  if (typeof token !== "string" || !/^[0-9a-f-]{16,64}$/.test(token)) return undefined
  if (kind !== "app" && kind !== "monorepo") return undefined
  return { token, kind }
}

/**
 * Serve one request: read it from `input`, answer it and write the answer through `write`, prefixed
 * with the request's token. Returns false (writing nothing) for a malformed request.
 */
export async function serveAppSummaryChild(
  cwd: string,
  input: ReadableStream<Uint8Array>,
  write: (line: string) => Promise<void>,
): Promise<boolean> {
  const text = await readBoundedStream(input, CHILD_INPUT_MAX_BYTES)
  const request = text.truncated ? undefined : parseRequest(text.text)
  if (request === undefined) return false
  await write(`${request.token} ${JSON.stringify(await answerAppSummary(cwd, request))}\n`)
  return true
}

if (import.meta.main) {
  // Bound before the config loads, so nothing it patches can reach the protocol channel.
  const stdout = process.stdout.write.bind(process.stdout)
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(`${args.map((arg) => String(arg)).join(" ")}\n`)
  }
  console.log = toStderr
  console.info = toStderr
  console.debug = toStderr
  const served = await serveAppSummaryChild(
    process.argv[2] ?? process.cwd(),
    Bun.stdin.stream(),
    (line) => new Promise((done) => stdout(line, () => done())),
  )
  if (!served) process.stderr.write("nifra mcp: invalid app summary request\n")
  // The config may leave a handle open (a pool, an interval); the answer is written, so stop here.
  process.exit(served ? 0 : 2)
}
