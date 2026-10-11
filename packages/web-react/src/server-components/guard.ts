import type { StandardSchemaV1 } from "@nifrajs/core/schema"
import { guardComponentProps } from "@nifrajs/web/server-components/props"
import {
  type ComponentType,
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react"

interface ClientContract {
  readonly reference: ComponentType<Record<string, unknown>>
  readonly schema: StandardSchemaV1
  readonly slots: readonly string[]
}
const contracts = new WeakMap<object, ClientContract>()
const wrappers = new WeakMap<object, ClientContract>()
const encoder = new TextEncoder()

function failure(): Error {
  const error = new Error("component_failed")
  error.stack = ""
  return error
}

function slot(value: unknown, depth = 0): ReactNode {
  if (depth > 16) throw failure()
  if (
    value === undefined ||
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    isValidElement(value)
  )
    return value
  if (Array.isArray(value) && value.length <= 128)
    return value.map((item: unknown) => slot(item, depth + 1))
  throw failure()
}

function publicProps(contract: ClientContract, raw: unknown): Promise<Record<string, unknown>> {
  return (async () => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw failure()
    const dto: Record<string, unknown> = Object.create(null)
    const slots: Record<string, ReactNode> = Object.create(null)
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(raw))) {
      if (!Object.hasOwn(descriptor, "value")) throw failure()
      if (contract.slots.includes(name)) slots[name] = slot(descriptor.value)
      else if (name !== "children" && name !== "ref" && name !== "key") dto[name] = descriptor.value
    }
    const projected = await guardComponentProps(contract.schema, dto)
    if (typeof projected !== "object" || projected === null || Array.isArray(projected))
      throw failure()
    return { ...projected, ...slots }
  })().catch(() => {
    throw failure()
  })
}

/** Called by generated facades. The actual native reference stays private to this module. */
export function guardedClientReference(
  reference: unknown,
  schema: StandardSchemaV1,
  slots: readonly string[] = [],
): ComponentType<Record<string, unknown>> {
  const Facade = (): never => {
    throw failure()
  }
  contracts.set(Facade, {
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
    reference: reference as ComponentType<Record<string, unknown>>,
    schema,
    slots,
  })
  return Facade
}

export function guardedClientElement(
  type: unknown,
  raw: unknown,
  key?: unknown,
): ReactNode | undefined {
  if ((typeof type !== "object" && typeof type !== "function") || type === null) return undefined
  const contract = contracts.get(type)
  if (contract === undefined) return undefined
  if (
    key !== undefined &&
    key !== null &&
    !(
      (typeof key === "string" && encoder.encode(key).length <= 128) ||
      (typeof key === "number" && Number.isSafeInteger(key))
    )
  )
    throw failure()
  const props = publicProps(contract, raw ?? {})
  const publicKey = typeof key === "string" || typeof key === "number" ? key : null
  // Only a promise of projected props reaches React's element/debug metadata. Raw props stay in the guard closure.
  const Guarded = async ({
    value,
  }: {
    value: Promise<Record<string, unknown>>
  }): Promise<ReactNode> =>
    createElement(contract.reference, {
      ...(await value),
      key: publicKey,
    })
  wrappers.set(Guarded, contract)
  return createElement(Guarded, {
    value: props,
    key: publicKey,
  })
}

export function guardedCreateElement(
  type: unknown,
  props?: unknown,
  ...children: ReactNode[]
): ReactNode {
  const raw =
    children.length === 0
      ? props
      : {
          // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
          ...(props as Record<string, unknown> | undefined),
          children: children.length === 1 ? children[0] : children,
        }
  const key =
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).key : undefined
  const guarded = guardedClientElement(type, raw, key)
  if (guarded !== undefined) return guarded
  return createElement(
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
    type as ComponentType,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
    props as Record<string, unknown> | null | undefined,
    ...children,
  )
}

export function guardedCloneElement(
  element: ReactElement,
  props?: unknown,
  ...children: ReactNode[]
): ReactNode {
  const contract =
    (typeof element.type === "object" || typeof element.type === "function") &&
    element.type !== null
      ? (wrappers.get(element.type) ?? contracts.get(element.type))
      : undefined
  if (contract === undefined)
    return cloneElement(
      element,
      // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
      props === null ? undefined : (props as Record<string, unknown> | undefined),
      ...children,
    )
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
  const previous = element.props as Record<string, unknown>
  const value = Object.hasOwn(previous, "value")
    ? // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
      (previous.value as Promise<Record<string, unknown>>)
    : publicProps(contract, previous)
  const raw = props ?? {}
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.values(Object.getOwnPropertyDescriptors(raw)).some(
      (descriptor) => !Object.hasOwn(descriptor, "value"),
    )
  )
    throw failure()
  const next = value.then((projected) =>
    publicProps(contract, { ...projected, ...raw, ...(children.length === 0 ? {} : { children }) }),
  )
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
  const rawKey = (raw as Record<string, unknown>).key ?? element.key
  if (
    rawKey !== null &&
    !(
      (typeof rawKey === "string" && encoder.encode(rawKey).length <= 128) ||
      (typeof rawKey === "number" && Number.isSafeInteger(rawKey))
    )
  )
    throw failure()
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
  const key = rawKey as string | number | null
  const Guarded = async ({
    value,
  }: {
    value: Promise<Record<string, unknown>>
  }): Promise<ReactNode> => createElement(contract.reference, { ...(await value), key })
  wrappers.set(Guarded, contract)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Registered native references and projected props retain the pinned React ABI; key and prop vocabulary are checked before serialization.
  return createElement(Guarded, { value: next, key: key as string | number | null })
}
