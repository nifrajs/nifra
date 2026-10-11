import type {
  ComponentRenderContext,
  ServerComponentRenderAdapter,
} from "@nifrajs/web/server-components"
import {
  bytesStream,
  encodeComponentBytes,
  readComponentBytes,
} from "@nifrajs/web/server-components/stream"
import { createFromReadableStream } from "@vitejs/plugin-rsc/ssr"
import type { ReactNode } from "react"
import { renderToReadableStream } from "react-dom/server.edge"

export type ReactFlightRenderer = (
  reference: string,
  props: unknown,
  context: ComponentRenderContext,
) => Promise<ReadableStream<Uint8Array>>

export function reactServerComponents(
  renderFlight: ReactFlightRenderer,
): ServerComponentRenderAdapter {
  return {
    name: "react",
    version: 1,
    async render(_view, props, context) {
      const flight = await readComponentBytes(
        await renderFlight(context.reference, props, context),
        context.signal,
      )
      const tree = await createFromReadableStream<ReactNode>(bytesStream(flight))
      let failed = false
      const options: NonNullable<Parameters<typeof renderToReadableStream>[1]> = {
        identifierPrefix: context.instance + "-",
        signal: context.signal,
        onError() {
          failed = true
          return "component_failed"
        },
      }
      if (context.nonce !== undefined) options.nonce = context.nonce
      const html = await renderToReadableStream(tree, options)
      await html.allReady
      const bytes = await readComponentBytes(html, context.signal)
      if (failed) throw new Error("component_failed")
      return {
        html: new TextDecoder().decode(bytes),
        payload: { flight: encodeComponentBytes(flight) },
      }
    },
  }
}
