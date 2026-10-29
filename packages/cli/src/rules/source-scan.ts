import type * as TSApi from "typescript"
import type { Diagnostic } from "../diagnostics.ts"
import { createSourceFacts, type SourceFacts } from "../internal/source-facts.ts"
import { commentBlockExpectation, MISSING_EXPECTATION_REASON } from "./comment-markers.ts"
import type { RuleContext } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

/** One place in a file a source rule reports, once the line it sits on is known. */
export interface SourceFinding {
  /** The offset in the file the finding is reported at. */
  readonly position: number
  /** Where a `nifra-expect` comment is read: the line of this offset, else the finding's own. */
  readonly expectAt?: number
  /** `note` is set when a `nifra-expect` comment names the finding but gives no reason. */
  readonly report: (line: number, note?: string) => Diagnostic
}

export interface SourceScan {
  /** The `nifra-expect` names that accept a finding. */
  readonly expectation: readonly string[]
  /** Whether a comment without a reason after its colon fails to accept a finding. */
  readonly requireReason?: boolean
  /** A cheap test of a file's text; the file is parsed only when it passes. */
  readonly mayMatch: (text: string) => boolean
  readonly find: (facts: SourceFacts, tree: TSApi.SourceFile) => readonly SourceFinding[]
}

/**
 * The shared walk of a lint over TypeScript sources: every `.ts`/`.tsx` file whose text passes `mayMatch`
 * is parsed, `find` names its findings, and one a `// nifra-expect <code>` block above its line
 * accepts is dropped.
 */
export async function scanSources(
  ctx: RuleContext,
  scan: SourceScan,
): Promise<readonly Diagnostic[]> {
  const loaded = await loadRuleTypeScript(ctx)
  if (loaded.diagnostics !== undefined) return loaded.diagnostics
  if (loaded.compiler === undefined) return []
  const facts = createSourceFacts(loaded.compiler)
  const findings: Diagnostic[] = []
  for (const file of ctx.project.source.files) {
    if (!/\.[cm]?tsx?$/.test(file)) continue
    const text = ctx.project.source.read(file)
    if (text === undefined || !scan.mayMatch(text)) continue
    const tree = facts.parse(file, text)
    if (tree === undefined) continue
    const lines = text.split("\n")
    const lineOf = (position: number): number =>
      tree.getLineAndCharacterOfPosition(position).line + 1
    for (const found of scan.find(facts, tree)) {
      const line = lineOf(found.position)
      const expected = commentBlockExpectation(
        lines,
        found.expectAt === undefined ? line : lineOf(found.expectAt),
        scan.expectation,
      )
      if (expected !== undefined && (scan.requireReason !== true || expected.reason !== undefined))
        continue
      findings.push(
        found.report(line, expected === undefined ? undefined : MISSING_EXPECTATION_REASON),
      )
    }
  }
  return findings
}
