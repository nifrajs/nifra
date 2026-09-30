---
"@nifrajs/web": patch
---

fix(web): a client navigation that changes the query re-runs the layout loaders. A layout loader was
kept whenever the params its layout owns were unchanged, so one that reads `ctx.search` or the request
URL went on showing the previous query's data. Keys that no loader should see belong in the route's
`searchClientKeys`, which still skips the request entirely.

After an action that redirects, every layout loader of the target runs, the same as the revalidation
after an action that does not redirect. `submit(action, body, { revalidate: false })` keeps the layout
data an ordinary navigation would.
