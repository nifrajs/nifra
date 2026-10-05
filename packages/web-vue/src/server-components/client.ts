import { disposeComponentPortals } from "@nifrajs/web/server-components/portal"
import {
  type NativeRangeOptions,
  nativeComponentClient,
} from "@nifrajs/web/server-components/range"
import { type Component, createSSRApp, h, nextTick, shallowReactive } from "vue"
export function vueComponentClient(options: Omit<NativeRangeOptions, "adapter" | "runtime">) {
  return nativeComponentClient({
    ...options,
    adapter: "vue",
    runtime: {
      hydrate(host, contract, record, current) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
        const props = shallowReactive({ ...(record.props as Record<string, unknown>) })
        const slots = Object.fromEntries(
          contract.slots.map((name) => [
            name,
            '<nifra-slot data-nifra-slot="' +
              name +
              '">' +
              (record.slots?.[name] ?? "") +
              "</nifra-slot>",
          ]),
        )
        let isCurrent = current
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
        let previous = h(contract.component as Component, { ...props, slots })
        const app = createSSRApp({
          render() {
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
            if (isCurrent()) previous = h(contract.component as Component, { ...props, slots })
            return previous
          },
        })
        app.mount(host)
        let disposed = false
        return {
          ready: nextTick(),
          async update(next, valid) {
            if (disposed || !valid()) return
            isCurrent = valid
            for (const key of Object.keys(props)) if (!Object.hasOwn(next, key)) delete props[key]
            Object.assign(props, next)
            await nextTick()
          },
          async dispose() {
            if (!disposed) {
              disposed = true
              try {
                await disposeComponentPortals(host)
              } finally {
                app.unmount()
              }
            }
          },
        }
      },
    },
  })
}
