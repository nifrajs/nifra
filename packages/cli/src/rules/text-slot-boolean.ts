import { diagnostic } from "../diagnostics.ts"
import type { CheckRule } from "./index.ts"
import { scanSources } from "./source-scan.ts"

const TEXT_SLOT_BOOLEAN_EXPECTATION = ["NF-C055", "text-slot-boolean"] as const
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
  scan: (ctx) =>
    scanSources(ctx, {
      expectation: TEXT_SLOT_BOOLEAN_EXPECTATION,
      mayMatch: (text) => text.includes("coerce") && ZOD_IMPORT.test(text),
      find: (facts, tree) =>
        facts.textSlotBooleanCoercions(tree).map((found) => ({
          position: found.position,
          report: (line) =>
            diagnostic({
              code: "NF-C055",
              severity: "warn",
              file: tree.fileName,
              line,
              message: `\`coerce.boolean()\` in the \`${found.slot}\` schema of ${found.method} ${found.path} reads every non-empty value as true, "false" and "0" included: a ${VALUE_IN[found.slot]} value is always text. Use \`z.stringbool()\`, which reads "false", "0", "no" and "off" as false and refuses text it does not know.`,
              evidence: [
                "zod's coerce.boolean() is Boolean(value): any non-empty string is true",
                `${found.slot} values arrive as text, so "false" never reaches the schema as false`,
                "a use kept on purpose: `// nifra-expect NF-C055: <reason>` above the call",
              ],
              verify: "nifra check",
            }),
        })),
    }),
}
