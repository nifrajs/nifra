import { spawnSync } from "node:child_process"
import { rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")
const result = spawnSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "--project",
    resolve(root, "packages/web/test/fixtures/server-components/tsconfig.contract.json"),
  ],
  { cwd: resolve(root, "packages/web"), encoding: "utf8" },
)
if (result.status !== 0) throw new Error(result.stdout + result.stderr)
console.log("components: five-adapter schema contract types and deliberate breaks passed")
const require = createRequire(resolve(root, "packages/web/package.json"))
const tsc = resolve(root, "node_modules/typescript/bin/tsc")
const fixture = resolve(root, "packages/web/test/fixtures/server-components")
const commands = [
  [
    "svelte implementation",
    [
      require.resolve("svelte-check/bin/svelte-check"),
      "--workspace",
      resolve(root, "packages/web-svelte"),
      "--tsconfig",
      "tsconfig.components.json",
      "--output",
      "human",
    ],
  ],
  [
    "react",
    [
      tsc,
      "--project",
      resolve(root, "packages/web-react/test/fixtures/server-components/tsconfig.json"),
    ],
  ],
  [
    "vue",
    [require.resolve("vue-tsc/bin/vue-tsc.js"), "--project", resolve(fixture, "vue/tsconfig.json")],
  ],
  ["solid", [tsc, "--project", resolve(fixture, "solid/tsconfig.json")]],
  ["preact", [tsc, "--project", resolve(fixture, "preact/tsconfig.json")]],
  [
    "svelte",
    [
      require.resolve("svelte-check/bin/svelte-check"),
      "--workspace",
      resolve(fixture, "svelte"),
      "--tsconfig",
      "tsconfig.json",
      "--output",
      "human",
    ],
  ],
] as const
const run = (args: readonly string[], negative = false): string => {
  const result = spawnSync("node", args, { cwd: root, encoding: "utf8" })
  const output = result.stdout + result.stderr
  if (!negative && result.status !== 0) throw new Error(output)
  if (
    negative &&
    (result.status === 0 || !/number.*string|not assignable to type 'string'/.test(output))
  )
    throw new Error(
      `Native template did not reject its deliberately broken schema input:\n${output}`,
    )
  return output
}
run([resolve(root, "scripts/gen-component-svelte-types.mjs"), "--check"])
for (const [adapter, args] of commands) {
  run(args)
  console.log(`components: ${adapter} native fixture typecheck passed`)
}
for (const adapter of ["vue", "svelte", "preact"] as const) {
  const file = resolve(
    fixture,
    adapter,
    adapter === "vue"
      ? "Invalid.types.frontend.vue"
      : adapter === "preact"
        ? "Invalid.types.frontend.tsx"
        : "Invalid.types.frontend.svelte",
  )
  const imports =
    'import type { ComponentState, ServerComponent } from "@nifrajs/web/server-components/client"; declare const handle: ServerComponent<{ id: string }, { title: string }, string>;'
  const source =
    adapter === "vue"
      ? `<script setup lang="ts">${imports} import {createServerComponentOutlet} from "@nifrajs/web-vue/server-components/outlet"; defineProps<{state: ComponentState}>(); const Outlet = createServerComponentOutlet(handle);</script><template><Outlet :state="state" instance-key="stable" :input="{id: 42}" /></template>`
      : adapter === "preact"
        ? `${imports} import {ServerComponent as Outlet} from "@nifrajs/web-preact/server-components/outlet"; export function Invalid({state}: {state: ComponentState}) { return <Outlet state={state} component={handle} instanceKey="stable" input={{id: 42}} />; }`
        : `<script lang="ts">${imports} import Outlet from "@nifrajs/web-svelte/server-components/outlet"; let {state}: {state: ComponentState} = $props();</script><Outlet {state} component={handle} instanceKey="stable" input={{id: 42}} />`
  try {
    await writeFile(file, source, { flag: "wx" })
    run(commands.find(([name]) => name === adapter)![1], true)
    console.log(`components: ${adapter} native template deliberate break rejected`)
  } finally {
    await rm(file, { force: true })
  }
}
