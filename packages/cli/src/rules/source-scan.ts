import type * as TSApi from "typescript"
import type { Diagnostic } from "../diagnostics.ts"
import { createSourceFacts, type SourceFacts } from "../internal/source-facts.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
import type { RuleContext } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

/** One place in a file a source rule reports, once the line it sits on is known. */
export interface SourceFinding {
  /** The offset in the file the finding is anchored to; its line is where `nifra-expect` is read. */
  readonly position: number
  readonly report: (line: number) => Diagnostic
}

/**
 * The shared walk of a lint over TypeScript sources: every `.ts`/`.tsx` file whose text passes `mayMatch`
 * is parsed, `find` names its findings, and one a `// nifra-expect <code>` block above its line
 * accepts is dropped.
 */
export async function scanSources(
  ctx: RuleContext,
  expectation: readonly [code: string, name: string],
  mayMatch: (text: string) => boolean,
  find: (facts: SourceFacts, tree: TSApi.SourceFile) => readonly SourceFinding[],
): Promise<readonly Diagnostic[]> {
  const loaded = await loadRuleTypeScript(ctx)
  if (loaded.diagnostics !== undefined) return loaded.diagnostics
  if (loaded.compiler === undefined) return []
  const facts = createSourceFacts(loaded.compiler)
  const findings: Diagnostic[] = []
  for (const file of ctx.project.source.files) {
    if (!/\.[cm]?tsx?$/.test(file)) continue
    const text = ctx.project.source.read(file)
    if (text === undefined || !mayMatch(text)) continue
    const tree = facts.parse(file, text)
    if (tree === undefined) continue
    const lines = text.split("\n")
    for (const found of find(facts, tree)) {
      const line = tree.getLineAndCharacterOfPosition(found.position).line + 1
      if (commentBlockExpectation(lines, line, expectation) === undefined)
        findings.push(found.report(line))
    }
  }
  return findings
}
