/**
 * `nifra_scaffold` — turn a URL path into the correct `routes/` file (the convention an agent most often
 * gets wrong) + a minimal, contract-correct stub. The mapping is the inverse of @nifrajs/web's
 * `filePathToPatterns`: `:id`/`[id]` → `[id]`, `*rest`/`[...rest]` → `[...rest]`, `[[lang]]` optional,
 * `/` → `index`. The framework (→ file extension) comes from the project's `clientModule`.
 *
 * Page stubs are emitted only for the JSX family (react/preact/solid — one shared, verified shape);
 * for vue/svelte/vanilla we return the correct PATH + the route-module contract and point at
 * `nifra_example` for the body, rather than hand-writing an SFC we can't typecheck here.
 */

import { mkdir, writeFile } from "node:fs/promises"
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
- \`export default function Page(props: { data: LoaderData<typeof loader> }) { … }\` — the page component.
- \`export async function loader({ params, request, api }: LoaderArgs<typeof backend>) { … }\` — server-only; data for SSR. Reach the backend via \`api\` (typed) / DB via the backend, NEVER a top-level server-only import.
- \`export async function action({ request, api }: ActionArgs<typeof backend>) { … }\` — server-only; handles the form POST.
- \`export const meta = { title, meta:[…] }\` — head tags.
Path params are typed on \`params\`.`

function jsxStub(file: string, params: string[]): string {
  const paramsNote =
    params.length > 0 ? `params.${params.join(", params.")}` : "no path params on this route"
  const loaderLine =
    params.length > 0
      ? `// export async function loader({ params, api }: LoaderArgs<typeof backend>) { return { /* fetch by ${params[0]} */ } }`
      : `// export async function loader({ api }: LoaderArgs<typeof backend>) { return {} }`
  return `// ${file} — server-only loader/action allowed; never top-level-import server-only code (DB/secrets).
// Available here: ${paramsNote}. Fetch data in a loader via the typed \`api\`; see nifra_example("loader").
${loaderLine}
export default function Page() {
  return <main>TODO: ${file}</main>
}
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
  await mkdir(dirname(target), { recursive: true })
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

/** Render the tool result as markdown — the file path, the stub (if any), and the contract note. */
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
