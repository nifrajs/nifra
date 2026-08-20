/**
 * `nifra_scaffold` - turn a URL path into the correct `routes/` file (the convention an agent most often
 * gets wrong) + a minimal, contract-correct stub. The mapping is the inverse of @nifrajs/web's
 * `filePathToPatterns`: `:id`/`[id]` → `[id]`, `*rest`/`[...rest]` → `[...rest]`, `[[lang]]` optional,
 * `/` → `index`. The framework (→ file extension) comes from the project's `clientModule`.
 *
 * Page stubs are emitted for the JSX family (react/preact/solid - one shared, verified shape) and
 * for vanilla (a zero-runtime `html` page carrying the golden island pattern); for vue/svelte we
 * return the correct PATH + the route-module contract and point at `nifra_example` for the body,
 * rather than hand-writing an SFC we can't typecheck here.
 */

import { lstat, mkdir, realpath, writeFile } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"

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

/** Map a URL path to its `routes/` file path (relative to `routes/`, without extension prefix dir).
 * `/` → `index`; `/users/:id` → `users/[id]`; `/blog/*slug` → `blog/[...slug]`. */
export function routePathToFile(urlPath: string, ext: string): string {
  const segments = urlPath.split("/").filter((s) => s.length > 0)
  if (segments.length === 0) return `routes/index.${ext}`
  const last = segments.length - 1
  // Catch-all must be the final segment (mirrors @nifrajs/web); flag it rather than emit an invalid file.
  for (let i = 0; i < last; i++) {
    if (segments[i]?.startsWith("*") || segments[i]?.startsWith("[..."))
      throw new Error(`catch-all must be the last segment: "${urlPath}"`)
  }
  return `routes/${segments.map(segmentToFile).join("/")}.${ext}`
}

const ROUTE_CONTRACT = `A route module may export:
- \`export default function Page(props: { data: LoaderData<typeof loader> }) { … }\` - the page component.
- \`export async function loader({ params, request, api }: LoaderArgs<typeof backend>) { … }\` - server-only; data for SSR. Reach the backend via \`api\` (typed) / DB via the backend, NEVER a top-level server-only import.
- \`export async function action({ request, api }: ActionArgs<typeof backend>) { … }\` - server-only; handles the form POST.
- \`export const meta = { title, meta:[…] }\` - head tags.
Path params are typed on \`params\`.`

function jsxStub(file: string, params: string[]): string {
  const paramsNote =
    params.length > 0 ? `params.${params.join(", params.")}` : "no path params on this route"
  const loaderLine =
    params.length > 0
      ? `// export async function loader({ params, api }: LoaderArgs<typeof backend>) { return { /* fetch by ${params[0]} */ } }`
      : `// export async function loader({ api }: LoaderArgs<typeof backend>) { return {} }`
  return `// ${file} - server-only loader/action allowed; never top-level-import server-only code (DB/secrets).
// Available here: ${paramsNote}. Fetch data in a loader via the typed \`api\`; see nifra_example("loader").
${loaderLine}
export default function Page() {
  return <main>TODO: ${file}</main>
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
function vanillaStub(file: string, params: string[]): string {
  const paramsNote =
    params.length > 0 ? `params.${params.join(", params.")}` : "no path params on this route"
  const loaderLine =
    params.length > 0
      ? `// export async function loader({ params, api }: LoaderArgs<typeof backend>) { return { /* fetch by ${params[0]} */ } }`
      : `// export async function loader({ api }: LoaderArgs<typeof backend>) { return {} }`
  return `// ${file} - @nifrajs/web-vanilla route. Server-rendered HTML, ZERO framework runtime.
// Available here: ${paramsNote}. Fetch data in a loader via the typed \`api\`; see nifra_example("loader").
import { html } from "@nifrajs/web-vanilla"

// No client framework to hydrate with - vanilla routes are documents, not hydrated apps.
export const hydrate = false

${loaderLine}

export default function Page() {
  return html\`<main><h1>TODO: ${file}</h1></main>\`
}

// --- Add interactivity the AI-safe way (islands), NOT hydration ---------------------------------
// 1. Render a marker in the page above:  html\`<nifra-island data-id="counter" data-props=\${JSON.stringify({ start: 0 })}></nifra-island>\`
// 2. Wire the route to its enhancer bundle:  export const islandScripts = [/* built URL of ./counter.client.ts */]
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
function nanoStub(file: string, params: string[]): string {
  const paramsNote =
    params.length > 0 ? `params.${params.join(", params.")}` : "no path params on this route"
  const loaderLine =
    params.length > 0
      ? `// export async function loader({ params, api }: LoaderArgs<typeof backend>) { return { /* seed by ${params[0]} */ } }`
      : `// export async function loader({ api }: LoaderArgs<typeof backend>) { return {} }`
  return `// ${file} - @nifrajs/web-vanilla route + a nano island (explicit reactivity, zero VDOM).
// Available here: ${paramsNote}. Seed data in a loader via the typed \`api\`; see nifra_example("loader").
import { html } from "@nifrajs/web-vanilla"

// The document is static; the nano client below owns all interactivity. No hydration.
export const hydrate = false

${loaderLine}

export default function Page() {
  // The island marker: data-props is the initial state the client reads on mount.
  return html\`<main>
    <h1>Todos</h1>
    <nifra-island data-id="todos" data-props=\${JSON.stringify({ items: [] })}></nifra-island>
  </main>\`
}

// Wire the route to the built URL of ./todos.client.ts (the nano enhancer below).
// export const islandScripts = [/* built URL of ./todos.client.ts */]

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

/** Param names a route file declares, for the stub's notes. */
function paramsOf(file: string): string[] {
  const out: string[] = []
  for (const m of file.matchAll(/\[(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\]/g))
    out.push(m[1] as string)
  return out
}

export interface ScaffoldResult {
  readonly file: string
  readonly content?: string
  readonly note: string
}

export interface ScaffoldWriteResult extends ScaffoldResult {
  readonly written: boolean
  readonly reason?: string
}

/** Scaffold a page route for `urlPath` under the project's `framework`. Returns the correct file path
 * always; a ready-to-write stub for the JSX family, contract guidance otherwise. */
export function scaffoldRoute(
  urlPath: string,
  framework: Framework,
  variant: ScaffoldVariant = "default",
): ScaffoldResult {
  const ext = EXT[framework]
  const file = routePathToFile(urlPath, ext)
  const params = paramsOf(file)
  // `stateful` is vanilla-only: it swaps the static island stub for the nano golden pattern. Asking
  // for it on a JSX/SFC framework is a no-op on the flavour (those lanes have their own reactivity).
  if (framework === "vanilla" && variant === "stateful") {
    return {
      file,
      content: nanoStub(file, params),
      note: `Create ${file} as a zero-runtime @nifrajs/web-vanilla route with a nano island. ${ROUTE_CONTRACT}\nThe stub embeds the golden nano client (signal + computed(fn,[deps]) + keyed bindList + collected cleanups); write it as the companion .client.ts. \`nifra check\` runs NF-C021/C022/C023 over it; nifra_docs("nano") is the full cookbook.`,
    }
  }
  if (framework === "react" || framework === "preact" || framework === "solid") {
    return {
      file,
      content: jsxStub(file, params),
      note: `Create ${file}. ${ROUTE_CONTRACT}\nIf the rendered page misbehaves (hydration warning, a value that stops updating), call nifra_frontend { adapter: "${framework}" } for the cause + fix.`,
    }
  }
  if (framework === "vanilla") {
    return {
      file,
      content: vanillaStub(file, params),
      note: `Create ${file} as a zero-runtime @nifrajs/web-vanilla route. ${ROUTE_CONTRACT}\nInteractivity comes from islands (imperative enhancers), never hydration - the stub embeds the golden pattern; nifra_example("islands") has the full cookbook. For explicit local state (a list a human edits), scaffold with variant "stateful" to get the nano pattern instead.`,
    }
  }
  return {
    file,
    note: `Create ${file} as a ${framework} route module. ${ROUTE_CONTRACT}\nFor the ${framework} page body, call nifra_example (it ships verified ${framework} snippets) rather than guessing the SFC shape. If a value stops updating the template, call nifra_frontend { adapter: "${framework}" } for the ${framework} reactivity-loss fix.`,
  }
}

function resolveInsideCwd(cwd: string, relativeFile: string): string {
  const root = resolve(cwd)
  const target = resolve(root, relativeFile)
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to write outside project root: ${relativeFile}`)
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

/** Write a scaffolded route stub when the framework has a verified ready-to-write body. The write is
 * intentionally conservative: it refuses non-JSX stubs (where we only return contract guidance) and
 * uses `wx`, so an agent cannot overwrite user work by accident. */
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
  const target = resolveInsideCwd(cwd, result.file)
  await assertNoSymlinkedAncestors(cwd, target)
  await mkdir(dirname(target), { recursive: true })
  await assertNoSymlinkedAncestors(cwd, target)
  try {
    await writeFile(target, result.content, { flag: "wx" })
  } catch (err) {
    if (err && typeof err === "object" && (err as { code?: string }).code === "EEXIST") {
      return { ...result, written: false, reason: `file already exists: ${result.file}` }
    }
    throw err
  }
  return { ...result, written: true }
}

/** Render the tool result as markdown - the file path, the stub (if any), and the contract note. */
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
  const stub = r.content ? `\n\n\`\`\`${EXT[framework]}\n${r.content}\`\`\`` : ""
  return `# Scaffold route \`${urlPath}\` (${framework})\n\n**File:** \`${r.file}\`\n\n${r.note}${stub}`
}
