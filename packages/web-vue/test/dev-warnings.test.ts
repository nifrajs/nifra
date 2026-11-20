import { expect, test } from "bun:test"
import { format } from "node:util"
import { classify, isConsoleDiagnostic } from "@nifrajs/web/diagnostic"
import { createSSRApp, defineComponent, h } from "vue"
import { renderToString } from "vue/server-renderer"

// The warning Vue's own development build prints, not a copy of its text.
test("Vue's missing-prop warning is a nifra warning, not an error", async () => {
  const seen: string[] = []
  const original = console.warn
  console.warn = (...args: unknown[]) => {
    seen.push(format(...args))
  }
  try {
    const Child = defineComponent({
      props: { id: { type: String, required: true } },
      render() {
        return h("p", this.id)
      },
    })
    await renderToString(createSSRApp({ render: () => h(Child) }))
  } finally {
    console.warn = original
  }
  expect(seen).toHaveLength(1)
  const message = seen[0] ?? ""
  expect(isConsoleDiagnostic(message)).toBe(true)
  expect(classify("Warning", message)).toMatchObject({
    code: "NIFRA_VUE_WARNING",
    severity: "warning",
  })
})
