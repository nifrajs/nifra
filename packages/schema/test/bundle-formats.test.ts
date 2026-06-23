import { describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Regression guard for the prod-build format bug.
 *
 * `nifra build` runs the server through `Bun.build` with `minify`/tree-shaking on. The standard
 * string formats USED to register as a bare top-level side effect of `./src/formats.ts`, reachable
 * only via the `export { registerFormat } from "./formats.ts"` re-export in the entry. An app that
 * imports `t` but never names `registerFormat` gives the bundler nothing to anchor that module to —
 * and `Bun.build` does NOT honor the `sideEffects` package.json field — so the registration loop was
 * dropped from the bundle and every `t.string({ format })` rejected with "Unknown format" in
 * production while unbundled `nifra dev` worked.
 *
 * This bundles exactly that shape (import `t`, use a format, never touch `registerFormat`) with the
 * same minify+treeshake settings the framework uses, runs the artifact, and asserts a valid value
 * passes and an invalid one is rejected for the RIGHT reason. Fails on the old top-level-side-effect
 * code; passes once registration is driven from the reachable validate path.
 */

// The `bun` export condition resolves `@nifrajs/schema` to this source entry — bundling it directly is
// equivalent to what a `target: "bun"` app build resolves, and keeps the test hermetic (no dist needed).
const SRC_INDEX = join(import.meta.dir, "..", "src", "index.ts")

async function buildMinifiedBundleAndRun(): Promise<{
  good: unknown
  badFormat: unknown
}> {
  // realpath: on macOS `tmpdir()` is the `/var` symlink to `/private/var`; the bundle is imported by
  // absolute file URL, so the path must be the real one or the dynamic import can't resolve it.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "nifra-schema-bundle-")))
  try {
    const entryPath = join(dir, "entry.ts")
    // Deliberately import ONLY `t` — never `registerFormat` — so nothing references ./formats.ts except
    // the validate path. This is the exact import shape that triggered the bug.
    writeFileSync(
      entryPath,
      `import { t } from ${JSON.stringify(SRC_INDEX)}\n` +
        `const schema = t.object({ email: t.string({ format: "email" }) })\n` +
        `export async function run() {\n` +
        `  const good = await schema["~standard"].validate({ email: "ada@example.com" })\n` +
        `  const badFormat = await schema["~standard"].validate({ email: "not-an-email" })\n` +
        `  return { good, badFormat }\n` +
        `}\n`,
    )

    const result = await Bun.build({
      entrypoints: [entryPath],
      target: "bun",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
    })
    if (!result.success) {
      throw new Error(`bundle failed:\n${result.logs.map(String).join("\n")}`)
    }

    const outPath = join(dir, "out.mjs")
    writeFileSync(outPath, await result.outputs[0]!.text())
    const mod = (await import(pathToFileURL(outPath).href)) as {
      run: () => Promise<{ good: unknown; badFormat: unknown }>
    }
    return await mod.run()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function isValue(r: unknown): r is { value: unknown } {
  return typeof r === "object" && r !== null && "value" in r
}
function isIssues(r: unknown): r is { issues: ReadonlyArray<{ message: string }> } {
  return typeof r === "object" && r !== null && "issues" in r
}

describe("string formats survive a minified production bundle", () => {
  test("a valid email passes and an invalid one is rejected (not 'Unknown format')", async () => {
    const { good, badFormat } = await buildMinifiedBundleAndRun()

    // Before the fix this was `{ issues: [{ message: "Unknown format 'email'" }] }`.
    expect(isValue(good)).toBe(true)

    // Rejected because the value doesn't match the format — NOT because the format went unregistered.
    expect(isIssues(badFormat)).toBe(true)
    if (isIssues(badFormat)) {
      const messages = badFormat.issues.map((i) => i.message).join(" | ")
      expect(messages).not.toContain("Unknown format")
      expect(messages.toLowerCase()).toContain("format")
    }
  })
})
