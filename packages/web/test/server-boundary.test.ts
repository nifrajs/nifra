import { expect, test } from "bun:test"
import {
  SERVER_FN_MODULE,
  SERVER_ONLY_MODULE,
  vitePublicEnvPrefix,
} from "../src/internal/server-boundary.ts"

/**
 * The `.server` and `.fn` conventions share one owner and one extension tail. This pins that the two
 * matchers never drift on which extensions count - the drift that once let a hand-written
 * `**\/*.server.{ts,tsx,js,jsx}` miss the extensionless and `.mts`/`.cts`/`.mjs`/`.cjs` forms the regex
 * accepts, waving a module the build empties straight into the browser.
 */
test("both conventions match the identical source-extension tail", () => {
  for (const tail of ["", ".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx"]) {
    expect(SERVER_ONLY_MODULE.test(`db.server${tail}`), `server${tail}`).toBe(true)
    expect(SERVER_FN_MODULE.test(`todos.fn${tail}`), `fn${tail}`).toBe(true)
  }
  // A name/directory that merely contains the word is not a module of that convention.
  expect(SERVER_ONLY_MODULE.test("observer.ts")).toBe(false)
  expect(SERVER_ONLY_MODULE.test("server/index.ts")).toBe(false)
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
