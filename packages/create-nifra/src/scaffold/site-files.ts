/**
 * The rest of a site scaffold's mechanical files: the adapter re-export, the manifest, the tsconfig.
 *
 * Same argument as `site-build.ts`. These three were five copies each whose only real difference was
 * which framework they name, and keeping five copies is how `.vercel` came to be excluded from four
 * tsconfigs and not the fifth.
 */
import { type FrameworkSpec, NIFRA_DEP_RANGE } from "./frameworks.ts"

/** JSON as these files are written: two-space indent, trailing newline. */
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/**
 * `framework.ts` - the one file every server entry imports the adapter from, which is what keeps the
 * entries themselves framework-agnostic and therefore shareable.
 */
export function renderFrameworkModule(framework: FrameworkSpec): string {
  return `// The frontend adapter for this app. \`create-nifra --framework <react|preact|vue|solid|svelte>\` swaps
// this one line (and the routes + build config); every server entry imports the adapter from here, so
// they stay framework-agnostic.
import { ${framework.adapter} } from "${framework.package}"

export const adapter = ${framework.adapter}
`
}

/** The scripts every site scaffold ships, identical across frameworks. */
const SCRIPTS: Readonly<Record<string, string>> = {
  dev: "nifra dev",
  preview: "bunx wrangler pages dev dist",
  build: "bun run build.ts",
  "build:bun": "bun run build-bun.ts",
  "build:node": "bun run build-node.ts",
  "build:deno": "bun run build-deno.ts",
  "build:vercel": "bun run build-vercel.ts",
  start: "bun dist-bun/server-bun.js",
  "start:node": "node dist-node/server-node.js",
  "deploy:cf": "wrangler pages deploy dist",
  "deploy:vercel": "vercel deploy --prebuilt",
  check: "nifra check && nifra assure",
}

/** Nifra packages every site depends on, whatever it renders with. */
const NIFRA_RUNTIME = ["client", "core", "middleware", "schema", "deno", "node", "web"]

export function renderPackageJson(framework: FrameworkSpec): string {
  const dependencies: Record<string, string> = {}
  for (const name of NIFRA_RUNTIME) dependencies[`@nifrajs/${name}`] = NIFRA_DEP_RANGE
  dependencies[framework.package] = NIFRA_DEP_RANGE
  Object.assign(dependencies, framework.runtimeDependencies)

  return json({
    name: "nifra-site",
    version: "0.0.0",
    type: "module",
    private: true,
    scripts: SCRIPTS,
    dependencies,
    devDependencies: {
      "@nifrajs/cli": NIFRA_DEP_RANGE,
      ...framework.devDependencies,
      typescript: "^6.0.3",
      vite: "^8.2.1",
    },
  })
}

/**
 * Directories a build writes and a typecheck must not read, plus the entries that are run by Bun
 * rather than typechecked as part of the app.
 *
 * `.vercel` is in here for every framework. It was missing from React's copy alone, which is the shape
 * this whole refactor is about: `build-vercel.ts` writes there in all five, and four tsconfigs knew.
 */
const EXCLUDE = [
  "node_modules",
  "dist",
  "dist-bun",
  "dist-node",
  "dist-deno",
  "dist-vercel",
  ".nifra",
  ".vercel",
  ".wrangler",
  "server-manifest.ts",
  "server-bun.ts",
  "server-node.ts",
  "server-deno.ts",
  "server-vercel.ts",
  "_worker.ts",
  "build.ts",
  "build-bun.ts",
  "build-node.ts",
  "build-deno.ts",
  "build-vercel.ts",
]

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
      ...(ts.types === undefined ? {} : { types: ts.types }),
    },
    include: ts.includeTsx === false ? ["**/*.ts"] : ["**/*.ts", "**/*.tsx"],
    exclude: EXCLUDE,
  })
}
