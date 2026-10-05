import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { i18nCheckPassed, renderI18nCheck, runI18nCheck } from "../src/i18n-check.ts"

const I18N = JSON.stringify(join(import.meta.dir, "../../i18n/src/index.ts"))
const CLI = join(import.meta.dir, "../src/cli.ts")

const ENTRY = `import { defineLocales } from ${I18N}
export const locales = defineLocales({ default: "en", locales: { en: {}, fr: {}, gu: {}, hi: { draft: true } } })
export const catalogs = {
  en: { home: { title: "Welcome, {name}" }, brand: "nifra", cta: "Read the <link>terms</link>" },
  fr: () => import("./fr.json"),
  gu: async () => ({ home: { title: "સ્વાગત છે, {name}" }, brand: "nifra", cta: "<link>શરતો</link> વાંચો" }),
  hi: { home: { title: "स्वागत है" } },
}
export const ignore = { untranslated: ["brand"] }
`

let root = ""
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nifra-i18n-check-"))
  await mkdir(join(root, "shared"))
  await writeFile(join(root, "shared", "i18n.ts"), ENTRY)
  await writeFile(
    join(root, "shared", "fr.json"),
    JSON.stringify({ home: { title: "Bienvenue" }, brand: "nifra", old: "Ancien" }),
  )
  // Written up front: Bun caches a directory's entries once a module in it has been resolved.
  await writeFile(join(root, "bad.ts"), "export const locales = {}\n")
})
afterAll(() => rm(root, { recursive: true, force: true }))

describe("nifra i18n check", () => {
  test("finds the default entry, loads lazy and module catalogs, and checks them", async () => {
    const out = await runI18nCheck(root)
    expect(out.entry).toBe("shared/i18n.ts")
    const findings = out.result.findings.map(
      (f) => `${f.severity} ${f.locale} ${f.code} ${f.key ?? ""}`,
    )
    expect(findings).toEqual([
      "error fr placeholder home.title",
      "warning fr unused-key old",
      "warning fr missing-key cta",
      "error hi placeholder home.title",
      "info hi missing-key brand",
      "info hi missing-key cta",
    ])
    expect(out.result.ok).toBe(false)
    expect(i18nCheckPassed(out, false)).toBe(false)
    const text = renderI18nCheck(out).join("\n")
    expect(text).toContain("nifra i18n check - shared/i18n.ts")
    expect(text).toContain("  en      default  3 messages\n  fr               2/3 (66.7%)\n")
    expect(text).toContain("  gu               3/3 (100%)\n  hi      draft    1/3 (33.3%)")
    expect(text).toContain("✖ fr  placeholder: home.title drops {name} that en's message shows")
    expect(text).toContain("• hi  missing-key (2): brand, cta")
    expect(text).toContain("2 errors, 2 warnings")
  })

  test("an explicit entry, and the errors a malformed entry gets", async () => {
    await expect(runI18nCheck(root, { entry: "bad.ts" })).rejects.toThrow(
      "bad.ts must export `locales`",
    )
    await expect(runI18nCheck(root, { entry: "nope.ts" })).rejects.toThrow("nope.ts does not exist")
    const empty = await mkdtemp(join(tmpdir(), "nifra-i18n-empty-"))
    try {
      await expect(runI18nCheck(empty)).rejects.toThrow("no entry module found")
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  test("the CLI exits 1 on errors, prints JSON, and --strict fails on warnings", async () => {
    const run = async (...args: string[]) => {
      const proc = Bun.spawn([process.execPath, CLI, "i18n", ...args], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exit }
    }
    const failing = await run("check", "--json")
    expect(failing.exit).toBe(1)
    const json = JSON.parse(failing.stdout) as { entry: string; result: { ok: boolean } }
    expect(json.entry).toBe("shared/i18n.ts")
    expect(json.result.ok).toBe(false)

    await writeFile(
      join(root, "clean.ts"),
      `import { defineLocales } from ${I18N}
export const locales = defineLocales({ default: "en", locales: { en: {}, fr: {} } })
export const catalogs = { en: { a: "Hello", b: "Bye" }, fr: { a: "Bonjour" } }
`,
    )
    const warned = await run("check", "clean.ts")
    expect(warned.exit).toBe(0)
    expect(warned.stdout).toContain("0 errors, 1 warning - pass --strict to fail on warnings")
    expect((await run("check", "clean.ts", "--strict")).exit).toBe(1)

    const unknown = await run("lint")
    expect(unknown.exit).toBe(1)
    expect(unknown.stderr).toContain("unknown i18n action: lint")
  }, 30_000)
})

test("the report escapes control and bidi characters from catalog keys", () => {
  const text = renderI18nCheck({
    entry: "shared/i18n.ts",
    result: {
      ok: false,
      coverage: [],
      findings: [
        {
          severity: "error",
          code: "placeholder",
          locale: "fr",
          key: "a\u001b[2Jb",
          message: "a\u001b[2Jb‮ drops {name}",
        },
      ],
    },
  }).join("\n")
  expect(text).toContain("a\\u001b[2Jb\\u202e drops {name}")
  expect(text).not.toContain("\u001b")
  expect(text).not.toContain("‮")
})
