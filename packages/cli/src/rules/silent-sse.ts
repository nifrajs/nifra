import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { createSourceFacts } from "../internal/source-facts.ts"
import type { TypeScriptApi } from "../internal/typescript-import.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
import type { CheckRule } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const SILENT_SSE_EXPECTATION = ["NF-C061", "silent-sse"]
/** Bun's `idleTimeoutSec` default: a connection that moves no bytes for this long is closed. */
const BUN_IDLE_SECONDS = 10
const BUN_LISTENER = /\.listen\s*\(|\bBun\.serve\s*\(/
/** What sets a listener's idle timeout: `withIdleTimeout`, `listen()`'s `idleTimeoutSec`, `Bun.serve()`'s `idleTimeout`. */
const IDLE_TUNING_NAMES: ReadonlySet<string> = new Set([
  "withIdleTimeout",
  "idleTimeoutSec",
  "idleTimeout",
])
const IDLE_TUNING_HINT = /\bwithIdleTimeout\b|\bidleTimeoutSec\b|\bidleTimeout\b/

/** Whether code in `tree` names one of {@link IDLE_TUNING_NAMES}: a comment or a string that says so tunes nothing. */
function tunesIdleTimeout(ts: TypeScriptApi, tree: TSApi.SourceFile): boolean {
  const visit = (node: TSApi.Node): boolean => {
    if (ts.isIdentifier(node) && IDLE_TUNING_NAMES.has(node.text)) return true
    return ts.forEachChild(node, visit) === true
  }
  return visit(tree)
}

/**
 * NF-C061: in a project served by a Bun `listen()` or `Bun.serve()`, an SSE stream that sends no ping
 * inside the listener's idle timeout. Bun closes a connection that moves no bytes for 10 seconds, so
 * a stream that stays silent that long is cut, and `app.fetch` in a test never shows it. A project
 * that tunes the timeout in code anywhere (`withIdleTimeout`, `idleTimeoutSec`, `idleTimeout`) is left alone.
 */
export const silentSseRule: CheckRule = {
  code: "NF-C061",
  title: "SSE stream with no heartbeat under Bun's idle timeout",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return []
    const facts = createSourceFacts(ts)
    const candidates: { file: string; text: string; tree: TSApi.SourceFile }[] = []
    let bunListener = false
    for (const file of ctx.project.source.files) {
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue
      const text = ctx.project.source.read(file)
      if (text === undefined) continue
      const tuned = IDLE_TUNING_HINT.test(text)
      const serves = BUN_LISTENER.test(text)
      const streams = /\bsse\b/.test(text)
      if (!tuned && !serves && !streams) continue
      const tree = facts.parse(file, text)
      if (tree === undefined) continue
      if (tuned && tunesIdleTimeout(ts, tree)) return []
      bunListener ||= serves
      if (streams) candidates.push({ file, text, tree })
    }
    if (!bunListener) return []
    const findings: Diagnostic[] = []
    for (const { file, text, tree } of candidates) {
      const lines = text.split("\n")
      for (const stream of facts.silentSseStreams(tree, BUN_IDLE_SECONDS)) {
        const line = tree.getLineAndCharacterOfPosition(stream.position).line + 1
        if (commentBlockExpectation(lines, line, SILENT_SSE_EXPECTATION) !== undefined) continue
        findings.push(
          diagnostic({
            code: "NF-C061",
            severity: "info",
            file,
            line,
            message:
              stream.keepAlive === undefined
                ? `This SSE stream sends no keep-alive ping, so on a Bun server it is closed after ${BUN_IDLE_SECONDS} seconds without an event. Pass \`{ keepAlive: 5_000 }\`, or raise the timeout: \`withIdleTimeout\` from \`@nifrajs/core/idle-timeout\` under \`listen()\`, or the \`idleTimeout\` option of \`Bun.serve()\`.`
                : `This SSE stream pings every ${stream.keepAlive} ms, which is not inside Bun's default ${BUN_IDLE_SECONDS}-second idle timeout, so a quiet stream is closed. Ping more often than every ${BUN_IDLE_SECONDS * 1000} ms, or raise the timeout with \`withIdleTimeout\` under \`listen()\` or the \`idleTimeout\` option of \`Bun.serve()\`.`,
            evidence: [
              "the project serves with a Bun listener and sets no idleTimeoutSec, idleTimeout or withIdleTimeout",
              `Bun closes a connection that moves no bytes for ${BUN_IDLE_SECONDS} seconds by default`,
              "a stream kept on purpose: `// nifra-expect NF-C061: <reason>` above the registration",
            ],
            verify: "nifra check",
          }),
        )
      }
    }
    return findings
  },
}
