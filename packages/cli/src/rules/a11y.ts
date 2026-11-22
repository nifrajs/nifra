import { diagnostic } from "../diagnostics.ts"
import type { A11yCode } from "../internal/a11y-jsx.ts"
import type { CheckRule } from "./index.ts"
import { scanSources } from "./source-scan.ts"

const TEST_DIR = /(?:^|\/)(?:tests?|__tests__)\//
const MAY_MATCH = /\brole=|\baria-|\btabindex=|<(?:img|html|area|input)\b/i

/**
 * NF-C062 and NF-C063 - accessibility of the JSX a page renders, judged from what the markup spells out.
 * The two codes split by what a user loses: C062 is markup assistive technology cannot read at all (a
 * role that does not exist, a misspelled `aria-*` attribute, a role missing the state it requires), and
 * C063 is markup it reads worse than it could (no `alt`, a positive `tabindex`, a `<div role="button">`).
 * A `nifra-expect a11y: <reason>` comment accepts a finding of either.
 *
 * What it cannot see stays out: contrast, focus order, keyboard operation and anything a spread or an
 * expression supplies. Pair it with axe-core in a browser test.
 */
function a11yRule(code: A11yCode, title: string): CheckRule {
  return {
    code,
    title,
    scan: (ctx) =>
      scanSources(ctx, {
        expectation: [code, "a11y"],
        requireReason: true,
        mayMatch: (text) => MAY_MATCH.test(text),
        find: (facts, tree) =>
          TEST_DIR.test(tree.fileName)
            ? []
            : facts
                .a11yFindings(tree)
                .filter((found) => found.code === code)
                .map((found) => ({
                  position: found.position,
                  expectAt: found.expectAt,
                  report: (line: number, note?: string) =>
                    diagnostic({
                      code,
                      severity: "warn",
                      file: tree.fileName,
                      line,
                      message: note === undefined ? found.message : `${found.message} (${note})`,
                      evidence: [
                        `kind: ${found.kind}`,
                        "WAI-ARIA 1.2 and ARIA in HTML, read from the markup in this file",
                        `a use kept on purpose: \`// nifra-expect ${code}: <reason>\` above the element`,
                      ],
                      verify: "nifra check",
                    }),
                })),
      }),
  }
}

export const unreadableAriaRule = a11yRule(
  "NF-C062",
  "ARIA markup assistive technology cannot read",
)
export const weakAccessibleMarkupRule = a11yRule(
  "NF-C063",
  "Markup assistive technology reads worse than it could",
)

export const a11yRules = Object.freeze([unreadableAriaRule, weakAccessibleMarkupRule])
