import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { createSourceFacts } from "../internal/source-facts.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
import type { CheckRule } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const SERVER_FN_NAMESPACE_EXPECTATION = ["NF-C056", "server-fn-namespace"]
const SERVER_FN_SUFFIX = /\.fn(?:\.[cm]?[jt]sx?)?$/

/**
 * NF-C056: `serverFunctions("todos", mod)` where `mod` is `todos-list.fn.ts`. The client build calls
 * the namespace named by the file, so a mount under another word serves routes the stubs never reach
 * and every call 404s.
 */
export const serverFnNamespaceRule: CheckRule = {
  code: "NF-C056",
  title: "serverFunctions namespace differs from its module's filename",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return []
    const facts = createSourceFacts(ts)
    const findings: Diagnostic[] = []
    for (const file of ctx.project.source.files) {
      if (!/\.[cm]?tsx?$/.test(file)) continue
      const text = ctx.project.source.read(file)
      if (text === undefined || !text.includes("serverFunctions") || !text.includes(".fn")) continue
      const tree = facts.parse(file, text)
      if (tree === undefined) continue
      const lines = text.split("\n")
      for (const mount of facts.serverFunctionMounts(tree)) {
        const base = mount.specifier.split("/").pop() ?? ""
        const expected = base.replace(SERVER_FN_SUFFIX, "")
        if (mount.namespace === expected) continue
        const line = tree.getLineAndCharacterOfPosition(mount.position).line + 1
        if (commentBlockExpectation(lines, line, SERVER_FN_NAMESPACE_EXPECTATION) !== undefined)
          continue
        findings.push(
          diagnostic({
            code: "NF-C056",
            severity: "error",
            file,
            line,
            message: `serverFunctions(${JSON.stringify(mount.namespace)}, ...) mounts ${base}, whose client stubs call the namespace ${JSON.stringify(expected)}: every call 404s. Mount it as serverFunctions(${JSON.stringify(expected)}, ...), or rename the file.`,
            evidence: [
              "the client build names a *.fn.ts module's namespace after its filename without .fn",
              `the server mounts it under /_nifra/fn/${mount.namespace}/, the stubs POST to /_nifra/fn/${expected}/`,
              "a mount kept on purpose: `// nifra-expect NF-C056: <reason>` above the call",
            ],
            verify: "nifra check",
          }),
        )
      }
    }
    return findings
  },
}
