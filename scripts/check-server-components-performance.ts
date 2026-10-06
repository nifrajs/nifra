import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { arch, cpus, tmpdir } from "node:os"
import { relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const root = resolve(import.meta.dirname, "..")
const baseline = "a19402be504144c81f8935545cd4d6612f68e903"
const scratch = await mkdtemp(resolve(tmpdir(), "nifra-component-performance-"))
const fixture = "packages/web/test/fixtures/server-components"
const run = (args: readonly string[], env: Record<string, string> = {}): string => {
  const result = spawnSync(args[0]!, args.slice(1), {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  })
  if (result.status !== 0)
    throw new Error(`${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}
try {
  const archive = spawnSync("git", ["archive", baseline, "packages/web/src"], {
    cwd: root,
    maxBuffer: 20 * 1024 * 1024,
  })
  assert.equal(archive.status, 0, "Frozen disabled-mode source baseline is required")
  const unpack = spawnSync("tar", ["-xf", "-", "-C", scratch], { input: archive.stdout })
  assert.equal(unpack.status, 0)
  await symlink(resolve(root, "node_modules"), resolve(scratch, "node_modules"), "dir")
  const resultAt = (entry: string) =>
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The bounded measurement child emits the fixed metrics envelope used by this runner.
    JSON.parse(
      run([process.execPath, `${fixture}/check-disabled.ts`], {
        NIFRA_COMPONENT_BASE_WEB: pathToFileURL(entry).href,
      }).trim(),
    ) as { fingerprint: string; p95: number; runs: readonly unknown[] }
  console.log("components: measure frozen disabled baseline (five runs)")
  const before = resultAt(resolve(scratch, "packages/web/src/index.ts"))
  const after = resultAt(resolve(root, "packages/web/src/index.ts"))
  assert.equal(
    after.fingerprint,
    before.fingerprint,
    "Disabled SSR and headers must remain equivalent",
  )
  assert.ok(
    after.p95 <= before.p95 * 1.03,
    `Disabled-mode p95 ${after.p95} exceeds 1.03x baseline ${before.p95}`,
  )
  const entry = resolve(scratch, "disabled-entry.ts")
  await writeFile(
    entry,
    `import {createWebApp} from ${JSON.stringify(resolve(root, "packages/web/src/index.ts"))}; export const app = createWebApp({manifest:{routes:[],layouts:{},errors:{}},adapter:{renderToString(){return ""},renderToStream(){return new ReadableStream()},hydrationHead(){return ""}},clientEntry:"/entry.js",llmsTxt:false});`,
  )
  const forbidden: string[] = []
  const built = await Bun.build({
    entrypoints: [entry],
    target: "bun",
    plugins: [
      {
        name: "disabled-import-proof",
        setup(builder) {
          builder.onLoad({ filter: /.*/ }, (args) => {
            const name = relative(root, args.path).replaceAll("\\", "/")
            if (
              /^packages\/(?:web\/(?:src|dist)\/server-components|web-(?:react|vue|svelte|solid|preact))\//.test(
                name,
              ) ||
              /node_modules\/(?:\.bun\/)?(?:react(?:-dom|-server-dom-webpack)?|vue|svelte|solid-js|preact(?:-render-to-string)?)(?:@|\/)/.test(
                name,
              )
            )
              forbidden.push(name)
            return undefined
          })
        },
      },
    ],
  })
  assert.ok(built.success, "Disabled bundle must build")
  assert.deepEqual(
    forbidden,
    [],
    "Disabled apps may not load feature or unrelated framework modules",
  )
  await mkdir(resolve(root, ".nifra-components-fixtures"), { recursive: true })
  await writeFile(
    resolve(root, ".nifra-components-fixtures/performance-disabled.json"),
    JSON.stringify(
      {
        status: "passed",
        baseline,
        before,
        after,
        hardware: cpus()[0]?.model,
        arch: arch(),
        bun: Bun.version,
        samples: 200,
        warmups: 30,
        runs: 5,
      },
      null,
      2,
    ) + "\n",
  )
  console.log("components: disabled response, imports and 1.03x latency gate passed")
  for (const adapter of ["react", "vue", "svelte", "solid", "preact"]) {
    run(["node", `${fixture}/build-fixture.mjs`], {
      NIFRA_COMPONENT_ADAPTER: adapter,
      NIFRA_COMPONENT_TARGET: "node",
    })
    run(["node", `${fixture}/check-performance.mjs`], {
      NIFRA_COMPONENT_ADAPTER: adapter,
      NIFRA_COMPONENT_OUT: resolve(root, ".nifra-components-fixtures", adapter, "node"),
    })
    console.log(
      `components: ${adapter} equal-work SSR/refresh latency and compressed bundles passed`,
    )
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
