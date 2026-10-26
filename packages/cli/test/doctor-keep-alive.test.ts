import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
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

test("a session cookie renamed outright under a known auth integration is noted, a cookiePrefix is not", async () => {
  const renamed = app(
    { "@nifrajs/web": "5.0.0", "better-auth": "1.0.0" },
    {
      "routes/list.tsx": KEPT,
      "lib/auth.ts": 'betterAuth({ advanced: { cookies: { session_token: { name: "sid" } } } })\n',
    },
  )
  const result = await collectDoctorResult(renamed)
  expect(result.ok).toBe(true)
  expect(result.keepAliveIdentity).toEqual({
    routes: ["routes/list.tsx"],
    renamedIn: "lib/auth.ts",
  })
  const report = doctorReport(result).join("\n")
  expect(report).toContain("lib/auth.ts renames the session cookie")
  expect(report).toContain("exported from backend/framework.ts")

  const prefixed = app(
    { "@nifrajs/web": "5.0.0", "better-auth": "1.0.0" },
    {
      "routes/list.tsx": KEPT,
      "lib/auth.ts": 'betterAuth({ advanced: { cookiePrefix: "orbit" } })\n',
    },
  )
  expect((await collectDoctorResult(prefixed)).keepAliveIdentity).toBeUndefined()

  const named = app(
    { "@nifrajs/web": "5.0.0", "@auth/core": "0.40.0" },
    {
      "routes/list.tsx": KEPT,
      "lib/auth.ts": 'Auth({ cookies: { sessionToken: { name: "sid" } } })\n',
      "backend/framework.ts": 'export const keepAlive = { identityCookies: ["sid"] }\n',
    },
  )
  expect((await collectDoctorResult(named)).keepAliveIdentity).toBeUndefined()
})

/** A package outside the app's own package.json, installed into the app as a symlink. */
const linkPackage = (
  root: string,
  name: string,
  at: string,
  dependencies: Record<string, string>,
  field = "dependencies",
) => {
  writeAppFile(
    root,
    `${at}/package.json`,
    JSON.stringify({ name, version: "1.0.0", [field]: dependencies }),
  )
  const link = join(root, "node_modules", ...name.split("/"))
  mkdirSync(join(link, ".."), { recursive: true })
  symlinkSync(join(root, at), link, "dir")
}
const install = (root: string, name: string) =>
  writeAppFile(
    root,
    `node_modules/${name}/package.json`,
    JSON.stringify({ name, version: "1.0.0" }),
  )

test("a workspace package that brings Better Auth in turns the warning into a note", async () => {
  const root = app(
    { "@nifrajs/web": "5.0.0", "@workspace/session": "workspace:*" },
    { "routes/list.tsx": KEPT },
  )
  linkPackage(root, "@workspace/session", "packages/session", {
    "@workspace/auth-core": "workspace:*",
  })
  linkPackage(root, "@workspace/auth-core", "packages/auth-core", { "better-auth": "1.0.0" })
  install(root, "better-auth")
  const result = await collectDoctorResult(root)
  expect(result.ok).toBe(true)
  expect(result.keepAliveIdentity).toBeUndefined()
  expect(result.keepAliveIdentityCovered).toEqual({
    routes: ["routes/list.tsx"],
    package: "better-auth",
    via: ["@workspace/session", "@workspace/auth-core"],
  })
  const report = doctorReport(result).join("\n")
  expect(report).toContain(
    "routes/list.tsx keep pages alive, and this app reaches better-auth through @workspace/session > @workspace/auth-core",
  )
  expect(report).toContain("<prefix>.session_token")
  expect(report).not.toContain("nothing names this app's sign-in cookie")
})

test("a wrapper that reaches no auth library keeps the warning, and a rename in the app still warns", async () => {
  const bare = app(
    { "@nifrajs/web": "5.0.0", "@workspace/ui": "workspace:*" },
    { "routes/list.tsx": KEPT },
  )
  linkPackage(bare, "@workspace/ui", "packages/ui", { "left-pad": "1.0.0" })
  const plain = await collectDoctorResult(bare)
  expect(plain.keepAliveIdentity).toEqual({ routes: ["routes/list.tsx"] })
  expect(plain.keepAliveIdentityCovered).toBeUndefined()

  const renamed = app(
    { "@nifrajs/web": "5.0.0", "@workspace/session": "workspace:*" },
    {
      "routes/list.tsx": KEPT,
      "lib/auth.ts": 'betterAuth({ advanced: { cookies: { session_token: { name: "sid" } } } })\n',
    },
  )
  linkPackage(renamed, "@workspace/session", "packages/session", { "better-auth": "1.0.0" })
  install(renamed, "better-auth")
  const result = await collectDoctorResult(renamed)
  expect(result.keepAliveIdentity).toEqual({
    routes: ["routes/list.tsx"],
    renamedIn: "lib/auth.ts",
  })
  expect(result.keepAliveIdentityCovered).toBeUndefined()
})

test("an auth library a wrapper declares counts only once it is installed", async () => {
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const root = app(
      { "@nifrajs/web": "5.0.0", "@workspace/session": "workspace:*" },
      { "routes/list.tsx": KEPT },
    )
    linkPackage(root, "@workspace/session", "packages/session", { "better-auth": "1.0.0" }, field)
    const missing = await collectDoctorResult(root)
    expect(missing.keepAliveIdentity).toEqual({ routes: ["routes/list.tsx"] })
    expect(missing.keepAliveIdentityCovered).toBeUndefined()

    install(root, "better-auth")
    const installed = await collectDoctorResult(root)
    expect(installed.keepAliveIdentity).toBeUndefined()
    expect(installed.keepAliveIdentityCovered?.package).toBe("better-auth")
  }
})
