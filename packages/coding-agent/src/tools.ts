import { type NifraContextOptions, type NifraContextResult, runNifraContext } from "./context.ts"
import {
  runNifraVerification,
  type VerificationOptions,
  type VerificationResult,
} from "./verification.ts"

export interface NifraAgentTool {
  readonly name: "nifra.context" | "nifra.check" | "nifra.assure" | "nifra.test"
  readonly description: string
  readonly capability: "process"
  execute(): Promise<NifraContextResult | VerificationResult>
}

/** Short, provider-neutral instructions injected into Pi only when the optional agent is used. */
export const NIFRA_AGENT_INSTRUCTIONS = `
You are operating inside a Nifra project. Before making framework changes, use \`nifra context\` when available to inspect the current typed project surfaces. After changes, run \`nifra check --json\` and, when assurance is configured, \`nifra assure --json\`. Treat failed checks as structured repair work. Keep changes scoped, preserve existing user edits, and never expose secrets in responses or session notes.
`.trim()

/** Optional first-party tool descriptors. The Pi adapter can register these through an extension. */
export function createNifraTools(
  options: NifraContextOptions & Pick<VerificationOptions, "command">,
): readonly NifraAgentTool[] {
  const verification = (name: "check" | "assure" | "test"): Promise<VerificationResult> =>
    runNifraVerification(name, options)
  return Object.freeze([
    {
      name: "nifra.context",
      description: "Read the current Nifra project context and machine-readable agent surfaces.",
      capability: "process",
      execute: () => runNifraContext(options),
    },
    {
      name: "nifra.check",
      description: "Run the Nifra typed contract check and return structured diagnostics.",
      capability: "process",
      execute: () => verification("check"),
    },
    {
      name: "nifra.assure",
      description: "Run Nifra capability assurance and return structured diagnostics.",
      capability: "process",
      execute: () => verification("assure"),
    },
    {
      name: "nifra.test",
      description: "Run the configured Nifra test command with bounded output.",
      capability: "process",
      execute: () => verification("test"),
    },
  ])
}
