/**
 * The guided learn path - a SEQUENCE for building a nifra app end to end, as opposed to the random-access
 * search of `nifra_docs`/`nifra_example`. It is deliberately thin on embedded code: each step points at the
 * tool that produces the CORRECT, verified artifact (`nifra_scaffold` for a route, `nifra_example` for a
 * verified snippet, `nifra_run`/`nifra_render` to see it work), so an agent walks the path by composing the
 * existing tools rather than pasting code that can drift from the installed version.
 *
 * One source, two heads: `nifra_learn` (MCP) serves it to an agent as structured steps; `nifra learn` (CLI)
 * prints the same path for a human. Add or reorder steps here and both update.
 */

export interface LearnStep {
  /** Stable slug, e.g. `page-route`. */
  readonly id: string
  readonly title: string
  /** What you will have once this step is done. */
  readonly goal: string
  /** How to do it - prefer directing to the tool that emits the correct artifact over inline code. */
  readonly do: string
  /** How to confirm it worked. */
  readonly verify: string
  /** The `nifra_*` tools that carry out this step. */
  readonly tools: readonly string[]
  /** A `nifra_docs`/`nifra_example` query for going deeper. */
  readonly seeAlso?: string | undefined
}

export const LEARN_PATH: readonly LearnStep[] = [
  {
    id: "create-app",
    title: "Create the app",
    goal: "A running nifra dev server with one page route.",
    do: "Scaffold a new project with `npm create nifra@latest`, pick your framework adapter (React/Solid/Vue/Svelte/Preact), then `npm run dev`.",
    verify: "The dev server prints a localhost URL and the default page renders.",
    tools: ["nifra_context"],
    seeAlso: "project structure routes backend",
  },
  {
    id: "page-route",
    title: "Add a page route",
    goal: "A second page, server-rendered, reachable by URL.",
    do: "Ask nifra_scaffold for the path (e.g. /about) - it returns the exact `routes/` file and a contract-correct page stub. File-based: `routes/about.tsx` serves `/about`.",
    verify: "nifra_render /about returns the rendered HTML.",
    tools: ["nifra_scaffold", "nifra_render"],
    seeAlso: "page routes file-based routing layouts",
  },
  {
    id: "loader",
    title: "Load data for a page",
    goal: "A page whose data is fetched on the server before render.",
    do: "Export a `loader` from the route and read its result in the component. Get the exact shape from nifra_example ('loader').",
    verify: "nifra_render the page and confirm the loaded data is in the HTML.",
    tools: ["nifra_example", "nifra_render"],
    seeAlso: "loader server data page",
  },
  {
    id: "api-route",
    title: "Add a typed API route",
    goal: "A backend endpoint with a typed request/response contract.",
    do: "Add the route to `backend.ts` with an @nifrajs/schema body/query/response schema. nifra_context shows the resulting contract and the exact typed-client call form.",
    verify:
      "nifra_run { method, path, body } and check the status + parsed body; nifra_check confirms the contract typechecks.",
    tools: ["nifra_context", "nifra_run", "nifra_check"],
    seeAlso: "api route schema validation backend",
  },
  {
    id: "typed-client",
    title: "Call the API, fully typed",
    goal: "The page calls the API through the compile-time typed client - no hand-written client twin.",
    do: "Use @nifrajs/client against the backend type. The call form is exactly what nifra_context prints for that route; a drifted call is a compile error, not a runtime surprise.",
    verify: "nifra_check passes; nifra_run the page path and see the data flow end to end.",
    tools: ["nifra_context", "nifra_check", "nifra_run"],
    seeAlso: "typed client treaty end-to-end types",
  },
  {
    id: "protect",
    title: "Protect a route",
    goal: "A route that requires an authenticated session.",
    do: "Wire @nifrajs/auth (or @nifrajs/better-auth) and gate the route. nifra_example ('protected route') has the verified pattern; nifra_assure reports whether the gate is actually enforced.",
    verify:
      "nifra_run the route unauthenticated (expect 401/redirect) and authenticated (expect 200); nifra_assure shows the enforcement evidence.",
    tools: ["nifra_example", "nifra_assure", "nifra_run"],
    seeAlso: "auth session protected route better-auth",
  },
  {
    id: "background-work",
    title: "Do work in the background",
    goal: "A request that enqueues a job instead of blocking on slow work.",
    do: "Define a job with @nifrajs/jobs and enqueue it from a route. nifra_example ('job') has the shape; nifra_inspect shows the enqueue landing on the dev server.",
    verify:
      "nifra_run the route, then nifra_inspect the dev server to see the request completed fast and the effect fired.",
    tools: ["nifra_example", "nifra_run", "nifra_inspect"],
    seeAlso: "jobs queue background enqueue",
  },
  {
    id: "ship",
    title: "Build and deploy",
    goal: "A production build served by your chosen runtime.",
    do: "Pick an adapter (@nifrajs/node, @nifrajs/workers, @nifrajs/deno, or a static/Vercel target) and run the production build. nifra_levels shows what the app already proves before you ship.",
    verify:
      "The build completes and the artifact serves the app; nifra_check + nifra_levels are green.",
    tools: ["nifra_levels", "nifra_check"],
    seeAlso: "deploy build adapters node workers deno",
  },
]

/** The compact index: numbered steps with their goal, plus how to drill into one. */
function renderIndex(): string {
  const lines = LEARN_PATH.map((step, i) => `${i + 1}. ${step.title} - ${step.goal} [${step.id}]`)
  return [
    `nifra learn path (${LEARN_PATH.length} steps). Call nifra_learn with step: N for the detail of step N.`,
    "",
    ...lines,
  ].join("\n")
}

/** One step's full detail, with a pointer to the next. */
function renderStep(step: LearnStep, index: number): string {
  const parts = [
    `Step ${index + 1}/${LEARN_PATH.length}: ${step.title}  [${step.id}]`,
    "",
    `Goal:   ${step.goal}`,
    `Do:     ${step.do}`,
    `Verify: ${step.verify}`,
    `Tools:  ${step.tools.join(", ")}`,
  ]
  if (step.seeAlso !== undefined) {
    parts.push(`See:    nifra_docs / nifra_example "${step.seeAlso}"`)
  }
  const next = LEARN_PATH[index + 1]
  parts.push(
    "",
    next !== undefined
      ? `Next:   step ${index + 2} (${next.title})`
      : "Done - you have shipped a nifra app.",
  )
  return parts.join("\n")
}

/**
 * Render the learn path. No `step` (or an out-of-range one) returns the index; a valid 1-based `step`
 * returns that step's detail. Kept pure so `nifra_learn` and `nifra learn` render identically.
 */
export function renderLearnResult(step?: number): string {
  if (step === undefined) return renderIndex()
  const index = step - 1
  const found = LEARN_PATH[index]
  if (found === undefined) {
    return `No step ${step}. The path has ${LEARN_PATH.length} steps.\n\n${renderIndex()}`
  }
  return renderStep(found, index)
}
