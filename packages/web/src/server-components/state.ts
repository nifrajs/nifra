import { ServerComponentError } from "./error.ts"
import { validateComponentHTML } from "./html.ts"
import { COMPONENT_LIMITS, componentKey } from "./protocol.ts"
import type { ComponentIsland, ComponentRecord, ComponentState } from "./types.ts"
import { componentValue } from "./value.ts"

const token = /^[A-Za-z0-9_-]{1,128}$/
function object(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    Object.keys(value).some((field) => !fields.includes(field) && !optional.includes(field))
  )
    throw new ServerComponentError("component_protocol", 400)
  // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before field inspection; each typed field follows its closed vocabulary check.
  return value as Record<string, unknown>
}
export function componentToken(value: unknown): value is string {
  return typeof value === "string" && token.test(value)
}
function island(value: unknown): ComponentIsland {
  const item = object(value, ["reference", "key", "props", "renderId"], ["slots"])
  if (!componentToken(item.reference) || !componentToken(item.renderId) || !componentKey(item.key))
    throw new ServerComponentError("component_protocol", 400)
  if (
    item.slots !== undefined &&
    (typeof item.slots !== "object" ||
      item.slots === null ||
      Array.isArray(item.slots) ||
      Object.entries(item.slots).some(
        ([key, html]) => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || typeof html !== "string",
      ))
  )
    throw new ServerComponentError("component_protocol", 400)
  if (item.slots !== undefined)
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before field inspection; each typed field follows its closed vocabulary check.
    for (const html of Object.values(item.slots)) validateComponentHTML(html as string)
  const result: ComponentIsland = {
    reference: item.reference,
    key: item.key,
    renderId: item.renderId,
    props: componentValue(item.props),
  }
  if (item.slots !== undefined) Object.assign(result, { slots: item.slots })
  return result
}
/** One record, checked as each of a state's is; `ids` and `islandIds` collect what must be unique. */
function componentRecord(
  value: unknown,
  ids: Set<string>,
  islandIds: Set<string>,
): ComponentRecord {
  const record = object(
    value,
    ["instance", "reference", "key", "parent", "input", "html"],
    ["payload", "islands"],
  )
  if (
    !componentToken(record.instance) ||
    ids.has(record.instance) ||
    !componentToken(record.reference) ||
    !componentKey(record.key) ||
    (record.parent !== null && !componentToken(record.parent)) ||
    typeof record.html !== "string"
  )
    throw new ServerComponentError("component_protocol", 400)
  ids.add(record.instance)
  validateComponentHTML(record.html)
  if (
    record.islands !== undefined &&
    (!Array.isArray(record.islands) || record.islands.length > COMPONENT_LIMITS.instances)
  )
    throw new ServerComponentError("component_protocol", 400)
  const islands =
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before field inspection; each typed field follows its closed vocabulary check.
    record.islands === undefined ? undefined : (record.islands as unknown[]).map(island)
  for (const island of islands ?? []) {
    if (islandIds.has(island.renderId)) throw new ServerComponentError("component_protocol", 400)
    islandIds.add(island.renderId)
  }
  const result: ComponentRecord = {
    instance: record.instance,
    reference: record.reference,
    key: record.key,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before field inspection; each typed field follows its closed vocabulary check.
    parent: record.parent as string | null,
    html: record.html,
    input: componentValue(record.input, COMPONENT_LIMITS.inputBytes),
  }
  if (record.payload !== undefined)
    Object.assign(result, {
      payload: componentValue(record.payload, COMPONENT_LIMITS.outputBytes),
    })
  if (islands !== undefined) Object.assign(result, { islands })
  return result
}

/** A record that arrives alone, as a partially prerendered hole's does, checked as a state's are. */
export function parseComponentRecord(value: unknown): ComponentRecord {
  const record = componentRecord(
    componentValue(value, COMPONENT_LIMITS.documentBytes),
    new Set(),
    new Set(),
  )
  if ((record.islands?.length ?? 0) >= COMPONENT_LIMITS.instances)
    throw new ServerComponentError("component_limit", 413)
  return record
}

export function parseComponentState(
  value: unknown,
  maxBytes: number = COMPONENT_LIMITS.documentBytes,
  externalParent?: string | null,
): ComponentState {
  const bounded = componentValue(value, maxBytes)
  const state = object(bounded, ["v", "build", "adapter", "owner", "scope", "records"])
  if (
    state.v !== 1 ||
    !componentToken(state.build) ||
    !componentToken(state.owner) ||
    !componentToken(state.scope) ||
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before field inspection; each typed field follows its closed vocabulary check.
    !["react", "vue", "svelte", "solid", "preact"].includes(state.adapter as string) ||
    !Array.isArray(state.records) ||
    state.records.length > COMPONENT_LIMITS.instances
  )
    throw new ServerComponentError("component_protocol", 400)
  const ids = new Set<string>()
  const islandIds = new Set<string>()
  let instances = state.records.length
  const records: ComponentRecord[] = state.records.map((value: unknown) => {
    const record = componentRecord(value, ids, islandIds)
    instances += record.islands?.length ?? 0
    if (instances > COMPONENT_LIMITS.instances)
      throw new ServerComponentError("component_limit", 413)
    return record
  })
  // Refreshes contain a single child and may name its already mounted parent. Documents carry the full forest.
  for (const record of records) {
    const chain = new Set([record.instance])
    let parent = record.parent
    while (parent !== null) {
      if (!ids.has(parent) && parent === externalParent) break
      if (chain.has(parent) || !ids.has(parent) || chain.size >= 16)
        throw new ServerComponentError("component_protocol", 400)
      chain.add(parent)
      parent = records.find((item) => item.instance === parent)?.parent ?? null
    }
  }
  return {
    v: 1,
    build: state.build,
    owner: state.owner,
    scope: state.scope,
    // biome-ignore lint/plugin/requireSafetyCommentForTypeAssertion: Object shape is checked before field inspection; each typed field follows its closed vocabulary check.
    adapter: state.adapter as ComponentState["adapter"],
    records,
  }
}
