/**
 * Build a benchmark tree that runs the PUBLISHED `@nifrajs/*` packages instead of this checkout.
 *
 * The suite already measures `dist/`, not `src/` - _nifra-app.ts pins the built artifact on purpose,
 * because `@nifrajs/core`'s "bun" export condition would otherwise resolve to live TypeScript and
 * measure something no installed user runs. What it does NOT cover is the step from "dist this
 * checkout just built" to "the tarball npm actually serves": the `files` allowlist, whatever the
 * publish pipeline did to it, and the transitive dependency versions a fresh install resolves. This
 * closes that gap, which is the whole point of quoting a release's numbers.
 *
 *   bun run bench/http-realworld/setup-published.ts            # pins the version in package.json
 *   bun run bench/http-realworld/setup-published.ts 2.9.0      # an explicit version
 *   bun run bench/http-realworld/setup-published.ts latest     # whatever npm currently serves
 *
 * Then run the normal harness against it:
 *
 *   BENCH_APP_DIR=bench/.published/app bun run bench/http-realworld/run.ts
 *
 * The install happens in a temp directory OUTSIDE the repo and is copied in. Running `bun install`
 * inside the repo would let the root workspace claim it and link `@nifrajs/*` straight back to
 * `packages/*` - silently benchmarking the checkout again while appearing to test the release, which
 * is the one failure this script must not have. Every import below is rewritten to an explicit path
 * for the same reason: a BARE specifier still resolves through the root workspace map, which beats
 * this directory's node_modules. Verified with marker builds, not assumed.
 *
 * KNOWN GAP - the Deno arm cannot run in this mode today. `@nifrajs/deno` publishes only `src/*.ts`,
 * and Deno refuses to strip types for anything under `node_modules`
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so the installed package fails to import. This is
 * not a bench limitation: `import "npm:@nifrajs/deno@2.9.0"` fails the same way, which is the exact
 * form the package README documents. It reproduces on 2.8.2, so it predates this release. The Bun
 * and Node arms measure the published packages; Deno numbers still have to come from the default
 * workspace mode until the package ships a Deno-loadable artifact.
 */
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Packages the bench actually loads. Peers (hono, elysia, fastify) stay on the repo's pinned
 * versions - they are the comparison, and changing them would move both sides of the ratio. */
const PACKAGES = ["@nifrajs/core", "@nifrajs/middleware", "@nifrajs/node", "@nifrajs/deno"] as const

const REPO = join(import.meta.dir, "..", "..")
const OUT_DIR = join(REPO, "bench", ".published", "app")

/** Rewrites applied to each copied server file: workspace-relative `dist/` paths become paths into
 * the installed packages. Same `<root>/<pkg>/dist/...` shape on both sides, so only the root moves. */
const REWRITES: ReadonlyArray<readonly [string, string]> = [
  ["../../packages/core/dist/", "./node_modules/@nifrajs/core/dist/"],
  ["../../packages/middleware/dist/", "./node_modules/@nifrajs/middleware/dist/"],
  ["../../packages/core/src/index.ts", "./node_modules/@nifrajs/core/dist/index.js"],
  // `@nifrajs/deno` ships `src/`, so its published layout keeps that path.
  ["../../packages/deno/src/", "./node_modules/@nifrajs/deno/src/"],
  // The Node adapter must become an explicit path too, for two reasons, both verified by marker
  // builds. A BARE `@nifrajs/node` here resolves through the ROOT workspace map - which wins over
  // this directory's node_modules and silently bundles the checkout, the exact failure this script
  // exists to prevent. And Bun's resolver would then take the package's "bun" condition to
  // `src/*.ts`, while a real Node user gets the "default" condition and runs `dist/index.js`. The
  // explicit dist path pins both: published tree, and the artifact Node actually loads.
  ['from "@nifrajs/node"', 'from "./node_modules/@nifrajs/node/dist/index.js"'],
]

/** Server files plus the shared app. `serve-node.ts` carries the Fastify arm and imports no nifra. */
const FILES = [
  "_nifra-app.ts",
  "serve.ts",
  "serve-node.ts",
  "serve-node-nifra.ts",
  "serve-deno.ts",
] as const

function run(cmd: string, args: readonly string[], cwd: string): void {
  const res = spawnSync(cmd, [...args], { cwd, stdio: "inherit" })
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${res.status})`)
}

/** The version to install. Defaults to whatever this checkout claims, so the tree matches the tag
 * being measured rather than drifting to a newer release mid-comparison. */
async function resolveVersion(argv: readonly string[]): Promise<string> {
  const explicit = argv[2]
  if (explicit !== undefined && explicit !== "") return explicit
  const pkg = JSON.parse(
    await readFile(join(REPO, "packages", "core", "package.json"), "utf8"),
  ) as {
    version: string
  }
  return pkg.version
}

const version = await resolveVersion(process.argv)
console.log(`[bench-published] installing ${PACKAGES.join(", ")} @ ${version}`)

const staging = await mkdtemp(join(tmpdir(), "nifra-bench-published-"))
await writeFile(
  join(staging, "package.json"),
  `${JSON.stringify(
    {
      name: "nifra-bench-published",
      private: true,
      dependencies: Object.fromEntries(PACKAGES.map((name) => [name, version])),
    },
    null,
    2,
  )}\n`,
)
run("bun", ["install", "--no-save"], staging)

// Prove the tree is the registry's, not a link back into this checkout. A symlinked package here
// would mean the whole run silently measured the workspace again.
const installedCore = JSON.parse(
  await readFile(join(staging, "node_modules", "@nifrajs", "core", "package.json"), "utf8"),
) as { version: string }
if (version !== "latest" && installedCore.version !== version) {
  throw new Error(`installed @nifrajs/core ${installedCore.version}, expected ${version}`)
}
console.log(`[bench-published] resolved @nifrajs/core ${installedCore.version}`)

await rm(OUT_DIR, { recursive: true, force: true })
await mkdir(OUT_DIR, { recursive: true })
await cp(join(staging, "node_modules"), join(OUT_DIR, "node_modules"), {
  recursive: true,
  dereference: true, // materialize bun's store links, so nothing points outside this tree
})

for (const file of FILES) {
  let source = await readFile(join(import.meta.dir, file), "utf8")
  for (const [from, to] of REWRITES) source = source.replaceAll(from, to)
  if (source.includes("../../packages/")) {
    throw new Error(`${file} still references the workspace after rewriting - add a REWRITES entry`)
  }
  await writeFile(join(OUT_DIR, file), source)
}

await rm(staging, { recursive: true, force: true })

console.log(`[bench-published] wrote ${OUT_DIR}`)
console.log("[bench-published] run it with:")
console.log(`  BENCH_APP_DIR=bench/.published/app bun run bench/http-realworld/run.ts`)
