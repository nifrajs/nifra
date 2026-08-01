import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { serverFnStubPlugin } from "../src/build.ts"
import {
  generateServerFnStub,
  scanServerFnExports,
  serverFnNamespace,
} from "../src/internal/server-boundary.ts"

/**
 * The client half of server functions. The guarantee that matters is negative: the function bodies,
 * and everything they import, must not be in the browser bundle. Everything else here supports that.
 */

const SOURCE = `import { serverFn } from "@nifrajs/web/fn"
import { SECRET_TOKEN } from "./secrets.server.ts"

export const addTodo = serverFn({ input: undefined }, async (input) => {
  return { token: SECRET_TOKEN, input }
})

export const removeTodo = serverFn({}, async () => ({ ok: true }))

export type Todo = { id: string }
export const helper = (n: number): number => n + 1
`

describe("serverFnNamespace", () => {
  test("is the filename without the .fn suffix, not the path", () => {
    expect(serverFnNamespace("/deep/nested/app/actions/todos.fn.ts")).toBe("todos")
    expect(serverFnNamespace("todos.fn.tsx")).toBe("todos")
    expect(serverFnNamespace("billing.fn.js")).toBe("billing")
    // A path-derived namespace would put the build machine's layout into a public URL.
    expect(serverFnNamespace("/home/runner/work/app/src/todos.fn.ts")).not.toContain("runner")
  })
})

describe("scanServerFnExports", () => {
  test("finds the declared functions and ignores everything else", () => {
    expect(scanServerFnExports(SOURCE)).toEqual(["addTodo", "removeTodo"])
  })

  test("refuses a declaration form it cannot read, rather than silently dropping it", () => {
    // Silently skipping would ship a client missing that export, failing as "not a function" far from
    // the cause - so an unreadable form is a build error instead.
    const odd = `const inner = serverFn({}, () => ({}))\nexport { inner as addTodo }\n`
    expect(() => scanServerFnExports(odd)).toThrow(/cannot read/)
  })

  test("a commented-out declaration is not mistaken for a real one", () => {
    const commented = `// export const ghost = serverFn({}, () => ({}))\nexport const real = serverFn({}, () => ({}))\n`
    expect(scanServerFnExports(commented)).toEqual(["real"])
  })
})

describe("generateServerFnStub", () => {
  const stub = generateServerFnStub(SOURCE, "todos")

  test("exports a stub for each server function", () => {
    expect(stub).toContain("export const addTodo =")
    expect(stub).toContain("export const removeTodo =")
  })

  test("carries none of the module's own code or imports", () => {
    // The whole point: the body, and the secret it closed over, stay on the server.
    expect(stub).not.toContain("SECRET_TOKEN")
    expect(stub).not.toContain("secrets.server")
    expect(stub).not.toContain("@nifrajs/web/fn")
    expect(stub).not.toContain("helper")
  })

  test("posts JSON to the namespaced route", () => {
    expect(stub).toContain('"/_nifra/fn/todos"')
    expect(stub).toContain('method: "POST"')
    // The content type is what stops a cross-origin form forging one of these; the stub and the
    // server's guard have to agree on it.
    expect(stub).toContain('"content-type": "application/json"')
    expect(stub).toContain('credentials: "same-origin"')
  })

  test("names namespace drift on a 404 instead of reporting a bare status", () => {
    expect(stub).toContain("is not mounted at")
    expect(stub).toContain("serverFunctions")
  })

  test("is valid JavaScript", () => {
    expect(() => new Function(stub.replaceAll(/^export /gm, ""))).not.toThrow()
  })
})

describe("the Bun client build", () => {
  test("bundles the stub, and no part of the server module", async () => {
    const root = mkdtempSync(join(tmpdir(), "nifra-fn-stub-"))
    try {
      mkdirSync(root, { recursive: true })
      writeFileSync(
        join(root, "secrets.server.ts"),
        'export const SECRET_TOKEN = "hunter2-DO-NOT-SHIP"\n',
      )
      writeFileSync(join(root, "todos.fn.ts"), SOURCE)
      writeFileSync(
        join(root, "entry.ts"),
        'import { addTodo } from "./todos.fn.ts"\nglobalThis.__addTodo = addTodo\n',
      )

      const built = await Bun.build({
        entrypoints: [join(root, "entry.ts")],
        target: "browser",
        plugins: [serverFnStubPlugin()],
      })
      expect(built.success).toBe(true)
      const code = await built.outputs[0]!.text()

      // The negative that the feature exists for.
      expect(code).not.toContain("hunter2-DO-NOT-SHIP")
      expect(code).not.toContain("SECRET_TOKEN")
      // And the positive: the call survives, aimed at the mounted route.
      expect(code).toContain("/_nifra/fn/todos")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
