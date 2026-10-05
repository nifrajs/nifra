import type { Route } from "./+types/index"

export const meta = {
  title: "nifra + ISR",
  meta: [{ name: "description", content: "Incremental Static Regeneration on nifra." }],
}

export default function Home(props: Route.ComponentProps) {
  return (
    <section>
      <p>
        server renders: <b>{props.data.renders}</b>
      </p>
      <p>
        Reload within {props.data.revalidate}s and this holds - you're served the cached page
        (response header <code>x-nifra-isr: hit</code>). After the window, the next request gets the
        stale page instantly (<code>stale</code>) while a fresh copy regenerates behind it. Edit{" "}
        <code>routes/index.tsx</code> to begin.
      </p>
    </section>
  )
}
