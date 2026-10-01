import { defer } from "@nifrajs/web"

// The loader DEFERS slow data: the shell (the <h1> + the fallback) renders immediately, then `feed`
// streams in behind <Await> and resolves on the client without a re-fetch. The 400ms delay stands
// in for a slow upstream call; on a client navigation the value is awaited and arrives resolved.
export function loader() {
  return {
    feed: defer(
      new Promise<string>((resolve) => setTimeout(() => resolve("streamed in after 400ms"), 400)),
    ),
  }
}
