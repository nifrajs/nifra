/**
 * A doc page's JSX body as markdown, for `llms-full.txt`. Kept apart from gen-llms.ts, which writes
 * files when it is imported, so the conversion can be tested on its own.
 */
import { type DocConsts, evaluateDocConsts } from "./doc-code-consts.ts"
import { type DocData, evaluateDataCalls } from "./doc-data.ts"

function decodeEntities(s: string): string {
  // `&amp;` decodes LAST: decoding it first turns `&amp;lt;` into `&lt;` which the next pass then
  // wrongly decodes again (double-unescaping) - the text meant a literal "&lt;".
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&(?:#39|apos|lsquo|rsquo);/g, "'")
    .replace(/&[lr]dquo;/g, '"')
    .replace(/&rarr;/g, "->")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&")
}

/** Resolve simple JSX expression containers in prose: {" "} → space, {"text"} / {'text'} → text,
 * {`x`} → x. */
function resolveExpressions(s: string): string {
  return s
    .replace(/\{"\s*"\}/g, " ")
    .replace(/\{"((?:[^"\\]|\\.)*)"\}/g, (_, t: string) => t.replace(/\\([\\'"])/g, "$1"))
    .replace(/\{'((?:[^'\\]|\\.)*)'\}/g, (_, t: string) => t.replace(/\\([\\'"])/g, "$1"))
    .replace(/\{`((?:[^`\\]|\\.)*)`\}/g, (_, t) => t)
}

/** A line that's leftover JSX-expression residue (e.g. a `{ARRAY.map((x) => (` data table that the
 * converter can't evaluate) rather than prose. Dropped during conversion - runs while code is still
 * placeholders, so real code is never matched. Keeps blank lines + placeholders. */
function isJsxResidue(line: string): boolean {
  if (line === "" || /^@@(?:FENCE|CODE)\d+@@$/.test(line)) return false
  if (/^\{[\w$]+(?:\.[\w$]+)*(?:\.map\b|\()/.test(line)) return true // {FRAMEWORKS.map((f) => (  {fn(
  if (/^`?\{[\w$]+(?:\.[\w$]+)+\}`?$/.test(line)) return true // {f.name}  `{f.pkg}`
  if (/^[)\]}]+[);,]*$/.test(line)) return true // ))}  )}  )  };
  return false
}

// A braced value is a run of template literals and other non-brace characters. The two never start
// with the same character, so a tag that fails to match backtracks linearly.
const CODE_BLOCK_TAG =
  /<CodeBlock\s+((?:[\w-]+=(?:\{(?:`(?:[^`\\]|\\.)*`|[^{}`])*\}|"[^"]*")\s*)*)\/>/g

/** The code a `<CodeBlock>`'s attributes name, or why it names none the page can show. */
function codeBlockSource(
  file: string,
  src: string,
  attributes: string,
  consts: DocConsts,
): { readonly code: string; readonly lang: string } {
  const lang = /\blang="([\w-]+)"/.exec(attributes)?.[1] ?? "ts"
  const expression = /\bcode=\{((?:`(?:[^`\\]|\\.)*`|[^{}`])*)\}/.exec(attributes)?.[1]?.trim()
  if (expression === undefined)
    throw new Error(`${file}: <CodeBlock ${attributes.trim()}/> has no code attribute`)
  if (/^\w+$/.test(expression)) {
    const code = consts.values.get(expression)
    if (code === undefined)
      throw new Error(
        `${file}: <CodeBlock code={${expression}}> cannot be evaluated: ${consts.unresolved.get(expression) ?? `${expression} is not a const of this page`}`,
      )
    return { code, lang }
  }
  // An inline expression may read the page's consts, so it is evaluated as one more of them.
  const probe = "__CODE_BLOCK__"
  const inline = evaluateDocConsts(file, `${src}\nconst ${probe} = (${expression})\n`)
  const code = inline.values.get(probe)
  if (code === undefined)
    throw new Error(
      `${file}: <CodeBlock code={${expression}}> cannot be evaluated: ${inline.unresolved.get(probe) ?? "not a string expression"}`,
    )
  return { code, lang }
}

/** Convert a doc page's JSX component body to markdown. Code blocks are pulled out as placeholders
 * BEFORE prose transforms so their raw `<`/`>`/`&`/`{}` survive untouched, then restored as fences.
 * A `<CodeBlock>` whose code cannot be evaluated throws, naming the page and the const. */
export function jsxToMarkdown(
  file: string,
  src: string,
  consts: DocConsts,
  data: DocData = new Map(),
): string {
  // Blank the code consts FIRST - their example snippets contain `export default function` /
  // `return (` that would otherwise be mistaken for the real component.
  let blanked = src
  for (const [start, end] of [...consts.ranges].sort((a, b) => b[0] - a[0]))
    blanked = blanked.slice(0, start) + blanked.slice(end)
  const stripped = blanked.replace(/\bconst\s+\w+\s*=\s*`(?:[^`\\]|\\.)*`/g, "")
  const compStart = stripped.search(/export\s+default/)
  const start = stripped.indexOf("return (", compStart < 0 ? 0 : compStart)
  if (start < 0) return ""
  let body = stripped.slice(start + "return (".length, stripped.lastIndexOf(")"))

  // 1. Protect code: <CodeBlock code={NAME} lang="x" /> → placeholder.
  const fences: string[] = []
  body = body.replace(CODE_BLOCK_TAG, (_, attributes: string) => {
    const { code, lang } = codeBlockSource(file, src, attributes, consts)
    fences.push(`\`\`\`${lang}\n${code.trim()}\n\`\`\``)
    return `\n\n@@FENCE${fences.length - 1}@@\n\n`
  })
  if (body.includes("<CodeBlock"))
    throw new Error(`${file}: a <CodeBlock> is written in a form the converter cannot read`)
  body = evaluateDataCalls(file, body, data)
  // Inline code is text, never markup: `<reason>` inside it must survive the leftover-tag pass.
  const spans: string[] = []
  body = body.replace(/<code>([\s\S]*?)<\/code>/g, (_, t: string) => {
    spans.push(`\`${decodeEntities(resolveExpressions(t))}\``)
    return `@@CODE${spans.length - 1}@@`
  })

  // 2. Headings (drop the page <h1>, which duplicates the meta title we emit above).
  body = body
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/g, "")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, "\n\n### $1\n\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, "\n\n#### $1\n\n")
  // 3. Links, lists, paragraphs.
  body = body
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, "[$2]($1)")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/g, "\n- $1")
    .replace(/<\/?(?:ul|ol)[^>]*>/g, "\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/g, "\n\n$1\n\n")
  // 4. Inline emphasis → markdown.
  body = body.replace(/<\/?(?:b|strong)>/g, "**").replace(/<\/?(?:i|em)>/g, "_")
  // 5. Resolve remaining JSX expressions, strip leftover tags, decode entities.
  body = resolveExpressions(body).replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  // Strip leftover tags to a fixpoint: a single pass can splice removed delimiters into a new tag
  // (`<<b>i>` survives one pass as `<i>`).
  for (let prev = ""; prev !== body; ) {
    prev = body
    body = body.replace(/<[^>]+>/g, "")
  }
  body = decodeEntities(body)
  // 6. Normalize whitespace WHILE code is still placeholders, so trimming the JSX indentation off
  // prose lines (4-space lead would otherwise read as a markdown code block) never touches the code.
  body = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !isJsxResidue(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
  // Then restore the code verbatim (fences keep their own indentation).
  body = body
    .replace(/@@CODE(\d+)@@/g, (_, i) => spans[Number(i)] ?? "")
    .replace(/@@FENCE(\d+)@@/g, (_, i) => fences[Number(i)] ?? "")
  return body.trim()
}
