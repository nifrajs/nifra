/**
 * `nifra_frontend` - a symptom-indexed catalog of the mistakes an agent (or a human) hits on the client
 * side of a nifra app, across every adapter. It is the FRONTEND companion to `nifra_check`: where the
 * check statically flags the footguns nifra's own seam owns (server-only imports, island bindings), this
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
  /** Framework/runtime versions covered by the advice. Omitted only for Nifra-wide seam entries. */
  readonly versions?: readonly string[] | undefined
  /** The authoritative documentation or linter reference for this case. */
  readonly source?: string | undefined
  /** Coarse category used by JSON consumers to group related cases. */
  readonly category?:
    | "seam"
    | "hydration"
    | "reactivity"
    | "effects"
    | "lists"
    | "runtime"
    | "ssr"
    | undefined
}

export interface FrontendGuidanceResult {
  readonly schemaVersion: 1
  readonly adapter?: GuidanceAdapter | undefined
  readonly symptom?: string | undefined
  readonly matched: boolean
  readonly entries: readonly GuidanceEntry[]
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
      "Browser code (a page, `frontend/` or `shared/`) imports backend code - `backend/`, a route's `.backend.ts` half, the DB, a secret, `node:*` - so the browser build refuses it.",
    fix: "Move the access into the route's `.backend.ts` half (`loader`/`action` with `loaderOutput`/`actionOutput`) and read the result as `data` in the page. Reach the backend through the typed `api` argument; put code both sides need in `shared/`.",
    verify:
      "nifra_check - its transitive server-import scan flags the exact import chain into a client module.",
    seeAlso: "project structure route backend half import rules",
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
    category: "runtime",
  },
  {
    id: "loader-typing",
    adapters: ["all"],
    symptom:
      "Loader data is typed `any` in the page, or a hand-written interface silently drifts from what the loader actually returns.",
    cause:
      "The component types its props by hand instead of inferring them from the loader, so a change to the loader is not a type error at the use site.",
    fix: 'Type the page from its generated route types: `import type { Route } from "./+types/<name>"` and `props: Route.ComponentProps`. Its `data` is the `loaderOutput` schema\'s type - what actually reaches the browser - while `LoaderData<typeof loader>` also types fields the schema strips. Call the backend through the typed `api` (`Route.LoaderArgs`) so the request/response shape is inferred, not restated.',
    verify:
      "nifra_context prints the exact loader shape and typed call form; nifra_check fails on drift.",
    seeAlso: "route types Route.ComponentProps loaderOutput typed client",
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
      "The framework's own linter for JSX keys; for an islands bindList, nifra_check flags a positional key as NF-C022.",
    seeAlso: "list key stable id reconcile bindList islands",
  },
  {
    id: "vue-lost-reactivity",
    adapters: ["vue"],
    symptom:
      "A value stops updating the template after you pull it out of a ref, reactive object, or props.",
    cause:
      "Destructuring a `reactive()` object or the `props` argument of `setup(props)` copies the current value and drops the reactive link; a `ref` read in script forgets `.value`. In Vue 3.5 `<script setup>`, destructuring `defineProps()` is compiled to keep reads reactive, but passing the destructured name to `watch` still hands it a plain value.",
    fix: "Keep the reactive source intact: use `toRefs`/`storeToRefs` when you must destructure, access `props.x` directly, watch a getter such as `() => foo` for a destructured prop, and remember `.value` on a ref in script (templates unwrap it for you).",
    verify:
      "eslint-plugin-vue - it is the authority on Vue reactivity; nifra does not re-implement it.",
    seeAlso: "eslint-plugin-vue toRefs reactivity",
    versions: ["Vue 3.4-3.5"],
    source: "https://vuejs.org/guide/essentials/reactivity-fundamentals.html",
    category: "reactivity",
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
    versions: ["Solid 1.8-1.9"],
    source: "https://docs.solidjs.com/concepts/components/props",
    category: "reactivity",
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
    versions: ["Svelte 5"],
    source: "https://svelte.dev/docs/svelte/$props",
    category: "reactivity",
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
    versions: ["React 18-19", "Preact 10-11"],
    source: "https://react.dev/reference/react/useEffect",
    category: "effects",
  },
  {
    id: "react-hydration-browser-read",
    adapters: ["react"],
    symptom:
      "React reports a hydration mismatch when a component reads window, localStorage, matchMedia, or the current time while rendering.",
    cause:
      "The server render and the first client render produce different output. React requires the tree passed to hydrateRoot to match the server HTML.",
    fix: "Render the same deterministic value on both sides, then read browser-only state in an effect and render the updated value after hydration. Pass server-known locale, time, and flags through loader data.",
    verify:
      "React's hydration warning should disappear; run `nifra_render` and a browser smoke test for the route.",
    seeAlso: "hydrateRoot browser-only APIs deterministic rendering",
    versions: ["React 18-19"],
    source: "https://react.dev/reference/react-dom/client/hydrateRoot",
    category: "hydration",
  },
  {
    id: "react-effect-cleanup",
    adapters: ["react"],
    symptom:
      "A subscription, timer, or request keeps running after a React component changes or unmounts.",
    cause:
      "The effect does not return cleanup, or cleanup does not undo the setup created for the previous dependency values.",
    fix: "Return cleanup from every effect that subscribes, starts a timer, or owns an abortable request. Make cleanup idempotent because development Strict Mode may run setup and cleanup more than once.",
    verify:
      "Use the React hooks linter and a mount-update-unmount test that asserts the subscription and timer are released.",
    seeAlso: "useEffect cleanup Strict Mode abort controller",
    versions: ["React 18-19"],
    source: "https://react.dev/reference/react/useEffect#parameters",
    category: "effects",
  },
  {
    id: "react-state-position",
    adapters: ["react"],
    symptom:
      "React preserves input or component state for the wrong item after a reorder, conditional change, or route transition.",
    cause:
      "State is associated with a component's position and key. An index key or changing component identity makes React reuse state for a different item.",
    fix: "Use a stable data key for each list item and give intentionally reset content a deliberate, changing key. Do not use array indexes for reorderable lists.",
    verify:
      "Exercise insert, remove, and reorder cases with a stateful row test; keep `eslint-plugin-react` key diagnostics enabled.",
    seeAlso: "preserving and resetting state stable keys",
    versions: ["React 18-19"],
    source: "https://react.dev/learn/preserving-and-resetting-state",
    category: "lists",
  },
  {
    id: "preact-compat-runtime",
    adapters: ["preact"],
    symptom:
      "A Preact app has a null context, invalid hook behavior, or a component that works before an adapter or dependency is added.",
    cause:
      "React imports and Preact compat imports are mixed, or more than one Preact runtime is installed. Context and hooks depend on one shared runtime instance.",
    fix: "Choose Preact or `preact/compat` consistently, alias React packages only at the bundler boundary, and dedupe Preact across the workspace.",
    verify:
      "Run `nifra_doctor`, inspect the resolved dependency tree, and exercise a context provider plus a hook in a production build.",
    seeAlso: "preact compat switching from React single runtime",
    versions: ["Preact 10-11"],
    source: "https://preactjs.com/guide/v10/switching-to-preact/",
    category: "runtime",
  },
  {
    id: "preact-effect-cleanup",
    adapters: ["preact"],
    symptom:
      "A Preact effect creates duplicate listeners or timers after rerenders, navigation, or development reloads.",
    cause:
      "The effect setup has no cleanup, or dependencies cause a new setup without removing the previous one.",
    fix: "Return cleanup from `useEffect` and keep the dependency list aligned with every value read by the effect. Abort requests owned by the effect.",
    verify:
      "Use `eslint-plugin-react-hooks` with the Preact hooks configuration and assert listener counts across rerenders.",
    seeAlso: "Preact hooks useEffect cleanup dependencies",
    versions: ["Preact 10-11"],
    source: "https://preactjs.com/guide/v10/hooks/",
    category: "effects",
  },
  {
    id: "preact-hydration-output",
    adapters: ["preact"],
    symptom:
      "Preact replaces server markup or event handlers fail after hydration even though the page initially looks correct.",
    cause:
      "The first client render differs from the server HTML, often because a browser API, random value, or locale is read during render.",
    fix: "Keep the initial render deterministic and move browser-only reads into an effect or an explicit client-only boundary. Ensure the server and client use the same Preact runtime.",
    verify:
      "Run the route through SSR plus `hydrate`, capture console errors, and compare the initial markup before effects run.",
    seeAlso: "Preact hydrate SSR deterministic render",
    versions: ["Preact 10-11"],
    source: "https://preactjs.com/guide/v10/api-reference/#hydrate",
    category: "hydration",
  },
  {
    id: "solid-for-index",
    adapters: ["solid"],
    symptom:
      "A Solid list displays the wrong row state or does unnecessary work after an item is inserted or reordered.",
    cause:
      "`Index` tracks positions while `For` tracks item identity. Choosing the wrong primitive changes which values remain attached to a row.",
    fix: "Use `<For>` for collections whose item identity can move and `<Index>` only when position is the identity. Supply a stable key at the data boundary when persistence matters.",
    verify:
      "Test insert, remove, and reorder operations while editing one row; assert both rendered identity and preserved local state.",
    seeAlso: "Solid list rendering For Index",
    versions: ["Solid 1.8-1.9"],
    source: "https://docs.solidjs.com/concepts/control-flow/list-rendering",
    category: "lists",
  },
  {
    id: "solid-tracking-scope",
    adapters: ["solid"],
    symptom:
      "A Solid computation reads a signal once and never updates, or a server-rendered value is captured before the component runs.",
    cause:
      "The signal is read outside a tracked computation or at module/component setup time instead of inside JSX, `createEffect`, or `createMemo`.",
    fix: "Read signals where Solid can track them, keep derived work in `createMemo`, and keep side effects in `createEffect`. Do not cache a getter's current value as a plain variable.",
    verify:
      "Change the source signal after mount and assert the derived output changes without manually calling an update function.",
    seeAlso: "Solid reactivity tracking createMemo createEffect",
    versions: ["Solid 1.8-1.9"],
    source: "https://docs.solidjs.com/concepts/reactivity",
    category: "reactivity",
  },
  {
    id: "solid-effect-cleanup",
    adapters: ["solid"],
    symptom: "A Solid event listener, interval, or resource outlives the owner that created it.",
    cause:
      "The effect allocates an external resource without registering cleanup with the current owner.",
    fix: "Register teardown with `onCleanup` in the same owner that created the resource. Abort async work when its owner is disposed.",
    verify:
      "Mount and dispose the owner repeatedly, then assert that listener, timer, and request counts return to zero.",
    seeAlso: "Solid onCleanup effects",
    versions: ["Solid 1.8-1.9"],
    source: "https://docs.solidjs.com/reference/lifecycle/on-cleanup",
    category: "effects",
  },
  {
    id: "vue-ref-script-access",
    adapters: ["vue"],
    symptom:
      "A Vue ref appears to work in a template but is stale or compares incorrectly in script code.",
    cause:
      "Templates unwrap refs, while JavaScript and TypeScript code must read and write the ref's `.value`.",
    fix: "Use `.value` in script, or use `toRefs`/`storeToRefs` when exposing reactive properties without losing their link.",
    verify:
      "Run a component test that changes the ref from script and asserts both the value and rendered output update.",
    seeAlso: "Vue refs unwrapping in templates and script",
    versions: ["Vue 3.4-3.5"],
    source: "https://vuejs.org/guide/essentials/reactivity-fundamentals.html#ref-unwrapping",
    category: "reactivity",
  },
  {
    id: "vue-watch-source",
    adapters: ["vue"],
    symptom:
      "A Vue watcher never runs, runs only once, or fires for a value that the code did not intend to observe.",
    cause:
      "The watcher received a plain value instead of a reactive source, or a deep object was watched without an explicit decision about traversal cost.",
    fix: "Pass a ref, getter, or reactive object as the watch source. Choose `deep`, `immediate`, and flush timing deliberately, and use `watchEffect` only when its automatic dependencies are intended.",
    verify:
      "Change the source and an unrelated nested value separately; assert the exact watcher calls and cleanup behavior.",
    seeAlso: "Vue watch sources deep watchers watchEffect",
    versions: ["Vue 3.4-3.5"],
    source: "https://vuejs.org/guide/essentials/watchers.html",
    category: "effects",
  },
  {
    id: "vue-hydration-browser-read",
    adapters: ["vue"],
    symptom:
      "Vue warns about hydration mismatch when a component reads browser state or formats a value during SSR.",
    cause:
      "The server and client produce different initial VNodes because browser-only state, timezone, locale, or random data is read during render.",
    fix: "Render a deterministic initial value, then update browser-only state in `onMounted` or a client-only boundary. Serialize server-known locale and time through loader data.",
    verify:
      "Run SSR plus hydration with console warnings treated as failures and test at least one non-default locale.",
    seeAlso: "Vue SSR hydration mismatch onMounted",
    versions: ["Vue 3.4-3.5"],
    source: "https://vuejs.org/guide/scaling-up/ssr.html#hydration-mismatch",
    category: "hydration",
  },
  {
    id: "svelte-keyed-each",
    adapters: ["svelte"],
    symptom:
      "A Svelte row keeps the wrong input value or local state after a list item is inserted, removed, or reordered.",
    cause:
      "An unkeyed `{#each}` block reuses DOM by position, so local state follows the slot instead of the item identity.",
    fix: "Use a keyed each block, `{#each items as item (item.id)}`, when item identity must survive collection changes.",
    verify:
      "Test reorder and deletion with focused, edited inputs and assert the state stays with the same id.",
    seeAlso: "Svelte keyed each blocks list identity",
    versions: ["Svelte 4-5"],
    source: "https://svelte.dev/docs/svelte/each",
    category: "lists",
  },
  {
    id: "svelte-effect-cleanup",
    adapters: ["svelte"],
    symptom:
      "A Svelte 5 effect leaves a timer, subscription, or request alive after dependencies change or the component unmounts.",
    cause:
      "The effect does not return a teardown function, or legacy and runes lifecycle assumptions are mixed.",
    fix: "Return cleanup from `$effect` for every resource it creates. Keep DOM-only work in `$effect` and derived values in `$derived`.",
    verify:
      "Mount, change dependencies, and destroy the component while asserting the cleanup function runs once for each setup.",
    seeAlso: "Svelte 5 $effect teardown $derived",
    versions: ["Svelte 5"],
    source: "https://svelte.dev/docs/svelte/$effect",
    category: "effects",
  },
  {
    id: "svelte-ssr-browser-read",
    adapters: ["svelte"],
    symptom:
      "A Svelte page flashes or reports a hydration mismatch when it reads browser globals, random values, or the current time.",
    cause:
      "SSR executes the component before a browser exists, and the server output differs from the browser's first render.",
    fix: "Keep the initial markup deterministic, use `onMount` for browser-only reads, and pass server-known values through page or loader data.",
    verify:
      "SSR the page, hydrate it in a browser, and fail the test on hydration warnings or a changed first render.",
    seeAlso: "Svelte onMount SSR browser-only code hydration",
    versions: ["Svelte 4-5"],
    source: "https://svelte.dev/docs/svelte/svelte#onmount",
    category: "hydration",
  },
  {
    id: "prefer-reactive-island",
    adapters: ["vanilla"],
    symptom:
      "A vanilla page needs local state or a list a human edits, and hand-written DOM updates are getting fragile.",
    cause:
      "An imperative defineIsland enhancer has no state primitive, so each update is hand-wired and a list means rebuilding the container.",
    fix: "Mount the island with `bindIsland`: `state(key, fallback)` for state, `data-bind-*` attributes for the markup, `bindList` for a keyed list, `resource` for async. Everything the setup creates stops when the island unmounts.",
    verify:
      "nifra_check runs NF-C047 (a binding names no state or handler), NF-C048 (a binding outside a bindIsland host) and NF-C022 (a positional list key) over the island code.",
    seeAlso: "bindIsland state data-bind bindList resource islands",
    category: "seam",
  },
  {
    id: "swap-a-region",
    adapters: ["vanilla"],
    symptom:
      'A search form, a filter or a "more" link on a vanilla page reloads the whole document to change one region.',
    cause:
      "A plain link or form always loads a full page, and a vanilla page has no client router to fetch only the part that changed.",
    fix: 'Mark the region `data-swap-slot="results"` and make `slot("results", content)` its only content, add `data-swap="replace:results"` (or `append:results`) to the link or form, and call `enableSwap` from `@nifrajs/web/islands/swap` in place of `mountIslands`. The server answers with that slot of the same page; anything else loads normally.',
    verify:
      "nifra_check runs NF-C049 to NF-C052 over the swap markup and NF-C048 over bindings inside a slot.",
    seeAlso: "data-swap data-swap-slot slot enableSwap islands",
    category: "seam",
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

/** Return whether a catalog entry applies to the requested adapter. */
const appliesTo = (entry: GuidanceEntry, adapter: GuidanceAdapter): boolean =>
  adapter === "all" || entry.adapters.includes("all") || entry.adapters.includes(adapter)

/** Scope the catalog once so the CLI and MCP heads cannot drift in their adapter filtering. */
function scopedEntries(adapter: GuidanceAdapter | undefined): readonly GuidanceEntry[] {
  return adapter === undefined
    ? FRONTEND_GUIDANCE
    : FRONTEND_GUIDANCE.filter((entry) => appliesTo(entry, adapter))
}

/** Keyword score of an entry against a query - counts distinct query words found in its text. */
function score(entry: GuidanceEntry, words: readonly string[]): number {
  const hay =
    `${entry.id} ${entry.symptom} ${entry.cause} ${entry.fix} ${entry.seeAlso ?? ""} ${entry.category ?? ""} ${entry.versions?.join(" ") ?? ""}`.toLowerCase()
  let hits = 0
  for (const w of words) if (hay.includes(w)) hits++
  return hits
}

/** Longest symptom text scored; the MCP schema advertises the same cap, this enforces it. */
const MAX_SYMPTOM_LENGTH = 256

/** Select the entries rendered by the CLI and MCP heads; also the stable JSON shape for agents (no rendered prose). */
export function selectFrontendGuidance(args: {
  adapter?: string | undefined
  symptom?: string | undefined
  limit?: number | undefined
}): FrontendGuidanceResult {
  const adapter = parseAdapter(args.adapter)
  const scoped = scopedEntries(adapter)
  const query = args.symptom?.trim().slice(0, MAX_SYMPTOM_LENGTH)
  if (query === undefined || query.length === 0) {
    return { schemaVersion: 1, adapter, matched: true, entries: scoped }
  }
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
  const limit = Math.min(Math.max(args.limit ?? 3, 1), 5)
  const entries = scoped
    .map((entry) => ({ entry, s: score(entry, words) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((r) => r.entry)
  return { schemaVersion: 1, adapter, symptom: query, matched: entries.length > 0, entries }
}

/** Render one matched entry with all optional metadata that is actually present. */
function renderEntry(entry: GuidanceEntry): string {
  const scope = entry.adapters.includes("all") ? "all adapters" : entry.adapters.join(", ")
  const parts = [
    `[${entry.id}]  (${scope})`,
    `Symptom: ${entry.symptom}`,
    `Cause:   ${entry.cause}`,
    `Fix:     ${entry.fix}`,
    `Verify:  ${entry.verify}`,
  ]
  if (entry.versions !== undefined) parts.push(`Applies: ${entry.versions.join(", ")}`)
  if (entry.category !== undefined) parts.push(`Category: ${entry.category}`)
  if (entry.source !== undefined) parts.push(`Source:   ${entry.source}`)
  if (entry.seeAlso !== undefined) parts.push(`See:     ${entry.seeAlso}`)
  return parts.join("\n")
}

/** Render the compact index used when no symptom matched or was supplied. */
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
  const selected = selectFrontendGuidance(args)
  const selectedAdapter = selected.adapter
  const scoped = scopedEntries(selectedAdapter)
  if (selected.symptom === undefined) return renderIndex(scoped, selectedAdapter)
  if (!selected.matched) {
    return `No frontend-guidance entry matched "${selected.symptom}"${selectedAdapter ? ` for ${selectedAdapter}` : ""}.\n\n${renderIndex(scoped, selectedAdapter)}`
  }
  return selected.entries.map(renderEntry).join("\n\n")
}
