---
"@nifrajs/core": minor
"@nifrajs/client": patch
"@nifrajs/cli": patch
"@nifrajs/web": patch
---

fix(client): a segment that is part literal, part param is callable through the typed client

A route such as `/files/:name.json`, `/post-:id` or `/v:major.:minor` could not be reached through
the typed client: `:name.json` was typed as a param named `name.json` whose call sent the value
without `.json`, and `post-:id` was typed as a property that sent the pattern text itself. Such a
segment is now a call with the segment as the request carries it:

```ts
await api.files("report.json").get() // GET /files/:name.json, c.params.name === "report"
await api("post-42").get()           // GET /post-:id
await api("v1.2").get()              // GET /v:major.:minor
```

- The argument is typed as the segment's literal text around any string (`` `${string}.json` ``), so
  `api.files("report.txt")` does not compile. A constraint is not part of the text:
  `/img/:id{[0-9]+}.png` takes `` `${string}.png` ``, and the server decides whether the value fits.
- The value is sent as one encoded segment, as a param value is: a `/` in it never adds a path level.
- A static segment at the same position keeps its exact text (`api.files("index.json")` is
  `/files/index.json` when that route exists, which is the route the server picks), and a
  whole-segment param keeps its call by name (`api.files({ id })`).
- Two such segments at one position that accept the same text resolve to the types of the one
  registered first.
- `@nifrajs/core` exports `RequestPath<Path>`, the same reading for a whole path:
  `RequestPath<"/files/:name.json">` is `` `/files/${string}.json` ``, a constraint reads as
  `${string}`, and a path ending in optional params is one template per form.
- The cli's route listings and the generated `llms.txt` print the call the same way
  (``api.files(`${name}.json`)``), and print an unnamed wildcard as `({ "*": rest })`.
