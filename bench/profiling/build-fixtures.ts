import { mkdirSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"

const root = resolve(import.meta.dir, "../..")
const out = resolve(process.argv[2] ?? "bench/profiling/results/candidate")
mkdirSync(out, { recursive: true })
const sourceRoot = resolve(root, "packages/core/src")
const distRoot = resolve(root, "packages/core/dist")
const built = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "fixture-entry.ts")],
  target: "bun",
  outdir: out,
  plugins: [
    {
      name: "profile-built-core",
      setup(build) {
        build.onLoad({ filter: /[/\\]packages[/\\]core[/\\]src[/\\].*\.tsx?$/ }, ({ path }) => {
          const target = resolve(distRoot, relative(sourceRoot, path).replace(/\.tsx?$/, ".js"))
          return { contents: readFileSync(target, "utf8"), loader: "js" }
        })
      },
    },
  ],
})
if (!built.success) throw new AggregateError(built.logs, "Bun fixture build failed")
for (const [entry, folder] of [
  ["bench/http-realworld/serve-node-nifra.ts", "realworld"],
  ["bench/http/worst-case/serve-node-nifra-worst.ts", "generic"],
] as const) {
  const result = await Bun.build({
    entrypoints: [resolve(root, entry)],
    target: "node",
    outdir: resolve(out, folder),
  })
  if (!result.success) throw new AggregateError(result.logs, "Node fixture build failed")
}
console.log(out)
