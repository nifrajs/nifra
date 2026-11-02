import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-server-fn-namespace-")
})
afterEach(() => removeFixtureRoot(root))

const findings = async (): Promise<readonly string[]> => {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code === "NF-C056")
    .map((diagnostic) => `${diagnostic.file}:${diagnostic.line} ${diagnostic.severity}`)
}

test("a namespace that differs from the mounted module's filename is reported", async () => {
  writeAppFile(
    root,
    "backend/mount.ts",
    `import { serverFunctions } from "@nifrajs/web/fn"
import * as todos from "./actions/todos.fn"
import * as items from "./actions/todo-items.fn.ts"
import * as plain from "./helpers"
import * as kept from "./actions/kept.fn"
import * as ok from "./actions/ok.fn.ts"
export const plugins = [
  serverFunctions("todo", todos),
  serverFunctions("todo-items", items),
  serverFunctions("other", plain),
  // nifra-expect NF-C056: mounted under an alias on purpose
  serverFunctions("alias", kept),
  serverFunctions("ok", ok),
]
`,
  )
  expect(await findings()).toEqual(["backend/mount.ts:8 error"])
})

test("an aliased import and a namespace import of @nifrajs/web/fn are followed", async () => {
  writeAppFile(
    root,
    "backend/mount.ts",
    `import { serverFunctions as mount } from "@nifrajs/web/fn"
import * as fn from "@nifrajs/web/fn"
import * as a from "./a.fn"
import * as b from "./b.fn.js"
export const plugins = [mount("x", a), fn.serverFunctions("y", b)]
`,
  )
  expect(await findings()).toEqual(["backend/mount.ts:5 error", "backend/mount.ts:5 error"])
})

test("a serverFunctions of another package or a module reached another way is left alone", async () => {
  writeAppFile(
    root,
    "backend/mount.ts",
    `import { serverFunctions } from "./local-helper"
import * as a from "./a.fn"
export const plugins = [serverFunctions("x", a)]
`,
  )
  writeAppFile(
    root,
    "backend/named.ts",
    `import { serverFunctions } from "@nifrajs/web/fn"
import { addTodo } from "./todos.fn"
import * as todos from "./todos.fn"
const alias = todos
export const plugins = [serverFunctions("x", { addTodo }), serverFunctions("x", alias), serverFunctions(name, todos)]
declare const name: string
`,
  )
  expect(await findings()).toEqual([])
})

test("a name the file declares again is not the import, in any scope", async () => {
  writeAppFile(
    root,
    "backend/shadow.ts",
    `import { serverFunctions } from "@nifrajs/web/fn"
import * as todos from "./todos.fn"
import * as items from "./items.fn"
export const local = (() => {
  const serverFunctions = (namespace: string, module: unknown) => ({ namespace, module })
  return [serverFunctions("other", todos)]
})()
export const param = (items: unknown) => serverFunctions("other", items)
`,
  )
  expect(await findings()).toEqual([])
})

test("a nifra-expect above a call that spans lines accepts it", async () => {
  writeAppFile(
    root,
    "backend/mount.ts",
    `import { serverFunctions } from "@nifrajs/web/fn"
import * as kept from "./kept.fn"
import * as wrong from "./wrong.fn"
export const plugins = [
  // nifra-expect NF-C056: mounted under an alias on purpose
  serverFunctions(
    "alias",
    kept,
  ),
  serverFunctions(
    "other",
    wrong,
  ),
]
`,
  )
  expect(await findings()).toEqual(["backend/mount.ts:11 error"])
})

test("a nifra-expect with no reason does not hide an error, and the finding says so", async () => {
  writeAppFile(
    root,
    "backend/mount.ts",
    `import { serverFunctions } from "@nifrajs/web/fn"
import * as todos from "./todos.fn"
// nifra-expect NF-C056:
export const plugin = serverFunctions("todo", todos)
`,
  )
  const result = await collectCheckResult(root, { lintsOnly: true })
  const found = result.diagnostics.filter((diagnostic) => diagnostic.code === "NF-C056")
  expect(found.map((diagnostic) => diagnostic.line)).toEqual([4])
  expect(found[0]?.message).toContain("gives no reason after its colon")
})
