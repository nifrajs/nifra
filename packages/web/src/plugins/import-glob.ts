/**
 * `import.meta.glob` for the Bun build. Vite expands it at build time and Bun has no equivalent, so
 * without this a module that loads its siblings through a glob bundles with the call left in place:
 * `import.meta.glob` is `undefined` in the browser and every file it named is missing from the build.
 */
import { existsSync } from "node:fs"
import { dirname, extname, relative, resolve, sep } from "node:path"
import type { BunPlugin } from "bun"
import { readSource } from "./kit.ts"

const SOURCE = /\.[cm]?[jt]sx?$/
const CALL = /\bimport\.meta\.glob\b/g
const LOADERS: Readonly<Record<string, "ts" | "tsx" | "jsx" | "js">> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".jsx": "jsx",
  // Bun's own default: a `.js` module may hold JSX, a `.mjs` or `.cjs` one may not.
  ".js": "jsx",
}

interface GlobOptions {
  readonly eager: boolean
  /** The export each entry takes: `"default"`, a name, or the whole module when unset. */
  readonly pick: string | undefined
}

/** A literal the call's arguments may hold. */
type Literal = string | boolean | readonly string[] | Readonly<Record<string, string | boolean>>

/**
 * `source` with every comment, string body and template text blanked to spaces, offsets kept, so a
 * glob named in prose or inside a string is never read as a call. A template's `${}` stays code.
 */
function codeOnly(source: string): string {
  const out = source.split("")
  const blank = (from: number, to: number): void => {
    for (let index = from; index < to; index++) if (out[index] !== "\n") out[index] = " "
  }
  // Reads code from `start`; inside a template's `${`, returns past the `}` that closes it.
  const code = (start: number, nested: boolean): number => {
    let index = start
    let depth = 0
    while (index < source.length) {
      const char = source[index]
      if (source.startsWith("//", index)) {
        const end = source.indexOf("\n", index)
        const stop = end === -1 ? source.length : end
        blank(index, stop)
        index = stop
      } else if (source.startsWith("/*", index)) {
        const end = source.indexOf("*/", index + 2)
        const stop = end === -1 ? source.length : end + 2
        blank(index, stop)
        index = stop
      } else if (char === '"' || char === "'") {
        let end = index + 1
        while (end < source.length && source[end] !== char) end += source[end] === "\\" ? 2 : 1
        blank(index + 1, Math.min(end, source.length))
        index = end + 1
      } else if (char === "`") {
        index = template(index + 1)
      } else if (nested && char === "}" && depth === 0) {
        return index + 1
      } else {
        if (nested && char === "{") depth += 1
        if (nested && char === "}") depth -= 1
        index += 1
      }
    }
    return index
  }
  const template = (start: number): number => {
    let index = start
    while (index < source.length && source[index] !== "`") {
      if (source.startsWith("${", index)) {
        index = code(index + 2, true)
      } else {
        const step = source[index] === "\\" ? 2 : 1
        blank(index, index + step)
        index += step
      }
    }
    return index + 1
  }
  code(0, false)
  return out.join("")
}

/** A reader over the call's argument text: string, array of strings, `{ key: literal }`, booleans. */
function argumentReader(text: string, start: number) {
  let at = start
  const space = (): void => {
    while (at < text.length && /\s/.test(text[at] ?? "")) at += 1
  }
  const fail = (): never => {
    throw new SyntaxError("not a literal")
  }
  const string = (): string => {
    const quote = text[at]
    if (quote !== '"' && quote !== "'" && quote !== "`") return fail()
    let value = ""
    at += 1
    while (at < text.length && text[at] !== quote) {
      const char = text[at] ?? ""
      if (quote === "`" && char === "$" && text[at + 1] === "{") return fail()
      if (char === "\\") {
        value += text[at + 1] ?? ""
        at += 2
      } else {
        value += char
        at += 1
      }
    }
    at += 1
    return value
  }
  const literal = (): Literal => {
    space()
    const char = text[at]
    if (char === "[") {
      at += 1
      const items: string[] = []
      for (;;) {
        space()
        if (text[at] === "]") break
        items.push(string())
        space()
        if (text[at] === ",") at += 1
        else if (text[at] !== "]") return fail()
      }
      at += 1
      return items
    }
    if (char === "{") {
      at += 1
      const entries: Record<string, string | boolean> = {}
      for (;;) {
        space()
        if (text[at] === "}") break
        const key = /^[A-Za-z_$][\w$]*/.exec(text.slice(at))?.[0]
        const name = key ?? string()
        if (key !== undefined) at += key.length
        space()
        if (text[at] !== ":") return fail()
        at += 1
        const value = literal()
        if (typeof value !== "string" && typeof value !== "boolean") return fail()
        entries[name] = value
        space()
        if (text[at] === ",") at += 1
        else if (text[at] !== "}") return fail()
      }
      at += 1
      return entries
    }
    if (text.startsWith("true", at) || text.startsWith("false", at)) {
      const value = text.startsWith("true", at)
      at += value ? 4 : 5
      return value
    }
    return string()
  }
  return {
    literal,
    space,
    get at() {
      return at
    },
    expect(char: string): void {
      space()
      if (text[at] !== char) fail()
      at += 1
    },
    peek(): string | undefined {
      space()
      return text[at]
    },
  }
}

const OPTION_NAMES = new Set(["eager", "import"])

// `Array.isArray` does not narrow a readonly array out of a union.
const isList = (value: Literal): value is readonly string[] => Array.isArray(value)

function readOptions(value: Literal | undefined): GlobOptions {
  if (value === undefined) return { eager: false, pick: undefined }
  if (typeof value !== "object" || isList(value)) throw new SyntaxError("options")
  const options: Readonly<Record<string, string | boolean>> = value
  for (const name of Object.keys(options))
    if (!OPTION_NAMES.has(name)) throw new SyntaxError(`option ${name}`)
  const eager = options.eager ?? false
  const pick = options.import
  if (typeof eager !== "boolean" || (pick !== undefined && typeof pick !== "string"))
    throw new SyntaxError("option types")
  return { eager, pick }
}

/** The files a set of patterns matches from `importer`, by Vite's rules, sorted; `!` excludes. */
function matchGlob(importer: string, root: string, patterns: readonly string[]): string[] {
  // Globs read `\` as an escape, so on Windows every path is matched with forward slashes.
  const slash = (path: string): string => (sep === "\\" ? path.replaceAll("\\", "/") : path)
  const absolute = (pattern: string): string => {
    if (pattern.startsWith("/")) return slash(resolve(root, `.${pattern}`))
    if (pattern.startsWith("./") || pattern.startsWith("../"))
      return slash(resolve(dirname(importer), pattern))
    throw new SyntaxError(`pattern ${pattern}`)
  }
  const include = patterns.filter((pattern) => !pattern.startsWith("!")).map(absolute)
  const exclude = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => new Bun.Glob(absolute(pattern.slice(1))))
  const found = new Set<string>()
  for (const pattern of include) {
    const segments = pattern.split("/")
    const wild = segments.findIndex((segment) => /[*?[\]{}]/.test(segment))
    if (wild === -1) {
      if (existsSync(pattern)) found.add(pattern)
      continue
    }
    const base = segments.slice(0, wild).join("/") || "/"
    const rest = segments.slice(wild).join("/")
    for (const file of new Bun.Glob(rest).scanSync({ cwd: base, onlyFiles: true })) {
      const path = slash(resolve(base, file))
      if (!rest.includes("node_modules") && path.split("/").includes("node_modules")) continue
      found.add(path)
    }
  }
  const self = slash(importer)
  return [...found]
    .filter((path) => path !== self && !exclude.some((glob) => glob.match(path)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** `value` as a JS string literal that stays on one line for every parser: before ES2019, U+2028 and
 * U+2029 end a line even inside a string. */
const stringLiteral = (value: string): string =>
  JSON.stringify(value).replace(
    /[\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16)}`,
  )

/** How a matched file is keyed, as Vite keys it: from the importer (`./x.ts`) or the root (`/x.ts`). */
function keyOf(importer: string, root: string, file: string, rooted: boolean): string {
  if (rooted) return `/${relative(root, file).replaceAll("\\", "/")}`
  const path = relative(dirname(importer), file).replaceAll("\\", "/")
  return path.startsWith(".") ? path : `./${path}`
}

/**
 * How often `import.meta.glob` appears in the module's code as Bun reads it: types stripped and JSX
 * text turned into strings, neither of which {@link codeOnly} can see in the source.
 */
function globsInCode(source: string, file: string): number {
  const js = new Bun.Transpiler({ loader: LOADERS[extname(file)] ?? "js" }).transformSync(source)
  return codeOnly(js).match(CALL)?.length ?? 0
}

const unclear = (file: string): Error =>
  new Error(
    `[nifra/web] ${file}: the Bun build cannot tell this module's import.meta.glob calls from text that names it (JSX text, or a quote inside a regular expression). Move the calls into a .ts module, or build with --vite.`,
  )

/**
 * `source` (the module at `file`) with each `import.meta.glob(...)` call expanded into an object of
 * the files it matches. Throws, naming the line, on a call this cannot read.
 */
export function expandImportGlobs(source: string, file: string, root: string): string {
  const real = globsInCode(source, file)
  // A docs page that shows the call in JSX text has no call to expand, and rewriting its text is wrong.
  if (real === 0) return source
  // JSX text is not a string to `codeOnly`: an apostrophe there flips what it reads as code.
  const code = codeOnly(source)
  if ((code.match(CALL)?.length ?? 0) !== real) throw unclear(file)
  const edits: Array<{ start: number; end: number; text: string }> = []
  const hoisted: string[] = []
  let call = 0
  for (const match of code.matchAll(CALL)) {
    let start = match.index
    const line = source.slice(0, start).split("\n").length
    // A bundle that expands the call has the function: a `typeof` guard around it reads so.
    const guard = /\btypeof\s+$/.exec(code.slice(Math.max(0, start - 32), start))
    if (guard !== null) {
      start -= guard[0].length
      edits.push({ start, end: match.index + match[0].length, text: '"function"' })
      continue
    }
    const refuse = (why: string): never => {
      throw new Error(
        `[nifra/web] ${file}:${line}: import.meta.glob ${why}. The Bun build reads a literal pattern (a string or an array of strings starting with ./, ../ or /, "!" excluding) and the options eager and import; write it that way, or build with --vite.`,
      )
    }
    let after = start + match[0].length
    if (!/^\s*[(<]/.test(code.slice(after))) refuse("is read as a value, not called")
    // `import.meta.glob<T>(...)`: TypeScript's type argument, dropped with the call.
    if (code[after] === "<") {
      const close = code.indexOf(">(", after)
      if (close === -1) refuse("has a type argument this cannot read")
      after = close + 1
    }
    const reader = argumentReader(source, after)
    let patterns: readonly string[]
    let options: GlobOptions
    try {
      reader.expect("(")
      const first = reader.literal()
      patterns = typeof first === "string" ? [first] : isList(first) ? first : []
      if (patterns.length === 0) throw new SyntaxError("patterns")
      let second: Literal | undefined
      if (reader.peek() === ",") {
        reader.expect(",")
        if (reader.peek() !== ")") second = reader.literal()
      }
      options = readOptions(second)
      if (reader.peek() === ",") reader.expect(",")
      reader.expect(")")
    } catch (error) {
      return refuse(
        error instanceof SyntaxError && error.message.startsWith("option ")
          ? `takes the ${error.message.slice(7)} option, which the Bun build does not support`
          : "takes arguments that are not literals",
      )
    }
    let files: string[]
    try {
      files = matchGlob(file, root, patterns)
    } catch {
      return refuse("takes a pattern that does not start with ./, ../ or /")
    }
    const rooted = patterns.some((pattern) => pattern.replace(/^!/, "").startsWith("/"))
    const entries = files.map((target, index) => {
      const key = stringLiteral(keyOf(file, root, target, rooted))
      const specifier = stringLiteral(keyOf(file, root, target, false))
      if (options.eager) {
        const name = `__nifra_glob_${call}_${index}`
        hoisted.push(`import * as ${name} from ${specifier}`)
        return `${key}: ${options.pick === undefined ? name : `${name}[${stringLiteral(options.pick)}]`}`
      }
      const load = `import(${specifier})`
      return `${key}: () => ${options.pick === undefined ? load : `${load}.then((m) => m[${stringLiteral(options.pick)}])`}`
    })
    edits.push({ start, end: reader.at, text: `({${entries.join(", ")}})` })
    call += 1
  }
  let next = source
  for (const edit of edits.reverse())
    next = next.slice(0, edit.start) + edit.text + next.slice(edit.end)
  // Equal counts can still pair a text mention with a missed call; one left in the code is that.
  if (globsInCode(next, file) !== 0) throw unclear(file)
  // Import declarations are hoisted wherever they sit, so appending keeps any directive prologue first.
  return hoisted.length === 0 ? next : `${next}\n${hoisted.join("\n")}\n`
}

/**
 * Expand `import.meta.glob` in the app's own modules, for `Bun.build`. `root` is the app root, which a
 * pattern starting with `/` is read from. Installed packages are left as published. Register it after
 * every plugin that loads app modules itself (a server-function stub must win over it); a module such
 * a plugin loads keeps its call, which {@link assertNoImportGlob} then refuses in the output. Register
 * it before a plugin that rewrites source through `addSourceTransform`: it reads through that rewrite.
 */
export function importGlobPlugin(options: { readonly root: string }): BunPlugin {
  return {
    name: "nifra-import-glob",
    setup(build) {
      build.onLoad({ filter: SOURCE }, async (args) => {
        if (args.namespace !== "file" || args.path.split("/").includes("node_modules"))
          return undefined
        if (!(await Bun.file(args.path).text()).includes("import.meta.glob")) return undefined
        // Claiming the module would skip a later plugin's rewrite of it (the copy split), so read
        // through it.
        const source = await readSource(build, args.path)
        const contents = expandImportGlobs(source, args.path, options.root)
        if (contents === source) return undefined
        return { contents, loader: LOADERS[extname(args.path)] ?? "js" }
      })
    },
  }
}

/** Refuse a bundle that still calls `import.meta.glob`: the browser has no such function, so every
 * file the call named would be missing at run time. `outputs` are the emitted chunks, path to text. */
export function assertNoImportGlob(outputs: ReadonlyArray<readonly [string, string]>): void {
  const left = outputs
    .filter(([, text]) => /\bimport\.meta\.glob\s*\(/.test(text))
    .map(([path]) => path)
  if (left.length === 0) return
  throw new Error(
    `[nifra/web] ${left.join(", ")} still call${left.length === 1 ? "s" : ""} import.meta.glob, which no browser or server runtime defines. A plugin that loads a module itself runs before the glob expansion and keeps its call; expand it in that plugin, or build with --vite.`,
  )
}
