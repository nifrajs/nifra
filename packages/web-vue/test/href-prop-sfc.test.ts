import { expect, test } from "bun:test"
import { compileScript, parse, registerTS } from "@vue/compiler-sfc"
import ts from "typescript"

registerTS(() => ts)

const SFC = `<script setup lang="ts">
import type { Href } from "@nifrajs/web"
defineProps<{ to: Href }>()
</script>
<template><a :href="to"><slot /></a></template>
`

// A component wrapping <a> takes `to: Href`. The compiler has to resolve the imported brand to emit the
// prop, and it throws on a type it cannot (a generic over a conditional type is one that it cannot).
test("a Vue SFC declares an Href prop and compiles", () => {
  const { descriptor, errors } = parse(SFC, { filename: `${import.meta.dir}/HrefLink.vue` })
  expect(errors).toEqual([])
  const compiled = compileScript(descriptor, {
    id: "href-link",
    fs: {
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      realpath: (file) => ts.sys.realpath?.(file) ?? file,
    },
  })
  expect(compiled.content).toMatch(/to:\s*\{[^}]*required:\s*true/)
})
