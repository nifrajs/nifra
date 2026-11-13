import { describe, expect, test } from "bun:test"
import { evaluateDocConsts } from "./doc-code-consts.ts"
import { docDataBindings, evaluateDataCalls } from "./doc-data.ts"
import { jsxToMarkdown } from "./llms-convert.ts"
import { emptyFences } from "./llms-corpus-check.ts"

const page = (consts: string, body: string): string =>
  `${consts}\nexport default function Page() {\n  return (\n    <div>\n${body}\n    </div>\n  )\n}\n`

const convert = (src: string): string =>
  jsxToMarkdown("page.tsx", src, evaluateDocConsts("page.tsx", src))

describe("doc consts", () => {
  test("joined arrays, templates over consts, and + evaluate to the code the page shows", () => {
    const { values, unresolved } = evaluateDocConsts(
      "page.tsx",
      [
        'const BASE = "nifra check"',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a fixture file's own template literal, written as source text
        'const STEPS = [`${BASE} --json`, "nifra fix --code NF-C030"].join("\\n")',
        'const BOTH = BASE + " && " + STEPS',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a fixture file's own template literal, written as source text
        "const ESCAPED = `a \\` b \\${c}`",
        "const meta = docsMeta()",
      ].join("\n"),
    )
    expect(values.get("STEPS")).toBe("nifra check --json\nnifra fix --code NF-C030")
    expect(values.get("BOTH")).toBe("nifra check && nifra check --json\nnifra fix --code NF-C030")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the escaped interpolation the converter keeps literal
    expect(values.get("ESCAPED")).toBe("a ` b ${c}")
    expect(unresolved.get("meta")).toBe("CallExpression is not a string the page can show")
  })

  test("literal two-column rows evaluate for static JSX tables", () => {
    const { tuples } = evaluateDocConsts(
      "page.tsx",
      'const TUPLE = [["React", "19.3.1"], ["TypeScript", "6.0.3"]] as const',
    )
    expect(tuples.get("TUPLE")).toEqual([
      ["React", "19.3.1"],
      ["TypeScript", "6.0.3"],
    ])
  })
})

describe("jsxToMarkdown", () => {
  test("a joined const fills its block, fenced in the language the page names", () => {
    const md = convert(
      page(
        'const CMD = ["nifra upgrade 5.0.0", "nifra check"].join("\\n")\nconst JSON_SAMPLE = `{ "a": 1 }`',
        '<CodeBlock code={CMD} lang="bash" />\n<CodeBlock code={JSON_SAMPLE} lang="json" />\n<CodeBlock code={CMD} />',
      ),
    )
    expect(md).toContain("```bash\nnifra upgrade 5.0.0\nnifra check\n```")
    expect(md).toContain('```json\n{ "a": 1 }\n```')
    expect(md).toContain("```ts\nnifra upgrade 5.0.0")
    expect(emptyFences(md)).toEqual([])
  })

  test("an inline code expression is evaluated against the page's consts", () => {
    const md = convert(
      page('const A = "a"', '<CodeBlock\n  code={\n    A + "\\nb"\n  }\n  lang="ts"\n/>'),
    )
    expect(md).toBe("```ts\na\nb\n```")
  })

  test("a literal tuple map renders table rows instead of JSX residue", () => {
    const md = convert(
      page(
        'const TUPLE = [["React", "19.3.1"], ["TypeScript", "6.0.3"]] as const',
        "<table><thead><tr><th>Dependency</th><th>Certified tuple</th></tr></thead><tbody>{TUPLE.map(([name, version]) => <tr key={name}><td>{name}</td><td>{version}</td></tr>)}</tbody></table>",
      ),
    )
    expect(md).toContain(
      "| Dependency | Certified tuple |\n| --- | --- |\n| React | 19.3.1 |\n| TypeScript | 6.0.3 |",
    )
    expect(md).not.toContain("TUPLE.map")
  })

  test("a literal pipe in a tuple cell is escaped so the row keeps two columns", () => {
    const md = convert(
      page(
        'const TUPLE = [["React | Solid", "19 | 1"]] as const',
        "<table><thead><tr><th>Dependency</th><th>Certified tuple</th></tr></thead><tbody>{TUPLE.map(([name, version]) => <tr key={name}><td>{name}</td><td>{version}</td></tr>)}</tbody></table>",
      ),
    )
    expect(md).toContain("| React \\| Solid | 19 \\| 1 |")
  })

  test("a backslash in a tuple cell is escaped too, so it cannot cancel the pipe escape", () => {
    const md = convert(
      page(
        'const TUPLE = [["a\\\\|b", "c"]] as const',
        "<table><thead><tr><th>Dependency</th><th>Certified tuple</th></tr></thead><tbody>{TUPLE.map(([name, version]) => <tr key={name}><td>{name}</td><td>{version}</td></tr>)}</tbody></table>",
      ),
    )
    expect(md).toContain("| a\\\\\\|b | c |")
  })

  test("a line break inside a header or a tuple value cannot split the row", () => {
    const md = convert(
      page(
        'const TUPLE = [["Re\\nact", "19.3\\n.1"]] as const',
        "<table><thead><tr><th>Depen\ndency</th><th>Certified\n  tuple</th></tr></thead><tbody>{TUPLE.map(([name, version]) => <tr key={name}><td>{name}</td><td>{version}</td></tr>)}</tbody></table>",
      ),
    )
    expect(md).toContain("| Depen dency | Certified tuple |\n| --- | --- |\n| Re act | 19.3 .1 |")
  })

  test("a block whose code cannot be evaluated fails, naming the page and the const", () => {
    const src = page("const CODE = load()", "<CodeBlock code={CODE} />")
    expect(() => convert(src)).toThrow(
      "page.tsx: <CodeBlock code={CODE}> cannot be evaluated: CallExpression is not a string the page can show",
    )
    expect(() => convert(page("", "<CodeBlock code={MISSING} />"))).toThrow(
      "MISSING is not a const of this page",
    )
  })

  test("a braced value may mix template literals, braces inside them, and other code", () => {
    const md = convert(page('const B = "b"', '<CodeBlock code={`{a}` + B} lang="ts" />'))
    expect(md).toBe("```ts\n{a}b\n```")
  })

  test("angle brackets inside inline code survive the leftover-tag pass", () => {
    const md = convert(
      page(
        "",
        "<p>\n  Mark it with <code>// nifra-expect &lt;code&gt;: &lt;reason&gt;</code> or{\" \"}\n  <code>{'client<typeof app>'}</code>, never <b>bare</b>.\n</p>",
      ),
    )
    expect(md).toBe(
      "Mark it with `// nifra-expect <code>: <reason>` or\n`client<typeof app>`, never **bare**.",
    )
  })

  test("named and numeric entities decode to the ASCII the page shows", () => {
    const md = convert(
      page(
        "",
        "<p>\n  The app&apos;s <code>&#123; op &#125;</code> &ldquo;wins&rdquo; &rarr; done.\n</p>",
      ),
    )
    expect(md).toBe('The app\'s `{ op }` "wins" -> done.')
  })
})

describe("emptyFences", () => {
  test("names a block with nothing but blank lines inside", () => {
    expect(emptyFences("text\n```ts\n\n```\n```bash\nls\n```\n```\n```")).toEqual([
      "line 2: ```ts with no code",
      "line 8: ``` with no code",
    ])
  })
})

describe("data a page imports", () => {
  const data = new Map<string, unknown>([
    ["percentOf", (a: number, b: number) => Math.round((a / b) * 100)],
    ["rps", (framework: string) => (framework === "Nifra" ? 121 : 120)],
    ["formatPercent", (value: number) => `${value}%`],
  ])

  test("a call to a data export renders the text the page shows, across lines", () => {
    const body = `at {formatPercent(\n  percentOf(\n    rps("Nifra"),\n    rps("Elysia"),\n  ),\n)} of Elysia`
    expect(evaluateDataCalls("page.tsx", body, data)).toBe("at 101% of Elysia")
  })

  test("a call to anything else is left for the converter as it was", () => {
    const body = "{ROWS.map((row) => (\n{local(1)} {formatPercent(5)}"
    expect(evaluateDataCalls("page.tsx", body, data)).toBe("{ROWS.map((row) => (\n{local(1)} 5%")
  })

  test("a data call that reads a page local throws, naming the page", () => {
    expect(() => evaluateDataCalls("page.tsx", "{formatPercent(local)}", data)).toThrow(
      "page.tsx: {formatPercent(local)} reads Identifier",
    )
  })

  test("only value imports from shared/data modules are bound", async () => {
    const bindings = await docDataBindings(
      `${import.meta.dir}/../site/routes/docs/page.tsx`,
      [
        'import { formatPercent, type HttpWorkloadMetric } from "../../shared/data/benchmarks"',
        'import { pageMeta } from "../../shared/meta"',
      ].join("\n"),
    )
    expect([...bindings.keys()]).toEqual(["formatPercent"])
    expect(typeof bindings.get("formatPercent")).toBe("function")
  })
})
