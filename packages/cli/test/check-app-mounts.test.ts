import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-app-mounts-")
  writeAppFile(
    root,
    "backend/app.ts",
    `import { server } from "@nifrajs/core/server"
const auth = { fetch: (_request: Request) => new Response("auth") }
const nested = server().get("/api/billing/plan", () => "free")
export const backend = server()
  .mount({ path: "/api/auth", app: auth, opaque: "better-auth handler" })
  .mount({ path: "/api/billing", app: nested })
  .get("/api/users", () => [])
`,
  )
  writeAppFile(
    root,
    "src/session.ts",
    [
      'export const session = () => fetch("/api/auth/get-session")',
      'export const users = () => fetch("/api/users")',
      'export const plan = () => fetch("/api/billing/plan")',
      'export const escape = () => fetch("/api/auth/../users")',
      "",
    ].join("\n"),
  )
})
afterEach(() => removeFixtureRoot(root))

const assurance = `import { defineAssuranceConfig } from "@nifrajs/core/assurance"
import { backend } from "./backend/app.ts"
export default defineAssuranceConfig({
  source: backend,
  policy: { rules: [{ name: "all", match: {}, require: [] }] },
})
`

const flagged = (result: Awaited<ReturnType<typeof collectCheckResult>>): string[] =>
  result.diagnostics
    .filter((diagnostic) => diagnostic.rule === "typed-client")
    .map((diagnostic) => diagnostic.message.match(/"(\/[^"]*)"/)?.[1] ?? diagnostic.message)
    .sort()

test("a fetch into a mount the app declares opaque is not a hand-rolled API call", async () => {
  const without = await collectCheckResult(root, { lintsOnly: true })
  expect(flagged(without)).toEqual([
    "/api/auth/../users",
    "/api/auth/get-session",
    "/api/billing/plan",
    "/api/users",
  ])
  expect(without.externalMounts).toBeUndefined()

  writeAppFile(root, "nifra.assurance.ts", assurance)
  const withSource = await collectCheckResult(root, { lintsOnly: true })
  // The opaque better-auth mount is external; a mount without that declaration and a `..` escape are not.
  expect(flagged(withSource)).toEqual(["/api/auth/../users", "/api/billing/plan", "/api/users"])
  expect(withSource.externalMounts).toEqual(["/api/auth"])
})

test("a mount already listed in nifra.check.json is listed once", async () => {
  writeAppFile(root, "nifra.assurance.ts", assurance)
  writeAppFile(root, "nifra.check.json", JSON.stringify({ externalMounts: ["/api/auth"] }))
  const result = await collectCheckResult(root, { lintsOnly: true })
  expect(result.externalMounts).toEqual(["/api/auth"])
  expect(flagged(result)).toEqual(["/api/auth/../users", "/api/billing/plan", "/api/users"])
})
