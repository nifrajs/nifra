<!--
  Home route (Vue SFC). The plain <script> carries nifra's route convention — loader/action/meta are
  server-only named exports the client codegen tree-shakes out. <script setup> + <template> are the
  component. The form POST is the SSR action path; after a client submit the loader revalidates with
  no full reload (progressive enhancement). Compiled by @nifrajs/web-vue/plugin.
-->
<script lang="ts">
import type { ActionArgs, LoaderArgs } from "@nifrajs/client"
import type { backend } from "../backend"

export const meta = {
  title: "nifra site",
  meta: [{ name: "description", content: "A nifra + Vue SSR site, deployable to every runtime." }],
}

// Loader runs on the server (in-process during SSR). The action handles the form POST.
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.data?.count ?? 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post()
  return { ok: true }
}
</script>

<script setup lang="ts">
// compose() spreads data/actionData/pending/submission as props — declare them so they aren't attrs.
defineProps(["data", "actionData", "pending", "submission"])
</script>

<template>
  <div>
    <section class="hero">
      <h1>Your nifra app,<br /><span class="grad">everywhere.</span></h1>
      <p>
        SSR + hydration, end-to-end types, Vue. One source — deploy to Cloudflare Pages, Node, Deno,
        or Vercel Edge. Edit <code>routes/index.vue</code> to begin.
      </p>
    </section>
    <div class="card">
      <div>
        <h3>Live full-stack loop</h3>
        <p>
          Count is rendered by a typed <code>loader</code>, incremented by an <code>action</code>,
          revalidated with no full reload.
        </p>
      </div>
      <form method="post" style="display: flex; align-items: center; gap: 16px">
        <span class="count">{{ data.count }}</span>
        <button class="btn" type="submit">increment →</button>
      </form>
    </div>
  </div>
</template>
