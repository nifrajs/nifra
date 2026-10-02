/**
 * Compose a site scaffold: shared base, generated files, framework overlay, target files.
 *
 * A site is the same few files whatever it renders with or deploys to - the backend, the assurance
 * config, the landing page's backend half - plus what is mechanical enough to emit from a model (the
 * manifest, the tsconfig, the adapter module, the target's config), and the files that are genuinely
 * the framework's own. There is no per-runtime server entry or build script: `nifra build` generates
 * the target's entry from `backend/` and `routes/`.
 *
 * The framework files stay literal on purpose. `nifra.config.ts` explains why Solid wants a `solid`
 * resolve condition and what `@preact/preset-vite` is; the routes are the app a user reads first. That
 * prose belongs in a file you can open, not in a TypeScript string.
 */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type FrameworkSpec, frameworkSpec } from "./frameworks.ts"
import {
  renderFrameworkModule,
  renderPackageJson,
  renderTsconfig,
  type SiteTarget,
} from "./site-files.ts"
import { targetFiles } from "./targets.ts"

/**
 * Files identical in every site scaffold, taken from the base directory.
 *
 * Listed rather than globbed: a glob would silently absorb a file someone adds to the base for one
 * framework's benefit, which is the failure this is meant to end. Adding a shared file means saying so
 * here, and `site-composition.test.ts` fails if this list and the directory disagree.
 */
export const SHARED_SITE_FILES: readonly string[] = [
  "backend/app.ts",
  "backend/counter.ts",
  "gitignore",
  "nifra.assurance.ts",
  "routes/index.backend.ts",
]

/** Files each framework supplies itself, relative to its overlay directory. */
export const FRAMEWORK_SITE_FILES: readonly string[] = ["README.md", "nifra.config.ts"]

/** Route frontend files, whose extension is the framework's own. The backend half is shared. */
export const ROUTE_BASENAMES: readonly string[] = ["_404", "_layout", "index"]

/** Extension the framework's route files carry. */
export function routeExtension(framework: FrameworkSpec): string {
  if (framework.id === "svelte") return "svelte"
  if (framework.id === "vue") return "vue"
  return "tsx"
}

const here = dirname(fileURLToPath(import.meta.url))
/** The base directory: the shared files plus React's own, which is also the React overlay. */
export const SITE_BASE_DIR = join(here, "..", "..", "template-site")
export function overlayDir(framework: FrameworkSpec): string {
  return framework.id === "react"
    ? SITE_BASE_DIR
    : join(here, "..", "..", `template-site-${framework.id}`)
}

/** Every file a site scaffold generates, and the text it holds. */
export function generatedSiteFiles(
  framework: FrameworkSpec,
  site: SiteTarget,
): Map<string, string> {
  const files = new Map<string, string>()
  files.set("backend/framework.ts", renderFrameworkModule(framework))
  files.set("package.json", renderPackageJson(framework, site))
  files.set("tsconfig.json", renderTsconfig(framework))
  for (const [file, text] of targetFiles(site.target, site.name, site.docker)) files.set(file, text)
  return files
}

/**
 * Declared for every target, not just the edge ones, so `nifra target cloudflare` later keeps the
 * shared backend's rate limit working without a second edit.
 */
const CLIENT_IP_DECLARATION = `// Cloudflare and Vercel expose no socket: the caller's address arrives in a header their edge
// overwrites (\`cf-connecting-ip\` / \`x-real-ip\`), and this trusts it so backend/app.ts's rate limit can
// tell visitors apart. Without it an edge build has no caller address and the limit refuses every
// request. It holds only while that edge is the one way in - served any other way (\`wrangler pages
// dev\`, your own workerd) the header is whatever the client sent. Bun, Node and Deno use the socket.
export const clientIp = "platform"
`

/** The framework's `nifra.config.ts`, declaring the target `nifra build` emits. */
export function withTarget(config: string, site: SiteTarget): string {
  return `${config.replace(/\n*$/, "\n")}\n${CLIENT_IP_DECLARATION}\n// The deploy target \`nifra build\` emits; \`nifra target <t>\` switches it.\nexport const target = "${site.target}"\n`
}

export interface MaterializeOptions extends SiteTarget {
  /** Overwrite an existing destination. Default false, which refuses rather than clobbers. */
  readonly force?: boolean
}

/**
 * Write a complete site scaffold into `target`.
 *
 * Refusing an occupied destination is the default and is preserved deliberately: `cp`'s
 * `errorOnExist` did that before this was generated, and losing it would turn a mistyped path into
 * silent data loss in someone's working directory. `--force` is what `bun create nifra .` needs.
 */
export async function materializeSite(
  target: string,
  id: string,
  options: MaterializeOptions,
): Promise<void> {
  const framework = frameworkSpec(id)
  const overlay = overlayDir(framework)
  const force = options.force === true
  const copy = (from: string, to: string): Promise<void> =>
    cp(from, to, force ? { force: true } : { errorOnExist: true, force: false })
  // `wx` fails when the file exists, which is the write-side equivalent of `errorOnExist`.
  const emit = (to: string, contents: string): Promise<void> =>
    writeFile(to, contents, force ? {} : { flag: "wx" })

  for (const dir of ["routes", "backend"]) await mkdir(join(target, dir), { recursive: true })
  for (const file of SHARED_SITE_FILES) await copy(join(SITE_BASE_DIR, file), join(target, file))
  for (const [file, contents] of generatedSiteFiles(framework, options)) {
    await emit(join(target, file), contents)
  }
  await copy(join(overlay, "README.md"), join(target, "README.md"))
  await emit(
    join(target, "nifra.config.ts"),
    withTarget(await readFile(join(overlay, "nifra.config.ts"), "utf8"), options),
  )
  const extension = routeExtension(framework)
  for (const base of ROUTE_BASENAMES) {
    const name = join("routes", `${base}.${extension}`)
    await copy(join(overlay, name), join(target, name))
  }
}
