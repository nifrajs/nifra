import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { createSourceFacts } from "../internal/source-facts.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
import type { CheckRule } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const SILENT_SSE_EXPECTATION = ["NF-C061", "silent-sse"]
/** Bun's `idleTimeoutSec` default: a connection that moves no bytes for this long is closed. */
const BUN_IDLE_SECONDS = 10
const BUN_LISTENER = /\.listen\s*\(|\bBun\.serve\s*\(/
const IDLE_TUNING = /\bwithIdleTimeout\b|\bidleTimeoutSec\b/

/**
 * NF-C061: in a project served by a Bun `listen()` or `Bun.serve()`, an SSE stream that sends no ping
 * inside the listener's idle timeout. Bun closes a connection that moves no bytes for 10 seconds, so
 * a stream that stays silent that long is cut, and `app.fetch` in a test never shows it. A project
 * that tunes the timeout anywhere (`withIdleTimeout`, `idleTimeoutSec`) is left alone.
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
      if (IDLE_TUNING.test(text)) return []
      bunListener ||= BUN_LISTENER.test(text)
      if (!/\bsse\b/.test(text)) continue
      const tree = facts.parse(file, text)
      if (tree !== undefined) candidates.push({ file, text, tree })
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
                ? `This SSE stream sends no keep-alive ping, so on a Bun \`listen()\` server it is closed after ${BUN_IDLE_SECONDS} seconds without an event. Pass \`{ keepAlive: 5_000 }\`, or wrap the producer in \`withIdleTimeout\` from \`@nifrajs/core/idle-timeout\`.`
                : `This SSE stream pings every ${stream.keepAlive} ms, which is not inside Bun's ${BUN_IDLE_SECONDS}-second idle timeout, so a quiet stream is closed. Ping more often than every ${BUN_IDLE_SECONDS * 1000} ms, or wrap the producer in \`withIdleTimeout\`.`,
            evidence: [
              "the project serves with a Bun listener and sets no idleTimeoutSec or withIdleTimeout",
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
