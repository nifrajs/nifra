/**
 * A site scaffold's mechanical files: the adapter re-export, the manifest, the tsconfig. These were
 * five copies each whose only real difference was which framework they name, and keeping five copies
 * is how `.vercel` came to be excluded from four tsconfigs and not the fifth.
 */
import { type FrameworkSpec, NIFRA_DEP_RANGE } from "./frameworks.ts"
import { type DeployTarget, deployScript, TARGETS } from "./targets.ts"

/** JSON as these files are written: two-space indent, trailing newline. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/**
 * `backend/framework.ts` - the file the generated server entry imports the adapter from. It stays
 * edge-bundlable: CLI-only tooling (Vite plugins, compilers) lives in `nifra.config.ts`.
 */
export function renderFrameworkModule(framework: FrameworkSpec): string {
  return `// The frontend adapter for this app. \`create-nifra --framework <react|preact|vue|solid|svelte>\` swaps
// this one line (and the routes + build config); the server entry \`nifra build\` generates imports the
// adapter from here, so it stays framework-agnostic.
import { ${framework.adapter} } from "${framework.package}"

export const adapter = ${framework.adapter}

// Where backend/app.ts is served over HTTP. "" keeps it loader-only: loaders and actions call it
// in-process. Set "/api" to serve it to the browser too, and re-export it from nifra.config.ts, which
// \`nifra dev\` loads: \`export { adapter, apiPrefix } from "./backend/framework"\`.
export const apiPrefix = ""
`
}

/** Nifra packages every site depends on, whatever it renders with and wherever it deploys. */
const NIFRA_RUNTIME = ["client", "core", "middleware", "schema", "web"]

/** The deploy shape a site's manifest is written for. */
export interface SiteTarget {
  readonly target: DeployTarget
  readonly docker: boolean
  /** The app name, for the Docker image tag. */
  readonly name: string
}

export function renderPackageJson(framework: FrameworkSpec, site: SiteTarget): string {
  const spec = TARGETS[site.target]
  const dependencies: Record<string, string> = {}
  for (const name of [...NIFRA_RUNTIME, ...(spec.runtime ?? [])].sort()) {
    dependencies[`@nifrajs/${name}`] = NIFRA_DEP_RANGE
  }
  dependencies[framework.package] = NIFRA_DEP_RANGE
  Object.assign(dependencies, framework.runtimeDependencies)
  const deploy = deployScript(site.target, site.name, site.docker)

  return json({
    name: "nifra-site",
    version: "0.0.0",
    type: "module",
    private: true,
    scripts: {
      dev: "nifra dev",
      build: "nifra build",
      ...(spec.start === undefined ? {} : { start: spec.start }),
      ...(deploy === undefined ? {} : { deploy }),
      check: "nifra check && nifra assure",
    },
    dependencies,
    devDependencies: {
      "@nifrajs/cli": NIFRA_DEP_RANGE,
      "@types/bun": "^1.4.2",
      ...framework.devDependencies,
      typescript: "^6.0.3",
      vite: "^8.2.1",
    },
  })
}

/** Directories a build writes and a typecheck must not read. */
const EXCLUDE = ["node_modules", "dist", ".nifra", ".nifra-build", ".vercel", ".wrangler"]

export function renderTsconfig(framework: FrameworkSpec): string {
  const ts = framework.typescript
  return json({
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM", "DOM.Iterable"],
      ...(ts.jsx === undefined ? {} : { jsx: ts.jsx }),
      ...(ts.jsxImportSource === undefined ? {} : { jsxImportSource: ts.jsxImportSource }),
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      noEmit: true,
      verbatimModuleSyntax: true,
      // The `--db` modules import their siblings as `./schema.ts`, the way Bun runs them.
      allowImportingTsExtensions: true,
      types: ["bun", ...(ts.types ?? [])],
      // Merges the generated `.nifra/types` tree in, so a route imports its types as `./+types/<name>`.
      rootDirs: [".", "./.nifra/types"],
    },
    include: ts.include ?? ["**/*.ts", "**/*.tsx"],
    exclude: EXCLUDE,
  })
}
