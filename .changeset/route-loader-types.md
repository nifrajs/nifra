---
"@nifrajs/client": minor
"@nifrajs/web": minor
"@nifrajs/cli": minor
"create-nifra": minor
---

The generated `./+types/<name>` module declares `Route.Loader` and `Route.Action`. Annotate a
route's loader, `export const loader: Route.Loader = async ({ params, api }) => ...`, and what it
returns is checked against `loaderOutput` at compile time. A field of the wrong type, a `defer(...)`
whose value does not match its `t.deferred(...)` field, or any data from a loader with no
`loaderOutput` is a type error. A redirect, a `Response` and returning nothing stay allowed.
`Route.Action` does the same against `actionOutput`, `revalidate(paths, data)` included. A field the
schema does not declare is not a type error, because the output guard drops it.

`@nifrajs/client` exports the types behind them: `InputOf<Module, Name>` (what a route module's
output schema accepts), `RouteLoaderReturn<Module>` and `RouteActionReturn<Module>`.

`nifra scaffold` and the `create-nifra` starters write the annotation. `nifra schemas` reports a
generated schema over an annotated loader or action as unchecked (NF-C033 warns), because the
annotation, not the body, is then the function's return type.
