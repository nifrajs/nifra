import assert from "node:assert/strict"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const scratch = await realpath(await mkdtemp(resolve(tmpdir(), "nifra-components-consumers-")))
const tarballs = resolve(scratch, "tarballs")
const consumer = resolve(scratch, "consumer")
const children = new Set<ChildProcess>()
function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (child.pid === undefined) return
  try {
    process.platform === "win32" ? child.kill(signal) : process.kill(-child.pid, signal)
  } catch (error) {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The isolated consumer runner reads its own package metadata and child-process errors; no HTTP input supplies these values.
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
  }
}
function run(args: readonly string[], cwd: string, env: Record<string, string> = {}): string {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(`${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
async function probe(args: readonly string[], cwd: string, adapter: string): Promise<void> {
  const listener = createServer()
  await new Promise<void>((accept) => listener.listen(0, "127.0.0.1", accept))
  const address = listener.address()
  if (address === null || typeof address === "string") throw new Error("Missing consumer port")
  await new Promise<void>((accept) => listener.close(() => accept()))
  const port = address.port
  const child = spawn(
    args[0]!,
    args.slice(1).map((arg) => arg.replaceAll("{port}", String(port))),
    {
      cwd,
      env: { ...process.env, PORT: String(port) },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  children.add(child)
  let logs = ""
  child.stdout?.on("data", (bytes) => {
    logs = (logs + bytes).slice(-16000)
  })
  child.stderr?.on("data", (bytes) => {
    logs = (logs + bytes).slice(-16000)
  })
  try {
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(logs)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          signal: AbortSignal.timeout(2000),
        })
        if (response.ok) {
          assert.match(await response.text(), /Public title/)
          ready = true
          break
        }
      } catch {
        /* Retry only the bounded startup listener probe. */
      }
      await new Promise((accept) => setTimeout(accept, 100))
    }
    assert.ok(ready, logs)
    run(
      ["node", resolve(root, "packages/web/test/fixtures/server-components/check-browser.mjs")],
      consumer,
      {
        NIFRA_COMPONENT_ADAPTER: adapter,
        NIFRA_COMPONENT_URL: `http://127.0.0.1:${port}/`,
        NIFRA_COMPONENT_BROWSER: "chromium",
      },
    )
  } finally {
    stop(child)
    await Promise.race([
      new Promise((accept) => child.once("exit", accept)),
      new Promise((accept) => setTimeout(accept, 2000)),
    ])
    if (child.exitCode === null && child.signalCode === null) stop(child, "SIGKILL")
    children.delete(child)
  }
}

try {
  await mkdir(tarballs)
  await mkdir(consumer)
  const packages = new Map<
    string,
    {
      path: string
      manifest: {
        name: string
        private?: boolean
        dependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
      }
    }
  >()
  for (const name of await readdir(resolve(root, "packages"))) {
    const path = resolve(root, "packages", name)
    try {
      const manifest = JSON.parse(await readFile(resolve(path, "package.json"), "utf8"))
      if (!manifest.private) packages.set(manifest.name, { path, manifest })
    } catch (error) {
      if (
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The isolated consumer runner reads its own package metadata and child-process errors; no HTTP input supplies these values.
        (error as NodeJS.ErrnoException).code !== "ENOENT" &&
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The isolated consumer runner reads its own package metadata and child-process errors; no HTTP input supplies these values.
        (error as NodeJS.ErrnoException).code !== "ENOTDIR"
      )
        throw error
    }
  }
  const needed = new Set([
    "@nifrajs/cli",
    "@nifrajs/web",
    "@nifrajs/schema",
    "@nifrajs/web-react",
    "@nifrajs/web-vue",
    "@nifrajs/web-svelte",
    "@nifrajs/web-solid",
  ])
  for (const name of needed) {
    const pkg = packages.get(name)
    if (pkg === undefined) throw new Error(`Missing public package ${name}`)
    for (const dependency of [
      ...Object.keys(pkg.manifest.dependencies ?? {}),
      ...Object.keys(pkg.manifest.peerDependencies ?? {}),
    ])
      if (packages.has(dependency)) needed.add(dependency)
  }
  const dependencies: Record<string, string> = {
    react: "19.2.7",
    "react-dom": "19.2.7",
    "react-server-dom-webpack": "19.2.7",
    vue: "3.5.40",
    svelte: "5.56.8",
    "solid-js": "1.9.14",
    vite: "8.2.1",
    "@vitejs/plugin-rsc": "0.5.35",
    "@vitejs/plugin-vue": "6.0.9",
    "@sveltejs/vite-plugin-svelte": "7.3.1",
    "vite-plugin-solid": "2.11.14",
    typescript: "6.0.3",
    "@types/react": "19.2.17",
    "@types/react-dom": "19.2.3",
    "@types/node": "25.5.0",
  }
  for (const name of needed) {
    const pkg = packages.get(name)!
    const before = new Set(await readdir(tarballs))
    run(["bun", "pm", "pack", "--destination", tarballs], pkg.path)
    const added = (await readdir(tarballs)).filter((file) => !before.has(file))
    assert.equal(added.length, 1)
    dependencies[name] = "file:" + resolve(tarballs, added[0]!)
  }
  await writeFile(
    resolve(consumer, "package.json"),
    JSON.stringify(
      {
        name: "fabricated-component-consumer",
        private: true,
        type: "module",
        nifra: { environment: "shared" },
        dependencies,
      },
      null,
      2,
    ),
  )
  run(
    [
      "npm",
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      "--package-lock=false",
    ],
    consumer,
  )
  for (const name of needed)
    assert.ok(
      (await realpath(resolve(consumer, "node_modules", name))).startsWith(consumer + "/"),
      `Workspace source alias in ${name}`,
    )
  const fixture = resolve(root, "packages/web/test/fixtures/server-components")
  await cp(resolve(fixture, "contract-types.ts"), resolve(consumer, "contract-types.ts"))
  run(
    [
      "node",
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--target",
      "esnext",
      "--allowImportingTsExtensions",
      "--lib",
      "esnext,dom",
      "contract-types.ts",
    ],
    consumer,
  )
  console.log("components: isolated published declaration contracts and deliberate breaks passed")
  const apps = resolve(consumer, "apps")
  await mkdir(apps)
  for (const name of ["schema.shared.ts", "benchmark.backend.ts", "measure.frontend.ts"])
    await cp(resolve(fixture, name), resolve(apps, name))
  for (const adapter of ["react", "vue", "svelte", "solid"]) {
    const app = resolve(apps, adapter)
    await cp(
      adapter === "react"
        ? resolve(root, "packages/web-react/test/fixtures/server-components")
        : resolve(fixture, adapter),
      app,
      {
        recursive: true,
        filter: (path) => !path.includes("/.nifra/") && !path.includes("/node_modules/"),
      },
    )
    if (adapter === "react")
      for (const file of ["entry.client.ts", "entry-ssr.backend.ts"]) {
        const path = resolve(app, file)
        await writeFile(
          path,
          (await readFile(path, "utf8")).replaceAll(
            "../../../../web/test/fixtures/server-components/",
            "../",
          ),
        )
      }
    const entries =
      adapter === "react"
        ? { client: "entry.client.ts", ssr: "entry-ssr.backend.ts", rsc: "entry-rsc.backend.tsx" }
        : { client: "entry.client.ts", ssr: "entry.backend.ts" }
    const plugin =
      adapter === "react"
        ? ""
        : adapter === "vue"
          ? 'import plugin from "@vitejs/plugin-vue";'
          : adapter === "svelte"
            ? 'import {svelte as plugin} from "@sveltejs/vite-plugin-svelte";'
            : 'import plugin from "vite-plugin-solid";'
    await mkdir(resolve(app, "routes"))
    await mkdir(resolve(app, "backend"))
    await writeFile(
      resolve(app, "backend/framework.ts"),
      `export const adapter={renderToString(){return ""},renderToStream(){return new ReadableStream()},hydrationHead(){return ""}}; export const clientModule="@nifrajs/web-${adapter}/client"; export const componentPipeline=${JSON.stringify({ adapter, entries })};`,
    )
    await writeFile(
      resolve(app, "nifra.config.ts"),
      `${plugin} export {adapter,clientModule,componentPipeline} from "./backend/framework"; export const vitePlugins=[${adapter === "react" ? "" : adapter === "solid" ? "plugin({ssr:true})" : "plugin()"}];`,
    )
    const cli = resolve(consumer, "node_modules/@nifrajs/cli/dist/cli.js")
    run(["bun", cli, "build", "--target", "node"], app)
    await probe(["node", "dist/server.js"], app, adapter)
    await probe(["bun", cli, "dev", "--port", "{port}"], app, adapter)
    console.log(`components: ${adapter} packaged CLI build/dev and browser lifecycle passed`)
  }
  await writeFile(
    resolve(root, ".nifra-components-fixtures/packaged-consumers.json"),
    JSON.stringify(
      {
        status: "passed",
        adapters: ["react", "vue", "svelte", "solid"],
        packages: [...needed],
        mode: "isolated-tarballs",
        sourceAliases: false,
      },
      null,
      2,
    ) + "\n",
  )
} finally {
  for (const child of children) stop(child)
  await rm(scratch, { recursive: true, force: true })
}
