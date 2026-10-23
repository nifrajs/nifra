import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { collectDoctorResult, doctorReport } from "../src/doctor.ts"
import { writeAppFile } from "./fixture-root.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const app = (dependencies: Record<string, string>, files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "nifra-keep-alive-doctor-"))
  roots.push(root)
  writeAppFile(root, "package.json", JSON.stringify({ name: "app", dependencies }))
  writeAppFile(root, "routes/index.tsx", "export default function Home() { return null }\n")
  for (const [file, source] of Object.entries(files)) writeAppFile(root, file, source)
  return root
}
const KEPT = "export const keepAlive = true\nexport default function List() { return null }\n"

test("doctor notes keepAlive routes in an app that names no sign-in cookie, without failing", async () => {
  const root = app({ "@nifrajs/web": "5.0.0" }, { "routes/list.tsx": KEPT })
  const result = await collectDoctorResult(root)
  expect(result.ok).toBe(true)
  expect(result.keepAliveIdentity).toEqual({ routes: ["routes/list.tsx"] })
  const report = doctorReport(result).join("\n")
  expect(report).toContain(
    "routes/list.tsx keep pages alive, and nothing names this app's sign-in cookie",
  )
  expect(report).toContain("/docs/keep-alive#sign-in")
})

test("a known auth integration, identityCookies or identityChanged silences it", async () => {
  for (const [dependencies, files] of [
    [{ "@nifrajs/web": "5.0.0", "better-auth": "1.0.0" }, {}],
    [{ "@nifrajs/web": "5.0.0", "@nifrajs/auth": "5.0.0" }, {}],
    [
      { "@nifrajs/web": "5.0.0" },
      { "server.ts": "createWebApp({ keepAlive: { identityCookies: ['sid'] } })\n" },
    ],
    [
      { "@nifrajs/web": "5.0.0" },
      { "lib/auth.ts": "export const out = () => identityChanged()\n" },
    ],
  ] as const) {
    const root = app(dependencies, { "routes/list.tsx": KEPT, ...files })
    expect((await collectDoctorResult(root)).keepAliveIdentity).toBeUndefined()
  }
})

test("an app without keepAlive routes gets no note", async () => {
  const root = app({ "@nifrajs/web": "5.0.0" }, {})
  expect((await collectDoctorResult(root)).keepAliveIdentity).toBeUndefined()
})
