/**
 * Generates `packages/skills/skills/nifra-errors/SKILL.md`: one repair entry per stable code, so an
 * agent that meets `NIFRA_BACKEND_IN_CLIENT` or `NF-C031` loads one guide and lands on the fix. The
 * entries come from the two catalogs the tools already answer from (`nifra explain`, the dev
 * overlay), so the guide cannot drift from them. `--check` fails when the committed file is stale.
 */

import { isBuiltInCode, RULE_CODES } from "../packages/cli/src/rules/codes.ts"
import { RULE_EXPLANATIONS } from "../packages/cli/src/rules/explanations.ts"
import { DIAGNOSTIC_CATALOG } from "../packages/web/src/diagnostic-catalog.ts"

const OUT = "packages/skills/skills/nifra-errors/SKILL.md"
const SITE = "https://nifra.dev"

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

export function renderErrorSkill(): string {
  const parts: string[] = [
    [
      "---",
      "name: nifra-errors",
      "description: Use when a Nifra error, dev-overlay diagnostic or `nifra check` finding carries a stable code (NIFRA_BACKEND_IN_CLIENT, NIFRA_SCHEMA_PARSE, NF-C031, ...) - maps each code to its cause and repair. Also covers Solid 2.0 reactivity diagnostics the dev feed records. Load after the `nifra` skill.",
      "metadata:",
      `  docs: ${SITE}/docs/errors`,
      "---",
    ].join("\n"),
    [
      "# Nifra: repairing from an error code",
      "",
      "Generated from the catalogs `nifra explain` answers from; do not edit by hand (`bun run gen:errors`).",
      "Find the code in the error or finding, jump to its heading (the lower-cased code), apply the fix, then",
      "run the verify step. A code is stable forever: it is never renumbered or reused.",
      "",
      "`nifra explain <code-or-message>` returns the same entry live, with the frame in your source.",
    ].join("\n"),
    "## Runtime and build errors",
  ]
  for (const entry of DIAGNOSTIC_CATALOG) {
    const lines = [
      `### ${entry.code}`,
      "",
      `**Cause:** ${oneLine(entry.cause)}`,
      "",
      `**Fix:** ${oneLine(entry.fix)}`,
    ]
    if (entry.options !== undefined) {
      lines.push("", "Ways to fix it:")
      for (const option of entry.options) lines.push(`- ${option.label}: ${oneLine(option.fix)}`)
    }
    lines.push("", `Docs: ${SITE}/docs/${entry.docsAnchor}`)
    parts.push(lines.join("\n"))
  }
  parts.push("## `nifra check` findings")
  for (const code of Object.keys(RULE_CODES).sort()) {
    if (!isBuiltInCode(code)) continue
    const rule = RULE_EXPLANATIONS[code]
    const lines = [
      `### ${code}`,
      "",
      `${RULE_CODES[code]}`,
      "",
      `**Why:** ${oneLine(rule.why)}`,
      "",
      `**Fix:** ${oneLine(rule.fix)}`,
    ]
    if (rule.command !== undefined) lines.push("", `Run: \`${rule.command}\``)
    lines.push("", `Docs: ${SITE}${rule.docs}`)
    parts.push(lines.join("\n"))
  }
  parts.push(
    [
      "## Verify",
      "",
      "- A `nifra check` finding (`NF-...`): re-run `nifra check`; the fix is done when the code is gone from its output.",
      "- A runtime error (`NIFRA_...` in the dev server or a request): reproduce the failing action, then read `nifra errors`; the fix is done when no entry for the code remains that is not marked `stale`. A `stale` entry predates the last file change, so reproduce the action again to confirm the error does not return.",
      "- A build error (`NIFRA_...` from a standalone build): re-run the build; the fix is done when it exits 0. `nifra errors` reads the dev feed, not standalone build results, and `nifra check` does not reproduce runtime or build failures.",
    ].join("\n"),
  )
  return `${parts.join("\n\n")}\n`
}

if (import.meta.main) {
  const next = renderErrorSkill()
  if (process.argv.includes("--check")) {
    const current = (await Bun.file(OUT).exists()) ? await Bun.file(OUT).text() : ""
    if (current !== next) {
      console.error(`✗ ${OUT} is stale: run \`bun run gen:errors\``)
      process.exit(1)
    }
    console.log(`✓ ${OUT} is current`)
  } else {
    await Bun.write(OUT, next)
    console.log(`wrote ${OUT}`)
  }
}
