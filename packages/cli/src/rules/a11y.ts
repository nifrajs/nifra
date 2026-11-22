import { readFileSync } from "node:fs"
import { join } from "node:path"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import type { A11yCode, A11yFinding } from "../internal/a11y-element.ts"
import { a11yTemplateFindings } from "../internal/a11y-template.ts"
import { lineLookup, templateFiles } from "../internal/template-markup.ts"
import { commentBlockExpectation, MISSING_EXPECTATION_REASON } from "./comment-markers.ts"
import type { CheckRule, RuleContext } from "./index.ts"
import { scanSources } from "./source-scan.ts"

const TEST_DIR = /(?:^|\/)(?:tests?|__tests__)\//
const SCRIPT_MAY_MATCH = /\brole=|\baria-|\btabindex=|<(?:img|html|area|input)\b/i
const TEMPLATE_MAY_MATCH = /\brole\b|\baria-|tabindex|<(?:img|area|input)\b/i

function report(
  code: A11yCode,
  file: string,
  line: number,
  found: A11yFinding,
  note: string | undefined,
  template: boolean,
): Diagnostic {
  const marker = template
    ? `<!-- nifra-expect ${code}: <reason> -->`
    : `// nifra-expect ${code}: <reason>`
  return diagnostic({
    code,
    severity: "warn",
    file,
    line,
    message: note === undefined ? found.message : `${found.message} (${note})`,
    evidence: [
      `kind: ${found.kind}`,
      "WAI-ARIA 1.2 and ARIA in HTML, read from the markup in this file",
      `a use kept on purpose: \`${marker}\` above the element`,
    ],
    verify: "nifra check",
  })
}

/** The findings in the `<template>` of every `.vue` file and the markup of every `.svelte` file. */
async function templateDiagnostics(ctx: RuleContext, code: A11yCode): Promise<Diagnostic[]> {
  const expectation = [code, "a11y"]
  const out: Diagnostic[] = []
  for (const file of await templateFiles(ctx.root)) {
    const text = readFileSync(join(ctx.root, file), "utf8")
    if (!TEMPLATE_MAY_MATCH.test(text)) continue
    const { findings, expectationLines } = a11yTemplateFindings(text, file.endsWith(".vue"))
    const lineOf = lineLookup(text)
    for (const found of findings) {
      if (found.code !== code) continue
      const line = lineOf(found.position)
      const expected =
        commentBlockExpectation(expectationLines, lineOf(found.expectAt), expectation) ??
        commentBlockExpectation(expectationLines, line, expectation)
      if (expected?.reason !== undefined) continue
      out.push(
        report(
          code,
          file,
          line,
          found,
          expected === undefined ? undefined : MISSING_EXPECTATION_REASON,
          true,
        ),
      )
    }
  }
  return out
}

/**
 * NF-C062 and NF-C063 - accessibility of the markup a page renders, judged from what it spells out:
 * the JSX of `.tsx` files (React, Preact, Solid) and the templates of `.vue` and `.svelte` files. The
 * two codes split by what a user loses: C062 is markup assistive technology cannot read at all (a role
 * that does not exist, a misspelled `aria-*` attribute, a role missing the state it requires), and C063
 * is markup it reads worse than it could (no `alt`, a positive `tabindex`, a `<div role="button">`).
 * A `nifra-expect a11y: <reason>` comment accepts a finding of either.
 *
 * What it cannot see stays out: contrast, focus order, keyboard operation and anything a spread or an
 * expression supplies. Pair it with axe-core in a browser test.
 */
function a11yRule(code: A11yCode, title: string): CheckRule {
  return {
    code,
    title,
    async scan(ctx) {
      const scripts = await scanSources(ctx, {
        expectation: [code, "a11y"],
        requireReason: true,
        mayMatch: (text) => SCRIPT_MAY_MATCH.test(text),
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
                    report(code, tree.fileName, line, found, note, false),
                })),
      })
      return [...scripts, ...(await templateDiagnostics(ctx, code))]
    },
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
