/**
 * Provider-neutral context assembly.
 *
 * The assembler owns deterministic selection and token accounting only. Items are transient
 * caller data: this module does not persist, embed, redact, or log their contents. Durable memory,
 * retrieval indexes, and provider-specific tokenizers belong behind caller-owned adapters.
 */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KIND = /^[a-z][a-z0-9._:-]{0,63}$/
const MAX_ITEMS = 512
const MAX_TOKENS = 10_000_000
const MAX_ITEM_CHARS = 128_000
const MAX_SEPARATOR_CHARS = 1_024

export interface ContextItem {
  /** Stable caller-owned identity used in inclusion/omission reports. */
  readonly id: string
  /** Caller-defined category such as `memory`, `retrieval`, `conversation`, or `tools`. */
  readonly kind: string
  /** Transient text inserted into the assembled context. */
  readonly content: string
  /** Required items are admitted before optional items and fail closed when they do not fit. */
  readonly required?: boolean
  /** Higher-priority optional items are admitted first. */
  readonly priority?: number
  /** Optional tie-breaker for recency-aware sources. */
  readonly recency?: number
  /** Stable source label; it is metadata, not an authorization decision. */
  readonly source?: string
}

export interface ContextBudget {
  /** Absolute budget for the assembled context, including separators. */
  readonly maxTokens: number
  /** Tokens reserved for caller-owned content outside this assembly. */
  readonly reserveTokens?: number
}

export type ContextTokenCounter = (text: string) => number

export interface ContextAssemblyOptions {
  readonly budget: ContextBudget
  /** Defaults to a bounded deterministic chars/4 estimate. */
  readonly tokenCounter?: ContextTokenCounter
  /** Separator inserted between selected item contents. Defaults to two newlines. */
  readonly separator?: string
}

export interface ContextAssembly {
  readonly version: 1
  readonly text: string
  readonly items: readonly ContextItem[]
  readonly includedIds: readonly string[]
  readonly omittedIds: readonly string[]
  readonly tokens: number
  readonly budget: {
    readonly maxTokens: number
    readonly reserveTokens: number
    readonly availableTokens: number
  }
}

export interface ContextSource<Input = unknown> {
  /** Stable source identity used for diagnostics and default item attribution. */
  readonly id: string
  load(input: Input): readonly ContextItem[] | PromiseLike<readonly ContextItem[]>
}

export class ContextBudgetError extends Error {
  readonly code = "context_budget_exceeded" as const

  constructor(
    readonly requiredTokens: number,
    readonly availableTokens: number,
  ) {
    super("context: required items exceed the available token budget")
    this.name = "ContextBudgetError"
  }
}

/** A deterministic, provider-free token estimate suitable for local reference behavior. */
export function approximateContextTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Assemble already-collected items under a hard budget without mutating caller data. */
export function assembleContext(
  items: readonly ContextItem[],
  options: ContextAssemblyOptions,
): ContextAssembly {
  if (!Array.isArray(items) || items.length > MAX_ITEMS)
    throw new RangeError("context: item collection is unbounded")
  const budget = validateBudget(options.budget)
  const tokenCounter = options.tokenCounter ?? approximateContextTokens
  if (typeof tokenCounter !== "function")
    throw new TypeError("context: tokenCounter must be callable")
  const separator = options.separator ?? "\n\n"
  if (typeof separator !== "string" || separator.length > MAX_SEPARATOR_CHARS)
    throw new TypeError("context: separator is invalid")

  const normalized = items.map((item, index) => normalizeItem(item, index))
  const seen = new Set<string>()
  for (const entry of normalized) {
    if (seen.has(entry.item.id)) throw new TypeError(`context: duplicate item id ${entry.item.id}`)
    seen.add(entry.item.id)
  }

  const selected: NormalizedItem[] = []
  for (const entry of normalized.filter((candidate) => candidate.item.required === true)) {
    const candidate = [...selected, entry]
    const tokens = count(render(candidate, separator), tokenCounter)
    if (tokens > budget.availableTokens)
      throw new ContextBudgetError(tokens, budget.availableTokens)
    selected.push(entry)
  }

  const optional = normalized
    .filter((candidate) => candidate.item.required !== true)
    .sort((left, right) => {
      const priority = (right.item.priority ?? 0) - (left.item.priority ?? 0)
      if (priority !== 0) return priority
      const recency = (right.item.recency ?? 0) - (left.item.recency ?? 0)
      return recency !== 0 ? recency : left.index - right.index
    })
  for (const entry of optional) {
    const candidate = [...selected, entry]
    const tokens = count(render(candidate, separator), tokenCounter)
    if (tokens <= budget.availableTokens) selected.push(entry)
  }

  selected.sort((left, right) => left.index - right.index)
  const outputItems = Object.freeze(selected.map((entry) => entry.item))
  const text = render(selected, separator)
  const includedIds = Object.freeze(outputItems.map((item) => item.id))
  const included = new Set(includedIds)
  const omittedIds = Object.freeze(
    normalized.filter((entry) => !included.has(entry.item.id)).map((entry) => entry.item.id),
  )
  const tokens = count(text, tokenCounter)

  return Object.freeze({
    version: 1 as const,
    text,
    items: outputItems,
    includedIds,
    omittedIds,
    tokens,
    budget: Object.freeze({ ...budget }),
  })
}

/** Collect source-owned items in source order, then apply the same deterministic assembly rules. */
export async function collectContext<Input>(
  input: Input,
  sources: readonly ContextSource<Input>[],
  options: ContextAssemblyOptions,
): Promise<ContextAssembly> {
  if (!Array.isArray(sources) || sources.length > MAX_ITEMS)
    throw new RangeError("context: source collection is unbounded")
  const sourceIds = new Set<string>()
  for (const source of sources) {
    if (
      source === null ||
      typeof source !== "object" ||
      !IDENTIFIER.test(source.id) ||
      typeof source.load !== "function"
    )
      throw new TypeError("context: source is invalid")
    if (sourceIds.has(source.id)) throw new TypeError(`context: duplicate source id ${source.id}`)
    sourceIds.add(source.id)
  }
  const batches = await Promise.all(sources.map((source) => source.load(input)))
  const items: ContextItem[] = []
  for (let sourceIndex = 0; sourceIndex < batches.length; sourceIndex += 1) {
    const batch = batches[sourceIndex]
    const source = sources[sourceIndex]
    if (!Array.isArray(batch)) throw new TypeError("context: source did not return items")
    for (const item of batch) {
      items.push(item.source === undefined ? { ...item, source: source.id } : item)
    }
  }
  return assembleContext(items, options)
}

interface NormalizedItem {
  readonly index: number
  readonly item: ContextItem
}

function normalizeItem(value: ContextItem, index: number): NormalizedItem {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("context: item is invalid")
  if (!IDENTIFIER.test(value.id)) throw new TypeError("context: item id is invalid")
  if (!KIND.test(value.kind)) throw new TypeError("context: item kind is invalid")
  if (typeof value.content !== "string" || value.content.length > MAX_ITEM_CHARS)
    throw new TypeError("context: item content is invalid")
  if (value.required !== undefined && typeof value.required !== "boolean")
    throw new TypeError("context: item required flag is invalid")
  if (value.priority !== undefined && !finiteNumber(value.priority))
    throw new TypeError("context: item priority is invalid")
  if (value.recency !== undefined && !finiteNumber(value.recency))
    throw new TypeError("context: item recency is invalid")
  if (value.source !== undefined && !IDENTIFIER.test(value.source))
    throw new TypeError("context: item source is invalid")
  return {
    index,
    item: Object.freeze({ ...value }),
  }
}

function validateBudget(value: ContextBudget): ContextAssembly["budget"] {
  if (value === null || typeof value !== "object") throw new TypeError("context: budget is invalid")
  if (!integer(value.maxTokens) || value.maxTokens < 1)
    throw new TypeError("context: maxTokens is invalid")
  const reserveTokens = value.reserveTokens ?? 0
  if (!integer(reserveTokens) || reserveTokens >= value.maxTokens)
    throw new TypeError("context: reserveTokens is invalid")
  return {
    maxTokens: value.maxTokens,
    reserveTokens,
    availableTokens: value.maxTokens - reserveTokens,
  }
}

function render(items: readonly NormalizedItem[], separator: string): string {
  return items.map((entry) => entry.item.content).join(separator)
}

function count(text: string, tokenCounter: ContextTokenCounter): number {
  const value = tokenCounter(text)
  if (!integer(value) || value > MAX_TOKENS)
    throw new TypeError("context: tokenCounter returned an invalid count")
  return value
}

function finiteNumber(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value)
}

function integer(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS
  )
}
