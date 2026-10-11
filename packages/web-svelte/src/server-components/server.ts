import type { ServerComponentRenderAdapter } from "@nifrajs/web/server-components"
import { nativeServerComponents } from "@nifrajs/web/server-components/native"
import type { Component } from "svelte"
import { render } from "svelte/server"
import Island from "./Island.svelte"
export const svelteServerComponents = (): ServerComponentRenderAdapter =>
  nativeServerComponents("svelte", (component, props, renderId) =>
    renderId.endsWith("-view")
      ? // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The native renderer receives only its registered component and schema-projected props from the shared executor.
        render(component as Component<Record<string, unknown>>, { props }).body
      : render(Island, {
          props: {
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The native renderer receives only its registered component and schema-projected props from the shared executor.
            component: component as Component<Record<string, unknown>>,
            state: { props },
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The native renderer receives only its registered component and schema-projected props from the shared executor.
            slots: props.slots as Record<string, string>,
          },
        }).body,
  )
