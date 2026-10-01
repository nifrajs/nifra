import type { ActionArgs, LoaderArgs } from "@nifrajs/client"
import type { backend } from "../backend/app"

// SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). Proves
// the prerender pipeline is framework-agnostic - same opt-in flag, Solid SSR output (with the SSR
// transform active at build). `defer()` lives only in the action, so the prerendered GET is clean.
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
  return { ok: true }
}
