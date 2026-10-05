/**
 * Private environment reads in browser-reachable code. Browser code (a route's frontend half,
 * `frontend/`, `shared/`) may read `NODE_ENV`, the bundler's own `import.meta.env` flags and variables
 * named with the public prefix; any other `process.env`, `import.meta.env`, `Bun.env` or `Deno.env`
 * read is a secret on its way to a browser, or a value that is silently `undefined` there.
 *
 * Detection works on tokens, not text, so a string or comment that mentions `process.env.X` is not a
 * read. TypeScript and JSX go through Bun's transpiler first: JSX prose becomes string literals and type
 * positions disappear. SFC and MDX files contribute only their code: scripts, markup expressions and
 * ESM lines.
 */
import { readFileSync } from "node:fs"
import { HTML_COMMENT, withoutMatches } from "./html-spans.ts"

const IMPORT_META_FLAGS = new Set(["MODE", "DEV", "PROD", "SSR", "BASE_URL"])

/** Words after which a `/` starts a regular expression rather than a division. */
const BEFORE_EXPRESSION = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
  "instanceof",
])

type Token =
  | { readonly kind: "id" | "punct" | "string"; readonly value: string }
  | { readonly kind: "other" }

/** JavaScript tokens, with strings, template text, comments and regular expressions skipped. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = []
  // One entry per open `${`: how many `{` are open inside it.
  const templates: number[] = []
  let i = 0
  const readTemplate = (from: number): number => {
    let j = from
    while (j < code.length) {
      const c = code[j]
      if (c === "\\") j += 2
      else if (c === "`") {
        tokens.push({ kind: "other" })
        return j + 1
      } else if (c === "$" && code[j + 1] === "{") {
        templates.push(0)
        return j + 2
      } else j++
    }
    return j
  }
  const regexAllowed = (): boolean => {
    const prev = tokens.at(-1)
    if (prev === undefined) return true
    if (prev.kind === "id") return BEFORE_EXPRESSION.has(prev.value)
    if (prev.kind === "punct") return prev.value !== ")" && prev.value !== "]" && prev.value !== "}"
    return false
  }
  while (i < code.length) {
    const c = code[i] as string
    if (/\s/.test(c)) {
      i++
    } else if (c === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i)
      i = end === -1 ? code.length : end
    } else if (c === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2)
      i = end === -1 ? code.length : end + 2
    } else if (c === "'" || c === '"') {
      let j = i + 1
      let value = ""
      while (j < code.length && code[j] !== c && code[j] !== "\n") {
        if (code[j] === "\\") {
          value += code[j + 1] ?? ""
          j += 2
        } else value += code[j++]
      }
      tokens.push({ kind: "string", value })
      i = j + 1
    } else if (c === "`") {
      i = readTemplate(i + 1)
    } else if (c === "}" && templates.at(-1) === 0) {
      templates.pop()
      i = readTemplate(i + 1)
    } else if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1
      while (j < code.length && /[\w$\u0080-￿]/.test(code[j] as string)) j++
      tokens.push({ kind: "id", value: code.slice(i, j) })
      i = j
    } else if (/\d/.test(c) || (c === "." && /\d/.test(code[i + 1] ?? ""))) {
      let j = i + 1
      while (j < code.length && /[\w.]/.test(code[j] as string)) j++
      tokens.push({ kind: "other" })
      i = j
    } else if (c === "/" && regexAllowed()) {
      let j = i + 1
      let inClass = false
      while (j < code.length && code[j] !== "\n") {
        const d = code[j]
        if (d === "\\") j++
        else if (d === "[") inClass = true
        else if (d === "]") inClass = false
        else if (d === "/" && !inClass) break
        j++
      }
      j++
      while (j < code.length && /[a-z]/i.test(code[j] as string)) j++
      tokens.push({ kind: "other" })
      i = j
    } else if (c === "?" && code[i + 1] === "." && !/\d/.test(code[i + 2] ?? "")) {
      // Optional chaining reads the same property: `process?.env?.X` is `process.env.X`.
      tokens.push({ kind: "punct", value: "." })
      i += 2
    } else {
      const open = templates.length - 1
      if (c === "{" && open >= 0) templates[open] = (templates[open] as number) + 1
      if (c === "}" && open >= 0) templates[open] = (templates[open] as number) - 1
      tokens.push({ kind: "punct", value: c })
      i++
    }
  }
  return tokens
}

/** One environment read: what it looks like in source, and the variable it names, when it names one. */
interface EnvRead {
  readonly expression: string
  readonly name?: string
  /** `import.meta.env`, whose bundler flags (`MODE`, `DEV`, ...) are public. */
  readonly importMeta: boolean
}

function envReads(tokens: readonly Token[]): EnvRead[] {
  const reads: EnvRead[] = []
  const is = (at: number, kind: "id" | "punct", value: string): boolean => {
    const token = tokens[at]
    return token !== undefined && token.kind === kind && token.value === value
  }
  const stringAt = (at: number): string | undefined => {
    const token = tokens[at]
    return token?.kind === "string" ? token.value : undefined
  }
  const idAt = (at: number): string | undefined => {
    const token = tokens[at]
    return token?.kind === "id" ? token.value : undefined
  }
  /** A property read after an env object that ends at `at`: `.X` or `["X"]`. */
  const member = (base: string, at: number, importMeta: boolean): EnvRead => {
    const property = is(at, "punct", ".") ? idAt(at + 1) : undefined
    if (property !== undefined)
      return { expression: `${base}.${property}`, name: property, importMeta }
    const key = is(at, "punct", "[") && is(at + 2, "punct", "]") ? stringAt(at + 1) : undefined
    if (key !== undefined)
      return { expression: `${base}[${JSON.stringify(key)}]`, name: key, importMeta }
    return { expression: base, importMeta }
  }
  for (let i = 0; i < tokens.length; i++) {
    const head = idAt(i)
    if (
      (head === "process" || head === "Bun") &&
      is(i + 1, "punct", ".") &&
      is(i + 2, "id", "env")
    ) {
      reads.push(member(`${head}.env`, i + 3, false))
    } else if (
      head === "import" &&
      is(i + 1, "punct", ".") &&
      is(i + 2, "id", "meta") &&
      is(i + 3, "punct", ".") &&
      is(i + 4, "id", "env")
    ) {
      reads.push(member("import.meta.env", i + 5, true))
    } else if (head === "Deno" && is(i + 1, "punct", ".") && is(i + 2, "id", "env")) {
      const method = is(i + 3, "punct", ".") ? idAt(i + 4) : undefined
      const name =
        (method === "get" || method === "has") && is(i + 5, "punct", "(")
          ? stringAt(i + 6)
          : undefined
      reads.push(
        name !== undefined && is(i + 7, "punct", ")")
          ? { expression: `Deno.env.${method}(${JSON.stringify(name)})`, name, importMeta: false }
          : {
              expression: method === undefined ? "Deno.env" : `Deno.env.${method}()`,
              importMeta: false,
            },
      )
    }
  }
  return reads
}

// A closing tag ends at any space, slash or `>` after its name, as a browser and the compilers read it.
const SCRIPT_ELEMENT = /<script\b[^>]*>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi
const STYLE_ELEMENT = /<style\b[^>]*>[\s\S]*?<\/style(?=[\s/>])[^>]*>/gi

/** The code of a Svelte or Vue file: its scripts as modules, its markup expressions one by one. */
function sfcCode(
  source: string,
  vue: boolean,
): { readonly scripts: string[]; readonly expressions: string[] } {
  const scripts: string[] = []
  const withoutScripts = withoutMatches(source, SCRIPT_ELEMENT, (match) => {
    scripts.push(match[1] ?? "")
  })
  const markup = withoutMatches(withoutMatches(withoutScripts, STYLE_ELEMENT), HTML_COMMENT)
  const expressions: string[] = []
  if (vue) {
    for (const match of markup.matchAll(/\{\{([\s\S]*?)\}\}/g)) expressions.push(match[1] ?? "")
    for (const match of markup.matchAll(/\s(?::|@|v-|#)[\w:.[\]-]*\s*=\s*("([^"]*)"|'([^']*)')/g))
      expressions.push(match[2] ?? match[3] ?? "")
  } else {
    expressions.push(...braceExpressions(markup))
  }
  return { scripts, expressions }
}

/** Every top-level `{...}` region of markup, braces balanced. */
function braceExpressions(markup: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < markup.length; i++) {
    if (markup[i] === "{") {
      if (depth++ === 0) start = i + 1
    } else if (markup[i] === "}" && depth > 0 && --depth === 0) {
      out.push(markup.slice(start, i))
    }
  }
  return out
}

/** The code of an MDX file: its import/export lines and `{...}` expressions, never its prose or code. */
function mdxCode(source: string): string[] {
  const text = source
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "")
    .replace(/`[^`\n]*`/g, "")
  const esm = text.split("\n").filter((line) => /^(?:import|export)\b/.test(line))
  return [...esm, ...braceExpressions(text)]
}

const SCRIPT = /\.(?:[cm]?[jt]sx?)$/

function transpile(code: string, loader: "ts" | "tsx" | "js" | "jsx"): string {
  if (typeof Bun === "undefined") return code
  try {
    return new Bun.Transpiler({ loader }).transformSync(code)
  } catch {
    // Code the transpiler cannot parse fails the real build anyway; scan it as written.
    return code
  }
}

const loaderFor = (file: string): "ts" | "tsx" | "js" | "jsx" =>
  /\.[cm]?tsx$/.test(file)
    ? "tsx"
    : /\.[cm]?ts$/.test(file)
      ? "ts"
      : /\.jsx$/.test(file)
        ? "jsx"
        : "js"

/**
 * The private environment reads in one browser-reachable file, as written (`process.env.SECRET`).
 * `publicPrefix` is the app's public-env prefix; `""` makes every variable but `NODE_ENV` private.
 */
export function privateEnvReads(file: string, source: string, publicPrefix: string): string[] {
  if (!/\benv\b/.test(source)) return []
  const chunks: string[] = []
  if (SCRIPT.test(file)) chunks.push(transpile(source, loaderFor(file)))
  else if (/\.(?:svelte|vue)$/.test(file)) {
    const { scripts, expressions } = sfcCode(source, file.endsWith(".vue"))
    chunks.push(...scripts.map((script) => transpile(script, "ts")), ...expressions)
  } else if (/\.mdx?$/.test(file)) chunks.push(...mdxCode(source))
  else return []
  const allowed = (read: EnvRead): boolean => {
    if (read.name === undefined) return false
    if (read.name === "NODE_ENV") return true
    if (read.importMeta && IMPORT_META_FLAGS.has(read.name)) return true
    return publicPrefix !== "" && read.name.startsWith(publicPrefix)
  }
  const found = new Set<string>()
  for (const chunk of chunks) {
    if (!/\benv\b/.test(chunk)) continue
    for (const read of envReads(tokenize(chunk))) if (!allowed(read)) found.add(read.expression)
  }
  return [...found].sort()
}

/** The denial reason for a file's private environment reads. */
export function privateEnvReason(reads: readonly string[], publicPrefix: string): string {
  const allowed = publicPrefix === "" ? "NODE_ENV" : `NODE_ENV and variables named ${publicPrefix}*`
  return (
    `it reads private environment ${reads.length === 1 ? "variable" : "variables"} ${reads.join(", ")}. ` +
    `Browser code may read only ${allowed}; read the rest in a loader, an action or under backend/`
  )
}

/** The denial reason for one file's source, or `undefined` when it reads no private variable. */
export function privateEnvDenial(
  file: string,
  source: string,
  publicPrefix: string,
): string | undefined {
  const reads = privateEnvReads(file, source, publicPrefix)
  return reads.length === 0 ? undefined : privateEnvReason(reads, publicPrefix)
}

/** A per-file check for a finished build, reading each file once. */
export function privateEnvCheck(publicPrefix: string): (file: string) => string | undefined {
  const seen = new Map<string, string | undefined>()
  return (file) => {
    if (!seen.has(file)) {
      let source: string | undefined
      try {
        source = readFileSync(file, "utf8")
      } catch {
        source = undefined
      }
      seen.set(
        file,
        source === undefined ? undefined : privateEnvDenial(file, source, publicPrefix),
      )
    }
    return seen.get(file)
  }
}
