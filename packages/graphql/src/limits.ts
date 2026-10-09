import {
  type DocumentNode,
  type GraphQLError,
  Kind,
  type SelectionNode,
  type SelectionSetNode,
  visit,
} from "graphql"

export const DEFAULT_GRAPHQL_LIMITS = Object.freeze({
  maxQueryBytes: 64 * 1024,
  maxVariablesBytes: 256 * 1024,
  maxDepth: 20,
  maxAliases: 100,
  maxComplexity: 1_000,
  maxOperations: 10,
  maxFieldOverlaps: 2_000,
})

export interface GraphqlLimitsOptions {
  readonly maxQueryBytes?: number
  readonly maxVariablesBytes?: number
  readonly maxDepth?: number
  readonly maxAliases?: number
  readonly maxComplexity?: number
  readonly maxOperations?: number
  readonly maxFieldOverlaps?: number
}

export interface GraphqlLimits {
  readonly maxQueryBytes: number
  readonly maxVariablesBytes: number
  readonly maxDepth: number
  readonly maxAliases: number
  readonly maxComplexity: number
  readonly maxOperations: number
  readonly maxFieldOverlaps: number
}

function limit(value: number | undefined, fallback: number, name: string, minimum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new RangeError(`GraphQL ${name} must be a safe integer >= ${minimum}`)
  }
  return result
}

export function graphqlLimits(options: GraphqlLimitsOptions = {}): GraphqlLimits {
  return {
    maxQueryBytes: limit(
      options.maxQueryBytes,
      DEFAULT_GRAPHQL_LIMITS.maxQueryBytes,
      "maxQueryBytes",
      1,
    ),
    maxVariablesBytes: limit(
      options.maxVariablesBytes,
      DEFAULT_GRAPHQL_LIMITS.maxVariablesBytes,
      "maxVariablesBytes",
      0,
    ),
    maxDepth: limit(options.maxDepth, DEFAULT_GRAPHQL_LIMITS.maxDepth, "maxDepth", 1),
    maxAliases: limit(options.maxAliases, DEFAULT_GRAPHQL_LIMITS.maxAliases, "maxAliases", 0),
    maxComplexity: limit(
      options.maxComplexity,
      DEFAULT_GRAPHQL_LIMITS.maxComplexity,
      "maxComplexity",
      1,
    ),
    maxOperations: limit(
      options.maxOperations,
      DEFAULT_GRAPHQL_LIMITS.maxOperations,
      "maxOperations",
      1,
    ),
    maxFieldOverlaps: limit(
      options.maxFieldOverlaps,
      DEFAULT_GRAPHQL_LIMITS.maxFieldOverlaps,
      "maxFieldOverlaps",
      0,
    ),
  }
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function variablesBytes(value: Record<string, unknown> | null): number {
  return value === null ? 0 : utf8Bytes(JSON.stringify(value))
}

export interface GraphqlDocumentMetrics {
  readonly operations: number
  readonly depth: number
  readonly aliases: number
  readonly complexity: number
}

type SelectionMetrics = Omit<GraphqlDocumentMetrics, "operations">

const NO_SELECTIONS: SelectionMetrics = { depth: 0, aliases: 0, complexity: 0 }

/** `depth` counts from the selection set's own level, so one fragment measure holds at every spread. */
function selectionsMetrics(
  selections: readonly SelectionNode[],
  fragment: (name: string) => SelectionMetrics,
): SelectionMetrics {
  let depth = 0
  let aliases = 0
  let complexity = 0
  for (const selection of selections) {
    let nested: SelectionMetrics
    if (selection.kind === Kind.FIELD) {
      complexity += 1
      if (selection.alias !== undefined) aliases += 1
      nested =
        selection.selectionSet === undefined
          ? NO_SELECTIONS
          : selectionsMetrics(selection.selectionSet.selections, fragment)
      depth = Math.max(depth, nested.depth + 1)
    } else {
      nested =
        selection.kind === Kind.INLINE_FRAGMENT
          ? selectionsMetrics(selection.selectionSet.selections, fragment)
          : fragment(selection.name.value)
      depth = Math.max(depth, nested.depth)
    }
    aliases += nested.aliases
    complexity += nested.complexity
  }
  return { depth, aliases, complexity }
}

/**
 * Each fragment is measured once and reused at every spread. Expanding spreads in place costs a visit
 * per expanded field, and a document whose fragments each spread the one before twice turns n short
 * lines into 2^n visits, all of it synchronous before any limit can refuse the document.
 */
export function documentMetrics(document: DocumentNode): GraphqlDocumentMetrics {
  const definitions = new Map<string, readonly SelectionNode[]>()
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      definitions.set(definition.name.value, definition.selectionSet.selections)
    }
  }
  const measured = new Map<string, SelectionMetrics>()
  const measuring = new Set<string>()
  const fragment = (name: string): SelectionMetrics => {
    const known = measured.get(name)
    if (known !== undefined) return known
    const selections = definitions.get(name)
    // An unknown fragment and a cycle back into one being measured, both refused by validation,
    // add nothing.
    if (selections === undefined || measuring.has(name)) return NO_SELECTIONS
    measuring.add(name)
    const metrics = selectionsMetrics(selections, fragment)
    measuring.delete(name)
    measured.set(name, metrics)
    return metrics
  }
  let operations = 0
  let depth = 0
  let aliases = 0
  let complexity = 0
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue
    operations += 1
    const metrics = selectionsMetrics(definition.selectionSet.selections, fragment)
    depth = Math.max(depth, metrics.depth)
    aliases += metrics.aliases
    complexity += metrics.complexity
  }
  return { operations, depth, aliases, complexity }
}

export function requestLimitError(
  query: string,
  variables: Record<string, unknown> | null,
  limits: GraphqlLimits,
): string | undefined {
  if (utf8Bytes(query) > limits.maxQueryBytes) {
    return `GraphQL query exceeds the ${limits.maxQueryBytes}-byte limit.`
  }
  if (variablesBytes(variables) > limits.maxVariablesBytes) {
    return `GraphQL variables exceed the ${limits.maxVariablesBytes}-byte limit.`
  }
  return undefined
}

/**
 * Pairs of same-named fields across every selection set, the work graphql-js's
 * OverlappingFieldsCanBeMerged rule does: it compares every two fields that share a response name in
 * one selection set, counting the fields its fragment spreads and inline fragments bring in. A few
 * thousand bytes of `b(x: 1) b(x: 2) ...` hold within the depth and complexity limits yet cost seconds
 * of synchronous validation, so this is counted, and refused, before `validate()` runs. Measured
 * once {@link documentLimitError} passes and no fragment is unused, the fields it walks are bounded
 * by `maxComplexity`.
 */
export function fieldOverlaps(document: DocumentNode): number {
  const fragments = new Map<string, readonly SelectionNode[]>()
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition.selectionSet.selections)
    }
  }
  const fragmentNames = new Map<string, ReadonlyMap<string, number>>()
  const expanding = new Set<string>()
  const add = (
    selections: readonly SelectionNode[],
    names: Map<string, number>,
    spread: Set<string>,
  ): void => {
    for (const selection of selections) {
      if (selection.kind === Kind.FIELD) {
        const name = selection.alias?.value ?? selection.name.value
        names.set(name, (names.get(name) ?? 0) + 1)
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        add(selection.selectionSet.selections, names, spread)
      } else if (!spread.has(selection.name.value)) {
        spread.add(selection.name.value)
        for (const [name, count] of fragmentNamesOf(selection.name.value)) {
          names.set(name, (names.get(name) ?? 0) + count)
        }
      }
    }
  }
  // An unknown fragment and a cycle, both refused by validation, contribute nothing.
  const fragmentNamesOf = (fragment: string): ReadonlyMap<string, number> => {
    const known = fragmentNames.get(fragment)
    if (known !== undefined) return known
    const selections = fragments.get(fragment)
    if (selections === undefined || expanding.has(fragment)) return new Map()
    expanding.add(fragment)
    const names = new Map<string, number>()
    add(selections, names, new Set([fragment]))
    expanding.delete(fragment)
    fragmentNames.set(fragment, names)
    return names
  }
  let pairs = 0
  visit(document, {
    SelectionSet(node: SelectionSetNode) {
      const names = new Map<string, number>()
      add(node.selections, names, new Set())
      for (const count of names.values()) pairs += (count * (count - 1)) / 2
    },
  })
  return pairs
}

/** The first fragment no operation reaches; graphql-js refuses it, and no limit above counts it. */
function unusedFragment(document: DocumentNode): string | undefined {
  const spreads = new Map<string, readonly string[]>()
  const pending: string[] = []
  const spreadsIn = (node: DocumentNode["definitions"][number]): string[] => {
    const names: string[] = []
    visit(node, {
      FragmentSpread(spread) {
        names.push(spread.name.value)
      },
    })
    return names
  }
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      spreads.set(definition.name.value, spreadsIn(definition))
    } else if (definition.kind === Kind.OPERATION_DEFINITION) {
      pending.push(...spreadsIn(definition))
    }
  }
  const reached = new Set<string>()
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (reached.has(name)) continue
    reached.add(name)
    pending.push(...(spreads.get(name) ?? []))
  }
  for (const name of spreads.keys()) if (!reached.has(name)) return name
  return undefined
}

/**
 * Refuses, before `validate()`, the documents whose overlap validation is expensive: too many
 * same-named field pairs, or a fragment no operation uses (its fields escape `maxComplexity`). Run it
 * after {@link documentLimitError} passes.
 */
export function overlapLimitError(
  document: DocumentNode,
  limits: GraphqlLimits,
): string | undefined {
  const unused = unusedFragment(document)
  if (unused !== undefined) return `Fragment "${unused}" is never used.`
  return fieldOverlaps(document) > limits.maxFieldOverlaps
    ? `GraphQL document repeats field names in one selection set beyond the limit of ${limits.maxFieldOverlaps} same-named field pairs.`
    : undefined
}

export function documentLimitError(
  metrics: GraphqlDocumentMetrics,
  limits: GraphqlLimits,
): string | undefined {
  if (metrics.operations > limits.maxOperations) {
    return `GraphQL document exceeds the ${limits.maxOperations}-operation limit.`
  }
  if (metrics.depth > limits.maxDepth) {
    return `GraphQL document exceeds the depth limit of ${limits.maxDepth}.`
  }
  if (metrics.aliases > limits.maxAliases) {
    return `GraphQL document exceeds the ${limits.maxAliases}-alias limit.`
  }
  if (metrics.complexity > limits.maxComplexity) {
    return `GraphQL document exceeds the complexity limit of ${limits.maxComplexity}.`
  }
  return undefined
}

export function maskExecutionError(error: GraphQLError): Record<string, unknown> {
  return {
    message: "Internal server error.",
    ...(error.locations === undefined ? {} : { locations: error.locations }),
    ...(error.path === undefined ? {} : { path: error.path }),
  }
}

export function safeFormattedError(
  error: GraphQLError,
  phase: "request" | "execution",
  formatter?: (error: GraphQLError, phase: "request" | "execution") => unknown,
): unknown {
  if (formatter !== undefined) {
    try {
      return formatter(error, phase)
    } catch {
      return phase === "execution" ? maskExecutionError(error) : error.toJSON()
    }
  }
  return phase === "execution" ? maskExecutionError(error) : error.toJSON()
}
