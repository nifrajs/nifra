import { disposeComponentPortals } from "@nifrajs/web/server-components/portal"
import {
  type NativeRangeOptions,
  nativeComponentClient,
} from "@nifrajs/web/server-components/range"
import { type Component, flushSync, hydrate, tick, unmount } from "svelte"
import Island from "./Island.svelte"
import { islandState } from "./state.svelte.ts"
export function svelteComponentClient(options: Omit<NativeRangeOptions, "adapter" | "runtime">) {
  return nativeComponentClient({
    ...options,
    adapter: "svelte",
    runtime: {
      hydrate(host, contract, record) {
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
        const state = islandState(record.props as Record<string, unknown>)
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
        const instance = hydrate(Island, {
          target: host,
          props: {
            // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Only this adapter produces its prepared tree and native root; component records and public props are validated before native preparation.
            component: contract.component as Component<Record<string, unknown>>,
            state,
            slots,
          },
        })
        flushSync()
        let disposed = false
        return {
          ready: tick(),
          update(next, current) {
            if (!disposed && current())
              flushSync(() => {
                if (current()) state.props = next
              })
          },
          async dispose() {
            if (!disposed) {
              disposed = true
              try {
                await disposeComponentPortals(host)
              } finally {
                await unmount(instance)
              }
            }
          },
        }
      },
    },
  })
}
