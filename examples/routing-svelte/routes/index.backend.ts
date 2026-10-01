import { defer } from "@nifrajs/web"

// SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). Proves
// the prerender pipeline is framework-agnostic - same opt-in flag, Svelte SSR output. `defer()` lives
// only in the action, so the prerendered GET is clean.
export const prerender = true

export async function loader({ api }) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }) {
  await api.count.post()
  // defer() in an ACTION: the mutation returns immediately; the slow receipt resolves into <Await>.
  return {
    ok: true,
    receipt: defer(new Promise((resolve) => setTimeout(() => resolve("receipt #1042"), 200))),
  }
}
