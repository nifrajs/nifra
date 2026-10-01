import { defer } from "@nifrajs/web"

// The loader DEFERS slow data: the shell (the <h1> + the fallback) renders immediately, then `feed`
// streams in behind <Await> and hydrates without a client re-fetch. The 400ms delay stands in for
// a slow upstream call; on a client navigation the value is awaited and arrives resolved.
export function loader() {
  return {
    feed: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("streamed in after 400ms"), 400)),
    ),
    // NESTED defer - inside an array → object. `defer()` works at any depth, not just top-level keys:
    // each marker streams + hydrates independently behind its own <Await>.
    panels: [
      {
        id: "metrics",
        chart: defer(
          new Promise<number[]>((resolve) => setTimeout(() => resolve([3, 1, 4, 1, 5]), 250)),
        ),
      },
    ],
  }
}
