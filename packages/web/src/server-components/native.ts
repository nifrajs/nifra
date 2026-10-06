import { isClientIsland, isNativeServerView } from "./islands.ts"
import { guardComponentProps } from "./props.ts"
import { COMPONENT_LIMITS, componentKey } from "./protocol.ts"
import { componentToken } from "./state.ts"
import type { ComponentIsland, ServerComponentRenderAdapter } from "./types.ts"

export type NativeRender = (
  component: unknown,
  props: Record<string, unknown>,
  renderId: string,
) => string | Promise<string>
export function nativeServerComponents(
  name: "vue" | "svelte" | "solid" | "preact",
  render: NativeRender,
): ServerComponentRenderAdapter {
  return {
    name,
    version: 1,
    async render(view, props, context) {
      if (typeof view !== "function") throw new Error("component_contract")
      const value: unknown = await view({ props, children: context.children ?? [] })
      if (!isNativeServerView(value)) throw new Error("component_contract")
      const entries = Object.entries(value.islands)
      if (entries.length > COMPONENT_LIMITS.instances) throw new Error("component_limit")
      const seen = new Set<string>()
      const islands: ComponentIsland[] = []
      const markup: Record<string, { readonly html: string; readonly renderId: string }> =
        Object.create(null)
      for (const [slot, instance] of entries) {
        if (
          !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(slot) ||
          !isClientIsland(instance.contract) ||
          !componentToken(instance.contract.reference) ||
          !componentKey(instance.key) ||
          Object.keys(instance.slots).some((name) => !instance.contract.slots.includes(name))
        )
          throw new Error("component_contract")
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([context.instance, instance.contract.reference, instance.key]),
          ),
        )
        const renderId = `i_${[...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("")}`
        if (seen.has(renderId)) throw new Error("component_contract")
        seen.add(renderId)
        const projected = await guardComponentProps(instance.contract.props, instance.props)
        // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The closed schema guard and bounded JSON validator produced this public props object before native rendering.
        const guarded = projected as Record<string, unknown> // Closed schema guard and JSON check own this boundary.
        const slots = Object.fromEntries(
          instance.contract.slots.map((name) => {
            const html = instance.slots[name] ?? ""
            if (typeof html !== "string") throw new Error("component_contract")
            return [name, `<nifra-slot data-nifra-slot="${name}">${html}</nifra-slot>`]
          }),
        )
        const html = await render(instance.contract.component, { ...guarded, slots }, renderId)
        if (context.signal.aborted) throw new Error("component_cancelled")
        markup[slot] = {
          html: `<nifra-island data-nifra-island="${renderId}">${html}</nifra-island>`,
          renderId,
        }
        islands.push({
          reference: instance.contract.reference,
          key: instance.key,
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: The closed schema guard and bounded JSON validator produced this public props object before native rendering.
          props: projected as ComponentIsland["props"],
          renderId,
          slots: instance.slots,
        })
      }
      const ranges: Record<string, { html: string; instance: string }> = Object.create(null)
      const rangeIds = new Set<string>()
      for (const [name, child] of Object.entries(value.ranges)) {
        if (
          !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
          child.parent !== context.instance ||
          !(context.children ?? []).includes(child) ||
          rangeIds.has(child.instance)
        )
          throw new Error("component_contract")
        rangeIds.add(child.instance)
        ranges[name] = {
          instance: child.instance,
          html:
            '<nifra-component data-nifra-component="' +
            child.instance +
            '">' +
            child.html +
            "</nifra-component>",
        }
      }
      const html = await render(
        value.component,
        { props, islands: markup, ranges },
        `${context.instance}-view`,
      )
      return { html, islands }
    },
  }
}
