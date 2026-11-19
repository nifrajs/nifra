/**
 * The 5.16 upgrade codemod, end to end. A small app is written in the shapes 5.15 accepted (type-argument
 * hooks, plain query keys, `formFor<App, Path>()`), the real route table is generated for it, and the
 * program is compiled before and after the recipe's source rewrites. Before, each shape is an error;
 * after, the only errors left are the sites the rewrites list for a person (a hook in a shared component),
 * so a rewrite that produces code the new types refuse, or leaves a shape behind unlisted, fails here.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import ts from "typescript"
import { getRecipe } from "../../../packages/cli/src/recipes/index.ts"
import { getSourceRewrite } from "../../../packages/cli/src/source-rewrites.ts"
import { writeRouteTypes } from "../../../packages/web/src/route-types.ts"
import { programDiagnostics } from "./helpers/typed-program.ts"

const REPO = resolve(import.meta.dir, "../../..")
const APP = join(REPO, "examples", `.upgrade-codemod-${process.pid}`)

const SEARCH = [
  'import type { StandardSchemaV1 } from "@nifrajs/core/server"',
  "export const searchSchema: StandardSchemaV1<{ page?: number }, { page: number }> = {",
  '  "~standard": { version: 1, vendor: "gate", validate: () => ({ value: { page: 1 } }) },',
  "}",
]

const LEGACY: Readonly<Record<string, string>> = {
  "backend.ts": `import { server } from "@nifrajs/core"
import { t } from "@nifrajs/schema"
export const backend = server().post("/todos", { body: t.object({ text: t.string() }) }, () => ({ ok: true }))
`,
  "routes/reports.tsx": `${SEARCH.join("\n")}
import { useParams, useSearch } from "@nifrajs/web-react/router"
export default function Reports() {
  const { page } = useSearch<typeof searchSchema>()
  const params = useParams()
  return <p>{page}{Object.keys(params).length}</p>
}
`,
  "routes/users/[id].tsx": `import { useParams } from "@nifrajs/web-react/router"
export default function User() {
  const { id } = useParams<{ id: string }>()
  return <p>{id}</p>
}
`,
  "routes/todos.tsx": `import { formFor } from "@nifrajs/web/forms"
import type { backend } from "../backend"
const f = formFor<typeof backend, "/todos">()
export default function Todos() {
  return <form method="post" action="/todos"><input {...f.field("text")} /></form>
}
`,
  "frontend/shared.tsx": `import { useSearch } from "@nifrajs/web-react/router"
export const Shared = () => useSearch<{ page: number }>().page
`,
  "frontend/cache.ts": `import { useQueryClient } from "@nifrajs/web-react/query"
interface User { readonly name: string }
export function warm(qc: ReturnType<typeof useQueryClient>, user: User): string | undefined {
  qc.setQueryData(["user", 1], user)
  return qc.getQueryData<User>(["user", 1])?.name
}
`,
}

const SOURCE_FILES = Object.keys(LEGACY).filter((file) => /\.tsx?$/.test(file))

const compile = () =>
  programDiagnostics(APP, "react", [
    ...SOURCE_FILES.map((file) => join(APP, file)),
    join(APP, ".nifra/types/routes.d.ts"),
  ])

beforeAll(() => {
  for (const [file, text] of Object.entries(LEGACY)) {
    mkdirSync(dirname(join(APP, file)), { recursive: true })
    writeFileSync(join(APP, file), text)
  }
  writeRouteTypes({ appRoot: APP })
})

afterAll(() => rmSync(APP, { recursive: true, force: true }))

test("every legacy shape fails the 5.16 types, the rewrites fix them, and only the listed site stays", () => {
  const recipe = getRecipe("5.16.0")
  expect(recipe?.sourceRewrites).toEqual(["route-hooks", "query-keys", "form-for"])

  const before = new Set(compile().map((reading) => reading.file))
  expect([...before].toSorted()).toEqual([
    "frontend/cache.ts",
    "frontend/shared.tsx",
    "routes/reports.tsx",
    "routes/todos.tsx",
    "routes/users/[id].tsx",
  ])

  const listed: string[] = []
  for (const file of SOURCE_FILES) {
    let text = readFileSync(join(APP, file), "utf8")
    for (const id of recipe?.sourceRewrites ?? []) {
      const rewrite = getSourceRewrite(id)
      if (rewrite === undefined || !rewrite.mentions(text)) continue
      const result = rewrite.rewrite(ts, file, text)
      text = result.text
      if (result.manual.length > 0) listed.push(file)
    }
    writeFileSync(join(APP, file), text)
  }

  expect(listed).toEqual(["frontend/shared.tsx"])
  expect([...new Set(compile().map((reading) => reading.file))]).toEqual(["frontend/shared.tsx"])
}, 120_000)
