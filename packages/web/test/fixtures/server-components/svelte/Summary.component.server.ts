import { t } from "@nifrajs/schema"
import { defineServerComponent, inheritOwnerAuthorization } from "@nifrajs/web/server-components"
import { clientIsland, nativeServerView } from "@nifrajs/web/server-components/islands"
import { summaryProps } from "../schema.shared"
import { counter } from "./Counter.island"
import View from "./View.frontend.svelte"
export const Summary = defineServerComponent({
  input: t.object({}),
  props: summaryProps,
  authorize: inheritOwnerAuthorization,
  load: (ctx) => ({
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The fixture owner loader supplies this fabricated data; the component props schema projects and validates its public fields.
    ...(ctx.data as Record<string, unknown>),
    internal: "SERVER_PRIVATE_SENTINEL_66",
  }),
  view({ props, children }) {
    const islandProps = {
      title: `${props.title} ${props.revision}`,
      privateValue: "ISLAND_PRIVATE_SENTINEL_42",
    }
    return nativeServerView(
      View,
      {
        picker: clientIsland(counter, props.islandKey, islandProps, {
          summary: `<p>Slot ${props.revision}</p>`,
        }),
      },
      children?.[0] === undefined ? {} : { detail: children[0] },
    )
  },
})
