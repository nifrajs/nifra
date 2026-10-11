import type { ServerComponentRenderAdapter } from "@nifrajs/web/server-components"
import { nativeServerComponents } from "@nifrajs/web/server-components/native"
import { type Component, createSSRApp, h } from "vue"
import { renderToString } from "vue/server-renderer"
export const vueServerComponents = (): ServerComponentRenderAdapter =>
  nativeServerComponents("vue", (component, props) =>
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The native renderer receives only its registered component and schema-projected props from the shared executor.
    renderToString(createSSRApp({ render: () => h(component as Component, props) })),
  )
