import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  DEFAULT_ASSURANCE_CONFIG,
  formatAssuranceReport,
  loadAssuranceConfig,
  runAssurance,
} from "../src/assure.ts"

const FIXTURES = join(import.meta.dir, ".tmp-nifra-assurance-fixtures")

afterAll(async () => {
  await rm(FIXTURES, { recursive: true, force: true })
})

const BACKEND = `import { server } from "@nifrajs/core"
import { bearer, csrf } from "@nifrajs/middleware"
const auth = bearer({ verify: (token) => token === "ok" ? { id: "u1" } : null })
export const backend = server()
  .get("/health", () => ({ ok: true }))
  .use(csrf({ secret: "0123456789abcdef0123456789abcdef" }))
  .use(auth)
  .get("/orders/:id", () => ({ id: "1" }))
  .post("/orders", () => ({ id: "1" }))
`

const CONFIG = `import { defineAssuranceConfig, NIFRA_ASSURANCE } from "@nifrajs/core/assurance"
import { backend } from "./backend.ts"
export default defineAssuranceConfig({
  source: backend,
  policy: {
    rules: [
      { name: "health", match: { paths: ["/health"] }, require: [], forbid: [NIFRA_ASSURANCE.AUTHENTICATED] },
      { name: "mutation", match: { methods: ["POST"] }, require: [NIFRA_ASSURANCE.AUTHENTICATED, NIFRA_ASSURANCE.CSRF] },
      { name: "read", match: { methods: ["GET"] }, require: [NIFRA_ASSURANCE.AUTHENTICATED] },
    ],
  },
})
`

async function project(name: string, config = CONFIG): Promise<string> {
  const dir = join(FIXTURES, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "backend.ts"), BACKEND)
  await writeFile(join(dir, DEFAULT_ASSURANCE_CONFIG), config)
  return dir
}

describe("nifra assure", () => {
  test("loads a real backend/config and passes when every route has its required evidence", async () => {
    const cwd = await project("pass")
    expect(await runAssurance(cwd)).toBe(true)
    expect(await runAssurance(cwd, { json: true })).toBe(true)
  })

  test("fails when policy requires evidence the route does not carry", async () => {
    const cwd = await project(
      "fail",
      CONFIG.replace(
        "NIFRA_ASSURANCE.AUTHENTICATED, NIFRA_ASSURANCE.CSRF]",
        'NIFRA_ASSURANCE.AUTHENTICATED, NIFRA_ASSURANCE.CSRF, "platform.tenant"]',
      ),
    )
    expect(await runAssurance(cwd)).toBe(false)
  })

  test("formats reports and rejects missing/foreign config modules", async () => {
    expect(formatAssuranceReport({ ok: true, routes: [], findings: [] })).toContain(
      "all required evidence",
    )
    const empty = join(FIXTURES, "empty")
    await mkdir(empty, { recursive: true })
    await expect(loadAssuranceConfig(empty)).rejects.toThrow("config not found")
    await writeFile(join(empty, DEFAULT_ASSURANCE_CONFIG), "export default { nope: true }\n")
    await expect(loadAssuranceConfig(empty)).rejects.toThrow("must default-export")
  })
})
