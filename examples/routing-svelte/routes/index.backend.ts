import { t } from "@nifrajs/schema"
import { defer } from "@nifrajs/web"
import type { Route } from "./+types/index"

// SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). Proves
// the prerender pipeline is framework-agnostic - same opt-in flag, Svelte SSR output. `defer()` lives
// only in the action, so the prerendered GET is clean.
export const prerender = true

export const loaderOutput = t.object({ count: t.number() })

export async function loader({ api }: Route.LoaderArgs) {
  const res = await api.count.get()
  return { count: res.ok ? res.data.count : 0 }
}

export const actionOutput = t.object({ ok: t.boolean(), receipt: t.deferred(t.string()) })

export async function action({ api }: Route.ActionArgs) {
  await api.count.post()
  // defer() in an ACTION: the mutation returns immediately; the slow receipt resolves into <Await>.
  return {
    ok: true,
    receipt: defer(new Promise((resolve) => setTimeout(() => resolve("receipt #1042"), 200))),
  }
}
