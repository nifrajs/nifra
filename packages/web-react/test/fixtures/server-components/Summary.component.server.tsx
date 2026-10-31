import { t } from "@nifrajs/schema"
import { defineServerComponent, inheritOwnerAuthorization } from "@nifrajs/web/server-components"
import { NestedServerComponent } from "@nifrajs/web-react/server-components/nested"
import React, { createElement as el, Suspense } from "react"
import { Counter as Native } from "./frontend/Client"

function Detail(_props: { privateValue: string }) {
  return el("p", {}, "Public detail")
}
function SlowDetail({ gate }: { gate: { promise: Promise<void>; settled: boolean } }) {
  if (!gate.settled) throw gate.promise
  return el("p", { id: "slow-ready" }, "Slow ready")
}
export const Summary = defineServerComponent({
  input: t.object({}),
  props: t.object({ title: t.string(), revision: t.number(), islandKey: t.number() }),
  authorize: inheritOwnerAuthorization,
  load: (ctx) => ({
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The fixture owner loader supplies this fabricated data; the component props schema projects and validates its public fields.
    ...(ctx.data as Record<string, unknown>),
    internal: "LOAD_PRIVATE_SENTINEL_82",
  }),
  async view({ props, children }) {
    const data = {
      title: `${props.title} ${props.revision}`,
      privateValue: "FLIGHT_PRIVATE_SENTINEL_73",
      summary: el("nifra-slot", {}, `Slot ${props.revision}`),
    }
    const make = React.createElement
    const node = make(Native, { ...data, key: props.islandKey })
    const child = children?.[0]
    const nested =
      child === undefined
        ? null
        : el(NestedServerComponent, { key: "detail", instance: child.instance, html: child.html })
    const detail =
      props.revision === 4
        ? el(
            Suspense,
            { fallback: el("p", { id: "slow-fallback" }, "Slow loading") },
            el(SlowDetail, {
              gate: (() => {
                let settled = false
                const promise = new Promise<void>((resolve) =>
                  setTimeout(() => {
                    settled = true
                    resolve()
                  }, 1_500),
                )
                return {
                  promise,
                  get settled() {
                    return settled
                  },
                }
              })(),
            }),
          )
        : make(Detail, { privateValue: "SERVER_DEBUG_PRIVATE_SENTINEL_91" })
    return el(
      "section",
      {},
      el("p", { id: "revision" }, `Revision ${props.revision}`),
      props.revision % 2 === 0
        ? [nested, React.cloneElement(node, { title: data.title })]
        : [React.cloneElement(node, { title: data.title }), nested],
      detail,
    )
  },
})
