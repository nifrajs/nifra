import { describe, expect, test } from "bun:test"
import { createSSRApp, defineComponent, h, type PropType } from "vue"
import { renderToString } from "vue/server-renderer"
import { errorBoundary } from "../src/error.ts"

const Fallback = defineComponent({
  props: { data: { type: Object as PropType<{ name: string; message: string }>, required: true } },
  setup: (props) => () => h("div", { id: "err" }, `${props.data.name}: ${props.data.message}`),
})

const render = (slot: () => unknown): Promise<string> => {
  const Boundary = errorBoundary(Fallback) as Parameters<typeof h>[0]
  return renderToString(createSSRApp({ render: () => h(Boundary, null, { default: slot }) }))
}

// Like React, Vue's boundary is a CLIENT recovery mechanism: `onErrorCaptured` handles a subtree throw
// (returns false → no propagation), but one-pass SSR can't re-render the fallback (that's client-only,
// browser-verified end-to-end via the codegen pipeline). In nifra's pipeline the boundary is client-only
// anyway, so an SSR render throw rejects and hits the agnostic 3a handler. These tests assert the SSR
// contract (capture without crashing or leaking the error) + transparency.
describe("@nifrajs/web-vue errorBoundary", () => {
  test("captures a subtree throw in SSR without crashing or leaking the error message", async () => {
    const Throwing = defineComponent({
      setup: () => () => {
        throw new Error("boom")
      },
    })
    const html = await render(() => h(Throwing))
    expect(typeof html).toBe("string") // onErrorCaptured handled it — no rejection
    expect(html).not.toContain("boom") // not leaked into SSR markup
  })

  test("captures a non-Error throw too (wrapped in an Error)", async () => {
    const Throwing = defineComponent({
      setup: () => () => {
        throw "plain string"
      },
    })
    expect(typeof (await render(() => h(Throwing)))).toBe("string")
  })

  test("transparent: renders children unchanged when nothing throws", async () => {
    const Ok = defineComponent({ setup: () => () => h("p", null, "ok") })
    const html = await render(() => h(Ok))
    expect(html).toContain("<p>ok</p>")
    expect(html).not.toContain('id="err"')
  })
})
