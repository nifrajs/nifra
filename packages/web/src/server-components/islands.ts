import type { StandardSchemaV1 } from "@nifrajs/core/server"
import type { ComponentKey, ComponentRecord, ServerComponentHandle } from "./types.ts"

const contractBrand = Symbol.for("nifra.components.island")
const viewBrand = Symbol.for("nifra.components.view")
export interface ClientIsland<Props = unknown, Component = unknown> {
  readonly reference?: string
  readonly props: StandardSchemaV1<unknown, Props>
  readonly component: Component
  readonly slots: readonly string[]
  readonly [contractBrand]: true
}
type NativeComponentProps<Component> = Component extends abstract new (
  ...args: never[]
) => { $props: infer Props }
  ? Props
  : Component extends abstract new (
        ...args: never[]
      ) => { props: infer Props }
    ? Props
    : Component extends (...args: infer Args) => unknown
      ? Args extends []
        ? object
        : Args[0] | Args[1]
      : never
type CompatibleComponent<Props, Component> =
  Props extends NativeComponentProps<Component>
    ? unknown
    : { readonly __nifraIslandPropsMustMatchComponent: never }

export function defineClientIsland<Props, Component>(
  definition: {
    readonly props: StandardSchemaV1<unknown, Props>
    readonly component: Component
    readonly slots?: readonly string[]
  } & CompatibleComponent<NoInfer<Props>, NoInfer<Component>>,
  reference?: string,
): ClientIsland<Props, Component> {
  const slots = definition.slots ?? []
  if (
    slots.length > 16 ||
    new Set(slots).size !== slots.length ||
    slots.some(
      (name) =>
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || ["ref", "key", "constructor"].includes(name),
    )
  )
    throw new Error("component_contract")
  const contract: ClientIsland<Props, Component> = {
    props: definition.props,
    component: definition.component,
    slots: Object.freeze([...slots]),
    [contractBrand]: true,
  }
  if (reference !== undefined) Object.assign(contract, { reference })
  return Object.freeze(contract)
}
export interface IslandInstance {
  readonly contract: ClientIsland
  readonly key: ComponentKey
  readonly props: unknown
  readonly slots: Readonly<Record<string, string>>
}
export function clientIsland<Props>(
  contract: ClientIsland<Props>,
  key: ComponentKey,
  props: NoInfer<Props>,
  slots: Readonly<Record<string, string>> = {},
): IslandInstance {
  return { contract, key, props, slots }
}
export interface NativeServerView {
  readonly component: unknown
  readonly islands: Readonly<Record<string, IslandInstance>>
  readonly ranges: Readonly<Record<string, ComponentRecord>>
  readonly [viewBrand]: true
}
/** Server-only native view: Vue VNode/component, Svelte component or Solid component. */
export function nativeServerView(
  component: unknown,
  islands: Readonly<Record<string, IslandInstance>> = {},
  ranges: Readonly<Record<string, ComponentRecord>> = {},
): NativeServerView {
  return { component, islands, ranges, [viewBrand]: true }
}
export function serverComponentChild(
  children: readonly ComponentRecord[],
  component: Pick<ServerComponentHandle, "reference">,
  key: ComponentKey,
): ComponentRecord {
  const matches = children.filter(
    (record) => record.reference === component.reference && record.key === key,
  )
  if (matches.length !== 1) throw new Error("component_contract")
  return matches[0]!
}
export function isNativeServerView(value: unknown): value is NativeServerView {
  return (
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before inspecting the private symbol brand created by this module.
    typeof value === "object" && value !== null && (value as NativeServerView)[viewBrand] === true
  )
}
export function isClientIsland(value: unknown): value is ClientIsland {
  return (
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before inspecting the private symbol brand created by this module.
    typeof value === "object" && value !== null && (value as ClientIsland)[contractBrand] === true
  )
}
