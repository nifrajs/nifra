import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { createSourceFacts } from "../internal/source-facts.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
import type { CheckRule } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const TEXT_SLOT_BOOLEAN_EXPECTATION = ["NF-C055", "text-slot-boolean"]
const ZOD_IMPORT = /from\s+["']zod(?:\/v4)?(?:\/mini)?["']/
const VALUE_IN = { query: "query", headers: "header", cookies: "cookie" } as const

/**
 * NF-C055: a zod `z.coerce.boolean()` in a route's `query`, `headers` or `cookies` schema. It is
 * `Boolean(value)`, and those values always arrive as text, so every non-empty value reads as `true`:
 * `?archived=false` and `?archived=0` both do. `z.stringbool()` reads the words a request sends.
 */
export const textSlotBooleanRule: CheckRule = {
  code: "NF-C055",
  title: "zod coerce.boolean() reads request text",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return []
    const facts = createSourceFacts(ts)
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      if (!/\.[cm]?tsx?$/.test(file)) continue
      const text = ctx.project.source.read(file)
      if (text === undefined || !text.includes("coerce") || !ZOD_IMPORT.test(text)) continue
      const tree = facts.parse(file, text)
      if (tree === undefined) continue
      const lines = text.split("\n")
      for (const found of facts.textSlotBooleanCoercions(tree)) {
        const line = tree.getLineAndCharacterOfPosition(found.position).line + 1
        if (commentBlockExpectation(lines, line, TEXT_SLOT_BOOLEAN_EXPECTATION) !== undefined)
          continue
        findings.push(
          diagnostic({
            code: "NF-C055",
            severity: "warn",
            file,
            line,
            message: `\`coerce.boolean()\` in the \`${found.slot}\` schema of ${found.method} ${found.path} reads every non-empty value as true, "false" and "0" included: a ${VALUE_IN[found.slot]} value is always text. Use \`z.stringbool()\`, which reads "false", "0", "no" and "off" as false and refuses text it does not know.`,
            evidence: [
              "zod's coerce.boolean() is Boolean(value): any non-empty string is true",
              `${found.slot} values arrive as text, so "false" never reaches the schema as false`,
              "a use kept on purpose: `// nifra-expect NF-C055: <reason>` above the call",
            ],
            verify: "nifra check",
          }),
        )
      }
    }
    return findings
  },
}
