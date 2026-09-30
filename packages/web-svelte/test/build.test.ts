import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildClient } from "@nifrajs/web/build"
import { svelteBunPlugin } from "../src/plugin.ts"

// A real client build of a Svelte app. Inside the package, so `svelte` and `@nifrajs/web` resolve
// the way they do for an app that depends on both.
const root = mkdtempSync(`${import.meta.dir}/.tmp-build-`)
afterAll(() => rmSync(root, { recursive: true, force: true }))

test("the browser bundle carries Svelte's client runtime, so the page can hydrate", async () => {
  const files: Record<string, string> = {
    "routes/_layout.svelte":
      "<script>\n  let { children } = $props()\n</script>\n\n<div>{@render children()}</div>\n",
    "routes/index.svelte": "<h1>home</h1>\n",
  }
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  const outDir = join(root, "dist")
  await buildClient({
    routesDir: join(root, "routes"),
    outDir,
    clientModule: "@nifrajs/web-svelte/client",
    plugins: [svelteBunPlugin("dom")],
    conditions: ["bun", "browser"],
    publicDir: false,
    minify: false,
  })
  const emitted = readdirSync(outDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => readFileSync(join(outDir, name), "utf8"))
    .join("\n")
  // The server entry's `hydrate` is a stub that throws this; the client one does the work.
  expect(emitted).not.toContain("lifecycle_function_unavailable")
  expect(emitted).toContain("hydration_mismatch")
}, 60_000)
