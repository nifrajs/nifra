import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import { createSourceFacts } from "../internal/source-facts.ts"
import type { TypeScriptApi } from "../internal/typescript-import.ts"
import { commentBlockExpectation } from "./comment-markers.ts"
import type { CheckRule } from "./index.ts"
import { loadRuleTypeScript } from "./typescript.ts"

const UNDECLARED_RESPONSE_EXPECTATION = ["NF-C054", "undeclared-response"]
const SERVER_FACTORY = /(?<![.\w$])(?:server|createWebApp)\s*\(/

/** The imports that build an OpenAPI document from the running routes, by module. */
const DOCUMENT_BUILDERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["@nifrajs/middleware", new Set(["openapi", "buildOpenApiDocument"])],
  ["@nifrajs/schema", new Set(["toOpenAPI", "toOpenAPIFromEvidence"])],
  ["@nifrajs/schema/openapi", new Set(["toOpenAPI", "toOpenAPIFromEvidence"])],
])

/** The first value import in `tree` of a builder in {@link DOCUMENT_BUILDERS}, as `name` from `module`. */
function documentBuilder(ts: TypeScriptApi, tree: TSApi.SourceFile): string | undefined {
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const names = DOCUMENT_BUILDERS.get(statement.moduleSpecifier.text)
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    if (names === undefined || clause?.isTypeOnly === true || bindings === undefined) continue
    if (!ts.isNamedImports(bindings)) continue
    for (const element of bindings.elements) {
      const name = (element.propertyName ?? element.name).text
      if (!element.isTypeOnly && names.has(name))
        return `\`${name}\` from ${statement.moduleSpecifier.text}`
    }
  }
  return undefined
}

/**
 * NF-C054: in a project that builds its OpenAPI document from the running routes (`openapi()`,
 * `buildOpenApiDocument`, `toOpenAPI`), a route registered without a `response` schema. The document
 * can only say such a route answers a generic `200`, so a client generated from it, in any language,
 * gets no type for the body. The typed client is unaffected: it reads the handler's TypeScript type.
 */
export const undeclaredResponseRule: CheckRule = {
  code: "NF-C054",
  title: "Route without a response schema in a published document",
  async scan(ctx) {
    const loaded = await loadRuleTypeScript(ctx)
    if (loaded.diagnostics !== undefined) return loaded.diagnostics
    const ts = loaded.compiler
    if (ts === undefined) return []
    const facts = createSourceFacts(ts)
    const sources: { file: string; text: string; tree: TSApi.SourceFile }[] = []
    let builder: string | undefined
    for (const file of ctx.project.source.files) {
      if (!/\.[cm]?tsx?$/.test(file)) continue
      const text = ctx.project.source.read(file)
      const serves = text !== undefined && SERVER_FACTORY.test(text)
      if (text === undefined || (!serves && !text.includes("@nifrajs/"))) continue
      const tree = facts.parse(file, text)
      if (tree === undefined) continue
      builder ??= documentBuilder(ts, tree)
      if (serves) sources.push({ file, text, tree })
    }
    if (builder === undefined) return []
    const findings: Diagnostic[] = []
    for (const { file, text, tree } of sources) {
      const lines = text.split("\n")
      for (const route of facts.undeclaredResponseRoutes(tree)) {
        const line = tree.getLineAndCharacterOfPosition(route.position).line + 1
        if (commentBlockExpectation(lines, line, UNDECLARED_RESPONSE_EXPECTATION) !== undefined)
          continue
        findings.push(
          diagnostic({
            code: "NF-C054",
            severity: "info",
            file,
            line,
            message: `${route.method} ${route.path} declares no \`response\` schema, so the OpenAPI document this project builds says only that it answers 200: a client generated from it gets no type for the body. Declare \`{ response: ... }\`, or generate the document with \`nifra openapi\`, which reads the handler's return type.`,
            evidence: [
              `the project builds its document from the running routes with ${builder}`,
              "a route without a response schema is documented as a 200 with no body type",
              "a route left out on purpose: `// nifra-expect NF-C054: <reason>` above the registration",
            ],
            verify: "nifra check",
          }),
        )
      }
    }
    return findings
  },
}
