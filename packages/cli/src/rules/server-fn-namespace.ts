import { diagnostic } from "../diagnostics.ts"
import type { CheckRule } from "./index.ts"
import { scanSources } from "./source-scan.ts"

const SERVER_FN_SUFFIX = /\.fn(?:\.[cm]?[jt]sx?)?$/

/**
 * NF-C056: `serverFunctions("todos", mod)` where `mod` is `todos-list.fn.ts`. The client build calls
 * the namespace named by the file, so a mount under another word serves routes the stubs never reach
 * and every call 404s.
 */
export const serverFnNamespaceRule: CheckRule = {
  code: "NF-C056",
  title: "serverFunctions namespace differs from its module's filename",
  scan: (ctx) =>
    scanSources(
      ctx,
      ["NF-C056", "server-fn-namespace"],
      (text) => text.includes("serverFunctions") && text.includes(".fn"),
      (facts, tree) =>
        facts.serverFunctionMounts(tree).flatMap((mount) => {
          const base = mount.specifier.split("/").pop() ?? ""
          const expected = base.replace(SERVER_FN_SUFFIX, "")
          if (mount.namespace === expected) return []
          return [
            {
              position: mount.position,
              report: (line) =>
                diagnostic({
                  code: "NF-C056",
                  severity: "error",
                  file: tree.fileName,
                  line,
                  message: `serverFunctions(${JSON.stringify(mount.namespace)}, ...) mounts ${base}, whose client stubs call the namespace ${JSON.stringify(expected)}: every call 404s. Mount it as serverFunctions(${JSON.stringify(expected)}, ...), or rename the file.`,
                  evidence: [
                    "the client build names a *.fn.ts module's namespace after its filename without .fn",
                    `the server mounts it under /_nifra/fn/${mount.namespace}/, the stubs POST to /_nifra/fn/${expected}/`,
                    "a mount kept on purpose: `// nifra-expect NF-C056: <reason>` above the call",
                  ],
                  verify: "nifra check",
                }),
            },
          ]
        }),
    ),
}
