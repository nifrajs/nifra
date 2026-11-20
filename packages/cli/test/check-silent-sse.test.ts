import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-silent-sse-")
})
afterEach(() => removeFixtureRoot(root))

const findings = async (): Promise<readonly string[]> => {
  const result = await collectCheckResult(root, { lintsOnly: true })
  return result.diagnostics
    .filter((diagnostic) => diagnostic.code === "NF-C061")
    .map((diagnostic) => `${diagnostic.file}:${diagnostic.line} ${diagnostic.severity}`)
}

const ROUTES = `import { server } from "@nifrajs/core/server"
import { sse, streaming } from "@nifrajs/core/sse"
import { t } from "@nifrajs/schema"
const feed = { sse: t.object({ id: t.string() }) }
const run = () => {}
const options = { keepAlive: 30_000 }
export const app = server()
  .use(streaming())
  .sse("/silent", feed, run)
  .sse("/pinged", feed, run, { keepAlive: 5_000 })
  .sse("/slow-ping", feed, run, { keepAlive: 15_000 })
  .sse("/exact", feed, run, { keepAlive: 10_000 })
  .sse("/off", feed, run, { keepAlive: 0 })
  .sse("/unknown", feed, run, options)
  .sse("/spread", feed, run, { ...options })
  .get("/helper", (c) => sse(c, run))
  .get("/helper-pinged", (c) => sse(c, run, { keepAlive: 2_000 }))
  // nifra-expect NF-C061: the client reconnects on its own
  .sse("/marked", feed, run)
`
const LISTEN = `import { app } from "./routes.ts"
app.listen(3000)
`

test("a stream with no ping inside Bun's idle timeout is reported on a listen() project", async () => {
  writeAppFile(root, "backend/routes.ts", ROUTES)
  writeAppFile(root, "backend/main.ts", LISTEN)
  // Silent, the 15 s and 10 s pings, the disabled ping and the helper call are reported; a ping
  // inside the timeout, an init the file cannot read, and the marked route are not.
  expect(await findings()).toEqual([
    "backend/routes.ts:9 info",
    "backend/routes.ts:11 info",
    "backend/routes.ts:12 info",
    "backend/routes.ts:13 info",
    "backend/routes.ts:16 info",
  ])
})

test("a project with no Bun listener is left alone", async () => {
  writeAppFile(root, "backend/routes.ts", ROUTES)
  expect(await findings()).toEqual([])
})

test("withIdleTimeout or idleTimeoutSec anywhere in the project silences the rule", async () => {
  writeAppFile(root, "backend/routes.ts", ROUTES)
  writeAppFile(root, "backend/main.ts", LISTEN)
  writeAppFile(
    root,
    "backend/long.ts",
    `import { withIdleTimeout } from "@nifrajs/core/idle-timeout"
export const long = withIdleTimeout
`,
  )
  expect(await findings()).toEqual([])
  writeAppFile(root, "backend/long.ts", `export const tuned = { idleTimeoutSec: 60 }\n`)
  expect(await findings()).toEqual([])
})

test("a computed keepAlive key is read when spelled out and skipped when it is not", async () => {
  writeAppFile(
    root,
    "backend/routes.ts",
    `import { server } from "@nifrajs/core/server"
import { streaming } from "@nifrajs/core/sse"
import { t } from "@nifrajs/schema"
const feed = { sse: t.object({ id: t.string() }) }
const run = () => {}
const key = "keepAlive"
export const app = server()
  .use(streaming())
  .sse("/spelled", feed, run, { ["keepAlive"]: 5_000 })
  .sse("/spelled-slow", feed, run, { ["keepAlive"]: 15_000 })
  .sse("/unknown", feed, run, { [key]: 5_000 })
  .sse("/other", feed, run, { ["maxBufferedBytes"]: 10 })
`,
  )
  writeAppFile(root, "backend/main.ts", LISTEN)
  expect(await findings()).toEqual(["backend/routes.ts:10 info", "backend/routes.ts:12 info"])
})

test("a comment or string that names withIdleTimeout tunes nothing, and Bun.serve's idleTimeout does", async () => {
  writeAppFile(root, "backend/routes.ts", ROUTES)
  writeAppFile(
    root,
    "backend/main.ts",
    `import { app } from "./routes.ts"
// TODO: add withIdleTimeout and idleTimeoutSec here
const note = "idleTimeout"
app.listen(3000)
`,
  )
  expect((await findings()).length).toBe(5)
  writeAppFile(
    root,
    "backend/main.ts",
    `import { app } from "./routes.ts"
Bun.serve({ idleTimeout: 0, fetch: app.fetch })
`,
  )
  expect(await findings()).toEqual([])
  // A quoted or computed property name sets the timeout all the same.
  for (const options of [
    `{ "idleTimeout": 60, fetch: app.fetch }`,
    `{ ["idleTimeout"]: 60, fetch: app.fetch }`,
  ]) {
    writeAppFile(
      root,
      "backend/main.ts",
      `import { app } from "./routes.ts"\nBun.serve(${options})\n`,
    )
    expect(await findings()).toEqual([])
  }
})

test("an sse call that is not from nifra is left alone", async () => {
  writeAppFile(
    root,
    "backend/routes.ts",
    `import { sse } from "./sse.ts"
import { server } from "@nifrajs/core/server"
export const app = server().get("/x", (c) => sse(c, () => {}))
`,
  )
  writeAppFile(root, "backend/main.ts", LISTEN)
  expect(await findings()).toEqual([])
})
