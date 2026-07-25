import { expect, test } from "bun:test"
import { h } from "preact"
import { renderToString } from "preact-render-to-string"
import { useServerFn } from "../src/fn.ts"

/**
 * The state machine is tested in `@nifrajs/web`'s suite, including the timing cases every adapter
 * inherits. What is specific here is Preact's compat `useSyncExternalStore`, which takes two arguments
 * rather than three - getting that wrong is an SSR crash, not a wrong value.
 */
function Panel() {
  const fn = useServerFn(async (input: { text: string }) => input.text)
  return h(
    "div",
    {
      "data-pending": String(fn.pending),
      "data-idle": String(fn.data === undefined && fn.error === undefined),
      "data-callable": String(typeof fn.call === "function" && typeof fn.reset === "function"),
    },
    "ready",
  )
}

test("renders idle during SSR and exposes call/reset", () => {
  const html = renderToString(h(Panel, {}))
  expect(html).toContain('data-pending="false"')
  expect(html).toContain('data-idle="true"')
  expect(html).toContain('data-callable="true"')
})

/**
 * Renders do not exercise `call`, and `call` is where the ref indirection lives - the piece that makes
 * the store both created-once and never-stale. The handle outlives the render (the store is held by
 * `useMemo`'s closure), so it can be driven directly afterwards.
 */
test("the handle keeps working after the render", async () => {
  let handle: ReturnType<typeof useServerFn<{ text: string }, string>> | undefined
  function Capture() {
    handle = useServerFn(async (input: { text: string }) => `echo:${input.text}`)
    return h("i", {}, "x")
  }
  renderToString(h(Capture, {}))
  if (handle === undefined) throw new Error("the component never rendered")

  await expect(handle.call({ text: "a" })).resolves.toBe("echo:a")
})
