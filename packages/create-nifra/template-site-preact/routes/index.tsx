import type { ActionArgs, LoaderArgs, LoaderData } from "@nifrajs/client"
import type { backend } from "../backend"

export const meta = {
  title: "nifra site",
  meta: [{ name: "description", content: "A nifra + Preact SSR site, deployable to every runtime." }],
}

// Loader runs on the server (in-process during SSR). The action handles the form POST; after a
// client submit the loader revalidates with no full reload (progressive enhancement).
export async function loader({ api }: LoaderArgs<typeof backend>) {
  const res = await api.count.get()
  return { count: res.ok ? res.data.count : 0 }
}

export async function action({ api }: ActionArgs<typeof backend>) {
  await api.count.post()
  return { ok: true }
}

export default function Home(props: { data: LoaderData<typeof loader> }) {
  return (
    <>
      <section className="hero">
        <h1>
          Your nifra app,
          <br />
          <span className="grad">everywhere.</span>
        </h1>
        <p>
          SSR + hydration, end-to-end types, Preact. One source — deploy to Cloudflare Pages, Node,
          Deno, or Vercel Edge. Edit <code>routes/index.tsx</code> to begin.
        </p>
      </section>

      <div className="card">
        <div>
          <h3>Live full-stack loop</h3>
          <p>
            Count is rendered by a typed <code>loader</code>, incremented by an <code>action</code>,
            revalidated with no full reload.
          </p>
        </div>
        <form method="post" style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span className="count">{props.data.count}</span>
          <button className="btn" type="submit">
            increment →
          </button>
        </form>
      </div>
    </>
  )
}
