import type { ActionArgs, LoaderArgs } from "@nifrajs/client"
import { defer } from "@nifrajs/web"
import type { backend } from "../backend/app"

// SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). The
// loader runs at build (bakes the initial count); the page is then live after hydration - the form
// POST + revalidation hit the worker (hybrid). `defer()` here lives only in the action (not the
// prerendered GET), so the static document has no unresolved deferreds.
export const prerender = true

// The full write-side loop, typed against the contract: the loader reads the count via the
// in-process api; the action increments it. After a client submit the loader REVALIDATES, so the
// count updates with no full reload. With JS off, the native POST re-renders the page with the
// fresh count (progressive enhancement).
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post()
  // defer() in an ACTION: the mutation (the count++) returns immediately; the slow "receipt" streams
  // into <Await> afterward (on a client submit) without blocking the count update.
  return {
    ok: true,
    receipt: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("receipt #1042"), 300)),
    ),
  }
}
