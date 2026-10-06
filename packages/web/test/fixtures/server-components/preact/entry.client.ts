import {
  ComponentController,
  invalidateComponentScope,
  parseComponentState,
} from "@nifrajs/web/server-components/client"
import { installComponentTrustedTypesPolicy } from "@nifrajs/web/server-components/trusted-html"
import { measureComponentAdapter } from "../measure.frontend"
import { componentClient } from "./adapter.frontend"
import { counter } from "./Counter.island"
import { fixtureRouter } from "./FixtureRouter.frontend"
import Page from "./Page.frontend.tsx"

if (new URL(location.href).searchParams.get("tt") === "yes") installComponentTrustedTypesPolicy()
const state = parseComponentState(
  JSON.parse(document.querySelector("#component-state")!.textContent!),
)
const measurement = measureComponentAdapter(componentClient({ islands: [counter] }))
const clientAdapter = measurement.adapter
Object.assign(window, {
  componentTimings: measurement.timings,
  componentTestAdapter: clientAdapter,
})
const controller = new ComponentController({
  state,
  adapter: clientAdapter,
  onError: (code) => window.dispatchEvent(new CustomEvent("fixture:error", { detail: code })),
})

import { h, hydrate } from "preact"

hydrate(h(Page, { state, controller, clientAdapter }), document.querySelector("#fixture-parent")!)
await controller.whenReady(state.records[0]!.instance)
const integration = fixtureRouter(controller, state)
Object.assign(window, {
  fixture: {
    ready: true,
    router: integration.router,
    mutate: integration.mutate,
    submit: integration.submit,
    switchScope: integration.switchScope,
    child: () => controller.state.records.find((record) => record.parent !== null)?.instance,
    refreshChild: (query = "") =>
      controller.refresh(
        controller.state.records.find((record) => record.parent !== null)!.instance,
        location.pathname + query,
      ),
    refresh: (query = "") =>
      controller.refresh(state.records[0]!.instance, location.pathname + query),
    invalidate: invalidateComponentScope,
    dispose: () => {
      integration.stop()
      return controller.dispose()
    },
  },
})
