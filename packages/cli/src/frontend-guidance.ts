/**
 * `nifra_frontend` - a symptom-indexed catalog of the mistakes an agent (or a human) hits on the client
 * side of a nifra app, across every adapter. It is the FRONTEND companion to `nifra_check`: where the
 * check statically flags the footguns nifra's own seam owns (server-only imports, the nano lane), this
 * catalog covers the ones a static rule can't own cheaply - hydration nondeterminism, a duplicated
 * framework runtime, and the per-framework reactivity-loss idioms that each ecosystem's own linter is
 * the real authority on.
 *
 * Deliberately a compact reference, not an accumulated fault corpus: two kinds of entry only.
 *   - Seam entries (`adapters: ["all"]`) - the boundary nifra defines: server/client split, the loader
 *     data contract, hydration determinism, one framework copy. These point at a `nifra_*` tool to fix
 *     and verify, because nifra owns that surface.
 *   - Framework entries - the classic reactivity-loss shape for one adapter (Vue ref, Solid props,
 *     Svelte runes, React/Preact deps). These point at that framework's own ESLint plugin, which is the
 *     authority; nifra does not re-implement it, it routes you to it.
 *
 * One source, two heads: `nifra_frontend` (MCP) serves it to an agent; `nifra frontend` (CLI) prints it
 * for a human. Both call {@link renderFrontendResult}, so they can never drift.
 */

import type { Framework } from "./scaffold.ts"

/** An adapter an entry applies to, or `all` for a seam issue that is adapter-independent. */
export type GuidanceAdapter = Framework | "all"

export interface GuidanceEntry {
  /** Stable slug, e.g. `server-import`. */
  readonly id: string
  /** Which adapters this applies to. `["all"]` is a seam issue every adapter shares. */
  readonly adapters: readonly GuidanceAdapter[]
  /** What you observe - the searchable symptom, phrased as the failure, not the cause. */
  readonly symptom: string
  /** Why it happens. */
  readonly cause: string
  /** The concrete change that fixes it. */
  readonly fix: string
  /** How to confirm it is fixed - a `nifra_*` tool for a seam issue, the framework's linter otherwise. */
  readonly verify: string
  /** Where to go deeper - a `nifra_docs`/`nifra_example` query, or the ecosystem linter that owns it. */
  readonly seeAlso?: string | undefined
}

/**
 * The catalog. Seam entries first (they are the nifra-specific value and apply everywhere), then the
 * per-framework reactivity-loss entries. Keep it compact and high-signal - a curated fault corpus mined
 * from real failures is operated depth and lives elsewhere, not in the public package.
 */
export const FRONTEND_GUIDANCE: readonly GuidanceEntry[] = [
  {
    id: "server-import",
    adapters: ["all"],
    symptom:
      "A client component crashes at build or runtime with a missing Node built-in, a leaked secret, or 'module not found in the browser'.",
    cause:
      "A server-only module (the DB, a secret, `node:*`, the backend file) is imported at the top level of a component, so the bundler tries to ship it to the browser.",
    fix: "Move the access into a server-only `loader`/`action` and read the result in the component. Reach the backend through the typed `api` argument, never a top-level server-only import.",
    verify:
      "nifra_check - its transitive server-import scan flags the exact import chain into a client module.",
    seeAlso: "loader action server-only import boundary",
  },
  {
    id: "hydration-mismatch",
    adapters: ["all"],
    symptom:
      "A hydration warning, text that flips on load, or 'server HTML did not match client' the first time the page becomes interactive.",
    cause:
      "The first client render is not identical to the SSR HTML - usually a non-deterministic read during render: `Date.now()`, `Math.random()`, `window`/`localStorage`, or a locale/timezone the server did not have.",
    fix: "Render deterministic markup, then apply anything client-only in an effect / `onMount` after the first paint. Pass anything the server knew (time, locale, flags) down through loader data so both renders agree.",
    verify:
      "nifra_render the route and diff its HTML against the first client render; nifra_check's hydration assurance reports nondeterminism it can see.",
    seeAlso: "hydration ssr determinism loader data",
  },
  {
    id: "duplicate-runtime",
    adapters: ["react", "preact", "solid", "vue", "svelte"],
    symptom:
      "'Invalid hook call', a null context/provider, signals that never update, or a component that mounts twice.",
    cause:
      "Two copies of the framework are in the bundle - the app's own dependency and a second one resolved through the adapter - so the two runtimes do not share the same module-level state.",
    fix: "Dedupe the framework to a single version across the workspace (one entry in the lockfile). The adapter must resolve the app's copy, not bundle its own.",
    verify: "nifra_doctor - it detects a duplicated framework runtime (NF-H002).",
    seeAlso: "duplicate framework runtime dedupe NF-H002",
  },
  {
    id: "loader-typing",
    adapters: ["all"],
    symptom:
      "Loader data is typed `any` in the page, or a hand-written interface silently drifts from what the loader actually returns.",
    cause:
      "The component types its props by hand instead of inferring them from the loader, so a change to the loader is not a type error at the use site.",
    fix: "Type the page from the loader: `props: { data: LoaderData<typeof loader> }`. Call the backend through the typed `api` so the request/response shape is inferred, not restated.",
    verify:
      "nifra_context prints the exact loader shape and typed call form; nifra_check fails on drift.",
    seeAlso: "LoaderData typed client loader inference",
  },
  {
    id: "list-key",
    adapters: ["all"],
    symptom:
      "List rows keep the wrong state on reorder/insert - a checked box, focus, or an input value jumps to a different row.",
    cause:
      "The list is keyed by the array index (or not keyed at all), so add/remove/reorder maps the wrong item to an existing node.",
    fix: "Key each row by a stable, unique id from the item, never its position in the array.",
    verify:
      "The framework's own linter for JSX keys; on the vanilla nano lane, nifra_check flags an index key as NF-C022.",
    seeAlso: "list key stable id reconcile nano",
  },
  {
    id: "vue-lost-reactivity",
    adapters: ["vue"],
    symptom:
      "A value stops updating the template after you pull it out of a ref, reactive object, or props.",
    cause:
      "Destructuring a `reactive()` object or `props` copies the current value and drops the reactive link; a `ref` read in script forgets `.value`.",
    fix: "Keep the reactive source intact: use `toRefs`/`storeToRefs` when you must destructure, access `props.x` directly, and remember `.value` on a ref in script (templates unwrap it for you).",
    verify:
      "eslint-plugin-vue - it is the authority on Vue reactivity; nifra does not re-implement it.",
    seeAlso: "eslint-plugin-vue toRefs reactivity",
  },
  {
    id: "solid-lost-reactivity",
    adapters: ["solid"],
    symptom: "A prop or store value renders once and never tracks updates in a Solid component.",
    cause:
      "Solid props are getters, evaluated where you read them. Destructuring props (or reading them outside JSX/an effect) reads once and loses tracking.",
    fix: "Access `props.x` at the point of use inside JSX, or `splitProps`/`mergeProps` when you need to pass a subset on. Never destructure props in the function signature.",
    verify:
      "eslint-plugin-solid - the authority on Solid reactivity; nifra routes you to it, not around it.",
    seeAlso: "eslint-plugin-solid splitProps props getters",
  },
  {
    id: "svelte-runes",
    adapters: ["svelte"],
    symptom:
      "In a Svelte 5 component, `export let` props or a `$:` statement do not behave as expected, or the compiler rejects them in runes mode.",
    cause:
      "Runes mode replaces the Svelte 4 idioms: props come from `$props()`, derived values from `$derived`, side effects from `$effect`. Mixing the two models is the mismatch.",
    fix: "In runes mode use `$props()` for inputs, `$state` for local state, `$derived` for computed values, and `$effect` for side effects - not `export let` or `$:`.",
    verify:
      "eslint-plugin-svelte and the Svelte compiler warnings own this; nifra points you at them.",
    seeAlso: "eslint-plugin-svelte runes $props $derived",
  },
  {
    id: "react-stale-deps",
    adapters: ["react", "preact"],
    symptom:
      "An effect or callback uses a stale value, fires too often, or never re-runs when a value it reads changes.",
    cause:
      "The dependency array omits a value the effect/callback closes over (or the effect has no array), so the closure captures an old render's value.",
    fix: "List every reactive value the effect reads in its deps, or hold the mutable value in a ref when it must not trigger a re-run. Do not silence the rule by emptying the array.",
    verify:
      "eslint-plugin-react-hooks (`exhaustive-deps`) is the authority on effect deps; nifra does not duplicate it.",
    seeAlso: "eslint-plugin-react-hooks exhaustive-deps effect closure",
  },
  {
    id: "prefer-nano-or-island",
    adapters: ["vanilla"],
    symptom:
      "A vanilla page needs local state or a list a human edits, and hand-written DOM updates are getting fragile.",
    cause:
      "The islands lane is imperative and has no state primitive, so each update is hand-wired and a list means rebuilding the container.",
    fix: "Use the nano lane: `signal` + `computed(fn, [deps])` for state, `bindList` for a keyed list, `resource` for async. Every reactive edge is a visible call, so its mistakes are static lints.",
    verify:
      "nifra_check runs NF-C021 (discarded disposer), NF-C022 (index key), NF-C023 (missing dep) over the nano code.",
    seeAlso: "nano signal computed bindList resource islands",
  },
]

const ADAPTER_ALIASES: Record<string, GuidanceAdapter> = {
  all: "all",
  react: "react",
  preact: "preact",
  solid: "solid",
  vue: "vue",
  svelte: "svelte",
  vanilla: "vanilla",
}

/** Normalize a free-text adapter argument to a known adapter, or `undefined` if it is not one. */
export function parseAdapter(value: string | undefined): GuidanceAdapter | undefined {
  if (value === undefined) return undefined
  return ADAPTER_ALIASES[value.trim().toLowerCase()]
}

const appliesTo = (entry: GuidanceEntry, adapter: GuidanceAdapter): boolean =>
  adapter === "all" || entry.adapters.includes("all") || entry.adapters.includes(adapter)

/** Keyword score of an entry against a query - counts distinct query words found in its text. */
function score(entry: GuidanceEntry, words: readonly string[]): number {
  const hay =
    `${entry.id} ${entry.symptom} ${entry.cause} ${entry.fix} ${entry.seeAlso ?? ""}`.toLowerCase()
  let hits = 0
  for (const w of words) if (hay.includes(w)) hits++
  return hits
}

function renderEntry(entry: GuidanceEntry): string {
  const scope = entry.adapters.includes("all") ? "all adapters" : entry.adapters.join(", ")
  const parts = [
    `[${entry.id}]  (${scope})`,
    `Symptom: ${entry.symptom}`,
    `Cause:   ${entry.cause}`,
    `Fix:     ${entry.fix}`,
    `Verify:  ${entry.verify}`,
  ]
  if (entry.seeAlso !== undefined) parts.push(`See:     ${entry.seeAlso}`)
  return parts.join("\n")
}

function renderIndex(
  entries: readonly GuidanceEntry[],
  adapter: GuidanceAdapter | undefined,
): string {
  const scope = adapter === undefined ? "all adapters" : `adapter: ${adapter}`
  const lines = entries.map((e) => {
    const s = e.adapters.includes("all") ? "all" : e.adapters.join("/")
    return `- ${e.id} (${s}) - ${e.symptom}`
  })
  return [
    `nifra frontend guidance (${entries.length} of ${FRONTEND_GUIDANCE.length}, ${scope}). Pass a symptom to get the cause + fix + how to verify; pass an adapter to filter.`,
    "",
    ...lines,
  ].join("\n")
}

/**
 * Render the catalog. Filters by `adapter` (when it names a known one), then by a `symptom` keyword
 * query. With no query it returns the (filtered) index; with a query it returns the best-matching
 * entries in full, or the index plus a "no match" note when nothing scores. Pure, so both heads agree.
 */
export function renderFrontendResult(args: {
  adapter?: string | undefined
  symptom?: string | undefined
  limit?: number | undefined
}): string {
  const adapter = parseAdapter(args.adapter)
  const scoped =
    adapter === undefined
      ? FRONTEND_GUIDANCE
      : FRONTEND_GUIDANCE.filter((e) => appliesTo(e, adapter))
  const query = args.symptom?.trim()
  if (query === undefined || query.length === 0) return renderIndex(scoped, adapter)

  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
  const limit = Math.min(Math.max(args.limit ?? 3, 1), 5)
  const ranked = scoped
    .map((entry) => ({ entry, s: score(entry, words) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)

  if (ranked.length === 0) {
    return `No frontend-guidance entry matched "${query}"${adapter ? ` for ${adapter}` : ""}.\n\n${renderIndex(scoped, adapter)}`
  }
  return ranked.map((r) => renderEntry(r.entry)).join("\n\n")
}
