import type { Route } from "./+types/index"

export const meta = {
  title: "nifra site",
  meta: [{ name: "description", content: "A nifra + React SSR site, deployable to every runtime." }],
}

export default function Home(props: Route.ComponentProps) {
  return (
    <>
      <section className="hero">
        <h1>
          Your nifra app,
          <br />
          <span className="grad">everywhere.</span>
        </h1>
        <p>
          SSR + hydration, end-to-end types, React. One source - deploy to Cloudflare Pages, Node,
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
