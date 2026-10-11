import { t } from "@nifrajs/schema"
import { defineServerComponent, inheritOwnerAuthorization } from "@nifrajs/web/server-components"
import { clientIsland, nativeServerView } from "@nifrajs/web/server-components/islands"
import { summaryProps } from "../schema.shared"
import View from "./ChildView.frontend.vue"
import { counter } from "./Counter.island"
export const Child = defineServerComponent({
  input: t.object({}),
  props: summaryProps,
  authorize: inheritOwnerAuthorization,
  load: (ctx) => ctx.data,
  view: ({ props }) =>
    nativeServerView(View, {
      picker: clientIsland(counter, "child", {
        title: `Child ${props.revision}`,
        prefix: "child-",
      }),
    }),
})
