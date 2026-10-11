import type { ComponentRenderContext, ServerComponentHandle } from "@nifrajs/web/server-components"
import { guardComponentProps } from "@nifrajs/web/server-components/props"
import { renderToReadableStream } from "@vitejs/plugin-rsc/rsc/server"
import { type ComponentType, createElement } from "react"
import { publicFlightStream } from "./flight.ts"

/** Export this renderer from the compiler's RSC entry, which owns React's server condition. */
export function createReactComponentRenderer(components: readonly ServerComponentHandle[]) {
  const references = new Map(components.map((component) => [component.reference, component]))
  if (references.size !== components.length || references.has(undefined))
    throw new Error("component_contract")
  return async (
    reference: string,
    props: unknown,
    context: ComponentRenderContext,
  ): Promise<ReadableStream<Uint8Array>> => {
    const component = references.get(reference)
    if (component === undefined) throw new Error("component_unavailable")
    const projected = await guardComponentProps(component.props, props)
    const stream = renderToReadableStream(
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The renderer resolves an allowlisted definition and guards its public props before invoking that definition.
      createElement(component.view as ComponentType<{ props: unknown; children: unknown }>, {
        props: projected,
        // biome-ignore lint/correctness/noChildrenProp: Server views receive verified record metadata through their declared children prop.
        children: context.children ?? [],
      }),
      {
        signal: context.signal,
        // React development debug metadata can contain server-only props; it has no public transport.
        debugChannel: { writable: new WritableStream<Uint8Array>({ write() {} }) },
        filterStackFrame: () => false,
        onError() {
          return "component_failed"
        },
      },
    )
    return publicFlightStream(stream, context.signal)
  }
}
