/**
 * `nifra_scaffold` - turn a URL path into the correct `routes/` files (the convention an agent most often
 * gets wrong) + a minimal, contract-correct route pair: the page, and its `.backend.ts` half holding the
 * loader and its output schema. The mapping is the inverse of @nifrajs/web's `filePathToPatterns`:
 * `:id`/`[id]` → `[id]`, `*rest`/`[...rest]` → `[...rest]`, `[[lang]]` optional, `/` → `index`. The
 * framework (→ file extension) comes from the project's `clientModule`.
 *
 * Page stubs are emitted for the JSX family (react/preact/solid - one shared, verified shape) and
 * for vanilla (a zero-runtime `html` page carrying the golden island pattern); for vue/svelte we
 * return the correct PATHS, the backend half and the route contract, and point at `nifra_example` for
 * the page body, rather than hand-writing an SFC we can't typecheck here.
 */

import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, resolve, sep } from "node:path"
import { paramConstraint } from "@nifrajs/core/pattern"

export type Framework = "react" | "preact" | "solid" | "vue" | "svelte" | "vanilla"

/** A scaffold flavour on top of the framework. `default` is the plain page stub; `stateful` only
 * applies to vanilla and emits the golden **nano** pattern (explicit reactivity: `signal` +
 * `computed(fn, [deps])` + keyed `bindList` + collected cleanups) instead of the static island stub -
 * the AI-safe small-app lane whose three mistakes NF-C021/C022/C023 catch statically. */
export type ScaffoldVariant = "default" | "stateful"

const EXT: Record<Framework, string> = {
  react: "tsx",
  preact: "tsx",
  solid: "tsx",
  vue: "vue",
  svelte: "svelte",
  vanilla: "ts",
}

/** Derive the framework from a `clientModule` like `@nifrajs/web-react/client`. Defaults to react. */
export function frameworkFromClientModule(clientModule: string | undefined): Framework {
  const m = /@nifrajs\/web-(react|preact|solid|vue|svelte|vanilla)\b/.exec(clientModule ?? "")
  return (m?.[1] as Framework | undefined) ?? "react"
}

/** One URL path segment → its `routes/` filename segment. Accepts both URL (`:id`, `*rest`) and
 * file (`[id]`, `[...rest]`) spellings so an agent can pass either. */
function segmentToFile(seg: string): string {
  if (seg.startsWith("[")) return seg // already file-spelled ([id], [...rest], [[lang]])
  if (seg.startsWith("*")) return `[...${seg.slice(1) || "rest"}]` // *rest / * → catch-all
  if (seg.startsWith(":")) return `[${seg.slice(1)}]` // :id → [id]
  return seg
}

/** Reject syntax that could be interpreted by the host filesystem rather than the route mapper. */
function assertSafeRouteSegment(segment: string, urlPath: string): void {
  if (segment === "." || segment === ".." || segment.includes("\0") || segment.includes("\\")) {
    throw new Error(
      `invalid route segment in ${JSON.stringify(urlPath)}: ${JSON.stringify(segment)}`,
    )
  }
  const brace = segment.indexOf("{")
  if (segment.startsWith(":") && brace > 0 && paramConstraint(segment.slice(brace)) !== undefined) {
    throw new Error(
      `a param constraint cannot be written in a route file name: ${JSON.stringify(segment)} in ${JSON.stringify(urlPath)}. Scaffold the page without it and check the value in the route's loader.`,
    )
  }
  const fileSegment = segmentToFile(segment)
  if (
    fileSegment === "." ||
    fileSegment === ".." ||
    fileSegment.includes("\0") ||
    fileSegment.includes("/") ||
    fileSegment.includes("\\") ||
    fileSegment.includes(":") ||
    /^[A-Za-z]:/.test(fileSegment)
  ) {
    throw new Error(
      `invalid route segment in ${JSON.stringify(urlPath)}: ${JSON.stringify(segment)}`,
    )
  }
}

/** Map a URL path to its `routes/` file path (relative to `routes/`, without extension prefix dir).
 * `/` → `index`; `/users/:id` → `users/[id]`; `/blog/*slug` → `blog/[...slug]`. */
export function routePathToFile(urlPath: string, ext: string): string {
  const segments = urlPath.split("/").filter((s) => s.length > 0)
  if (segments.length === 0) return `routes/index.${ext}`
  for (const segment of segments) assertSafeRouteSegment(segment, urlPath)
  const last = segments.length - 1
  // Catch-all must be the final segment (mirrors @nifrajs/web); flag it rather than emit an invalid file.
  for (let i = 0; i < last; i++) {
    if (segments[i]?.startsWith("*") || segments[i]?.startsWith("[..."))
      throw new Error(`catch-all must be the last segment: "${urlPath}"`)
  }
  return `routes/${segments.map(segmentToFile).join("/")}.${ext}`
}

const ROUTE_CONTRACT = `A route is two files:
- The page, \`routes/x.<ext>\` - ships to the browser: \`export default function Page({ data }: Route.ComponentProps)\` and \`export const meta = { title, meta: […] }\`. It never imports backend code.
- Its backend half, \`routes/x.backend.ts\` - never reaches the browser: \`export const loaderOutput = t.object({…})\` with \`export async function loader({ params, api }: Route.LoaderArgs)\` (data for SSR - only what the schema declares is sent), \`actionOutput\` with \`action\` (the form POST), and \`hydrate\`, \`islandScripts\`, \`revalidate\`, \`middleware\`. Reach the backend through the typed \`api\`.
Both import \`type { Route } from "./+types/<name>"\`, which \`nifra dev\`, \`nifra build\`, \`nifra check\` and \`nifra types\` generate. Path params are typed on \`params\`.`

interface RouteParam {
  readonly name: string
  readonly optional: boolean
}

/** Param names a route file declares, for the stubs. */
function paramsOf(file: string): RouteParam[] {
  const out: RouteParam[] = []
  for (const m of file.matchAll(/(\[)?\[(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\]/g))
    out.push({ name: m[2] as string, optional: m[1] !== undefined })
  return out
}

/** `./+types/<name>` for a route file: the generated module both halves import `Route` from. */
const typesOf = (file: string): string => `./+types/${basename(file).replace(/\.[^.]+$/, "")}`

/** `routes/users/[id].tsx` → `routes/users/[id].backend.ts`. */
export const backendFileOf = (file: string): string => file.replace(/\.[^./]+$/, ".backend.ts")

/** The page's backend half: its loader, and the schema that bounds what the loader sends. */
function backendStub(file: string, params: readonly RouteParam[], vanilla: boolean): string {
  const last = params.at(-1)
  const loader =
    last === undefined
      ? `export async function loader(_args: Route.LoaderArgs) {
  // Load through the typed backend client, \`api\` in these args; see nifra_example("loader").
  return { title: "TODO" }
}`
      : `export async function loader({ params }: Route.LoaderArgs) {
  // Load by params.${last.name} through the typed backend client, \`api\` in these args; see nifra_example("loader").
  return { title: \`TODO: \${params.${last.name}${last.optional ? ' ?? ""' : ""}}\` }
}`
  const vanillaExports = vanilla
    ? `

// No client framework to hydrate with - vanilla routes are documents, not hydrated apps.
export const hydrate = false

// The built URL of each island enhancer this page renders a marker for (./<name>.client.ts).
// export const islandScripts = []`
    : ""
  return `// ${backendFileOf(file)} - the server half of ${file}; it never reaches the browser.
import { t } from "@nifrajs/schema"
import type { Route } from "${typesOf(file)}"

// Only what this schema declares is sent to the page.
export const loaderOutput = t.object({ title: t.string() })

${loader}${vanillaExports}
`
}

function jsxStub(file: string): string {
  return `// ${file} - the page; it ships to the browser. Its data comes from ${basename(backendFileOf(file))}.
import type { Route } from "${typesOf(file)}"

export default function Page({ data }: Route.ComponentProps) {
  return <main>{data.title}</main>
}
`
}

/**
 * The @nifrajs/web-vanilla golden stub: a zero-runtime `html` page (`hydrate = false`), plus the
 * copy-paste island path as guidance. The uncommented body is a valid, typecheckable static page;
 * the commented block is the AI-safe interactivity pattern - an imperative enhancer that ALWAYS
 * returns its cleanup (the one thing NF-C020 checks), wired through `mountIslands`. Interactivity is
 * added by uncommenting and writing the companion `<name>.client.ts`, never by turning on hydration.
 */
function vanillaStub(file: string): string {
  return `// ${file} - @nifrajs/web-vanilla page. Server-rendered HTML, ZERO framework runtime; its data,
// and \`hydrate = false\`, live in ${basename(backendFileOf(file))}.
import { html } from "@nifrajs/web-vanilla"
import type { Route } from "${typesOf(file)}"

export default function Page({ data }: Route.ComponentProps) {
  return html\`<main><h1>\${data.title}</h1></main>\`
}

// --- Add interactivity the AI-safe way (islands), NOT hydration ---------------------------------
// 1. Render a marker in the page above:  html\`<nifra-island data-id="counter" data-props=\${JSON.stringify({ start: 0 })}></nifra-island>\`
// 2. Wire the route to its enhancer bundle, in ${basename(backendFileOf(file))}:
//    export const islandScripts = [/* built URL of ./counter.client.ts */]
// 3. Write ./counter.client.ts as an imperative enhancer that ALWAYS returns its cleanup:
//
//    import { defineIsland, mountIslands } from "@nifrajs/web/islands"
//    const counter = defineIsland<{ start: number }>((el, props) => {
//      let n = props.start
//      const out = el.querySelector("output")!
//      const onClick = () => { out.textContent = String(++n) }
//      el.querySelector("button")?.addEventListener("click", onClick)
//      return () => el.querySelector("button")?.removeEventListener("click", onClick) // cleanup - NF-C020
//    })
//    mountIslands({ counter })
//
// Cross-island coordination: create ONE createIslandBus() and close over it in each enhancer.
`
}

/**
 * The nano golden stub (`nifra scaffold --variant stateful`, vanilla only): a zero-runtime `html`
 * page that renders a `<nifra-island>` marker, plus the companion `<name>.client.ts` shown as the
 * copy-paste block. The client is the AI-safe small-app lane - explicit reactivity, no VDOM, no
 * auto-tracking - and every reactive edge is a visible call, which is what makes the three nano
 * mistakes STATICALLY catchable:
 *   - a `bind`/`bindList` whose disposer is discarded  -> NF-C021 (the block collects every disposer)
 *   - a `bindList` keyed by array index                -> NF-C022 (the block keys by `item.id`)
 *   - a `computed` reading a signal its `[deps]` omits  -> NF-C023 (the block declares `[todos]`)
 * The page body is a valid, typecheckable static document; interactivity is added by writing the
 * companion client shown, never by turning on hydration.
 */
function nanoStub(file: string): string {
  return `// ${file} - @nifrajs/web-vanilla page + a nano island (explicit reactivity, zero VDOM). The
// document is static and the nano client below owns all interactivity; \`hydrate = false\` and the
// island's \`islandScripts\` URL live in ${basename(backendFileOf(file))}.
import { html } from "@nifrajs/web-vanilla"
import type { Route } from "${typesOf(file)}"

export default function Page({ data }: Route.ComponentProps) {
  // The island marker: data-props is the initial state the client reads on mount.
  return html\`<main>
    <h1>\${data.title}</h1>
    <nifra-island data-id="todos" data-props=\${JSON.stringify({ items: [] })}></nifra-island>
  </main>\`
}

// --- ./todos.client.ts - the golden nano pattern (write this as a companion file) -----------------
//
//   import { defineIsland, mountIslands } from "@nifrajs/web/islands"
//   import { signal, computed, bind, bindList } from "@nifrajs/web/nano"
//
//   interface Todo { id: string; text: string; done: boolean }
//
//   const todos = defineIsland<{ items: Todo[] }>((el, props) => {
//     // 1. State is a signal. Reads are \`.get()\`, writes are \`.set(...)\` - every edge is visible.
//     const items = signal<Todo[]>(props.items)
//
//     // 2. Derived state declares its deps EXPLICITLY. Omitting \`todos\`/\`items\` here is NF-C023.
//     const remaining = computed(() => items.get().filter((t) => !t.done).length, [items])
//
//     // 3. Collect EVERY disposer. A bare \`bind(...)\`/\`bindList(...)\` that drops it is NF-C021.
//     const cleanups: Array<() => void> = []
//     const count = el.querySelector("[data-count]")!
//     cleanups.push(bind(count, remaining, (node, n) => { node.textContent = String(n) + " left" }))
//
//     // 4. Keyed list. Key by a STABLE id on the item, never the array index (NF-C022) - or
//     //    add/remove/reorder reuses the wrong DOM node.
//     const list = el.querySelector("[data-list]")!
//     cleanups.push(bindList(items, list, {
//       key: (t) => t.id,
//       create: (t) => { const li = document.createElement("li"); li.dataset.id = t.id; return li },
//       update: (li, t) => { li.textContent = t.text; li.classList.toggle("done", t.done) },
//     }))
//
//     // Mutations replace the value (Object.is-deduped); subscribers run synchronously.
//     const add = (text: string) => items.set([...items.get(), { id: crypto.randomUUID(), text, done: false }])
//     void add
//
//     // 5. Return the teardown - islands call it on soft-nav. This is what NF-C021 protects.
//     return () => { for (const off of cleanups) off() }
//   })
//
//   mountIslands({ todos })
//
// Cross-island coordination: one createIslandBus() closed over in each enhancer. nifra_docs("nano")
// has the full cookbook; \`nifra check\` runs NF-C021/C022/C023 over the client you write.
`
}

export interface ScaffoldResult {
  /** The page file. */
  readonly file: string
  /** The page stub, when there is a verified one for the framework. */
  readonly content?: string
  /** The page's backend half - framework-independent, so always present. */
  readonly backend: { readonly file: string; readonly content: string }
  readonly note: string
}

export interface ScaffoldWriteResult extends ScaffoldResult {
  readonly written: boolean
  readonly reason?: string
}

/** Scaffold a page route for `urlPath` under the project's `framework`. Returns the correct file paths
 * and the backend half always; a ready-to-write page stub for the JSX family and vanilla, contract
 * guidance otherwise. */
export function scaffoldRoute(
  urlPath: string,
  framework: Framework,
  variant: ScaffoldVariant = "default",
): ScaffoldResult {
  const ext = EXT[framework]
  const file = routePathToFile(urlPath, ext)
  const params = paramsOf(file)
  const backend = {
    file: backendFileOf(file),
    content: backendStub(file, params, framework === "vanilla"),
  }
  // `stateful` is vanilla-only: it swaps the static island stub for the nano golden pattern. Asking
  // for it on a JSX/SFC framework is a no-op on the flavour (those lanes have their own reactivity).
  if (framework === "vanilla" && variant === "stateful") {
    return {
      file,
      content: nanoStub(file),
      backend,
      note: `Create ${file} and ${backend.file} as a zero-runtime @nifrajs/web-vanilla route with a nano island. ${ROUTE_CONTRACT}\nThe stub embeds the golden nano client (signal + computed(fn,[deps]) + keyed bindList + collected cleanups); write it as the companion .client.ts. \`nifra check\` runs NF-C021/C022/C023 over it; nifra_docs("nano") is the full cookbook.`,
    }
  }
  if (framework === "react" || framework === "preact" || framework === "solid") {
    return {
      file,
      content: jsxStub(file),
      backend,
      note: `Create ${file} and ${backend.file}. ${ROUTE_CONTRACT}\nIf the rendered page misbehaves (hydration warning, a value that stops updating), call nifra_frontend { adapter: "${framework}" } for the cause + fix.`,
    }
  }
  if (framework === "vanilla") {
    return {
      file,
      content: vanillaStub(file),
      backend,
      note: `Create ${file} and ${backend.file} as a zero-runtime @nifrajs/web-vanilla route. ${ROUTE_CONTRACT}\nInteractivity comes from islands (imperative enhancers), never hydration - the stub embeds the golden pattern; nifra_example("islands") has the full cookbook. For explicit local state (a list a human edits), scaffold with variant "stateful" to get the nano pattern instead.`,
    }
  }
  return {
    file,
    backend,
    note: `Create ${file} as a ${framework} route module, and ${backend.file} from the stub below. ${ROUTE_CONTRACT}\nFor the ${framework} page body, call nifra_example (it ships verified ${framework} snippets) rather than guessing the SFC shape. If a value stops updating the template, call nifra_frontend { adapter: "${framework}" } for the ${framework} reactivity-loss fix.`,
  }
}

function resolveInsideRoutes(cwd: string, relativeFile: string): string {
  const root = resolve(cwd)
  const routesRoot = resolve(root, "routes")
  const target = resolve(root, relativeFile)
  if (target === routesRoot || !target.startsWith(`${routesRoot}${sep}`)) {
    throw new Error(`refusing to write outside routes directory: ${relativeFile}`)
  }
  return target
}

/** Lexical containment is not enough when an existing route directory is a symlink. Check every
 * existing ancestor and its real path before scaffolding so an agent cannot redirect a write outside
 * the selected project. The target itself is created with `wx`, so an existing target symlink is also
 * never followed/overwritten. */
async function assertNoSymlinkedAncestors(root: string, target: string): Promise<void> {
  const rootPath = resolve(root)
  const realRoot = await realpath(rootPath)
  let current = dirname(target)
  while (current !== rootPath) {
    if (!current.startsWith(`${rootPath}${sep}`)) {
      throw new Error(`refusing to write outside project root: ${target}`)
    }
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error(`refusing to write through symlinked directory: ${current}`)
      }
      const actual = await realpath(current)
      if (actual !== realRoot && !actual.startsWith(`${realRoot}${sep}`)) {
        throw new Error(`refusing to write outside project root through: ${current}`)
      }
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "ENOENT") {
        current = dirname(current)
        continue
      }
      throw err
    }
    current = dirname(current)
  }
}

/** Write a scaffolded route pair when the framework has a verified ready-to-write page body. The write
 * is intentionally conservative: it refuses frameworks where we only return contract guidance (a
 * backend half alone is a build error), refuses when either file exists, and uses `wx`, so an agent
 * cannot overwrite user work by accident. It then generates the route's `./+types` module, so both
 * halves typecheck at once. */
export async function writeScaffoldRoute(
  cwd: string,
  urlPath: string,
  framework: Framework,
  variant: ScaffoldVariant = "default",
): Promise<ScaffoldWriteResult> {
  const result = scaffoldRoute(urlPath, framework, variant)
  if (result.content === undefined) {
    return {
      ...result,
      written: false,
      reason: "no verified ready-to-write stub for this framework; use nifra_example for the body",
    }
  }
  const files = [
    { file: result.file, content: result.content },
    { file: result.backend.file, content: result.backend.content },
  ]
  const targets = files.map(({ file }) => resolveInsideRoutes(cwd, file))
  for (const target of targets) await assertNoSymlinkedAncestors(cwd, target)
  for (const [i, target] of targets.entries()) {
    if ((await lstat(target).catch(() => undefined)) !== undefined) {
      return { ...result, written: false, reason: `file already exists: ${files[i]?.file}` }
    }
  }
  await mkdir(dirname(targets[0] as string), { recursive: true })
  for (const target of targets) await assertNoSymlinkedAncestors(cwd, target)
  for (const [i, target] of targets.entries()) {
    try {
      await writeFile(target, files[i]?.content ?? "", { flag: "wx" })
    } catch (err) {
      if (err && typeof err === "object" && (err as { code?: string }).code === "EEXIST") {
        return { ...result, written: false, reason: `file already exists: ${files[i]?.file}` }
      }
      throw err
    }
  }
  const { refreshRouteTypes } = await import("./route-types.ts")
  refreshRouteTypes(cwd, () => {})
  return { ...result, written: true }
}

/** Render the tool result as markdown - the file paths, the stubs (if any), and the contract note. */
export function renderScaffold(
  urlPath: string,
  framework: Framework,
  variant: ScaffoldVariant = "default",
): string {
  let r: ScaffoldResult
  try {
    r = scaffoldRoute(urlPath, framework, variant)
  } catch (err) {
    return `Cannot scaffold ${JSON.stringify(urlPath)}: ${err instanceof Error ? err.message : String(err)}`
  }
  const page = r.content ? `\n\n\`${r.file}\`:\n\n\`\`\`${EXT[framework]}\n${r.content}\`\`\`` : ""
  const backend = `\n\n\`${r.backend.file}\`:\n\n\`\`\`ts\n${r.backend.content}\`\`\``
  return `# Scaffold route \`${urlPath}\` (${framework})\n\n**Files:** \`${r.file}\` + \`${r.backend.file}\`\n\n${r.note}${page}${backend}`
}
