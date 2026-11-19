/**
 * The `.svelte` and `.vue` half of `type-e2e.test.ts`. Plain `tsc` cannot read those files, so their
 * `searchSchema` reaches the route table only under svelte-check and vue-tsc. This writes one route of each
 * kind with the real `writeRouteTypes`, runs the framework's own checker over it, and holds what a page
 * and a link may do: `search` is the schema's output on the page and in the hook, and `href()` takes the
 * schema's input. A `@ts-expect-error` that stops matching is an error too, so each refusal is checked.
 *
 * A Vue page reads its search through `useSearch("/reports")`, not `defineProps<Route.ComponentProps>()`:
 * vue-tsc accepts that, but `@vue/compiler-sfc` cannot resolve `./+types/<name>` (it lives under the
 * `rootDirs` overlay) nor the conditional types inside it, so the component would not compile.
 */
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { writeRouteTypes } from "../../../packages/web/src/route-types.ts"

const REPO = resolve(import.meta.dir, "../../..")
const EXAMPLES = join(REPO, "examples")
const SVELTE = join(EXAMPLES, `.type-e2e-svelte-${process.pid}`)
const VUE = join(EXAMPLES, `.type-e2e-vue-${process.pid}`)

const SCHEMA = [
  'import type { StandardSchemaV1 } from "@nifrajs/core/server"',
  "export const searchSchema: StandardSchemaV1<{ page?: number }, { page: number }> = {",
  '  "~standard": { version: 1, vendor: "gate", validate: () => ({ value: { page: 1 } }) },',
  "}",
]

const CONSUMER = (adapter: string): string =>
  `import { href } from "@nifrajs/web-${adapter}/router"
export const ok = href({ to: "/reports", search: { page: 1 } })
export const defaulted = href({ to: "/reports", search: {} })
// @ts-expect-error - page is a number
export const wrong = href({ to: "/reports", search: { page: "x" } })
// @ts-expect-error - a route the app does not have
export const unknown = href({ to: "/zz-nope" })
`

// The route table is generated into a dot directory the globs skip, and no page here imports a `+types`
// module that would pull it in, so the program names it, as the example apps' own config does.
const tsconfig = (framework: string, extension: string): string =>
  `${JSON.stringify({
    extends: `../tsconfig.${framework}.json`,
    include: [
      "${configDir}/**/*.ts",
      ["${configDir}/**/*", extension].join("."),
      "${configDir}/.nifra/types/routes.d.ts",
    ],
  })}\n`

const files: ReadonlyArray<readonly [string, string]> = [
  [join(SVELTE, "tsconfig.json"), tsconfig("svelte", "svelte")],
  [
    join(SVELTE, "routes/reports.svelte"),
    `<script module lang="ts">
${SCHEMA.join("\n")}
</script>
<script lang="ts">
  import type { Route } from "./+types/reports"
  import { useSearch } from "@nifrajs/web-svelte/router"
  let { search }: Route.ComponentProps = $props()
  const page: number = search.page
  // @ts-expect-error - page is a number
  const wrong: string = search.page
  const viaHook: number = useSearch("/reports")().page
  void wrong
  void viaHook
</script>
<p>{page}</p>
`,
  ],
  [join(SVELTE, "consumer.ts"), CONSUMER("svelte")],
  [join(VUE, "tsconfig.json"), tsconfig("vue", "vue")],
  [
    join(VUE, "routes/reports.vue"),
    `<script lang="ts">
${SCHEMA.join("\n")}
</script>
<script setup lang="ts">
import { useSearch } from "@nifrajs/web-vue/router"
const search = useSearch("/reports")
const page: number = search.value.page
// @ts-expect-error - page is a number
const wrong: string = search.value.page
void wrong
</script>
<template><p>{{ page }}</p></template>
`,
  ],
  [join(VUE, "consumer.ts"), CONSUMER("vue")],
]

beforeAll(() => {
  for (const [path, text] of files) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  writeRouteTypes({ appRoot: SVELTE })
  writeRouteTypes({ appRoot: VUE })
})

afterAll(() => {
  rmSync(SVELTE, { recursive: true, force: true })
  rmSync(VUE, { recursive: true, force: true })
})

async function run(command: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...command], { cwd: REPO, stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  await proc.exited
  return `${out}${err}`
}

const bin = (name: string): string => join(EXAMPLES, "node_modules/.bin", name)

test("svelte-check types a .svelte route's search, on the page, in the hook and in href()", async () => {
  const out = await run([
    bin("svelte-check"),
    "--tsconfig",
    join(SVELTE, "tsconfig.json"),
    "--threshold",
    "error",
  ])
  const errors = out.split("\n").filter((line) => /\bERROR\b/.test(line))
  expect(errors).toEqual([])
  expect(out).toContain("COMPLETED")
}, 180_000)

test("vue-tsc types a .vue route's search, on the page, in the hook and in href()", async () => {
  const out = await run([bin("vue-tsc"), "--noEmit", "-p", join(VUE, "tsconfig.json")])
  expect(out.trim()).toBe("")
}, 180_000)
