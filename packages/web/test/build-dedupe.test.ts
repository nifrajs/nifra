import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BunPlugin } from "bun"
import { preactDedupePlugin, reactDedupePlugin, svelteDedupePlugin } from "../src/build.ts"

/** Drive a dedupe plugin's `onResolve` registrations through a minimal stub builder, returning a lookup
 * from specifier → pinned path (or undefined when no handler matches). Shared by the react/preact cases. */
function collectPins(plugin: BunPlugin): {
  pinned: (spec: string) => string | undefined
  matches: (spec: string) => boolean
} {
  const handlers: Array<{ filter: RegExp; cb: () => { path: string } }> = []
  const buildStub = {
    onResolve: (opts: { filter: RegExp }, cb: () => { path: string }) => {
      handlers.push({ filter: opts.filter, cb })
    },
  }
  // setup's real param is Bun's PluginBuilder; this unit only exercises onResolve, so a minimal stub is
  // enough - the cast is scoped to the stub's known shape.
  ;(plugin.setup as unknown as (b: typeof buildStub) => unknown)(buildStub)
  return {
    pinned: (spec) => handlers.find((h) => h.filter.test(spec))?.cb().path,
    matches: (spec) => handlers.some((h) => h.filter.test(spec)),
  }
}

// A `file:`-linked package can ship its own `react`, so the bundle gets two React cores → SSR
// `null is not an object (… useState)` (the second dispatcher is null). reactDedupePlugin must pin
// react + its JSX runtimes to ONE resolved copy, and must NOT touch same-prefix specifiers.
test("reactDedupePlugin pins react + jsx runtimes to one copy, leaves react-dom/react-* alone", () => {
  const plugin: BunPlugin = reactDedupePlugin(process.cwd())
  const { pinned, matches } = collectPins(plugin)

  // react core (where the dispatcher lives) pins to the single resolved path
  expect(pinned("react")).toBe(Bun.resolveSync("react", process.cwd()))
  // JSX runtimes pin too, so the transform's React is the same copy
  expect(pinned("react/jsx-runtime")).toBe(Bun.resolveSync("react/jsx-runtime", process.cwd()))

  // exact-match only - same-prefix specifiers must NOT be pinned (react-dom keeps its own conditions;
  // a third-party react-router must resolve normally)
  expect(matches("react-dom")).toBe(false)
  expect(matches("react-dom/server")).toBe(false)
  expect(matches("react-router")).toBe(false)
})

test("reactDedupePlugin handles a linked package repo without mutating the consumer store", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-linked-react-"))
  try {
    const app = join(root, "consumer-app")
    const shared = join(root, "shared-package-repo")
    const appReact = join(app, "node_modules", "react")
    const linkedReact = join(shared, "node_modules", "react")
    const linkedPackage = join(app, "node_modules", "linked-widget")
    const storeSentinel = join(app, "node_modules", ".bun", "store-sentinel.txt")
    for (const dir of [appReact, linkedReact, join(app, "node_modules", ".bun")])
      await mkdir(dir, { recursive: true })
    await writeFile(join(app, "package.json"), JSON.stringify({ name: "consumer-app" }))
    await writeFile(
      join(shared, "package.json"),
      JSON.stringify({ name: "linked-widget", version: "0.1.0" }),
    )
    const reactPackage = JSON.stringify({
      name: "react",
      version: "19.2.7",
      exports: {
        ".": "./index.js",
        "./jsx-runtime": "./jsx-runtime.js",
        "./jsx-dev-runtime": "./jsx-dev-runtime.js",
      },
    })
    await writeFile(join(appReact, "package.json"), reactPackage)
    await writeFile(join(linkedReact, "package.json"), reactPackage)
    for (const dir of [appReact, linkedReact]) {
      await writeFile(join(dir, "index.js"), "export {}\n")
      await writeFile(join(dir, "jsx-runtime.js"), "export {}\n")
      await writeFile(join(dir, "jsx-dev-runtime.js"), "export {}\n")
    }
    await symlink(shared, linkedPackage, "dir")
    await writeFile(storeSentinel, "must remain untouched\n")

    const before = await readFile(storeSentinel, "utf8")
    const { pinned } = collectPins(reactDedupePlugin(app))
    const after = await readFile(storeSentinel, "utf8")

    expect(pinned("react")).toBe(Bun.resolveSync("react", app))
    expect(pinned("react")).not.toBe(Bun.resolveSync("react", shared))
    expect(pinned("react/jsx-runtime")).toBe(Bun.resolveSync("react/jsx-runtime", app))
    expect(after).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// `examples/web-preact` is the nearest dir where `preact` resolves inside the nifra tree (it isn't a dep
// of @nifrajs/web itself). The plugin pins to whatever `from` resolves - so we assert against the same.
const PREACT_FROM = `${import.meta.dir}/../../../examples/web-preact`

test("preactDedupePlugin pins preact + hooks/compat/jsx to one copy, leaves preact-render-to-string alone", () => {
  const plugin: BunPlugin = preactDedupePlugin(PREACT_FROM)
  const { pinned, matches } = collectPins(plugin)

  // preact core (where the `options` global the renderer + hooks share lives) pins to one resolved path
  expect(pinned("preact")).toBe(Bun.resolveSync("preact", PREACT_FROM))
  // hooks must be the SAME copy - they register onto preact core's `options`; a split copy is the bug
  expect(pinned("preact/hooks")).toBe(Bun.resolveSync("preact/hooks", PREACT_FROM))
  expect(pinned("preact/compat")).toBe(Bun.resolveSync("preact/compat", PREACT_FROM))

  // exact-match only - the renderer keeps its own resolution (it transitively binds the pinned `preact`),
  // and same-prefix third-party packages must resolve normally
  expect(matches("preact-render-to-string")).toBe(false)
  expect(matches("preact-render-to-string/stream")).toBe(false)
  expect(matches("preact-iso")).toBe(false)
})

test("preactDedupePlugin is a no-op when preact is not resolvable (skips, never throws)", () => {
  // A dir with no preact in any ancestor node_modules: every spec resolution throws → no handlers pinned.
  const plugin: BunPlugin = preactDedupePlugin("/")
  const { matches } = collectPins(plugin)
  expect(matches("preact")).toBe(false)
})

// Svelte is the one framework whose bare entry is chosen by condition: `browser` is the client
// runtime, `default` the server one. A fake package keeps the map under the test's control.
async function fakeSvelteApp(): Promise<{ readonly app: string; readonly svelte: string }> {
  const app = await mkdtemp(join(tmpdir(), "nifra-svelte-pin-"))
  const svelte = join(app, "node_modules", "svelte")
  await mkdir(join(svelte, "src", "internal", "client"), { recursive: true })
  await writeFile(
    join(svelte, "package.json"),
    JSON.stringify({
      name: "svelte",
      version: "5.0.0",
      exports: {
        "./package.json": "./package.json",
        ".": {
          types: "./types/index.d.ts",
          worker: "./src/index-server.js",
          browser: "./src/index-client.js",
          default: "./src/index-server.js",
        },
        "./internal/client": { default: "./src/internal/client/index.js" },
        "./nested": { svelte: { browser: "./src/nested-client.js" }, default: "./src/nested.js" },
      },
    }),
  )
  for (const file of [
    "index-server.js",
    "index-client.js",
    "internal/client/index.js",
    "nested.js",
    "nested-client.js",
  ]) {
    await writeFile(join(svelte, "src", file), "export {}\n")
  }
  return { app, svelte: await realpath(svelte) }
}

/** Drive the Svelte plugin's resolver as `Bun.build` would, with the build's own `config`. */
function sveltePins(
  from: string,
  config?: { target?: string; conditions?: string | readonly string[] },
): (spec: string) => string | undefined {
  let resolver: ((args: { path: string }) => { path: string } | undefined) | undefined
  const buildStub = {
    ...(config === undefined ? {} : { config }),
    onResolve: (
      _opts: { filter: RegExp },
      cb: (args: { path: string }) => { path: string } | undefined,
    ) => {
      resolver = cb
    },
  }
  ;(svelteDedupePlugin(from).setup as unknown as (b: typeof buildStub) => unknown)(buildStub)
  return (spec) => resolver?.({ path: spec })?.path
}

test("svelteDedupePlugin pins a browser bundle to the client runtime, not the one this process runs", async () => {
  const { app, svelte } = await fakeSvelteApp()
  try {
    // A build with no `target` is a browser build: the bare entry is the CLIENT runtime. Pinning the
    // server one is what left a built page unable to hydrate.
    for (const config of [{}, { target: "browser" }, { target: "browser", conditions: ["bun"] }]) {
      const pin = sveltePins(app, config)
      expect(await realpath(pin("svelte") as string)).toBe(join(svelte, "src", "index-client.js"))
      // A condition-free subpath pins to the same copy.
      expect(await realpath(pin("svelte/internal/client") as string)).toBe(
        join(svelte, "src", "internal", "client", "index.js"),
      )
    }
  } finally {
    await rm(app, { recursive: true, force: true })
  }
})

test("svelteDedupePlugin reads nested conditions in the package's own order", async () => {
  const { app, svelte } = await fakeSvelteApp()
  try {
    // `svelte` is not an active condition, so its branch is skipped and `default` answers...
    expect(await realpath(sveltePins(app, {})("svelte/nested") as string)).toBe(
      join(svelte, "src", "nested.js"),
    )
    // ...and once the build names it, the branch - and the `browser` inside it - does.
    for (const conditions of ["svelte", ["svelte"]]) {
      expect(await realpath(sveltePins(app, { conditions })("svelte/nested") as string)).toBe(
        join(svelte, "src", "nested-client.js"),
      )
    }
  } finally {
    await rm(app, { recursive: true, force: true })
  }
})

test("svelteDedupePlugin keeps the runtime's own answer outside a browser bundle", async () => {
  const { app, svelte } = await fakeSvelteApp()
  try {
    // A server bundle, and a runtime plugin (no build config): both run Svelte's server entry.
    for (const config of [{ target: "bun" }, { target: "node" }, undefined]) {
      expect(await realpath(sveltePins(app, config)("svelte") as string)).toBe(
        join(svelte, "src", "index-server.js"),
      )
    }
  } finally {
    await rm(app, { recursive: true, force: true })
  }
})

test("svelteDedupePlugin leaves resolution alone when it cannot pin", async () => {
  // Svelte is not resolvable from here at all.
  expect(sveltePins("/", {})("svelte")).toBeUndefined()
  const { app } = await fakeSvelteApp()
  try {
    // A subpath the package does not export.
    expect(sveltePins(app, {})("svelte/internal/nope")).toBeUndefined()
    // A package with no export map: the runtime's answer, or nothing.
    await writeFile(
      join(app, "node_modules", "svelte", "package.json"),
      JSON.stringify({ name: "svelte", version: "5.0.0", main: "./src/index-server.js" }),
    )
    expect(sveltePins(app, {})("svelte")).toEndWith(join("src", "index-server.js"))
  } finally {
    await rm(app, { recursive: true, force: true })
  }
})
