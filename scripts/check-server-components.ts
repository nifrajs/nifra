import { type ChildProcess, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const fixture = "packages/web/test/fixtures/server-components"
const adapters = ["react", "vue", "svelte", "solid", "preact"] as const
const selected = process.argv.find((item) => item.startsWith("--target="))?.slice(9)
const targets = ["dev", "node", "bun", "deno", "cloudflare", "vercel"].filter(
  (item) => selected === undefined || item === selected,
)
const contractsOnly = selected === "contracts"
if (targets.length === 0 && !contractsOnly) throw new Error("Unknown server-components target")
const scratch = await mkdtemp(resolve(tmpdir(), "nifra-components-certification-"))
const results: unknown[] = []
const children = new Set<ChildProcess>()
function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The child-process cleanup handles only the Node error-code shape from its own process group.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}
const environment = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  XDG_CONFIG_HOME: resolve(scratch, "config"),
  XDG_CACHE_HOME: resolve(scratch, "cache"),
  WRANGLER_REGISTRY_PATH: resolve(scratch, "registry"),
}
for (const directory of ["config", "cache", "registry"]) await mkdir(resolve(scratch, directory))

async function run(args: readonly string[], env: Record<string, string> = {}): Promise<string> {
  const child = spawn(args[0]!, args.slice(1), {
    cwd: root,
    env: { ...environment, ...env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.add(child)
  let output = ""
  child.stdout?.on("data", (bytes) => {
    output = (output + bytes).slice(-200000)
  })
  child.stderr?.on("data", (bytes) => {
    output = (output + bytes).slice(-200000)
  })
  const code = await new Promise<number | null>((accept, reject) => {
    child.on("error", reject)
    child.on("exit", accept)
  })
  children.delete(child)
  if (code !== 0) throw new Error(`${args.join(" ")} failed (${code}):\n${output.slice(-12000)}`)
  return output
}
async function sourceDiffDigest(): Promise<string> {
  const hash = createHash("sha256")
  const child = spawn("git", ["diff", "--binary", "HEAD"], {
    cwd: root,
    env: environment,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.add(child)
  child.stdout?.on("data", (bytes) => hash.update(bytes))
  let error = ""
  child.stderr?.on("data", (bytes) => {
    error = (error + bytes).slice(-2000)
  })
  const code = await new Promise<number | null>((accept, reject) => {
    child.on("error", reject)
    child.on("close", accept)
  })
  children.delete(child)
  if (code !== 0) throw new Error(`Cannot fingerprint the complete candidate diff: ${error}`)
  return hash.digest("hex")
}
async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Missing local port")
  await new Promise<void>((accept) => server.close(() => accept()))
  return address.port
}
async function serve(
  args: readonly string[],
  adapter: string,
  target: string,
  browsers: boolean,
): Promise<void> {
  const port = await availablePort()
  const command = args.map((arg) => arg.replaceAll("{port}", String(port)))
  const child = spawn(command[0]!, command.slice(1), {
    cwd: root,
    env: { ...environment, PORT: String(port), NIFRA_COMPONENT_ADAPTER: adapter },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.add(child)
  let logs = ""
  child.stdout?.on("data", (bytes) => {
    logs = (logs + bytes).slice(-12000)
  })
  child.stderr?.on("data", (bytes) => {
    logs = (logs + bytes).slice(-12000)
  })
  let startupError: Error | undefined
  child.on("error", (error) => {
    startupError = error
  })
  const url = `http://127.0.0.1:${port}/`
  const env = {
    NIFRA_COMPONENT_ADAPTER: adapter,
    NIFRA_COMPONENT_TARGET: target,
    NIFRA_COMPONENT_URL: url,
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (startupError !== undefined || child.exitCode !== null)
        throw startupError ?? new Error(`Server exited: ${logs}`)
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
        if (response.ok) {
          await response.arrayBuffer()
          ready = true
          break
        }
      } catch {
        /* Only the bounded startup probe retries a listener that has not opened yet. */
      }
      await new Promise((accept) => setTimeout(accept, 100))
    }
    if (!ready) throw new Error(`Server did not become ready: ${logs}`)
    const output = await run(["node", `${fixture}/check-http.mjs`], env)
    const http = output.split("\n").find((line) => line.startsWith('{"adapter"'))
    if (http === undefined) throw new Error("Missing runtime conformance evidence")
    results.push({ ...JSON.parse(http), target })
    console.log(`components: ${adapter}/${target} HTTP passed`)
    if (browsers) {
      const browserOutput = await run(["node", `${fixture}/check-browser.mjs`], env)
      const records = browserOutput
        .split("\n")
        .filter((line) => line.startsWith('{"engine"'))
        .map((line) => JSON.parse(line))
      if (records.length !== 3 || records.some((record) => record.status !== "passed"))
        throw new Error("Missing browser conformance evidence")
      results.push(...records.map((record) => ({ ...record, target })))
      const csp = await run(["node", `${fixture}/check-browser.mjs`], {
        ...env,
        NIFRA_COMPONENT_URL: url + "?csp=yes",
      })
      if (csp.split("\n").filter((line) => line.startsWith('{"engine"')).length !== 3)
        throw new Error("Missing strict CSP evidence")
      const trusted = await run(["node", `${fixture}/check-browser.mjs`], {
        ...env,
        NIFRA_COMPONENT_BROWSER: "chromium",
        NIFRA_COMPONENT_URL: url + "?csp=yes&tt=yes",
      })
      if (!trusted.includes('"status":"passed"')) throw new Error("Missing Trusted Types evidence")
      results.push({
        adapter,
        target,
        suite: "strict-CSP-three-engines-and-Trusted-Types",
        status: "passed",
      })
      console.log(`components: ${adapter}/${target} browsers, CSP and Trusted Types passed`)
      if (target === "node-current") {
        const memory = await run(["node", `${fixture}/check-memory.mjs`], env)
        const memoryRecord = memory.split("\n").find((line) => line.startsWith('{"adapter"'))
        if (memoryRecord === undefined) throw new Error("Missing 1000-cycle memory evidence")
        results.push({ ...JSON.parse(memoryRecord), target })
        const performance = await run(["node", `${fixture}/check-browser-performance.mjs`], env)
        const performanceRecords = performance
          .split("\n")
          .filter((line) => line.startsWith('{"adapter"'))
          .map((line) => JSON.parse(line))
        if (performanceRecords.length !== 3)
          throw new Error("Missing three-engine commit performance evidence")
        results.push(...performanceRecords.map((record) => ({ ...record, target })))
        console.log(
          `components: ${adapter} 1000-cycle memory and three-engine prepare/commit performance passed`,
        )
      }
    }
  } catch (error) {
    throw new Error(`components: ${adapter}/${target} failed\n${logs}`, { cause: error })
  } finally {
    stop(child)
    await Promise.race([
      new Promise((accept) => child.once("exit", accept)),
      new Promise((accept) => setTimeout(accept, 2000)),
    ])
    if (child.exitCode === null) stop(child, "SIGKILL")
    children.delete(child)
  }
}

try {
  const contractFiles = (await readdir(resolve(root, "packages/web/test")))
    .filter(
      (name) =>
        /^server-components(?:-|\.)/.test(name) &&
        name.endsWith(".test.ts") &&
        (!contractsOnly ||
          !["server-components-dev.test.ts", "server-components-build.test.ts"].includes(name)),
    )
    .map((name) => "packages/web/test/" + name)
  const contracts = await run([
    process.execPath,
    "test",
    ...contractFiles,
    "packages/web-react/test/server-components-flight.test.ts",
    "packages/web-preact/test/server-components.test.ts",
    "packages/core/test/capability-context.test.ts",
    "packages/cli/test/component-check.test.ts",
  ])
  console.log(contracts.split("\n").slice(-6).join("\n"))
  if (!contractsOnly) await run([process.execPath, "scripts/check-server-components-types.ts"])
  // `npm exec` downloads a pinned runtime on first use. Fetch each one here, so the bounded readiness
  // probe in serve() times server startup rather than a cold download on a fresh runner.
  for (const [bin, runtime, users] of [
    ["node", "node@22.23.3", ["node", "vercel"]],
    ["bun", "bun@1.3.14", ["bun"]],
    ["deno", "deno@2.0.0", ["deno"]],
  ] as const) {
    if (!users.some((target) => targets.includes(target))) continue
    await run(["npm", "exec", "--yes", `--package=${runtime}`, "--", bin, "--version"])
  }
  for (const adapter of adapters)
    for (const target of targets) {
      if (target === "dev") {
        await serve(["node", `${fixture}/dev-fixture.mjs`], adapter, "vite-development", true)
        continue
      }
      console.log(`components: build ${adapter}/${target}`)
      await run(["node", `${fixture}/build-fixture.mjs`], {
        NIFRA_COMPONENT_ADAPTER: adapter,
        NIFRA_COMPONENT_TARGET: target,
      })
      const out = `.nifra-components-fixtures/${adapter}/${target}`
      if (target === "node") {
        await serve(["node", `${out}/server.js`], adapter, "node-current", true)
        await serve(
          ["npm", "exec", "--yes", "--package=node@22.23.3", "--", "node", `${out}/server.js`],
          adapter,
          "node-22.23.3",
          true,
        )
      } else if (target === "bun") {
        await serve(["bun", `${out}/server.js`], adapter, "bun-current", true)
        await serve(
          ["npm", "exec", "--yes", "--package=bun@1.3.14", "--", "bun", `${out}/server.js`],
          adapter,
          "bun-1.3.14",
          true,
        )
      } else if (target === "deno") {
        await serve(
          ["deno", "run", "--allow-read", "--allow-net", "--allow-env", `${out}/server.js`],
          adapter,
          "deno-current",
          true,
        )
        await serve(
          [
            "npm",
            "exec",
            "--yes",
            "--package=deno@2.0.0",
            "--",
            "deno",
            "run",
            "--allow-read",
            "--allow-net",
            "--allow-env",
            `${out}/server.js`,
          ],
          adapter,
          "deno-2.0.0",
          true,
        )
      } else if (target === "vercel") {
        await serve(
          [
            "npm",
            "exec",
            "--yes",
            "--package=node@22.23.3",
            "--",
            "node",
            `${fixture}/serve-vercel.mjs`,
            out,
          ],
          adapter,
          "vercel-node22",
          true,
        )
      } else {
        const config = resolve(root, out, "wrangler.json")
        await writeFile(
          config,
          JSON.stringify({
            name: "nifra-component-fixture",
            main: "_worker.js",
            compatibility_date: "2026-09-18",
            compatibility_flags: ["nodejs_compat"],
            assets: { directory: "." },
          }),
        )
        const wrangler = resolve(root, "node_modules/.bin/wrangler")
        await serve(
          [
            wrangler,
            "dev",
            "--config",
            config,
            "--local",
            "--ip",
            "127.0.0.1",
            "--port",
            "{port}",
            "--persist-to",
            resolve(scratch, adapter + "-workers"),
            "--show-interactive-dev-session=false",
          ],
          adapter,
          "workers-workerd",
          true,
        )
        await serve(
          [
            wrangler,
            "pages",
            "dev",
            resolve(root, out),
            "--compatibility-date",
            "2026-09-18",
            "--compatibility-flags",
            "nodejs_compat",
            "--ip",
            "127.0.0.1",
            "--port",
            "{port}",
            "--persist-to",
            resolve(scratch, adapter + "-pages"),
          ],
          adapter,
          "pages-workerd",
          true,
        )
      }
    }
  const digest = createHash("sha256")
    .update(await readFile(resolve(root, "bun.lock")))
    .digest("hex")
  const evidence = {
    v: 1,
    status: "passed",
    lock: digest,
    sourceRevision: (await run(["git", "rev-parse", "HEAD"])).trim(),
    sourceDiffDigest: await sourceDiffDigest(),
    versions: contractsOnly
      ? { bun: Bun.version }
      : {
          bun: Bun.version,
          node: (await run(["node", "--version"])).trim(),
          deno: (await run(["deno", "--version"])).trim(),
        },
    results,
  }
  await writeFile(
    resolve(root, ".nifra-components-fixtures", `certification-${selected ?? "all"}.json`),
    JSON.stringify(evidence, null, 2) + "\n",
  )
  console.log(`components: certification passed (${results.length} evidence records)`)
} finally {
  for (const child of children) stop(child)
  await rm(scratch, { recursive: true, force: true })
}
