/**
 * A local `wrangler dev` for a Worker fixture: a free port, a disposable sandbox for Wrangler's logs,
 * registry, config and Durable Object storage, and a process tree that is always torn down.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dir, "..")
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler")
const READY_TIMEOUT_MS = 45_000

export interface WranglerDev {
  readonly origin: string
  readonly port: number
  /** Resolves once `readyPath` answers at all. */
  ready(readyPath: string): Promise<void>
  /** The last 20 kB of Wrangler's output. */
  logs(): string
  stop(): Promise<void>
}

async function assertPortFree(port: number): Promise<void> {
  let listener: ReturnType<typeof Bun.serve> | undefined
  try {
    listener = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch: () => new Response(null, { status: 204 }),
    })
  } catch (error) {
    throw new Error(
      `workerd port ${port} is not free: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    listener?.stop(true)
  }
}

async function choosePort(requested: string | undefined): Promise<number> {
  if (requested !== undefined) {
    const port = Number(requested)
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error(`invalid NIFRA_WORKERD_PORT: ${requested}`)
    await assertPortFree(port)
    return port
  }
  for (let candidate = 8787; candidate < 8887; candidate++) {
    let listener: ReturnType<typeof Bun.serve> | undefined
    try {
      listener = Bun.serve({
        hostname: "127.0.0.1",
        port: candidate,
        fetch: () => new Response(null, { status: 204 }),
      })
      return candidate
    } catch {
      // Try the next local candidate; the final assertion still catches a race before Wrangler starts.
    } finally {
      listener?.stop(true)
    }
  }
  throw new Error("could not find a free local port for workerd")
}

function waitForExit(child: ChildProcess): Promise<number> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode ?? 1)
  return new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit(code ?? (signal === null ? 1 : 143)))
  })
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(child.pid), "/T", "/F"])
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
}

/** Start `wrangler dev --local` on `config`; `NIFRA_WORKERD_PORT` pins the port. */
export async function startWranglerDev(config: string): Promise<WranglerDev> {
  if (!existsSync(WRANGLER)) {
    throw new Error("wrangler is not installed; run `bun install` before check:workerd")
  }
  const port = await choosePort(process.env.NIFRA_WORKERD_PORT)
  const origin = `http://127.0.0.1:${port}`
  await assertPortFree(port)
  const persist = mkdtempSync(join(tmpdir(), "nifra-workerd-"))
  // Keep Wrangler's logs, registry, and config inside the disposable test sandbox.
  const wranglerConfig = join(persist, "config")
  const wranglerCache = join(persist, "cache")
  const wranglerRegistry = join(persist, "registry")
  mkdirSync(wranglerConfig, { recursive: true })
  mkdirSync(wranglerCache, { recursive: true })
  mkdirSync(wranglerRegistry, { recursive: true })
  const child = spawn(
    WRANGLER,
    [
      "dev",
      "--config",
      config,
      "--local",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      persist,
      "--log-level",
      "error",
      "--show-interactive-dev-session=false",
    ],
    {
      cwd: ROOT,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: wranglerConfig,
        XDG_CACHE_HOME: wranglerCache,
        WRANGLER_REGISTRY_PATH: wranglerRegistry,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let logs = ""
  const capture = (chunk: Buffer): void => {
    logs = `${logs}${chunk.toString()}`.slice(-20_000)
  }
  child.stdout?.on("data", capture)
  child.stderr?.on("data", capture)
  return {
    origin,
    port,
    logs: () => logs,
    async ready(readyPath) {
      const deadline = Date.now() + READY_TIMEOUT_MS
      while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`wrangler exited before readiness:\n${logs}`)
        try {
          await fetch(`${origin}${readyPath}`, { signal: AbortSignal.timeout(750) })
          return
        } catch {
          await Bun.sleep(150)
        }
      }
      throw new Error(`timed out waiting for wrangler at ${origin}:\n${logs}`)
    },
    async stop() {
      killTree(child)
      await waitForExit(child).catch(() => undefined)
      rmSync(persist, { recursive: true, force: true })
    },
  }
}
