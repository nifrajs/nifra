import { expect, test } from "bun:test"
import { SERVER_FN_MODULE, vitePublicEnvPrefix } from "../src/internal/server-boundary.ts"

test("the server-function matcher takes every source-extension tail, and only the suffix", () => {
  for (const tail of ["", ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]) {
    expect(SERVER_FN_MODULE.test(`todos.fn${tail}`), `fn${tail}`).toBe(true)
  }
  expect(SERVER_FN_MODULE.test("fn/index.ts")).toBe(false)
  expect(SERVER_FN_MODULE.test("defn.ts")).toBe(false)
})

/**
 * public-env maps Nifra's "which vars may reach the client" contract onto Vite's `envPrefix`. The
 * expose-nothing setting must become a sentinel Vite accepts but no real env key can match, so a user
 * asking to expose nothing actually exposes nothing.
 */
test("vitePublicEnvPrefix maps the public-env contract, including expose-nothing", () => {
  expect(vitePublicEnvPrefix(undefined)).toBe("PUBLIC_")
  expect(vitePublicEnvPrefix("APP_PUBLIC_")).toBe("APP_PUBLIC_")
  const disabled = vitePublicEnvPrefix("")
  expect(disabled).toContain("\0") // NUL - no environment-variable name can contain it
  expect(disabled).not.toBe("")
})
