import { createClientRouter, installHistory } from "@nifrajs/web/client"
import type { ClientServerFn } from "@nifrajs/web/fn"
import {
  bindComponentRouter,
  type ComponentController,
  type ComponentState,
  invalidateComponentScope,
  refreshAfterComponentMutation,
} from "@nifrajs/web/server-components/client"
import { save } from "./actions.fn"
export function fixtureRouter(controller: ComponentController, state: ComponentState) {
  const router = createClientRouter({
    patterns: [{ routeId: "product", pattern: "/" }],
    initial: {
      routeId: "product",
      params: {},
      path: location.pathname + location.search,
      data: null,
      serverComponents: state,
      pending: false,
    },
  })
  const unbind = bindComponentRouter(router)
  const history = installHistory(router)
  // The compiler replaces this declaration with the existing one-argument serverFn client stub.
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion lint/plugin/noChainedTypeAssertions: The compiled client import has the serverFn stub ABI; the browser conformance test exercises that emitted stub.
  const call = save as unknown as ClientServerFn<{ fail: boolean }, { ok: boolean }>
  return {
    router,
    mutate: (fail = false) =>
      refreshAfterComponentMutation(Promise.resolve(call({ fail })), controller, [
        controller.state.records.find((record) => record.parent === null)!.instance,
      ]),
    submit: (fail = false) =>
      router.submit("/", new URLSearchParams({ fail: fail ? "yes" : "no" })),
    switchScope: async () => {
      await invalidateComponentScope()
      // biome-ignore lint/suspicious/noDocumentCookie: the browser fixture sets the cookie its next request carries
      document.cookie = "fixture-subject=B; Path=/; SameSite=Lax"
      await router.invalidate()
    },
    stop() {
      unbind()
      history()
    },
  }
}
