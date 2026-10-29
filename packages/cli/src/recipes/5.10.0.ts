import type { UpgradeRecipe } from "./index.ts"

/**
 * Upgrade recipe for Nifra 5.10.
 *
 * No import or dependency moves. Partial prerendering is stable, so `createWebApp` takes it as `ppr`
 * and the `ppr-option` source rewrite moves `experimental: { ppr }`. The query cache sends nothing to
 * the browser unless the app names the queries, and an identity change cancels a mutation still
 * running; the notes say what an app sees differently.
 */
export const recipe: UpgradeRecipe = {
  version: "5.10.0",
  pins: [
    { match: "@nifrajs/", to: "5.10.0" },
    { match: "create-nifra", to: "5.10.0" },
    { match: "nifra", to: "5.10.0" },
  ],
  importMoves: [],
  sourceRewrites: ["ppr-option"],
  affects: [
    "@nifrajs/web",
    "@nifrajs/web-react",
    "@nifrajs/web-preact",
    "@nifrajs/web-vue",
    "@nifrajs/web-svelte",
    "@nifrajs/web-solid",
  ],
  notes: [
    "Partial prerendering is stable: `createWebApp({ ppr: partialPrerendering(...) })` replaces `experimental: { ppr: partialPrerendering(...) }`, and the `experimental` option is removed. Passing it throws a `TypeError` that names `ppr`. The startup errors name `ppr.origin`, `ppr.deployment`, `ppr.store` and `ppr.storeSecret`. The `ppr-option` rewrite moves `experimental: { ppr }` in a `createWebApp` options literal; options with a spread, a second key under `experimental`, or an `experimental` built in another file are listed by line or left for you to check.",
    "`dehydrate()` on a query client sends nothing unless `shouldDehydrateQuery` selects the queries, where a bare call sent every successful query, regular and infinite. Every dehydrated value is serialized into the page and readable by the visitor. Pass `shouldDehydrateQuery` naming the keys that are safe to send, or `() => true` when every successful query in that client is meant for the browser. Without it the browser starts with no cache for those queries and fetches them itself, so a component that rendered their data on the server can differ from it on the first client render.",
    "A mutation still running when the visitor's identity changes, in this tab or another tab of the site, is cancelled: its `mutate` promise rejects with `MutationCancelledError`, and its `onSuccess`, `onError` and `onSettled` callbacks do not run. The mutation function takes a second argument, `{ signal }`, an `AbortSignal` that is aborted at that moment; pass it to `fetch` to stop the request. A call site that awaits `mutateAsync` across a sign-in or sign-out catches that error.",
    '`nifra check` reports NF-C056 (error) for `serverFunctions("todo", todos)` where `todos` is a namespace import of `todos.fn.ts`: the client stubs call the namespace the file names, so a mount under another word answers 404 on every call. Rename the mount, or put `// nifra-expect NF-C056: <reason>` above a call kept on purpose.',
    "Closing a modal route with Back shows the page kept under it as it was, and the route's loader is not called again for it, unless that page was loaded for a previous visitor or marked stale.",
  ],
}
