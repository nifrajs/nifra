import type { ServerComponentRenderAdapter } from "@nifrajs/web/server-components"
import { nativeServerComponents } from "@nifrajs/web/server-components/native"
import { type Component, createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
export const solidServerComponents = (): ServerComponentRenderAdapter =>
  nativeServerComponents("solid", (component, props, renderId) =>
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The native renderer receives only its registered component and schema-projected props from the shared executor.
    renderToString(() => createComponent(component as Component<Record<string, unknown>>, props), {
      renderId,
    }),
  )
