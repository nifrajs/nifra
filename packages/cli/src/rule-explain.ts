/**
 * `nifra explain NF-xxxx`: a rule code answered from the catalog, with no project read. The catalog
 * loads only when a code is asked for, so the explain command's other paths never pay for it.
 */

/** The shape of a built-in rule code. A positional that matches it is a code, not an error message. */
export const RULE_CODE_SHAPE = /^NF-[A-Z]\d{3}$/

const DOCS_ORIGIN = "https://nifra.dev"

export interface RuleExplainOutput {
  readonly kind: "rule"
  readonly code: string
  readonly title: string
  /** The `nifra review` check it reports under. */
  readonly category: string
  /** What the rule reports and why it matters. */
  readonly message: string
  readonly fix: string
  readonly command?: string
  readonly docs: string
}

export interface UnknownRuleOutput {
  readonly code: "NIFRA_UNKNOWN_RULE"
  readonly message: string
}

export async function explainRule(code: string): Promise<RuleExplainOutput | UnknownRuleOutput> {
  const [{ isBuiltInCode, RETIRED_CODES, RULE_CODES }, { RULE_EXPLANATIONS }, { CHECK_CODES }] =
    await Promise.all([
      import("./rules/codes.ts"),
      import("./rules/explanations.ts"),
      import("./review.ts"),
    ])
  if (RETIRED_CODES.has(code))
    return {
      code: "NIFRA_UNKNOWN_RULE",
      message: `${code} is retired: no rule reports it any more, and the code is never reused.`,
    }
  if (!isBuiltInCode(code) || !Object.hasOwn(RULE_CODES, code))
    return {
      code: "NIFRA_UNKNOWN_RULE",
      message: `${code} is not a nifra rule code. \`nifra check --json\` lists each finding's code; \`nifra explain "<message>"\` explains an error instead.`,
    }
  const explanation = RULE_EXPLANATIONS[code]
  const out: RuleExplainOutput = {
    kind: "rule",
    code,
    title: RULE_CODES[code],
    category: CHECK_CODES[code] ?? "configuration",
    message: explanation.why,
    fix: explanation.fix,
    docs: `${DOCS_ORIGIN}${explanation.docs}`,
  }
  return explanation.command === undefined ? out : { ...out, command: explanation.command }
}

export const isRuleExplanation = (value: unknown): value is RuleExplainOutput =>
  typeof value === "object" &&
  value !== null &&
  Reflect.get(value, "kind") === "rule" &&
  ["code", "title", "category", "message", "fix", "docs"].every(
    (key) => typeof Reflect.get(value, key) === "string",
  )

export function renderRuleExplanation(out: RuleExplainOutput): string[] {
  return [
    `${out.code}  ${out.title}  (${out.category})`,
    `  ${out.message}`,
    `  fix: ${out.fix}`,
    ...(out.command === undefined ? [] : [`  run: ${out.command}`]),
    `  docs: ${out.docs}`,
  ]
}
