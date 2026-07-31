import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serverFnStubPlugin } from "../src/build.ts"
import { importVite } from "../src/internal/vite-import.ts"
import { viteServerFnStub } from "../src/plugins/vite-server-fn.ts"

/**
 * Bun and Vite must replace a `*.fn` module with the SAME stub.
 *
 * nifra ships two client pipelines, and a server function is a URL contract between a generated client
 * and a mounted route. If the two pipelines generated that URL differently - or one of them missed a
 * module entirely - the result is a client that works in dev and 404s in production, which is the
 * failure this codebase has already paid for more than once.
 *
 * Both plugins call the same generator, so this is really asserting that neither has quietly grown its
 * own copy. It is cheap to keep and it is the only test that fails when they diverge.
 */

const SOURCE = `import { serverFn } from "@nifrajs/web/fn"
import { SECRET_TOKEN } from "./secrets.server.ts"

export const addTodo = serverFn({}, async () => ({ token: SECRET_TOKEN }))
export const removeTodo = serverFn({}, async () => ({ ok: true }))
`

/**
 * What Bun's plugin emits, driven through its real `onLoad` rather than reimplemented here.
 *
 * The callback is CAPTURED and then awaited, rather than fired inside a fake `setup` and picked up
 * after a tick. The tick version passed alone and failed inside the full suite: one turn of the loop is
 * not a guarantee under load, only a guess that usually holds.
 */
async function bunStub(filePath: string): Promise<string> {
  let onLoad: ((args: { path: string }) => Promise<{ contents: string }>) | undefined
  serverFnStubPlugin().setup({
    onLoad: (
      _filter: { filter: RegExp },
      cb: (args: { path: string }) => Promise<{ contents: string }>,
    ) => {
      onLoad = cb
    },
    onResolve: () => {},
    config: {},
    module: () => {},
  } as never)
  if (onLoad === undefined) throw new Error("the Bun plugin registered no onLoad handler")
  return (await onLoad({ path: filePath })).contents
}

/** What the Vite plugin emits, through its real `transform`. */
function viteStub(filePath: string, source: string): string {
  const out = viteServerFnStub().transform(source, filePath)
  if (out === null) throw new Error("the Vite plugin declined to transform a .fn module")
  return out.code
}

test("both pipelines emit byte-identical stubs", async () => {
  const root = mkdtempSync(join(tmpdir(), "nifra-fn-parity-"))
  try {
    mkdirSync(root, { recursive: true })
    const filePath = join(root, "todos.fn.ts")
    writeFileSync(filePath, SOURCE)

    const fromBun = await bunStub(filePath)
    const fromVite = viteStub(filePath, SOURCE)

    expect(fromVite).toBe(fromBun)
    // And the stub is the real thing, not two identical empties.
    expect(fromBun).toContain("/_nifra/fn/todos")
    expect(fromBun).toContain("export const addTodo =")
    expect(fromBun).toContain("export const removeTodo =")
    expect(fromBun).not.toContain("SECRET_TOKEN")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the Vite plugin transforms .fn modules and leaves everything else alone", () => {
  const plugin = viteServerFnStub()
  expect(plugin.transform(SOURCE, "/app/todos.fn.ts")).not.toBeNull()
  expect(plugin.transform(SOURCE, "/app/todos.fn.tsx")).not.toBeNull()
  // Vite appends `?query` / `#hash` to ids; the suffix test has to see through them.
  expect(plugin.transform(SOURCE, "/app/todos.fn.ts?v=abc123")).not.toBeNull()
  // Not server functions.
  expect(plugin.transform("export const x = 1", "/app/routes/index.tsx")).toBeNull()
  expect(plugin.transform("export const x = 1", "/app/db.server.ts")).toBeNull()
  // `.fn` has to be the module suffix, not a substring of the name.
  expect(plugin.transform("export const x = 1", "/app/effn.ts")).toBeNull()
})

test("the SSR environment keeps the real module - only the client gets stubs", () => {
  const plugin = viteServerFnStub()
  expect(plugin.applyToEnvironment?.({ name: "client" })).toBe(true)
  // The server is what actually runs these functions; stubbing them there would make every call a
  // request to itself.
  expect(plugin.applyToEnvironment?.({ name: "ssr" })).toBe(false)
  // Vite 5 ignores applyToEnvironment and signals SSR to the transform hook.
  expect(plugin.transform(SOURCE, "/app/todos.fn.ts", { ssr: true })).toBeNull()
})

/**
 * The Bun side is proven by a real build that does not contain the secret; the Vite side gets the same
 * treatment rather than a unit comparison, because "the plugin returns the right string" and "the
 * bundle does not contain the server code" are different claims and only the second one matters.
 */
test("a real vite build contains the stub and none of the server module", async () => {
  const root = mkdtempSync(join(tmpdir(), "nifra-fn-vite-"))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, "secrets.server.ts"),
      'export const SECRET_TOKEN = "hunter2-DO-NOT-SHIP"\n',
    )
    // No bare specifiers: the plugin replaces this module before resolution, so `@nifrajs/web/fn`
    // would never be looked up - but keeping it resolvable proves the plugin, not the resolver.
    writeFileSync(
      join(root, "todos.fn.ts"),
      `import { SECRET_TOKEN } from "./secrets.server.ts"
const serverFn = (c, f) => f
export const addTodo = serverFn({}, async () => ({ token: SECRET_TOKEN }))
`,
    )
    writeFileSync(
      join(root, "entry.ts"),
      'import { addTodo } from "./todos.fn.ts"\nglobalThis.x = addTodo\n',
    )

    const vite = await importVite<{
      build(config: Record<string, unknown>): Promise<unknown>
    }>()
    const result = (await vite.build({
      root,
      logLevel: "silent",
      build: {
        write: false,
        lib: { entry: join(root, "entry.ts"), formats: ["es"], fileName: "entry" },
        rollupOptions: { plugins: [viteServerFnStub()] },
      },
    })) as ReadonlyArray<{ output: ReadonlyArray<{ code?: string }> }>
    const code = result[0]?.output.map((chunk) => chunk.code ?? "").join("\n") ?? ""

    expect(code).not.toContain("hunter2-DO-NOT-SHIP")
    expect(code).not.toContain("SECRET_TOKEN")
    expect(code).toContain("/_nifra/fn/todos")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
