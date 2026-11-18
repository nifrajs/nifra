import { expect, test } from "bun:test"
import type { JSX } from "@solidjs/web"
import { renderToStream } from "@solidjs/web"
import { createComponent, Errored } from "solid-js"
import { Await } from "../src/await.ts"
import { element, visible } from "./ssr-output.ts"

const deferred = <T>(promise: Promise<T>) => ({ __nifra_deferred: true as const, id: 1, promise })
test("Await renders a value, a settled deferred, its error fallback, or rethrows to a boundary", async () => {
  const failing = Promise.reject(new Error("down"))
  failing.catch(() => {})
  const value = (n: number) => element("p", {}, `n ${n}`)
  const render = async (ui: () => JSX.Element) =>
    visible(await renderToStream(ui, { onError: (error) => error }))
  expect({
    plain: await render(() => createComponent(Await<number>, { resolve: 3, children: value })),
    resolved: await render(() =>
      createComponent(Await<number>, { resolve: deferred(Promise.resolve(2)), children: value }),
    ),
    failed: await render(() =>
      createComponent(Await<number>, {
        resolve: deferred(failing),
        errorFallback: (error) => element("p", {}, `failed ${String(error)}`),
        children: value,
      }),
    ),
    rethrown: await render(() =>
      createComponent(Errored, {
        fallback: (error: () => unknown) => {
          const caught = error()
          return element("p", {}, `caught ${caught instanceof Error ? caught.message : caught}`)
        },
        get children() {
          return createComponent(Await<number>, { resolve: deferred(failing), children: value })
        },
      }),
    ),
  }).toEqual({
    plain: "<p>n 3</p>",
    resolved: "<p>n 2</p>",
    failed: "<p>failed Error: down</p>",
    rethrown: "<p>caught down</p>",
  })
})
