import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildClient, publicEnvDefines } from "../src/build.ts"

// #3b: `process.env.PUBLIC_API_URL` compiled to `undefined` (crash fixed, but the VALUE wasn't
// exposed). buildClient now bakes every PUBLIC_*-prefixed env var into the client `define` —
// `"process.env.PUBLIC_X": JSON.stringify(value)` — while leaving unprefixed secrets undefined.
// publicEnvDefines is the pure core of that, so the prefix + redaction contract is testable here.

test("bakes PUBLIC_-prefixed vars (JSON-encoded) and never exposes unprefixed secrets [#3b]", () => {
  const defines = publicEnvDefines("PUBLIC_", {
    PUBLIC_API_URL: "https://api.example.com",
    PUBLIC_FEATURE_FLAG: "on",
    SECRET_KEY: "sk_live_do_not_leak",
    DATABASE_URL: "postgres://localhost/app",
    NODE_ENV: "production",
  })

  // The public var is exposed under its `process.env.NAME` key, JSON-encoded (so a string is quoted).
  expect(defines["process.env.PUBLIC_API_URL"]).toBe('"https://api.example.com"')
  expect(defines["process.env.PUBLIC_FEATURE_FLAG"]).toBe('"on"')

  // A non-PUBLIC var gets NO define — the bare `process.env` → `({})` define resolves it to undefined,
  // so the secret can't reach the client bundle. This is the security boundary.
  expect(defines).not.toHaveProperty("process.env.SECRET_KEY")
  expect(defines).not.toHaveProperty("process.env.DATABASE_URL")
  expect(defines).not.toHaveProperty("process.env.NODE_ENV")

  // The secret's VALUE appears nowhere in the produced defines (defense in depth).
  expect(JSON.stringify(defines)).not.toContain("sk_live_do_not_leak")
})

test("JSON-encodes values so a value with quotes/braces can't break the define [#3b]", () => {
  const defines = publicEnvDefines("PUBLIC_", { PUBLIC_JSON: '{"a":"b\\""}' })
  // The result is a valid JS string literal — eval-equivalent round-trips back to the original.
  expect(JSON.parse(defines["process.env.PUBLIC_JSON"] as string)).toBe('{"a":"b\\""}')
})

test("a custom prefix overrides PUBLIC_; the default no longer matches [#3b]", () => {
  const defines = publicEnvDefines("NIFRA_PUBLIC_", {
    NIFRA_PUBLIC_CDN: "https://cdn.example.com",
    PUBLIC_API_URL: "https://api.example.com", // not the configured prefix → excluded
  })
  expect(defines["process.env.NIFRA_PUBLIC_CDN"]).toBe('"https://cdn.example.com"')
  expect(defines).not.toHaveProperty("process.env.PUBLIC_API_URL")
})

test("an empty prefix opts out entirely — no var is baked in [#3b]", () => {
  const defines = publicEnvDefines("", { PUBLIC_API_URL: "https://api.example.com" })
  expect(Object.keys(defines)).toHaveLength(0)
})

test('skips undefined values so `"undefined"` is never baked in [#3b]', () => {
  // A deleted/unset key can still enumerate as `undefined` on some env objects — it must be skipped,
  // not stringified to the literal `undefined` (which would shadow the bare-process.env fallback).
  const defines = publicEnvDefines("PUBLIC_", { PUBLIC_UNSET: undefined, PUBLIC_SET: "x" })
  expect(defines).not.toHaveProperty("process.env.PUBLIC_UNSET")
  expect(defines["process.env.PUBLIC_SET"]).toBe('"x"')
})

// End-to-end through the real `buildClient`: the temp app lives INSIDE the workspace so the generated
// bootstrap's `@nifrajs/web`/`@nifrajs/web/client` imports resolve via node_modules hoisting.
const WORKSPACE_TMP_BASE = `${import.meta.dir}/.tmp-public-env-`
const ENV_KEYS = ["PUBLIC_E2E_API_URL", "SECRET_E2E_KEY"] as const
let projectRoot: string
let externalOut: string | undefined
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  projectRoot = mkdtempSync(WORKSPACE_TMP_BASE)
  for (const k of ENV_KEYS) savedEnv[k] = Bun.env[k]
})
afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
  if (externalOut !== undefined) rmSync(externalOut, { recursive: true, force: true })
  externalOut = undefined
  // Restore the build environment exactly — never leak the test's PUBLIC_*/SECRET_* into later tests.
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete (Bun.env as Record<string, string>)[k]
    else (Bun.env as Record<string, string>)[k] = savedEnv[k] as string
  }
})

test("buildClient resolves app dependencies when outDir is outside the project", async () => {
  const routesDir = join(projectRoot, "routes")
  mkdirSync(routesDir, { recursive: true })
  writeFileSync(join(routesDir, "index.tsx"), "export default function Index() { return null }\n")
  const clientModule = join(projectRoot, "client-stub.ts")
  writeFileSync(clientModule, "export function mountRouter() {}\n")
  externalOut = mkdtempSync(join(tmpdir(), "nifra-client-output-"))

  const manifest = await buildClient({
    routesDir,
    outDir: externalOut,
    clientModule,
    minify: false,
  })

  expect(manifest.entry).toStartWith("/assets/_nifra-entry-")
  expect(readdirSync(externalOut)).toContain("manifest.json")
})

test("buildClient bakes a PUBLIC_ var's value into the client bundle, never a secret [#3b]", async () => {
  ;(Bun.env as Record<string, string>).PUBLIC_E2E_API_URL = "https://e2e.example.com/api"
  ;(Bun.env as Record<string, string>).SECRET_E2E_KEY = "sk_live_e2e_must_not_leak"

  const routesDir = join(projectRoot, "routes")
  mkdirSync(routesDir, { recursive: true })
  // A route module that reads BOTH a public and a secret var off `process.env`.
  writeFileSync(
    join(routesDir, "index.tsx"),
    "export default function Index() { return null }\n" +
      "export const apiUrl = process.env.PUBLIC_E2E_API_URL\n" +
      "export const secret = process.env.SECRET_E2E_KEY\n",
  )
  // A local client module exposing `mountRouter` so the generated bootstrap import resolves.
  const clientModule = join(projectRoot, "client-stub.ts")
  writeFileSync(clientModule, "export function mountRouter() {}\n")

  const outDir = join(projectRoot, "dist")
  await buildClient({ routesDir, outDir, clientModule, minify: false })

  // Read every emitted JS chunk and assert the PUBLIC value is inlined while the secret is absent.
  let bundle = ""
  for (const f of readdirSync(outDir)) {
    if (f.endsWith(".js")) bundle += readFileSync(join(outDir, f), "utf8")
  }
  expect(bundle).toContain("https://e2e.example.com/api") // PUBLIC_ value baked into the client
  expect(bundle).not.toContain("sk_live_e2e_must_not_leak") // secret never reaches the bundle
})
