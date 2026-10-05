import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"

// `Register` is augmented per program, so it is checked in a program of its own: augmenting it in the
// root typecheck would type every other test's catalogs too.
const FIXTURE = `import { createFormatter, type Formatter, type Translation } from "@nifrajs/i18n"

const en = { home: { title: "Hi {name}", cta: "Go" }, faq: [{ q: "Q", a: "A" }] }

declare module "@nifrajs/i18n" {
  interface Register {
    messages: typeof en
  }
}

const fr: Translation = { home: { title: "Salut {name}" } }
const t = createFormatter("fr", fr, { fallback: [en] })
t.t("home.title", { name: "Ada" })
t.t("faq.0.a")
// @ts-expect-error - a typo is a compile error everywhere once the catalog is registered
t.t("home.titel")
// @ts-expect-error - another locale's catalog is checked against the registered shape
const bad: Translation = { home: ["x"] }
// @ts-expect-error - so is a catalog passed straight to createFormatter
createFormatter("de", { faq: "x" })

// The bare \`Formatter\` (what the adapters' useT() returns) is the registered one.
const f: Formatter = t
f.t("home.cta")
// @ts-expect-error - not a registered key
f.t("nope")
const faq = f.get("faq")
faq?.map((item) => item.q.toUpperCase())

export { bad }
`

test("augmenting Register types every formatter, catalog and key in the program", async () => {
  const root = await mkdtemp(join(tmpdir(), "nifra-i18n-register-"))
  try {
    const file = join(root, "app.ts")
    await writeFile(file, FIXTURE)
    const program = ts.createProgram([file], {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noEmit: true,
      noUnusedLocals: true,
      paths: { "@nifrajs/i18n": [join(import.meta.dir, "../src/index.ts")] },
      skipLibCheck: true,
      strict: true,
      target: ts.ScriptTarget.ESNext,
      types: [],
    })
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
    expect(diagnostics).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
