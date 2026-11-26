/** The app every nifra Node row serves, whichever server is under it. */
import { responseObserver } from "../../packages/core/dist/response-observer.js"
import { makeNifraApp } from "./_nifra-app.ts"

// djb2 over the serialized body - deliberately cheap; the workload prices the middleware TIER (how
// the bytes reach the hook), not the hash itself.
function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}

/** The shared app, with the body-hash middleware when `body` is set. */
export function makeNifraNodeApp(body: boolean): ReturnType<typeof makeNifraApp> {
  const app = makeNifraApp()
  if (body) {
    app.use(responseObserver()).onResponseBody(
      (body, headers) => {
        headers.set(
          "x-body-hash",
          hash(typeof body === "string" ? body : new TextDecoder().decode(body)),
        )
        return undefined
      },
      (body, res) => {
        res.headers ??= {}
        res.headers["x-body-hash"] =
          typeof body === "string" ? hash(body) : hash(new TextDecoder().decode(body))
        return undefined
      },
    )
  }
  return app
}
