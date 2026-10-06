import type { ServerComponentRenderAdapter } from "@nifrajs/web/server-components"
import { nativeServerComponents } from "@nifrajs/web/server-components/native"
import { type ComponentType, h } from "preact"
import { preactRenderToString } from "../preact-render.ts"

export const preactServerComponents = (): ServerComponentRenderAdapter =>
  nativeServerComponents("preact", async (component, props) => {
    const renderer = await preactRenderToString()
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The native renderer receives only its registered component and schema-projected props from the shared executor.
    return renderer.renderToString(h(component as ComponentType<Record<string, unknown>>, props))
  })
