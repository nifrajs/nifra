import { disposeComponentPortals } from "@nifrajs/web/server-components/portal"
import {
  type NativeRangeOptions,
  nativeComponentClient,
} from "@nifrajs/web/server-components/range"
import { type ComponentType, h, hydrate, render } from "preact"

export function preactComponentClient(options: Omit<NativeRangeOptions, "adapter" | "runtime">) {
  return nativeComponentClient({
    ...options,
    adapter: "preact",
    runtime: {
      hydrate(host, contract, record, current) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The shared range validates the registered island and projects public props before native hydration.
        const component = contract.component as ComponentType<Record<string, unknown>>
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The shared range validates the registered island and projects public props before native hydration.
        let props = record.props as Record<string, unknown>
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
        let previous = h(component, { ...props, slots })
        const Island = () => {
          if (isCurrent()) previous = h(component, { ...props, slots })
          return previous
        }
        hydrate(h(Island, null), host)
        let disposed = false
        return {
          update(next, valid) {
            if (disposed || !valid()) return
            isCurrent = valid
            props = next
            render(h(Island, null), host)
          },
          async dispose() {
            if (!disposed) {
              disposed = true
              try {
                await disposeComponentPortals(host)
              } finally {
                render(null, host)
              }
            }
          },
        }
      },
    },
  })
}
