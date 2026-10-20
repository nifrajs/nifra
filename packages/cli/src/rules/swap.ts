import type * as TSApi from "typescript"
import { type Diagnostic, diagnostic } from "../diagnostics.ts"
import type { CheckRule } from "./index.ts"
import {
  type FileMarkup,
  HOLE,
  lineOf,
  projectMarkup,
  type SlotCall,
  type SwapMarkup,
  UNKNOWN,
} from "./islands.ts"

/**
 * NF-C049 to NF-C052 - the slot swap lints. A `data-swap` link or form (`@nifrajs/web/islands/swap`)
 * refreshes one `data-swap-slot` from the server's answer for that slot, which `slot()` in
 * `@nifrajs/web-vanilla` renders. Every way it can go wrong falls back to a normal page load, so
 * nothing breaks loudly: these lints say where a swap can never happen, or loses content when it does.
 * Like the binding lints, a value that is not literal is not judged.
 */

// The client and server accept these and nothing else.
const MODE = /^(replace|append):([A-Za-z][\w-]{0,63})$/
const SLOT_NAME = /^[A-Za-z][\w-]{0,63}$/

const fix = { recipe: "islands.swap", command: "nifra_docs islands" }
const verify = "nifra check --lints-only"

function swapUses(
  files: readonly FileMarkup[],
): Array<{ readonly file: FileMarkup; readonly use: SwapMarkup }> {
  return files.flatMap((file) => file.swaps.map((use) => ({ file, use })))
}

/** Every slot name the project's markup declares, or UNKNOWN when one is computed and could be any. */
function declaredSlots(uses: ReturnType<typeof swapUses>): Set<string> | typeof UNKNOWN {
  const declared = new Set<string>()
  for (const { use } of uses) {
    if (use.kind !== "slot") continue
    if (use.value === UNKNOWN) return UNKNOWN
    declared.add(use.value)
  }
  return declared
}

export const swapAttributeRule: CheckRule = {
  code: "NF-C049",
  title: "Swap link or form misdeclared",
  async scan(ctx) {
    const { diagnostics, markup } = await projectMarkup(
      ctx,
      "NF-C049",
      "Swap link or form misdeclared",
    )
    if (diagnostics !== undefined) return diagnostics
    const findings: Diagnostic[] = []
    for (const { file, use } of swapUses(markup.files)) {
      if (use.kind !== "swap") continue
      let message: string | undefined
      if (use.jsx)
        message =
          "data-swap in JSX never swaps: only a @nifrajs/web-vanilla page answers a slot swap, so the link or form loads the page normally"
      else if (use.tag !== "a" && use.tag !== "form")
        message = `data-swap on <${use.tag}> never swaps: it works on <a href> and <form> only`
      else if (use.tag === "a" && use.url === undefined)
        message = "data-swap on an <a> without href never swaps: there is no URL to fetch"
      else if (typeof use.value === "string" && !MODE.test(use.value))
        message = `data-swap="${use.value}" never swaps: write replace:<slot> or append:<slot>, the slot a letter then up to 63 letters, digits, _ or -`
      if (message === undefined) continue
      findings.push(
        diagnostic({
          code: "NF-C049",
          severity: "warn",
          file: file.file,
          line: use.line ?? lineOf(file.tree, use.node),
          message,
          evidence: [`data-swap=${typeof use.value === "string" ? use.value : "(interpolated)"}`],
          fix,
          verify,
        }),
      )
    }
    return findings
  },
}

export const swapTargetRule: CheckRule = {
  code: "NF-C050",
  title: "Swap names a slot nothing declares",
  async scan(ctx) {
    const { diagnostics, markup } = await projectMarkup(
      ctx,
      "NF-C050",
      "Swap names a slot nothing declares",
    )
    if (diagnostics !== undefined) return diagnostics
    const uses = swapUses(markup.files)
    const declared = declaredSlots(uses)
    if (declared === UNKNOWN) return []
    const findings: Diagnostic[] = []
    for (const { file, use } of uses) {
      if (use.kind !== "swap" || use.jsx || typeof use.value !== "string") continue
      const name = MODE.exec(use.value)?.[2]
      if (name === undefined || declared.has(name)) continue
      findings.push(
        diagnostic({
          code: "NF-C050",
          severity: "warn",
          file: file.file,
          line: use.line ?? lineOf(file.tree, use.node),
          message: `data-swap="${use.value}" names slot "${name}", which no data-swap-slot in the project declares, so the ${use.tag === "form" ? "form submits" : "link loads"} normally`,
          evidence: [`data-swap-slot="${name}" not found`],
          fix,
          verify,
        }),
      )
    }
    return findings
  },
}

/** Whether `node` is one of the file's `slot()` calls, and which. */
function slotCallOf(file: FileMarkup, node: TSApi.Node): SlotCall | undefined {
  return file.slotCalls.find((call) => call.node === node)
}

export const slotPlacementRule: CheckRule = {
  code: "NF-C051",
  title: "Slot content is not its slot() alone",
  async scan(ctx) {
    const { diagnostics, ts, markup } = await projectMarkup(
      ctx,
      "NF-C051",
      "Slot content is not its slot() alone",
    )
    if (diagnostics !== undefined || ts === undefined) return diagnostics ?? []
    const findings: Diagnostic[] = []
    const report = (file: FileMarkup, line: number, message: string, evidence: string): void => {
      findings.push(
        diagnostic({
          code: "NF-C051",
          severity: "warn",
          file: file.file,
          line,
          message,
          evidence: [evidence],
          fix,
          verify,
        }),
      )
    }
    for (const file of markup.files) {
      const seen = new Map<TSApi.Node, Set<string>>()
      for (const use of file.swaps) {
        if (use.kind !== "slot" || use.jsx || typeof use.value !== "string") continue
        const name = use.value
        const evidence = `data-swap-slot="${name}"`
        if (!SLOT_NAME.test(name)) {
          report(
            file,
            use.line ?? lineOf(file.tree, use.node),
            `data-swap-slot="${name}" is never swapped: a slot name is a letter then up to 63 letters, digits, _ or -`,
            evidence,
          )
          continue
        }
        const names = seen.get(use.node) ?? new Set<string>()
        seen.set(use.node, names)
        if (names.has(name)) {
          report(
            file,
            use.line ?? lineOf(file.tree, use.node),
            `a second data-swap-slot="${name}" in this markup is never swapped: a swap answers and fills the first slot of a name`,
            evidence,
          )
          continue
        }
        names.add(name)
        const content = use.content
        if (content === undefined) continue
        const [only] = content.holes
        if (content.text.trim() === HOLE && only !== undefined) {
          const call = slotCallOf(file, only)
          // Anything but a slot() call may be a component that renders one.
          if (call === undefined || call.name === UNKNOWN || call.name === name) continue
          report(
            file,
            use.line ?? lineOf(file.tree, use.node),
            `data-swap-slot="${name}" holds slot("${call.name}", ...): the server answers a swap of "${name}" from a slot() of that name, so this one is never swapped`,
            evidence,
          )
          continue
        }
        const holds = content.holes.some((hole) => slotCallOf(file, hole)?.name === name)
        report(
          file,
          use.line ?? lineOf(file.tree, use.node),
          holds
            ? `data-swap-slot="${name}" holds content beside slot("${name}", ...): a swap replaces it all with what slot() renders, so that content is lost. Move it out of the slot element`
            : `data-swap-slot="${name}" holds no slot("${name}", ...): the server has nothing to answer a swap of it with, so every swap loads the page normally. Make slot("${name}", content) its only content`,
          evidence,
        )
      }
      for (const call of file.slotCalls) {
        if (call.name === UNKNOWN) continue
        // Only a call placed straight into a template is judged; a returned one renders elsewhere.
        const parent = call.node.parent
        if (!ts.isTemplateSpan(parent)) continue
        const placed = file.placement.get(call.node)
        if (placed === undefined || placed.slot !== null) continue
        report(
          file,
          lineOf(file.tree, call.node),
          `slot("${call.name}", ...) is not the content of a data-swap-slot element, so nothing on the page is swapped with it. Wrap it: <div data-swap-slot="${call.name}">\${slot("${call.name}", ...)}</div>`,
          `slot("${call.name}")`,
        )
      }
    }
    return findings
  },
}

// Bare imports that look like path aliases may hold the app's own components.
const ALIAS = /^(?:~|@\/|#)/
// A stylesheet, an image or another framework's component never calls slot().
const NOT_SCRIPT = /\.(?!(?:[cm]?[jt]sx?)(?:\?|$))[a-z]+(?:\?.*)?$/i
const PAGE_FILE = /^routes\/(.+\.(?:tsx|jsx|svelte|vue|mdx))$/

/** Resolve a relative import of `from` among the project's files. */
function resolveImport(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | undefined {
  const base = from.slice(0, from.lastIndexOf("/") + 1)
  const parts: string[] = []
  for (const part of `${base}${specifier}`.split("/")) {
    if (part === "..") parts.pop()
    else if (part !== "." && part !== "") parts.push(part)
  }
  const path = parts.join("/")
  const stem = path.replace(/\.(?:js|jsx|mjs)$/, "")
  for (const candidate of [
    path,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.js`,
    `${stem}.jsx`,
    `${path}/index.ts`,
    `${path}/index.tsx`,
  ])
    if (files.has(candidate)) return candidate
  return undefined
}

/** The slot names `entries` and the project files they import render, or UNKNOWN when an import
 * cannot be followed. */
function renderedSlots(
  ts: typeof TSApi,
  entries: readonly string[],
  byFile: ReadonlyMap<string, FileMarkup>,
): Set<string> | typeof UNKNOWN {
  const names = new Set<string>()
  const files = new Set(byFile.keys())
  const pending = [...entries]
  const visited = new Set<string>()
  while (pending.length > 0) {
    const path = pending.pop()
    if (path === undefined || visited.has(path)) continue
    visited.add(path)
    const file = byFile.get(path)
    if (file === undefined) return UNKNOWN
    for (const call of file.slotCalls) {
      if (call.name === UNKNOWN) return UNKNOWN
      names.add(call.name)
    }
    for (const statement of file.tree.statements) {
      const specifier =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined
      if (specifier === undefined || NOT_SCRIPT.test(specifier)) continue
      if (specifier.startsWith(".")) {
        const target = resolveImport(path, specifier, files)
        if (target === undefined) return UNKNOWN
        pending.push(target)
      } else if (ALIAS.test(specifier)) return UNKNOWN
    }
  }
  return names
}

/** The path part of a link's href or a form's action, when it is literal. */
function literalPath(url: string): string | undefined {
  const end = url.search(/[?#]/)
  const path = end < 0 ? url : url.slice(0, end)
  return path.includes(HOLE) ? undefined : path
}

export const swapRouteRule: CheckRule = {
  code: "NF-C052",
  title: "Swap URL's page renders no such slot",
  async scan(ctx) {
    const { diagnostics, ts, markup } = await projectMarkup(
      ctx,
      "NF-C052",
      "Swap URL's page renders no such slot",
    )
    if (diagnostics !== undefined || ts === undefined) return diagnostics ?? []
    const uses = swapUses(markup.files)
    const declared = declaredSlots(uses)
    const targets: Array<{
      file: FileMarkup
      use: SwapMarkup
      value: string
      name: string
      path: string
    }> = []
    for (const { file, use } of uses) {
      if (use.kind !== "swap" || use.jsx || typeof use.value !== "string") continue
      const name = MODE.exec(use.value)?.[2]
      // A name no slot declares is NF-C050's finding.
      if (
        name === undefined ||
        use.url === UNKNOWN ||
        (declared !== UNKNOWN && !declared.has(name))
      )
        continue
      const path = literalPath(use.url ?? "")
      if (path !== undefined) targets.push({ file, use, value: use.value, name, path })
    }
    const pages = markup.files.flatMap((file) => {
      const match = PAGE_FILE.exec(file.file)
      return match?.[1] === undefined ? [] : [match[1]]
    })
    if (targets.length === 0 || pages.length === 0) return []
    const { buildManifest } = await import("@nifrajs/web")
    const { compileRoutePattern, matchRoutePattern, sortRoutesBySpecificity } = await import(
      "@nifrajs/core/pattern"
    )
    let manifest: ReturnType<typeof buildManifest>
    try {
      manifest = buildManifest(pages, () => async () => ({ default: null }))
    } catch {
      return []
    }
    const routes = sortRoutesBySpecificity(
      manifest.routes.flatMap((route) => {
        try {
          return [{ route, pattern: compileRoutePattern(route.pattern) }]
        } catch {
          return []
        }
      }),
    )
    const byFile = new Map(markup.files.map((file) => [file.file, file]))
    const findings: Diagnostic[] = []
    for (const { file, use, value, name, path } of targets) {
      // An empty or query-only URL is the page's own; elsewhere only a root-relative path is judged.
      const route =
        path === ""
          ? routes.find((entry) => `routes/${entry.route.file}` === file.file)?.route
          : path.startsWith("/")
            ? routes.find((entry) => matchRoutePattern(entry.pattern, path).matched)?.route
            : undefined
      if (route === undefined) continue
      const chain = [
        `routes/${route.file}`,
        ...route.layoutIds.flatMap((id) => {
          const layout = manifest.layouts[id]
          return layout === undefined ? [] : [`routes/${layout.file}`]
        }),
      ]
      const rendered = renderedSlots(ts, chain, byFile)
      if (rendered === UNKNOWN || rendered.has(name)) continue
      findings.push(
        diagnostic({
          code: "NF-C052",
          severity: "warn",
          file: file.file,
          line: use.line ?? lineOf(file.tree, use.node),
          message: `data-swap="${value}" goes to ${route.pattern}, whose page and layouts render no slot("${name}", ...), so every swap loads the page normally`,
          evidence: [`${route.pattern} -> ${chain.join(", ")}`],
          fix,
          verify,
        }),
      )
    }
    return findings
  },
}

export const swapRules = Object.freeze([
  swapAttributeRule,
  swapTargetRule,
  slotPlacementRule,
  swapRouteRule,
])
