/**
 * The five build entries a site scaffold ships, emitted from one shape.
 *
 * These were 25 files - five deploy targets copied across five framework directories - and the
 * difference between any two of them is mechanical: which runtime it targets, and which compiler
 * plugin, resolve conditions and defines the framework needs. Nothing else. So the target owns its
 * own prose (what it emits, how to run it) and the framework contributes its injections, and the 25
 * files come out of one function.
 *
 * The emitted text is asserted byte-for-byte against the templates that used to be checked in, so
 * this is a refactor whose correctness is decided by a test rather than by reading.
 */
import type { FrameworkSpec } from "./frameworks.ts"

const NODE_ENV_DEFINE = `"process.env.NODE_ENV": '"production"'`

/** The framework-dependent lines that vary inside every build file. */
interface Injections {
  /** Plugin import, or empty. Emitted directly under the `@nifrajs/web/build` import. */
  readonly pluginImport: string
  /** Hoisted `const define = …`, used when the object is shared by both build calls. */
  readonly defineConst: string
  readonly clientPlugins: string
  readonly clientConditions: string
  readonly clientDefine: string
  readonly serverPlugins: string
  readonly serverConditions: string
  readonly serverDefine: string
}

/**
 * A framework with no compiler plugin keeps the define inline in the client call, exactly as the
 * React and Preact templates had it: nothing is shared, so hoisting it would name a constant used
 * once. A framework WITH a plugin needs the same defines in both calls, so it hoists.
 */
function injectionsFor(framework: FrameworkSpec, target: BuildTarget): Injections {
  const extraDefines = Object.entries(framework.define ?? {}).map(([k, v]) => `${k}: ${v}`)
  const hoist = framework.bunPlugin !== undefined
  const defineEntries = [NODE_ENV_DEFINE, ...extraDefines]
  const defineLiteral =
    defineEntries.length === 1
      ? `{ ${defineEntries[0]} }`
      : `{\n${defineEntries.map((e) => `  ${e},`).join("\n")}\n}`

  const plugin = framework.bunPlugin
  const call = (mode: "dom" | "ssr"): string => {
    if (plugin === undefined) return ""
    return `  plugins: [${plugin.name}("${mode}")],${plugin.note?.[mode] ?? ""}\n`
  }
  const list = (values: readonly string[]): string =>
    `  conditions: [${values.map((c) => `"${c}"`).join(", ")}],\n`
  // The client call always names its conditions (`bun`, then anything the framework adds, then
  // `browser`). The server call names them ONLY when the framework contributes one - otherwise the
  // build's own default is right and spelling it out would be noise.
  const clientConditions = (extra: readonly string[] | undefined): string =>
    list(["bun", ...(extra ?? []), "browser"])
  const serverConditions = (extra: readonly string[] | undefined): string =>
    extra === undefined || extra.length === 0
      ? ""
      : list([...target.serverConditions.before, ...extra, ...target.serverConditions.after])

  return {
    pluginImport:
      plugin === undefined ? "" : `import { ${plugin.name} } from "${plugin.specifier}"\n`,
    defineConst: hoist
      ? `${framework.defineNote === undefined ? "" : `${framework.defineNote}\n`}const define = ${defineLiteral}\n`
      : "",
    clientPlugins: call("dom"),
    clientConditions: clientConditions(framework.conditions?.client),
    clientDefine: hoist ? "  define,\n" : `  define: ${defineLiteral},\n`,
    serverPlugins: call("ssr"),
    serverConditions: serverConditions(framework.conditions?.ssr),
    serverDefine: hoist ? "  define,\n" : "",
  }
}

/**
 * Where the framework's own resolve conditions sit inside a target's server list.
 *
 * The edge targets end theirs with `browser` (the worker has no Node builtins, so packages must be
 * asked for their browser build); Bun and Node do not. The framework's conditions go in the middle,
 * which is the order every checked-in template used.
 */
export interface ServerConditionSlots {
  readonly before: readonly string[]
  readonly after: readonly string[]
}

export interface BuildTarget {
  /** File name, e.g. `build-bun.ts`. */
  readonly file: string
  /** Leading comment block, without the trailing newline. */
  readonly header: string
  /**
   * Frameworks whose header says something extra here - what their plugin does, or how to run the
   * output once their compiler is in the picture.
   *
   * These are the one genuinely non-mechanical part of a build entry, and they are the reason this
   * table exists rather than a pure `{framework, runtime}` function: the prose a framework needs to
   * explain itself is written, not derived. Keeping them beside the target they belong to is the
   * closest thing to having them in the file without having five copies of the file.
   */
  readonly headerOverrides?: Readonly<Record<string, string>>
  /** Runtime conditions this target's SERVER build resolves with. */
  readonly serverConditions: ServerConditionSlots
  /** Extra `node:fs` named imports beyond `cpSync, mkdirSync, rmSync`. */
  readonly extraFsImports?: readonly string[]
  /** Lines between the imports and the first build call, `dir` already declared. */
  readonly setup: string
  /** Where `buildClient` writes assets, as a template expression. */
  readonly clientOutDir: string
  /** The server entry this target boots from. */
  readonly serverEntry: string
  /** Scratch directory for the server build. */
  readonly serverOutDir: string
  /** `target:` line for `buildServer`, or empty for the default (workerd). */
  readonly serverTarget: string
  /** Everything after the `buildServer` call. */
  readonly tail: string
}

export const BUILD_TARGETS: readonly BuildTarget[] = [
  {
    file: "build.ts",
    header:
      "// Build for Cloudflare Pages → dist/ (_worker.js + _routes.json + client assets). `bun run build`.",
    headerOverrides: {
      solid: `// Build for Cloudflare Pages → dist/ (_worker.js + _routes.json + client assets). \`bun run build\`.
// Solid: solidBunPlugin("dom") for the client, ("ssr") for the server + the \`solid\` export condition.`,
      svelte: `// Build for Cloudflare Pages → dist/ (_worker.js + _routes.json + client assets). \`bun run build\`.
// Svelte: svelteBunPlugin("dom") compiles .svelte for the client, ("ssr") for the server bundle.`,
    },
    serverConditions: { before: ["workerd", "edge-light"], after: ["browser"] },
    extraFsImports: ["writeFileSync"],
    setup: "const dist = `${dir}/dist`\n",
    clientOutDir: "`${dist}/assets`",
    serverEntry: "`${dir}/_worker.ts`",
    serverOutDir: "`${dir}/.build`",
    serverTarget: "",
    tail: `cpSync(worker, \`\${dist}/_worker.js\`)
rmSync(\`\${dir}/.build\`, { recursive: true, force: true })
writeFileSync(
  \`\${dist}/_routes.json\`,
  \`\${JSON.stringify({ version: 1, include: ["/*"], exclude: ["/assets/*"] }, null, 2)}\\n\`,
)
console.log("Cloudflare Pages output → dist (deploy: wrangler pages deploy dist)")
`,
  },
  {
    file: "build-bun.ts",
    header: `// Build for Bun (nifra's flagship runtime) → dist-bun/ (server-bun.js + client assets).
// \`bun run build:bun\`. Run: \`bun dist-bun/server-bun.js\`.`,
    serverConditions: { before: ["bun"], after: [] },
    setup: "const dist = `${dir}/dist-bun`\n",
    clientOutDir: "`${dist}/assets`",
    serverEntry: "`${dir}/server-bun.ts`",
    serverOutDir: "`${dir}/.build-bun`",
    serverTarget: '  target: "bun",\n',
    tail: `cpSync(worker, \`\${dist}/server-bun.js\`)
rmSync(\`\${dir}/.build-bun\`, { recursive: true, force: true })
console.log("Bun output → dist-bun (run: bun dist-bun/server-bun.js)")
`,
  },
  {
    file: "build-node.ts",
    header:
      "// Build for Node → dist-node/ (server-node.js + client assets). `bun run build:node`.",
    headerOverrides: {
      solid: `// Build for Node → dist-node/ (server-node.js + client assets). \`bun run build:node\`.
// Run: \`node dist-node/server-node.js\` (or the Dockerfile). \`node\`+\`solid\` → solid-js/web's server build.`,
      svelte: `// Build for Node → dist-node/ (server-node.js + client assets). \`bun run build:node\`.
// Run: \`node dist-node/server-node.js\` (or the Dockerfile).`,
      vue: `// Build for Node → dist-node/ (server-node.js + client assets). \`bun run build:node\`.
// Run: \`node dist-node/server-node.js\` (or the Dockerfile).`,
    },
    serverConditions: { before: ["node"], after: [] },
    setup: "const dist = `${dir}/dist-node`\n",
    clientOutDir: "`${dist}/assets`",
    serverEntry: "`${dir}/server-node.ts`",
    serverOutDir: "`${dir}/.build-node`",
    serverTarget: '  target: "node",\n',
    tail: `cpSync(worker, \`\${dist}/server-node.js\`)
rmSync(\`\${dir}/.build-node\`, { recursive: true, force: true })
console.log("Node output → dist-node (run: node dist-node/server-node.js)")
`,
  },
  {
    file: "build-deno.ts",
    header:
      "// Build for Deno → dist-deno/ (server-deno.js + client assets). `bun run build:deno`.",
    headerOverrides: {
      solid: `// Build for Deno → dist-deno/ (server-deno.js + client assets). \`bun run build:deno\`.
// Run: \`deno task start\` (or deployctl). Deno runs the edge bundle (workerd/edge-light + solid).`,
      svelte: `// Build for Deno → dist-deno/ (server-deno.js + client assets). \`bun run build:deno\`.
// Run: \`deno task start\` (or deployctl).`,
      vue: `// Build for Deno → dist-deno/ (server-deno.js + client assets). \`bun run build:deno\`.
// Run: \`deno task start\` (or deployctl for Deno Deploy).`,
    },
    serverConditions: { before: ["workerd", "edge-light"], after: ["browser"] },
    setup: "const dist = `${dir}/dist-deno`\n",
    clientOutDir: "`${dist}/assets`",
    serverEntry: "`${dir}/server-deno.ts`",
    serverOutDir: "`${dir}/.build-deno`",
    serverTarget: "",
    tail: `cpSync(worker, \`\${dist}/server-deno.js\`)
rmSync(\`\${dir}/.build-deno\`, { recursive: true, force: true })
console.log("Deno output → dist-deno (run: deno run -A dist-deno/server-deno.js)")
`,
  },
  {
    file: "build-vercel.ts",
    header: `// Build for Vercel, emitting Vercel's Build Output API v3 at .vercel/output/ so it deploys with no
// framework preset: \`vercel deploy --prebuilt\`. Layout:
//   .vercel/output/config.json                   — serve static files, else SSR via the function
//   .vercel/output/static/assets/<client bundle>  — Vercel's CDN serves these directly
//   .vercel/output/functions/index.func/index.js  — the Edge SSR function (+ .vc-config.json)`,
    serverConditions: { before: ["workerd", "edge-light"], after: ["browser"] },
    extraFsImports: ["writeFileSync"],
    setup: `const out = \`\${dir}/.vercel/output\`
const fn = \`\${out}/functions/index.func\`
`,
    clientOutDir: "`${out}/static/assets`",
    serverEntry: "`${dir}/server-vercel.ts`",
    serverOutDir: "`${dir}/.build-vercel`",
    serverTarget: "",
    tail: `cpSync(worker, \`\${fn}/index.js\`)
rmSync(\`\${dir}/.build-vercel\`, { recursive: true, force: true })

// Build Output API v3: serve real files first (\`handle: filesystem\` → /assets/*), then SSR the rest.
writeFileSync(
  \`\${fn}/.vc-config.json\`,
  \`\${JSON.stringify({ runtime: "edge", entrypoint: "index.js" }, null, 2)}\\n\`,
)
writeFileSync(
  \`\${out}/config.json\`,
  \`\${JSON.stringify(
    { version: 3, routes: [{ handle: "filesystem" }, { src: "/(.*)", dest: "/index" }] },
    null,
    2,
  )}\\n\`,
)
console.log("Vercel output → .vercel/output (deploy: vercel deploy --prebuilt)")
`,
  },
]

/** The `rm`/`mkdir` preamble differs only for Vercel, which builds two trees rather than one. */
function preambleFor(target: BuildTarget): string {
  if (target.file !== "build-vercel.ts") {
    return `rmSync(dist, { recursive: true, force: true })
mkdirSync(\`\${dist}/assets\`, { recursive: true })
`
  }
  return `rmSync(\`\${dir}/.vercel\`, { recursive: true, force: true })
mkdirSync(\`\${out}/static/assets\`, { recursive: true })
mkdirSync(fn, { recursive: true })
`
}

/** Emit one target's build entry for one framework. */
export function renderBuildFile(target: BuildTarget, framework: FrameworkSpec): string {
  const injections = injectionsFor(framework, target)
  const header = target.headerOverrides?.[framework.id] ?? target.header
  const fsImports = ["cpSync", "mkdirSync", "rmSync", ...(target.extraFsImports ?? [])].sort()
  return `${header}
import { ${fsImports.join(", ")} } from "node:fs"
import { buildClient, buildServer } from "@nifrajs/web/build"
${injections.pluginImport}
const dir = import.meta.dir
${target.setup}${injections.defineConst}${preambleFor(target)}
const client = await buildClient({
  routesDir: \`\${dir}/routes\`,
  outDir: ${target.clientOutDir},
  clientModule: "${framework.package}/client",
${injections.clientPlugins}${injections.clientConditions}${injections.clientDefine}})
const { worker } = await buildServer({
  routesDir: \`\${dir}/routes\`,
  serverEntry: ${target.serverEntry},
  outDir: ${target.serverOutDir},
${target.serverTarget}  clientEntry: client.entry,
${injections.serverPlugins}${injections.serverConditions}${injections.serverDefine}})
${target.tail}`
}
