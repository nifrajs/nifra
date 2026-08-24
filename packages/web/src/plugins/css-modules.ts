/**
 * `@nifrajs/web/plugins/css-modules` - a dependency-free CSS Modules (`*.module.css`) Bun plugin, in its
 * OWN module so the SSR preload registers it BEFORE any `.module.css` file loads. Mirrors the
 * `@nifrajs/web-vue/plugin` seam exactly: pass `"dom"` for the client bundle
 * (`buildClient({ plugins: [...] })`) and preload `"ssr"` for the server (`bun --preload`).
 *
 * Each `import styles from "./x.module.css"` becomes a JS module whose **default export** is the
 * `{ originalClassName: scopedClassName }` map; the rewritten (scoped) CSS is emitted into the client
 * stylesheet via the `?nifra-css-module` virtual-module idiom (the same trick the Vue plugin uses for
 * `?vue-css`). The `"ssr"` form emits **no** CSS - the stylesheet ships from the client build - but
 * produces the **identical** class map, so SSR markup's `class={styles.foo}` matches the bundled
 * selectors (scoped names are a pure function of file path + class name, so both builds agree).
 *
 * Scoping is deterministic (a stable 8-hex hash of the package-relative `filePath + className`, no
 * `Date.now`/`Math.random`/cwd), so builds are reproducible across machines and working directories.
 * Supported (the 95% case): class selectors (`.a`, `.a .b`, `.a.b`), combinators,
 * pseudo-classes/`:not(...)`, native nesting, at-rules (`@media`/`@supports`/`@container`/`@layer`),
 * `:global(...)`/`:local(...)` (function form), and **`@keyframes` names + their `animation`/
 * `animation-name` references** (scoped together, so two modules' same-named keyframes don't clash).
 * Not handled: the bare `:global`/`:local` *switch* form and `composes:` - out of scope by design.
 */
import type { BunPlugin } from "bun"
import { createStylesheetEmitter, hash8, normalizeFilePath, reproduciblePath } from "./kit.ts"

const STYLE_NS = "nifra-css-module"

/**
 * The scoped name for a class. Keyed by `filePath` + `className` (NUL-separated so `"a"+"bc"` can't
 * collide with `"ab"+"c"`), so the same class name in two different files gets two different scoped
 * names - cross-file collision resistance - while staying stable across builds.
 *
 * Exported because it is the definition of the name, and the OTHER pipeline has to be able to produce
 * it: Vite ships its own CSS-Modules naming, so without handing Vite this function a class is called
 * one thing under `nifra dev --vite` and another after `nifra build`. `filePath` must be the
 * package-relative form from `reproduciblePath`, never an absolute path, or the name stops being
 * reproducible across machines.
 */
export function scopedName(filePath: string, className: string): string {
  return `${className}_${hash8(`${filePath}\u0000${className}`)}`
}

/**
 * Scoped name for a `@keyframes` animation. Salted distinctly from {@link scopedName} so a class `.spin`
 * and a `@keyframes spin` in the same file don't collide, while staying stable across builds. Scoping
 * keyframe names (and their `animation`/`animation-name` references) is what stops two modules that each
 * declare `@keyframes spin` from clobbering each other in the bundle - the CSS-Modules spec behavior.
 */
function scopedKeyframeName(filePath: string, name: string): string {
  return `${name}_${hash8(`${filePath}\u0000@keyframes\u0000${name}`)}`
}

/** Matches `@keyframes name` / `@-webkit-keyframes name` (etc.); captures the leading keyword and name. */
const KEYFRAMES_PRELUDE = /(@(?:-\w+-)?keyframes\s+)([A-Za-z_][\w-]*)/i
/** An `animation` / `animation-name` declaration: capture the `prop:` head + the value (which holds the
 * keyframe-name token(s) to remap). */
const ANIMATION_DECL = /^(\s*animation(?:-name)?\s*:\s*)([\s\S]*)$/i
const isKeyframesAt = (at: string): boolean => at === "keyframes" || at.endsWith("-keyframes")

/** `s[i]` is a quote: return the index just past the matching close quote (honoring `\` escapes). */
function skipString(s: string, i: number): number {
  const quote = s[i]
  i++
  while (i < s.length) {
    const c = s[i]
    if (c === "\\") {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    i++
  }
  return i
}

/** `s[i..i+1]` is `/` + `*`: return the index just past the matching `*` + `/` (or end). */
function skipComment(s: string, i: number): number {
  i += 2
  while (i < s.length) {
    if (s[i] === "*" && s[i + 1] === "/") return i + 2
    i++
  }
  return i
}

/** `s[open]` is `{`: return the index of its matching `}` (string/comment/nesting aware), or -1. */
function findMatchingBrace(s: string, open: number): number {
  let depth = 0
  let i = open
  while (i < s.length) {
    const c = s[i]
    if (c === "/" && s[i + 1] === "*") {
      i = skipComment(s, i)
      continue
    }
    if (c === '"' || c === "'") {
      i = skipString(s, i)
      continue
    }
    if (c === "{") {
      depth++
      i++
      continue
    }
    if (c === "}") {
      depth--
      if (depth === 0) return i
      i++
      continue
    }
    i++
  }
  return -1
}

// Conditional group at-rules whose block contains nested rules (recurse). Everything else with a block
// (`@keyframes`, `@font-face`, `@page`, `@property`, …) is declarations/keyframe selectors - left as-is.
const GROUP_AT_RULES = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "scope",
  "starting-style",
  "document",
])

function atRuleName(prelude: string): string | null {
  const match = /^\s*@([a-zA-Z-]+)/.exec(prelude)
  return match ? (match[1] as string).toLowerCase() : null
}

const isIdentStart = (c: string): boolean => /[A-Za-z_-]/.test(c)
const isIdentChar = (c: string): boolean => /[\w-]/.test(c)

/**
 * Reject the CSS-Modules features this 95%-case scoper deliberately doesn't implement, so a file using
 * them fails loud (with the file + a workaround) rather than emitting silently-wrong or invalid CSS:
 * `composes:` (would leak into the output as invalid CSS) and `@value` (would not be substituted).
 */
function assertSupportedDeclaration(declaration: string, filePath: string): void {
  const trimmed = declaration.trimStart()
  if (/^composes\s*:/i.test(trimmed)) {
    throw new Error(
      `[nifra/web] CSS Modules: "composes" is unsupported in ${filePath} - inline the shared rules or share a plain class instead.`,
    )
  }
  if (/^@value\b/i.test(trimmed)) {
    throw new Error(
      `[nifra/web] CSS Modules: "@value" is unsupported in ${filePath} - use CSS custom properties (\`--name\`) instead.`,
    )
  }
}

/**
 * Rewrite a selector list: scope every class token (`.foo` → `.foo_<hash>`, recorded in `exportsMap`)
 * except those inside `:global(...)`. Tracks paren nesting so `:global(:not(.x))` leaves `.x` global
 * and `:not(.y)` outside scopes `.y`. Strings (attribute values) and comments pass through untouched.
 */
function rewriteSelectorList(
  selector: string,
  filePath: string,
  exportsMap: Record<string, string>,
): string {
  let out = ""
  let i = 0
  const n = selector.length
  // scopeStack top = whether class tokens here are local (scoped). parenStack records, per `(`,
  // whether it was a `:global(`/`:local(` wrapper we must unwrap (drop the wrapper + pop the scope).
  const scopeStack: boolean[] = [true]
  const parenStack: boolean[] = []
  const scoping = (): boolean => scopeStack[scopeStack.length - 1] as boolean

  while (i < n) {
    const c = selector[i] as string
    if (c === "/" && selector[i + 1] === "*") {
      const j = skipComment(selector, i)
      out += selector.slice(i, j)
      i = j
      continue
    }
    if (c === '"' || c === "'") {
      const j = skipString(selector, i)
      out += selector.slice(i, j)
      i = j
      continue
    }
    if (c === ":") {
      const rest = selector.slice(i)
      const wrapper = /^:(global|local)\s*\(/.exec(rest)
      if (wrapper) {
        scopeStack.push(wrapper[1] === "local")
        parenStack.push(true) // unwrap: emit neither `:global(` nor its matching `)`
        i += wrapper[0].length
        continue
      }
      // Bare `:global`/`:local` *switch* form (no parens, at a selector boundary) is NOT supported -
      // silently leaving it would mis-scope every following class. Fail loud instead.
      const bare = /^:(global|local)(?=[\s,>+~{]|$)/.exec(rest)
      if (bare) {
        throw new Error(
          `[nifra/web] CSS Modules: the bare ":${bare[1]}" switch is unsupported - use the function form ":${bare[1]}(...)" in ${filePath}`,
        )
      }
      out += c
      i++
      continue
    }
    if (c === "(") {
      parenStack.push(false)
      out += c
      i++
      continue
    }
    if (c === ")") {
      const wasWrapper = parenStack.pop()
      if (wasWrapper) scopeStack.pop()
      else out += c
      i++
      continue
    }
    if (c === ".") {
      const next = selector[i + 1]
      if (next !== undefined && isIdentStart(next)) {
        let j = i + 1
        while (j < n && isIdentChar(selector[j] as string)) j++
        const name = selector.slice(i + 1, j)
        if (scoping()) {
          const scoped = scopedName(filePath, name)
          exportsMap[name] = scoped
          out += `.${scoped}`
        } else {
          out += `.${name}`
        }
        i = j
        continue
      }
      out += c
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/**
 * Pre-scan: record every `@keyframes <name>` (any vendor prefix), at the top level and inside
 * conditional group at-rules (`@media` etc., where keyframes may legally live), into `map`
 * (`name → scopedName`). Runs BEFORE {@link transformBlock} so a forward reference
 * (`animation: spin` declared before `@keyframes spin`) still remaps. String/comment/brace aware.
 */
function collectKeyframes(css: string, filePath: string, map: Map<string, string>): void {
  let prelude = ""
  let i = 0
  while (i < css.length) {
    const c = css[i] as string
    if (c === "/" && css[i + 1] === "*") {
      i = skipComment(css, i)
      continue
    }
    if (c === '"' || c === "'") {
      const j = skipString(css, i)
      prelude += css.slice(i, j)
      i = j
      continue
    }
    if (c === ";") {
      prelude = ""
      i++
      continue
    }
    if (c === "{") {
      const end = findMatchingBrace(css, i)
      if (end === -1) break
      const at = atRuleName(prelude)
      if (at !== null && isKeyframesAt(at)) {
        const m = KEYFRAMES_PRELUDE.exec(prelude)
        const name = m?.[2]
        if (name !== undefined && !map.has(name)) map.set(name, scopedKeyframeName(filePath, name))
      } else if (at !== null && GROUP_AT_RULES.has(at)) {
        collectKeyframes(css.slice(i + 1, end), filePath, map)
      }
      prelude = ""
      i = end + 1
      continue
    }
    prelude += c
    i++
  }
}

/** Remap the keyframe-name token(s) in an `animation`/`animation-name` declaration to their scoped
 * names; any token that isn't a known keyframe (durations, timing functions, `infinite`, …) is left
 * untouched, since only THIS file's `@keyframes` names are in `keyframes`. Non-animation declarations
 * pass through unchanged. */
function rewriteAnimationRefs(declaration: string, keyframes: Map<string, string>): string {
  if (keyframes.size === 0) return declaration
  const m = ANIMATION_DECL.exec(declaration)
  if (m === null) return declaration
  const value = (m[2] as string).replace(/[A-Za-z_][\w-]*/g, (tok) => keyframes.get(tok) ?? tok)
  return `${m[1]}${value}`
}

/** Rewrite the name in a `@keyframes <name>` prelude to its scoped form (the inner `from`/`to`/`%`
 * block is left untouched by the caller). */
function scopeKeyframesPrelude(prelude: string, keyframes: Map<string, string>): string {
  return prelude.replace(KEYFRAMES_PRELUDE, (whole, kw: string, name: string) =>
    keyframes.has(name) ? `${kw}${keyframes.get(name)}` : whole,
  )
}

/**
 * Transform a block of CSS (the whole file, or a nested block) - scoping selectors of style rules,
 * recursing into conditional group at-rules and into style-rule blocks (native nesting), and leaving
 * declarations, keyframes, and `@font-face` bodies untouched.
 */
function transformBlock(
  css: string,
  filePath: string,
  exportsMap: Record<string, string>,
  keyframes: Map<string, string>,
): string {
  let out = ""
  let prelude = ""
  let i = 0
  while (i < css.length) {
    const c = css[i] as string
    if (c === "/" && css[i + 1] === "*") {
      const j = skipComment(css, i)
      prelude += css.slice(i, j)
      i = j
      continue
    }
    if (c === '"' || c === "'") {
      const j = skipString(css, i)
      prelude += css.slice(i, j)
      i = j
      continue
    }
    if (c === ";") {
      // A declaration or at-statement (`@import "...";`) - never carries a scoped selector, but an
      // `animation`/`animation-name` declaration's keyframe references must be remapped.
      assertSupportedDeclaration(prelude, filePath)
      out += `${rewriteAnimationRefs(prelude, keyframes)};`
      prelude = ""
      i++
      continue
    }
    if (c === "{") {
      const end = findMatchingBrace(css, i)
      if (end === -1) {
        // Unbalanced braces - bail out rather than corrupt: emit the remainder verbatim.
        prelude += css.slice(i)
        i = css.length
        break
      }
      const inner = css.slice(i + 1, end)
      const at = atRuleName(prelude)
      if (at !== null) {
        if (isKeyframesAt(at)) {
          // Scope the keyframe NAME; the `from`/`to`/`%` block holds no classes - leave it untouched.
          out += `${scopeKeyframesPrelude(prelude, keyframes)}{${inner}}`
        } else if (GROUP_AT_RULES.has(at)) {
          out += `${prelude}{${transformBlock(inner, filePath, exportsMap, keyframes)}}`
        } else {
          out += `${prelude}{${inner}}`
        }
      } else {
        out += `${rewriteSelectorList(prelude, filePath, exportsMap)}{${transformBlock(inner, filePath, exportsMap, keyframes)}}`
      }
      prelude = ""
      i = end + 1
      continue
    }
    prelude += c
    i++
  }
  // The block's final declaration may have no trailing `;` (e.g. `.a { composes: base }`).
  assertSupportedDeclaration(prelude, filePath)
  out += rewriteAnimationRefs(prelude, keyframes)
  return out
}

/** The transform result: the `{ original: scoped }` export map + the rewritten (scoped) stylesheet. */
export interface CssModuleResult {
  readonly exports: Readonly<Record<string, string>>
  readonly css: string
}

/**
 * Pure core (no I/O): scope a CSS-module source. Same `(source, filePath)` in → byte-identical out, so
 * the `"dom"` and `"ssr"` plugin forms produce the same class map. Exposed for direct testing.
 */
export function transformCssModule(source: string, filePath: string): CssModuleResult {
  const exportsMap: Record<string, string> = Object.create(null)
  // Collect `@keyframes` names first (forward references: `animation: spin` can precede its `@keyframes`).
  const keyframes = new Map<string, string>()
  collectKeyframes(source, filePath, keyframes)
  // Seed the export map with the scoped `@keyframes` names, BEFORE classes are collected.
  //
  // Keyframe names are part of the CSS Modules export namespace - postcss-modules exports them, so Vite
  // does, so nifra's dev pipeline does. Omitting them here made `styles.spin` a real value in dev and
  // `undefined` in production: the exact works-locally-breaks-deployed shape, with no error at either
  // end. Anyone reaching for a scoped keyframe (`style={{ animationName: styles.spin }}`) needs this.
  //
  // Seeding first rather than merging after is what decides a name used by BOTH a class and a keyframe in
  // one file: `transformBlock` then overwrites the entry, so the CLASS wins. That is the useful default -
  // `styles.x` in markup nearly always means a className - and it is deterministic either way, which is
  // what matters most for a name that has to agree across two pipelines.
  for (const [name, scoped] of keyframes) exportsMap[name] = scoped
  const css = transformBlock(source, filePath, exportsMap, keyframes)
  return { exports: exportsMap, css }
}

/**
 * The CSS Modules Bun plugin. `"dom"` → the `.module.css` import becomes the class map AND emits the
 * scoped stylesheet as a virtual `?nifra-css-module` module that `Bun.build`'s CSS bundler folds into
 * the app stylesheet. `"ssr"` → the class map only (no CSS; the scoped names match the client build).
 * Tolerates a trailing `?query` on the path (dev servers append one to bust Bun's import cache).
 */
export function cssModulesBunPlugin(generate: "dom" | "ssr"): BunPlugin {
  return {
    name: `nifra-css-modules-${generate}`,
    setup(build) {
      const stylesheet = createStylesheetEmitter(build, STYLE_NS)
      build.onLoad({ filter: /\.module\.css(\?|$)/ }, async (args) => {
        const path = normalizeFilePath(args.path)
        const source = await Bun.file(path).text()
        // Hash scoped names off the cwd-relative path so they're reproducible across machines/CI.
        const { exports, css } = transformCssModule(source, reproduciblePath(path))
        const js = `export default ${JSON.stringify(exports)}\n`
        // dom → emit the scoped stylesheet into the client bundle; ssr → the class map only.
        return {
          contents: generate === "dom" ? js + stylesheet.emit(path, css) : js,
          loader: "js",
        }
      })
    },
  }
}
