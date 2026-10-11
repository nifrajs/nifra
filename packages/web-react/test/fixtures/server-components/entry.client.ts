import {
  ComponentController,
  invalidateComponentScope,
  parseComponentState,
} from "@nifrajs/web/server-components/client"
import { installComponentTrustedTypesPolicy } from "@nifrajs/web/server-components/trusted-html"
import { reactComponentClient } from "@nifrajs/web-react/server-components/client"
import { createElement } from "react"
import { flushSync } from "react-dom"
import { hydrateRoot } from "react-dom/client"
import { measureComponentAdapter } from "../../../../web/test/fixtures/server-components/measure.frontend"
import { fixtureRouter } from "./FixtureRouter.frontend"
import Page from "./frontend/Page"

if (new URL(location.href).searchParams.get("tt") === "yes") installComponentTrustedTypesPolicy()
const state = parseComponentState(
  JSON.parse(document.querySelector("#component-state")!.textContent!),
)
const measurement = measureComponentAdapter(reactComponentClient())
Object.assign(window, {
  componentTimings: measurement.timings,
  componentTestAdapter: measurement.adapter,
})
const controller = new ComponentController({ state, adapter: measurement.adapter })
flushSync(() =>
  hydrateRoot(
    document.querySelector("#fixture-parent")!,
    createElement(Page, { state, controller }),
  ),
)
await controller.whenReady(state.records[0]!.instance)
const integration = fixtureRouter(controller, state)
Object.assign(window, {
  fixture: {
    ready: true,
    router: integration.router,
    mutate: integration.mutate,
    submit: integration.submit,
    switchScope: integration.switchScope,
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
