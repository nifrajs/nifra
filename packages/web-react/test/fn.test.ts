import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { useServerFn } from "../src/fn.ts"

/**
 * The binding is wiring; the state machine it wires to is tested in `@nifrajs/web`'s own suite,
 * including the timing cases. What is worth proving here is the part that is specific to React and
 * specific to the SERVER: `useSyncExternalStore` needs a server snapshot, and getting that wrong is a
 * hydration mismatch or a crash during SSR rather than a wrong value.
 *
 * The subscription itself is client-only by definition - no call happens during a server render - so
 * it is covered by the store's tests plus the browser-verified hydration suite, not re-simulated here.
 */

function Panel() {
  const addTodo = useServerFn(async (input: { text: string }) => ({ echoed: input.text }))
  return createElement(
    "div",
    {
      "data-pending": String(addTodo.pending),
      "data-has-data": String(addTodo.data !== undefined),
      "data-has-error": String(addTodo.error !== undefined),
      "data-callable": String(typeof addTodo.call === "function"),
      "data-resettable": String(typeof addTodo.reset === "function"),
    },
    "ready",
  )
}

test("renders idle during SSR without a call, and exposes call/reset", () => {
  const html = renderToStaticMarkup(createElement(Panel))
  expect(html).toContain('data-pending="false"')
  expect(html).toContain('data-has-data="false"')
  expect(html).toContain('data-has-error="false"')
  expect(html).toContain('data-callable="true"')
  expect(html).toContain('data-resettable="true"')
})

test("two components each get their own state", () => {
  // The store is per component instance; sharing one would make a pending call in a list of rows
  // spin every row.
  const html = renderToStaticMarkup(
    createElement("main", null, createElement(Panel), createElement(Panel)),
  )
  expect(html.match(/data-pending="false"/g)).toHaveLength(2)
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
    return createElement("i", null, "x")
  }
  renderToStaticMarkup(createElement(Capture))
  if (handle === undefined) throw new Error("the component never rendered")

  // The rendered snapshot is a value, not a live view - a mounted component re-renders from the
  // subscription instead. What matters here is that the call reaches the function.
  await expect(handle.call({ text: "a" })).resolves.toBe("echo:a")
})
