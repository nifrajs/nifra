import { afterEach, expect, test } from "bun:test"
import { compileVue } from "../src/plugin.ts"

/**
 * HMR wiring belongs to a dev server and must never reach a production bundle.
 *
 * `if (import.meta.hot)` looks like it would take care of that, and it does not: `Bun.build` keeps the
 * branch, so `__hmrId`, `createRecord` and the accept callback were measured in several chunks of a
 * `nifra build` client bundle. The phase cannot be a plugin constructor argument either - an app builds
 * `clientPlugins` once in `nifra.config.ts` and the same objects serve both phases - so the dev server
 * sets `NIFRA_DEV_HMR` and the compiler reads it.
 */

const SFC = `
<script setup>
import { ref } from "vue"
const n = ref(0)
</script>
<template><p>{{ n }}</p></template>
`

const HMR_MARKERS = ["__hmrId", "__VUE_HMR_RUNTIME__", "_rerender_only", "import.meta.hot"]

afterEach(() => {
  delete process.env.NIFRA_DEV_HMR
})

test("a production client compile emits no HMR wiring", () => {
  delete process.env.NIFRA_DEV_HMR
  const code = compileVue(SFC, "/app/routes/index.vue", "dom")
  for (const marker of HMR_MARKERS) expect(code).not.toContain(marker)
})

test("a dev-server client compile emits the HMR wiring", () => {
  process.env.NIFRA_DEV_HMR = "1"
  const code = compileVue(SFC, "/app/routes/dev.vue", "dom")
  for (const marker of HMR_MARKERS) expect(code).toContain(marker)
})

test("the SSR compile never emits HMR wiring, dev server or not", () => {
  process.env.NIFRA_DEV_HMR = "1"
  const code = compileVue(SFC, "/app/routes/ssr.vue", "ssr")
  for (const marker of HMR_MARKERS) expect(code).not.toContain(marker)
})

test("a template-only re-compile asks for rerender; a script change asks for reload", () => {
  process.env.NIFRA_DEV_HMR = "1"
  const file = "/app/routes/churn.vue"
  // First compile has no previous script to compare against, so it cannot claim rerender-only.
  expect(compileVue(SFC, file, "dom")).toContain("export const _rerender_only = false")
  // Same script, different template -> the render function alone can be swapped, keeping state.
  const templateChanged = SFC.replace("{{ n }}", "{{ n }}!")
  expect(compileVue(templateChanged, file, "dom")).toContain("export const _rerender_only = true")
  // Script changed -> the component has to be re-created.
  const scriptChanged = SFC.replace("const n = ref(0)", "const n = ref(1)")
  expect(compileVue(scriptChanged, file, "dom")).toContain("export const _rerender_only = false")
})
