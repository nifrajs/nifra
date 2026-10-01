/**
 * The client-build transforms that every pipeline must apply identically - the Bun client build, the
 * Vite dev server, the Vite production build, and `nifra dev --bun`:
 *
 *   - `*.fn` modules     - replaced with HTTP stubs, so the function bodies (and their imports) stay server-side.
 *   - public-env prefix  - which environment variables the client bundle is allowed to inline.
 *
 * Which files may reach a browser at all is the zone classifier's job (`zones.ts`). These two get one
 * definition here so the Bun and Vite halves emit identical bytes; a copied-then-edited second version
 * is how a client that works in dev and 404s in production happens.
 */

/** Modules whose exports become client stubs: `todos.fn.ts`, `x.fn.mjs`, or the extensionless `foo.fn`. */
export const SERVER_FN_MODULE = /\.fn(\.[cm]?[jt]sx?)?$/

import { jsStringLiteral } from "./js-string.ts"

// ---------------------------------------------------------------------------------------------------
// `.fn` - turn a server-function module into the client stubs that call it.
// ---------------------------------------------------------------------------------------------------

/**
 * The server half of a server function must never reach a browser: it closes over database handles,
 * secrets and everything else the module imports. So the CLIENT build does not bundle these modules at
 * all - it replaces each one with a stub per export that POSTs to the route the server mounted.
 *
 * The generation is pure on purpose. The Bun and Vite pipelines both need this transform and must
 * produce byte-identical stubs, so it lives here and each bundler contributes only its own plugin shell.
 * A divergence between the two would be a client that works in dev and 404s in production.
 *
 * The exports are found by scanning the SOURCE rather than importing it - importing would execute the
 * module, which is precisely what must not happen in a client build - and the declaration form is fixed:
 *
 *     export const addTodo = serverFn({ … }, async (input, c) => { … })
 *
 * Anything else is refused rather than skipped: a server function the scanner cannot see would be absent
 * from the client and fail as `addTodo is not a function` at runtime, far from the cause.
 */

/** `export const NAME = serverFn(` at the start of a line - the one declaration form. Explicit type
 * arguments (`serverFn<Input, Output>(...)`) are part of that form; the optional group accepts any
 * argument list without parentheses (object/tuple/union types included). A type argument that itself
 * contains parentheses (a function type) is beyond a scan - it still COUNTS as a call below, so it
 * fails loudly with the guidance error instead of silently emitting an exportless stub. */
const DECLARATION =
  /^[\t ]*export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*serverFn\s*(?:<[^()]*>)?\s*\(/gm
/** Any mention of `serverFn` being called - with or without type arguments - used to prove nothing
 * was missed. Broader than {@link DECLARATION} on purpose: `serverFn<` also counts, so an exotic
 * type-argument shape the declaration regex cannot read trips the calls>names refusal. */
const ANY_CALL = /\bserverFn\s*[<(]/g
/** Strip line and block comments by forward index scan, so prose cannot register as code. Not a
 * regex: every regex shape for comment stripping either backtracks polynomially on adversarial
 * source or is opaque enough that reviewers cannot tell. A `//` preceded by `:` is kept (URL in a
 * string - the same heuristic the previous implementation used); an unterminated block comment
 * swallows the rest of the source, matching a real parser. */
function stripComments(source: string): string {
  const parts: string[] = []
  let keepFrom = 0
  let i = 0
  while (i < source.length) {
    if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2)
      parts.push(source.slice(keepFrom, i))
      i = close === -1 ? source.length : close + 2
      keepFrom = i
    } else if (source.startsWith("//", i) && source[i - 1] !== ":") {
      const newline = source.indexOf("\n", i + 2)
      parts.push(source.slice(keepFrom, i))
      i = newline === -1 ? source.length : newline // keep the newline itself
      keepFrom = i
    } else {
      i++
    }
  }
  parts.push(source.slice(keepFrom))
  return parts.join("")
}

/**
 * The namespace a `*.fn.ts` module is mounted under: its filename without the `.fn` suffix.
 *
 * Deriving it from the filename rather than the full path keeps the build machine's directory layout
 * out of a public URL, and keeps the route readable in logs. It also means the mount on the server -
 * `serverFunctions("todos", …)` - has to use the same word, which is the one thing a reader must check
 * by eye today; {@link SERVER_FN_MODULE} files are named for it precisely to make that obvious.
 */
export function serverFnNamespace(filePath: string): string {
  const base = filePath.replaceAll("\\", "/").split("/").pop() ?? ""
  return base.replace(SERVER_FN_MODULE, "")
}

/** The server functions a module declares, in source order. */
export function scanServerFnExports(source: string): string[] {
  const code = stripComments(source)
  const names = [...code.matchAll(DECLARATION)].map((m) => m[1] as string)
  const calls = [...code.matchAll(ANY_CALL)].length
  if (calls > names.length) {
    throw new Error(
      "[nifra/fn] a server function is declared in a form the client transform cannot read. Use " +
        "`export const name = serverFn(…)` at the top level: the client build scans the source rather " +
        "than importing it (importing would run your server code during a browser build), so a " +
        "declaration it cannot see would be missing from the client and fail as `name is not a function`.",
    )
  }
  return names
}

/**
 * The client replacement for a `*.fn.ts` module: one stub per export, and none of the original code.
 *
 * `credentials: "same-origin"` is explicit rather than relied upon - the server refuses a cross-origin
 * call, and stating it here means the browser never sends cookies somewhere that would reject them.
 * The content type is not decoration either: it is what makes a cross-origin form unable to forge one
 * of these calls, so the stub and the server guard have to agree on it.
 */
export function generateServerFnStub(source: string, namespace: string): string {
  const names = scanServerFnExports(source)
  const calls = names
    .map((name) => `export const ${name} = (input) => __nifraCall(${jsStringLiteral(name)}, input)`)
    .join("\n")
  return `// Generated by @nifrajs/web: the server half of this module never reaches the browser.
const __nifraBase = ${jsStringLiteral(`/_nifra/fn/${namespace}`)}

async function __nifraCall(name, input) {
  const response = await fetch(\`\${__nifraBase}/\${name}\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input === undefined ? {} : input),
    credentials: "same-origin",
  })
  if (response.status === 404) {
    throw new Error(
      \`[nifra/fn] \${name} is not mounted at \${__nifraBase}. The client derives that path from this \` +
        \`file's name, so the server's serverFunctions(...) namespace has to match it.\`,
    )
  }
  if (!response.ok) {
    let detail = ""
    try {
      detail = JSON.stringify(await response.json())
    } catch {
      // A non-JSON error body is not worth a second failure; the status carries enough.
    }
    throw new Error(\`[nifra/fn] \${name} failed: \${response.status}\${detail ? \` \${detail}\` : ""}\`)
  }
  return response.status === 204 ? undefined : await response.json()
}

${calls}
`
}

// ---------------------------------------------------------------------------------------------------
// public-env - which environment variables the client bundle may inline.
// ---------------------------------------------------------------------------------------------------

/** Translate Nifra's public-env contract to Vite's `envPrefix` option. */
export function vitePublicEnvPrefix(prefix: string | undefined): string {
  const configured = prefix ?? "PUBLIC_"
  // Vite rejects an empty prefix. Environment-variable names cannot contain NUL, so this sentinel
  // cannot match an ambient key and faithfully represents Nifra's "expose nothing" setting.
  return configured === "" ? "\0nifra-public-env-disabled" : configured
}
