import { afterEach, beforeEach, expect, test } from "bun:test"
import { collectCheckResult } from "../src/check.ts"
import { createFixtureRoot, removeFixtureRoot, writeAppFile } from "./fixture-root.ts"

let root: string

beforeEach(() => {
  root = createFixtureRoot("tmp-check-merge-auth-")
  writeAppFile(
    root,
    "nifra.assurance.ts",
    `import { defineAssuranceConfig } from "@nifrajs/core/assurance"
import { backend } from "./backend/app.ts"
export default defineAssuranceConfig({
  source: backend,
  policy: { rules: [{ name: "all", match: {}, require: [] }] },
})
`,
  )
  writeAppFile(
    root,
    "backend/users.ts",
    `import { server } from "@nifrajs/core/server"
export const users = server().get("/api/users", () => []).post("/api/users", () => "ok")
`,
  )
})
afterEach(() => removeFixtureRoot(root))

const app = (mergeLine: string): string => `import { server } from "@nifrajs/core/server"
import { users } from "./users.ts"
const session = { id: "session", run: () => ({ ok: true, principal: { id: "u1" } }) } as never
export const backend = server()
  .authenticate(session)
  .get("/api/me", () => "me")
${mergeLine}
`

const mergeFindings = (result: Awaited<ReturnType<typeof collectCheckResult>>) =>
  result.diagnostics.filter((diagnostic) => diagnostic.code === "NF-C043")

test("a merge whose routes skip the parent's authenticate() is reported at the merge line", async () => {
  writeAppFile(root, "backend/app.ts", app("  .merge(users)"))
  const findings = mergeFindings(await collectCheckResult(root, { lintsOnly: true }))
  expect(findings).toHaveLength(1)
  expect(findings[0]?.file).toBe("backend/app.ts")
  expect(findings[0]?.line).toBe(7)
  expect(findings[0]?.severity).toBe("warning")
  expect(findings[0]?.message).toContain("authenticate(session)")
  expect(findings[0]?.message).toContain("GET /api/users, POST /api/users")
})

test("a nifra-expect with a reason on the merge line accepts it", async () => {
  writeAppFile(
    root,
    "backend/app.ts",
    app("  // nifra-expect NF-C043: the users module is a public directory\n  .merge(users)"),
  )
  expect(mergeFindings(await collectCheckResult(root, { lintsOnly: true }))).toEqual([])
})

test("a nifra-expect without a reason does not", async () => {
  writeAppFile(root, "backend/app.ts", app("  // nifra-expect NF-C043:\n  .merge(users)"))
  expect(mergeFindings(await collectCheckResult(root, { lintsOnly: true }))).toHaveLength(1)
})

test("a merged server that authenticates its own routes is not reported", async () => {
  writeAppFile(
    root,
    "backend/users.ts",
    `import { server } from "@nifrajs/core/server"
const session = { id: "session", run: () => ({ ok: true, principal: { id: "u1" } }) } as never
export const users = server().authenticate(session).get("/api/users", () => [])
`,
  )
  writeAppFile(root, "backend/app.ts", app("  .merge(users)"))
  expect(mergeFindings(await collectCheckResult(root, { lintsOnly: true }))).toEqual([])
})
