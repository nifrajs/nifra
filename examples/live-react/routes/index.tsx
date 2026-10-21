import { useQuery } from "@nifrajs/web-react/query"
import type { Route } from "./+types/index"

export const meta = {
  title: "nifra - live refresh demo",
  meta: [{ name: "description", content: "Pages that stay fresh on their own" }],
}

const CHOICES = ["bun", "deno", "node"] as const

async function lastVote(): Promise<{ at: number | null }> {
  const res = await fetch("/api/last-vote")
  return res.json()
}

function cast(choice: string): void {
  void fetch("/api/vote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ choice }),
  })
}

export default function Poll(props: Route.ComponentProps) {
  // Component data rather than route data: refetched on the same key the loader declares.
  const last = useQuery(["last-vote"], lastVote, { live: ["votes"] })
  const at = last.data?.at
  return (
    <section>
      <ul>
        {CHOICES.map((choice) => (
          <li key={choice}>
            <button type="button" onClick={() => cast(choice)}>
              {choice}
            </button>{" "}
            <span id={`count-${choice}`}>{props.data[choice]}</span>
          </li>
        ))}
      </ul>
      <p id="last-vote">
        {at === undefined || at === null
          ? "no votes yet"
          : `last vote at ${new Date(at).toISOString().slice(11, 19)} UTC`}
      </p>
      <p>Open this page in two tabs and vote in one: the other updates on its own.</p>
    </section>
  )
}
