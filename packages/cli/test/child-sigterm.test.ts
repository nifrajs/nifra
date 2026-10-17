import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { watch } from "node:fs/promises"
import { join } from "node:path"
import { runHydrationAssurance } from "../src/assure-hydration.ts"
import { spawnChild, WarmWorker } from "../src/mcp-exec.ts"
import { escalatingStop } from "../src/mcp-io.ts"
import { askProjectChild } from "../src/mcp-isolate.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

const root = createFixtureRoot("child-sigterm-")
afterAll(() => removeFixtureRoot(root))

// Fixture source that writes `value` to `file` under a temporary name, then renames it into place.
// `fileAppears` wakes on the create event, and a plain write's content can land after it.
const publish = (dir: string, file: string, value: string): string[] => [
  `writeFileSync(${JSON.stringify(join(dir, `${file}.partial`))}, ${value})`,
  `renameSync(${JSON.stringify(join(dir, `${file}.partial`))}, ${JSON.stringify(join(dir, file))})`,
]

/** Resolves once `file` exists in `dir`: the project has installed its SIGTERM handler. */
async function fileAppears(dir: string, file: string): Promise<void> {
  const watcher = new AbortController()
  try {
    const events = watch(dir, { signal: watcher.signal })
    if (existsSync(join(dir, file))) return
    for await (const _event of events) if (existsSync(join(dir, file))) return
  } finally {
    watcher.abort()
  }
}

// A graceful-shutdown hook that never finishes, in front of a request that never answers.
function ignoringApp(): string {
  const dir = createFixtureProject(root, "app-")
  writeAppFile(dir, "package.json", JSON.stringify({ name: "ignores-sigterm", type: "module" }))
  writeAppFile(
    dir,
    "backend/app.ts",
    [
      'import { renameSync, writeFileSync } from "node:fs"',
      "process.on('SIGTERM', () => {})",
      ...publish(dir, "ready", "String(process.pid)"),
      "export const backend = { fetch: () => new Promise(() => {}) }",
      "",
    ].join("\n"),
  )
  return dir
}

test("escalatingStop sends SIGKILL after the grace period", async () => {
  const sent: string[] = []
  const killed = Promise.withResolvers<void>()
  const stopper = escalatingStop((name) => {
    sent.push(name)
    if (name === "SIGKILL") killed.resolve()
  }, 0)
  stopper.stop()
  await killed.promise
  expect(sent).toEqual(["SIGTERM", "SIGKILL"])
  stopper.dispose()
  stopper.stop()
  expect(sent).toEqual(["SIGTERM", "SIGKILL"])
})

test("a cancelled nifra_run ends even when the app ignores SIGTERM", async () => {
  const dir = ignoringApp()
  const controller = new AbortController()
  const ready = fileAppears(dir, "ready")
  const run = spawnChild("mcp-run", dir, { requests: [{ path: "/" }] }, "run", controller.signal)
  await ready
  controller.abort("client cancelled")
  expect(await run).toBe("run cancelled: client cancelled.")
}, 60_000)

test("stopping a warm worker ends it even when the app ignores SIGTERM", async () => {
  const dir = ignoringApp()
  const ready = fileAppears(dir, "ready")
  const worker = new WarmWorker("mcp-run", dir, "fingerprint", "run")
  const pending = worker.request({ requests: [{ path: "/" }] })
  await ready
  worker.stop()
  await expect(pending).rejects.toThrow(/warm run worker exited/)
}, 60_000)

test.skipIf(process.platform === "win32")(
  "stopping a warm worker also ends the process its app started",
  async () => {
    const dir = createFixtureProject(root, "grandchild-")
    writeAppFile(dir, "package.json", JSON.stringify({ name: "grandchild", type: "module" }))
    writeAppFile(
      dir,
      "backend/app.ts",
      [
        'import { renameSync, writeFileSync } from "node:fs"',
        "const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'])",
        ...publish(dir, "ready", "String(child.pid)"),
        "export const backend = { fetch: () => new Promise(() => {}) }",
        "",
      ].join("\n"),
    )
    const ready = fileAppears(dir, "ready")
    const worker = new WarmWorker("mcp-run", dir, "fingerprint", "run")
    const pending = worker.request({ requests: [{ path: "/" }] })
    await ready
    const pid = Number(readFileSync(join(dir, "ready"), "utf8"))
    worker.stop()
    await expect(pending).rejects.toThrow(/warm run worker exited/)
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    // The test's own timeout bounds this wait: before the fix the child outlived the worker for good.
    while (alive()) await Bun.sleep(10)
  },
  60_000,
)

/** Spawns a helper the way `Bun.spawn` does by default: it inherits, and holds open, its parent's stderr. */
const helperSource = (dir: string): string[] => [
  'import { writeFileSync } from "node:fs"',
  "const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'])",
  `writeFileSync(${JSON.stringify(join(dir, "helper"))}, String(child.pid))`,
]

/** Waits for the helper to be gone, and how long the call took to return. */
async function helperEnds(dir: string, call: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await call()
  const took = performance.now() - started
  const pid = Number(readFileSync(join(dir, "helper"), "utf8"))
  const alive = (): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  while (alive()) await Bun.sleep(10)
  return took
}

test.skipIf(process.platform === "win32")(
  "a cold run returns once its child exits, and ends the process its app started",
  async () => {
    const dir = createFixtureProject(root, "cold-grandchild-")
    writeAppFile(dir, "package.json", JSON.stringify({ name: "cold-grandchild", type: "module" }))
    writeAppFile(
      dir,
      "backend/app.ts",
      [
        ...helperSource(dir),
        'export const backend = { fetch: () => new Response("cold") }',
        "",
      ].join("\n"),
    )
    let out = ""
    const took = await helperEnds(dir, async () => {
      out = await spawnChild("mcp-run", dir, { requests: [{ path: "/" }] }, "run")
    })
    expect(out).toContain("cold")
    // Bounded by the kill grace period, not by the 30 s timeout the open stderr pipe used to hold.
    expect(took).toBeLessThan(10_000)
  },
  60_000,
)

test.skipIf(process.platform === "win32")(
  "a project child returns once it exits, and ends the process the project config started",
  async () => {
    const dir = createFixtureProject(root, "project-grandchild-")
    writeAppFile(
      dir,
      "package.json",
      JSON.stringify({ name: "project-grandchild", type: "module" }),
    )
    writeAppFile(
      dir,
      "nifra.config.ts",
      [...helperSource(dir), 'export const apps = { web: "./web" }', ""].join("\n"),
    )
    const took = await helperEnds(dir, async () => {
      expect(await askProjectChild(dir, { op: "monorepo" }, { timeoutMs: 20_000 })).toEqual({
        ok: true,
        apps: { web: "./web" },
      })
    })
    expect(took).toBeLessThan(10_000)
  },
  60_000,
)

for (const [how, signal, toGroup] of [
  ["takes SIGTERM", "SIGTERM", false],
  ["takes Ctrl+C", "SIGINT", true],
] as const) {
  test.skipIf(process.platform === "win32")(
    `a server that ${how} ends a warm worker that catches SIGTERM before it exits`,
    async () => {
      const dir = ignoringApp()
      const host = Bun.spawn(
        [
          process.execPath,
          "-e",
          [
            `const { WarmWorker } = await import(${JSON.stringify(join(import.meta.dir, "../src/mcp-exec.ts"))})`,
            `const worker = new WarmWorker("mcp-run", ${JSON.stringify(dir)}, "fingerprint", "run")`,
            "void worker.request({ requests: [{ path: '/' }] }).catch(() => {})",
            "setInterval(() => {}, 1000)",
          ].join("\n"),
        ],
        // Its own group, so a Ctrl+C can be sent to the group a terminal would send it to.
        { stdout: "ignore", stderr: "ignore", detached: true },
      )
      await fileAppears(dir, "ready")
      const worker = Number(readFileSync(join(dir, "ready"), "utf8"))
      process.kill(toGroup ? -host.pid : host.pid, signal)
      await host.exited
      expect(host.signalCode).toBe(signal)
      const alive = (): boolean => {
        try {
          process.kill(worker, 0)
          return true
        } catch {
          return false
        }
      }
      // The server waits out the kill grace before it takes the signal: the worker is gone by then.
      expect(alive()).toBe(false)
    },
    30_000,
  )
}

test("a cancelled hydration run ends even when the project ignores SIGTERM", async () => {
  const dir = createFixtureProject(root, "hydration-")
  writeAppFile(dir, "package.json", JSON.stringify({ name: "hydration-sigterm", type: "module" }))
  writeAppFile(
    dir,
    "nifra.config.ts",
    [
      'import { writeFileSync } from "node:fs"',
      "process.on('SIGTERM', () => {})",
      `writeFileSync(${JSON.stringify(join(dir, "ready"))}, "")`,
      "await new Promise(() => {})",
      "",
    ].join("\n"),
  )
  writeAppFile(
    dir,
    "backend/app.ts",
    'import { server } from "@nifrajs/core"\nexport const backend = server()\n',
  )
  writeAppFile(dir, "routes/index.tsx", "export default () => null\n")
  const controller = new AbortController()
  const ready = fileAppears(dir, "ready")
  const run = runHydrationAssurance(dir, {}, { signal: controller.signal })
  await ready
  controller.abort()
  const result = await run
  expect(result.diagnostics[0]?.message).toBe("hydration runner failed: cancelled")
}, 60_000)
