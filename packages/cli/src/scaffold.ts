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
export function scaffoldRoute(urlPath: string, framework: Framework): ScaffoldResult {
  const ext = EXT[framework]
  const file = routePathToFile(urlPath, ext)
  const params = paramsOf(file)
  if (framework === "react" || framework === "preact" || framework === "solid") {
    return {
      file,
      content: jsxStub(file, params),
      note: `Create ${file}. ${ROUTE_CONTRACT}`,
    }
  }
  if (framework === "vanilla") {
    return {
      file,
      content: vanillaStub(file, params),
      note: `Create ${file} as a zero-runtime @nifrajs/web-vanilla route. ${ROUTE_CONTRACT}\nInteractivity comes from islands (imperative enhancers), never hydration - the stub embeds the golden pattern; nifra_example("islands") has the full cookbook.`,
    }
  }
  return {
    file,
    note: `Create ${file} as a ${framework} route module. ${ROUTE_CONTRACT}\nFor the ${framework} page body, call nifra_example (it ships verified ${framework} snippets) rather than guessing the SFC shape.`,
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
): Promise<ScaffoldWriteResult> {
  const result = scaffoldRoute(urlPath, framework)
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
export function renderScaffold(urlPath: string, framework: Framework): string {
  let r: ScaffoldResult
  try {
    r = scaffoldRoute(urlPath, framework)
  } catch (err) {
    return `Cannot scaffold ${JSON.stringify(urlPath)}: ${err instanceof Error ? err.message : String(err)}`
  }
  const stub = r.content ? `\n\n\`\`\`${EXT[framework]}\n${r.content}\`\`\`` : ""
  return `# Scaffold route \`${urlPath}\` (${framework})\n\n**File:** \`${r.file}\`\n\n${r.note}${stub}`
}
