import { afterAll, describe, expect, test } from "bun:test"
import { bindCommandArgv, findCommandSpec } from "../src/command-catalog.ts"
import { loadApp, loadBackendApp } from "../src/load.ts"
import {
  createFixtureProject,
  createFixtureRoot,
  removeFixtureRoot,
  writeAppFile,
} from "./fixture-root.ts"

// backend/app.ts imports @nifrajs/core, so fixtures live in the workspace where it resolves.
const FIXTURES = createFixtureRoot("tmp-api-only-introspection-")
afterAll(() => removeFixtureRoot(FIXTURES))

const BACKEND = `import { server } from "@nifrajs/core/server"
export const backend = server()
  .get("/health", () => "ok")
  .post("/orders", () => ({ id: 1 }))
`

const apiOnly = (name: string): string => {
  const root = createFixtureProject(FIXTURES, name)
  writeAppFile(root, "backend/app.ts", BACKEND)
  return root
}

async function run(name: string, cwd: string, argv: readonly string[] = []) {
  const spec = findCommandSpec(name)
  if (spec === undefined) throw new Error(`${name} command missing`)
  const input = bindCommandArgv(spec, [...argv])
  const output = await spec.run(input, { cwd, cliVersion: "0.0.0" })
  return { data: spec.json?.(output, input), text: spec.render(output, input).join("\n") }
}

describe("an API-only app (backend/app.ts, no web config)", () => {
  test("nifra routes lists its backend routes, as text, JSON and a graph", async () => {
    const root = apiOnly("routes-")
    const { text, data } = await run("routes", root)
    expect(text).toContain("/health")
    expect(text).toContain("/orders")
    expect(JSON.stringify(data)).toContain('"/orders"')
    expect((await run("routes", root, ["--graph"])).text).toContain("/orders")
  })

  test("nifra routes --modes names why it has nothing to read", async () => {
    const root = apiOnly("modes-")
    await expect(run("routes", root, ["--modes"])).rejects.toThrow(
      "routes --modes reads page routes, and",
    )
  })

  test("nifra context says what the app is and lists no pages", async () => {
    const root = apiOnly("context-")
    const index = (await run("context", root)).text
    expect(index).toContain("An API-only nifra app (backend/app.ts, no web config)")
    expect(index).toContain("`POST /orders`")
    expect(index).not.toContain("**Bundler**")
    expect(index).not.toContain("## Page routes")
    expect(index).not.toContain("**Pages:**")
    expect((await run("context", root, ["--kind", "pages"])).text).toContain(
      "An API-only app serves no pages.",
    )
  })

  test("loadApp names the API-only reading, and a directory with neither is refused by both", async () => {
    const root = apiOnly("load-")
    await expect(loadApp(root)).rejects.toThrow("this is an API-only app")
    const empty = createFixtureProject(FIXTURES, "empty-")
    await expect(loadBackendApp(empty)).rejects.toThrow(
      "a web app needs its config, an API-only app its backend/app.ts",
    )
    expect(String(await loadApp(empty).catch((error: unknown) => error))).not.toContain("API-only")
  })
})
