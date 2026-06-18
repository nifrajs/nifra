import type { ActionArgs, ActionData, LoaderArgs, LoaderData } from "@nifrajs/client"
import { defer } from "@nifrajs/web"
import { Await } from "@nifrajs/web-vue/await"
import { defineComponent, h } from "vue"
import type { backend } from "../backend"

// Static head for this route — SSR-injected + updated on client navigation.
export const meta = {
  title: "nifra + Vue — Home",
  meta: [{ name: "description", content: "nifra Vue bindings: loader + action + defer/Await" }],
}

// SSG: prerender this static route to dist/index.html at build (build.ts → prerenderRoutes). Proves
// the prerender pipeline is framework-agnostic — same opt-in flag, Vue render output. `defer()` lives
// only in the action, so the prerendered GET has no unresolved deferreds.
export const prerender = true

// Loader reads the count; the action increments it. After a client submit the loader REVALIDATES,
// so the count updates with no full reload (progressive enhancement with JS off).
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post()
  // defer() in an ACTION: the mutation (count++) returns immediately; the slow "receipt" resolves into
  // <Await> afterward (on a client submit) without blocking the count update.
  return {
    ok: true,
    receipt: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("receipt #1042"), 200)),
    ),
  }
}

export default defineComponent({
  name: "Home",
  // compose() passes data/actionData/pending/submission as props — declare them so they aren't attrs.
  props: {
    data: { required: true },
    actionData: { required: false, default: undefined },
    pending: { required: false, default: false },
    submission: { required: false, default: undefined },
  },
  setup(props) {
    return () => {
      const data = props.data as LoaderData<typeof loader>
      const actionData = props.actionData as ActionData<typeof action> | undefined
      return h("div", null, [
        h("h1", { id: "page" }, "Home"),
        h("p", { id: "count" }, `count: ${data.count}`),
        h("form", { method: "post" }, h("button", { id: "inc", type: "submit" }, "increment")),
        // After a submit, the action's deferred receipt resolves into <Await> (client-side on Vue).
        actionData
          ? h(
              Await,
              { resolve: actionData.receipt },
              {
                default: (receipt: string) => h("p", { id: "receipt" }, receipt),
                fallback: () => h("p", { id: "receipt-fallback" }, "receipt…"),
              },
            )
          : null,
      ])
    }
  },
})
