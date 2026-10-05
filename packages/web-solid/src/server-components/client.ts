import { disposeComponentPortals } from "@nifrajs/web/server-components/portal"
import {
  type NativeRangeOptions,
  nativeComponentClient,
} from "@nifrajs/web/server-components/range"
import { batch, type Component, createComponent, createSignal } from "solid-js"
import { hydrate } from "solid-js/web"
export function solidComponentClient(options: Omit<NativeRangeOptions, "adapter" | "runtime">) {
  return nativeComponentClient({
    ...options,
    adapter: "solid",
    runtime: {
      hydrate(host, contract, record) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
        const [props, setProps] = createSignal(record.props as Record<string, unknown>)
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
        const reactive = new Proxy<Record<string, unknown>>(
          {},
          {
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
            get: (_, name) => (name === "slots" ? slots : props()[name as string]),
            has: (_, name) => name === "slots" || Object.hasOwn(props(), name),
            ownKeys: () => [...Object.keys(props()), "slots"],
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
          },
        )
        const dispose = hydrate(
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
          () => createComponent(contract.component as Component<Record<string, unknown>>, reactive),
          host,
          { renderId: record.renderId },
        )
        let disposed = false
        return {
          update(next, current) {
            if (!disposed && current())
              batch(() => {
                if (current()) setProps(() => next)
              })
          },
          async dispose() {
            if (!disposed) {
              disposed = true
              try {
                await disposeComponentPortals(host)
              } finally {
                dispose()
              }
            }
          },
        }
      },
    },
  })
}
