/**
 * `nifra shell tauri` - add a Tauri 2 shell to an existing app: the transport module the pages reach
 * their server through, and the `src-tauri/` project that wraps the static build.
 *
 * Like `init-agents` it writes files only, never overwrites one without `--force`, and touches neither
 * `package.json` nor `nifra.config.ts`: the shell build passes `--transport` itself, so the web build of
 * the same app keeps its own fetch.
 */
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { type InitAgentsFileResult, writeOwned } from "./init-agents.ts"
import { resolveShellSpec, SHELL_DIST, shellFiles } from "./shell-files.ts"

export interface ShellInitOptions {
  /** The server the pages talk to. */
  readonly origin?: string | undefined
  /** The app's display name. Default: `package.json`'s `name`. */
  readonly name?: string | undefined
  /** The bundle identifier. Default `com.example.<name>`. */
  readonly id?: string | undefined
  readonly force?: boolean
}

export interface ShellInitResult {
  readonly files: readonly InitAgentsFileResult[]
  readonly origin: string
  readonly id: string
  readonly name: string
}

async function packageName(cwd: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"))
    const name = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "name") : null
    return typeof name === "string" && name !== "" ? name : undefined
  } catch {
    return undefined
  }
}

export async function runShellInit(
  cwd: string,
  options: ShellInitOptions = {},
): Promise<ShellInitResult> {
  const pkg = await packageName(cwd)
  const spec = resolveShellSpec({ ...options, packageName: pkg })
  const force = options.force === true
  const files: InitAgentsFileResult[] = []
  for (const [path, content] of shellFiles(spec)) {
    files.push(await writeOwned(cwd, path, content, force))
  }
  return { files, origin: spec.origin, id: spec.id, name: spec.name }
}

/** What the developer does after the files are written, as the CLI prints it and the JSON carries it. */
export function shellNextSteps(): readonly string[] {
  return [
    "bun add -d @tauri-apps/cli",
    "bunx tauri icon path/to/icon.png",
    "list tauri://localhost and http://tauri.localhost on the server: CORS, route allowedOrigins, serverFunctions origins, live trustedOrigins (docs/native-shells)",
    "export const prerender = true in a route's .backend.ts, for each page a shell opens on",
    `bunx tauri dev, or bunx tauri build (the page build lands in ${SHELL_DIST}/)`,
  ]
}

export type MobilePlatform = "android" | "ios"

export interface MobileInitResult {
  readonly platform: MobilePlatform
  readonly ok: boolean
  /** Why it did not run or what it said when it failed; empty on success. */
  readonly note: string
}

const MOBILE_TIMEOUT_MS = 300_000

/**
 * `tauri <platform> init` for each platform, with the project's own Tauri CLI. It generates the native
 * project under `src-tauri/gen/`, which needs the platform's toolchain (Android SDK and NDK, Xcode), so a
 * failure is reported per platform rather than thrown and the files already written stay.
 */
export async function initMobile(
  cwd: string,
  platforms: readonly MobilePlatform[],
  host: NodeJS.Platform = process.platform,
): Promise<MobileInitResult[]> {
  const bin = join(
    cwd,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tauri.cmd" : "tauri",
  )
  const results: MobileInitResult[] = []
  for (const platform of platforms) {
    if (platform === "ios" && host !== "darwin") {
      results.push({ platform, ok: false, note: "an iOS project needs macOS and Xcode" })
      continue
    }
    if (!existsSync(bin)) {
      results.push({
        platform,
        ok: false,
        note:
          "the Tauri CLI is not installed: run `bun add -d @tauri-apps/cli`, then `bunx tauri " +
          `${platform} init\``,
      })
      continue
    }
    const child = Bun.spawn([bin, platform, "init", "--ci"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    })
    const timer = setTimeout(() => child.kill(), MOBILE_TIMEOUT_MS)
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    clearTimeout(timer)
    const tail = `${out}\n${err}`.trim().split("\n").slice(-4).join(" | ")
    results.push({ platform, ok: code === 0, note: code === 0 ? "" : tail || `exited ${code}` })
  }
  return results
}
