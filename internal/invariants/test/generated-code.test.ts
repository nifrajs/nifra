/**
 * A generator that writes a value into code or config writes it as data: for any string, the output
 * parses, the value reads back unchanged, and nothing in it runs. Each generator gets the same
 * hostile strings in the field an outsider (incident traffic, a file name, a config value) controls.
 * A generator may refuse a value by throwing; it may never emit something that means otherwise.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateRegressionTest, type IncidentCapsule } from "@nifrajs/testing"
import { routeTypeFiles } from "@nifrajs/web/route-types"
import ts from "typescript"
import { serializeBunfig } from "../../../packages/cli/src/dev-bun-config.ts"
import { componentServerEntry } from "../../../packages/web/src/server-components/server-entry.ts"

const CANARY = "__nifraGeneratedCodeRan"

const HOSTILE: readonly string[] = [
  `'`,
  `"`,
  "`",
  "\\",
  "\\u0041",
  `\${globalThis.x}`,
  "\n",
  "\r\n",
  "  ",
  "*/ /*",
  "</script>",
  "\u0000",
  "\u{1F600}",
  `"); globalThis.${CANARY} = 1; ("`,
  `'); globalThis.${CANARY} = 1; ('`,
  `\` + (globalThis.${CANARY} = 1) + \``,
  `\n}); globalThis.${CANARY} = 1; ({\n`,
]

const transpiler = new Bun.Transpiler({ loader: "ts" })

/** Run transpiled module code with its imports replaced by `bindings`; returns nothing. */
function runModule(code: string, bindings: Record<string, unknown>): void {
  const js = transpiler.transformSync(code).replace(/^import\b[^\n]*\n/gm, "")
  new Function(...Object.keys(bindings), js)(...Object.values(bindings))
}

interface Generator {
  readonly name: string
  readonly file: string
  /** Generates with `value` in an outside-controlled field and returns what reads back. */
  roundTrip(value: string): unknown
}

const tmp: string[] = []
afterAll(() => {
  for (const dir of tmp) rmSync(dir, { recursive: true, force: true })
})

const GENERATORS: readonly Generator[] = [
  {
    name: "generateRegressionTest (request path and method from production traffic)",
    file: "packages/testing/src/incident.ts",
    roundTrip: (value) => {
      const capsule: IncidentCapsule = {
        id: "incident-1",
        capturedAt: "2026-01-01T00:00:00.000Z",
        request: { method: `GET${value}`, path: `/x${value}`, headers: {} },
        response: { status: 200 },
      }
      let title: string | undefined
      let replayed: IncidentCapsule | undefined
      runModule(generateRegressionTest(capsule), {
        describe: (name: string, body: () => void) => {
          title = name
          body()
        },
        it: (_name: string, body: () => Promise<void>) => void body(),
        assertIncidentReplays: (_app: unknown, emitted: IncidentCapsule) => {
          replayed = emitted
          return Promise.resolve()
        },
        app: {},
      })
      return { title, method: replayed?.request.method, path: replayed?.request.path }
    },
  },
  {
    name: "serializeBunfig (bunfig keys and values)",
    file: "packages/cli/src/dev-bun-config.ts",
    roundTrip: (value) => {
      const data = { define: { [`k${value}`]: `v${value}` }, serve: { static: { env: value } } }
      return Bun.TOML.parse(serializeBunfig(data))
    },
  },
  {
    name: "componentServerEntry (build entry and asset names)",
    file: "packages/web/src/server-components/server-entry.ts",
    roundTrip: (value) => {
      const source = componentServerEntry({
        build: `b${value}`,
        entry: `e${value}`,
        styles: [`s${value}`],
        assets: [`a${value}`],
        serverEntry: `server${value}.js`,
        platform: "bun",
      })
      return transpiler.scan(source).imports.map((entry) => entry.path)
    },
  },
  {
    name: "routeTypeFiles (route file names)",
    file: "packages/web/src/route-types.ts",
    roundTrip: (value) => {
      if (/[/\\\0]/.test(value)) return "not a file name"
      const appRoot = mkdtempSync(join(tmpdir(), "nifra-invariants-routes-"))
      tmp.push(appRoot)
      const routes = join(appRoot, "routes")
      mkdirSync(routes)
      const name = `p${value}`
      writeFileSync(join(routes, `${name}.tsx`), "export default () => null\n")
      writeFileSync(join(routes, `${name}.backend.ts`), "export const loader = () => ({})\n")
      return [...routeTypeFiles({ appRoot }).values()].flatMap((source) => {
        const file = ts.createSourceFile("route.d.ts", source, ts.ScriptTarget.Latest, true)
        const parseErrors =
          ts.transpileModule(source, { fileName: "route.ts", reportDiagnostics: true }).diagnostics
            ?.length ?? 0
        const specifiers: string[] = []
        const visit = (node: ts.Node): void => {
          if (
            ts.isImportTypeNode(node) &&
            ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)
          )
            specifiers.push(node.argument.literal.text)
          ts.forEachChild(node, visit)
        }
        visit(file)
        return [parseErrors, ...specifiers.map((path) => path.slice(path.lastIndexOf("/") + 1))]
      })
    },
  },
]

const expected = (generator: Generator, value: string): unknown => {
  switch (generator.file) {
    case "packages/testing/src/incident.ts":
      return {
        title: `regression: GET${value} /x${value}`,
        method: `GET${value}`,
        path: `/x${value}`,
      }
    case "packages/cli/src/dev-bun-config.ts":
      return { define: { [`k${value}`]: `v${value}` }, serve: { static: { env: value } } }
    case "packages/web/src/server-components/server-entry.ts":
      return ["node:fs/promises", "node:crypto", `./server${value}.js`]
    default:
      // The route table references search and slot types from its module, then the route's own types module.
      return /[/\\\0]/.test(value)
        ? "not a file name"
        : [0, `p${value}`, `p${value}`, 0, `p${value}.backend`, `p${value}`]
  }
}

for (const generator of GENERATORS) {
  describe(generator.name, () => {
    for (const value of HOSTILE) {
      test(`${JSON.stringify(value)} reads back unchanged, or is refused`, () => {
        Reflect.deleteProperty(globalThis, CANARY)
        let outcome: unknown
        try {
          outcome = generator.roundTrip(value)
        } catch (error) {
          // A refusal is a deliberate error from the generator, never a parse failure of its output.
          expect(String(error)).not.toMatch(/SyntaxError|Unexpected|Unterminated|parse/i)
          return
        } finally {
          expect(Reflect.get(globalThis, CANARY)).toBeUndefined()
        }
        expect(outcome).toEqual(expected(generator, value))
      })
    }
  })
}
