/**
 * Compose a site scaffold: shared base, generated files, framework overlay.
 *
 * A site is 26 files. Thirteen are the same whatever you render with - the Dockerfile, every server
 * entry, the worker, the assurance config - eight are mechanical enough to emit from a model, and five
 * are genuinely the framework's own. Keeping five copies of all 26 is what let `.vercel` reach four
 * tsconfigs and not the fifth, and a Vercel comment reach one build entry and not the other four.
 *
 * The five that stay literal stay literal on purpose. `nifra.config.ts` explains why Solid wants a
 * `solid` resolve condition and what `@preact/preset-vite` is; the routes are the app a user reads
 * first. That prose belongs in a file you can open, not in a TypeScript string.
 */
import { cp, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type FrameworkSpec, frameworkSpec } from "./frameworks.ts"
import { BUILD_TARGETS, renderBuildFile } from "./site-build.ts"
import { renderFrameworkModule, renderPackageJson, renderTsconfig } from "./site-files.ts"

/**
 * Files identical in every site scaffold, taken from the base directory.
 *
 * Listed rather than globbed: a glob would silently absorb a file someone adds to the base for one
 * framework's benefit, which is the failure this is meant to end. Adding a shared file means saying so
 * here, and `site-composition.test.ts` fails if this list and the directory disagree.
 */
export const SHARED_SITE_FILES: readonly string[] = [
  ".dockerignore",
  "Dockerfile",
  "_worker.ts",
  "backend.ts",
  "counter.ts",
  "deno.json",
  "gitignore",
  "nifra.assurance.ts",
  "server-bun.ts",
  "server-deno.ts",
  "server-node.ts",
  "server-vercel.ts",
  "wrangler.toml",
]

/** Files each framework supplies itself, relative to its overlay directory. */
export const FRAMEWORK_SITE_FILES: readonly string[] = ["README.md", "nifra.config.ts"]

/** Route files, whose extension is the framework's own. */
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

/** Every file a site scaffold emits, and the text it holds. Generated files only. */
export function generatedSiteFiles(framework: FrameworkSpec): Map<string, string> {
  const files = new Map<string, string>()
  for (const target of BUILD_TARGETS) files.set(target.file, renderBuildFile(target, framework))
  files.set("framework.ts", renderFrameworkModule(framework))
  files.set("package.json", renderPackageJson(framework))
  files.set("tsconfig.json", renderTsconfig(framework))
  return files
}

export interface MaterializeOptions {
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
  options: MaterializeOptions = {},
): Promise<void> {
  const framework = frameworkSpec(id)
  const overlay = overlayDir(framework)
  const force = options.force === true
  const copy = (from: string, to: string): Promise<void> =>
    cp(from, to, force ? { force: true } : { errorOnExist: true, force: false })
  // `wx` fails when the file exists, which is the write-side equivalent of `errorOnExist`.
  const emit = (to: string, contents: string): Promise<void> =>
    writeFile(to, contents, force ? {} : { flag: "wx" })

  await mkdir(join(target, "routes"), { recursive: true })
  for (const file of SHARED_SITE_FILES) await copy(join(SITE_BASE_DIR, file), join(target, file))
  for (const [file, contents] of generatedSiteFiles(framework)) {
    await emit(join(target, file), contents)
  }
  for (const file of FRAMEWORK_SITE_FILES) await copy(join(overlay, file), join(target, file))
  const extension = routeExtension(framework)
  for (const base of ROUTE_BASENAMES) {
    const name = join("routes", `${base}.${extension}`)
    await copy(join(overlay, name), join(target, name))
  }
}
