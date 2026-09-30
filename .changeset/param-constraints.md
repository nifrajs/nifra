---
"@nifrajs/core": minor
"@nifrajs/edge": minor
"@nifrajs/schema": minor
"@nifrajs/client": minor
"@nifrajs/cli": minor
"@nifrajs/testing": minor
"@nifrajs/web": minor
---

feat(core): a path param can say which values it accepts, written in braces after the name. A
request whose value does not fit is not served by that route:

```ts
app
  // /users/me is its own route; /users/42 is this one; /users/ada is a 404
  .get("/users/me", () => ({ me: true }))
  .get("/users/:id{[0-9]+}", (c) => ({ id: Number(c.params.id) }))
  // a list of values, and a count
  .get("/img/:size{thumb|full}/:file", (c) => ({ size: c.params.size, file: c.params.file }))
  .get("/countries/:code{[A-Z]{2}}", (c) => ({ code: c.params.code }))
  // inside a segment, and optional at the end of a path
  .get("/files/:name.:ext{png|jpg}", (c) => ({ name: c.params.name, ext: c.params.ext }))
  .get("/posts/:page{[0-9]+}?", (c) => ({ page: c.params.page ?? "1" }))
```

- A constraint is one character class with an optional count (`[0-9]`, `[a-z0-9_-]+`, `\d{4}`,
  `\w{2,8}`), or a list of two or more values (`png|jpg|webp`). A class holds letters, digits, ranges
  of them, `\d`, `\w` and `. _ ~ ! $ & ' ( ) + , ; = @ -`; there is no negated class and a count
  starts at one. Anything else in braces (`:id{int}`, `:id{.+}`, `:id{[0-9]+|[a-z]+}`) is literal
  text, as before.
- The param stays a `string`, keyed by its bare name: `Params<"/users/:id{[0-9]+}">` is
  `{ id: string }`.
- The value is checked as it was sent, before percent-decoding. `/users/4%32` does not fit
  `:id{[0-9]+}`; a broader route beside it serves that request.
- The narrowest route answers, whatever the order of registration: literal text, then a list, then a
  class, then a bare `:param`, then a wildcard. Between two constraints of a kind, the one that
  accepts fewer values is tried first. A method the narrowest matching route does not have answers
  `405`, as it does for a literal route beside a param route.
- Two spellings of one constraint (`[0-9]+`, `\d+`, `[0-9]{1,}`) are one route: the same method
  registered on both throws `DUPLICATE_ROUTE`.
- Inside a segment the text around the params is placed first and each value is then checked; the
  router does not look for another split.
- `routePatternOverlap` takes constraints into account: `/users/me` and `/users/:id{[0-9]+}` do not
  overlap.
- `@nifrajs/core/pattern` exports `paramConstraint(text)`, which reads a constraint at the start of
  `text`, and the `ParamConstraint` type. A param part of a compiled mixed segment carries its
  constraint as `c`.

feat(edge): the compact server accepts the same constraints.

feat(schema): `toOpenAPI` writes a constrained param into the path template by its bare name
(`/users/{id}`). Its schema is `{ type: "string", pattern }` for a character class and
`{ type: "string", enum }` for a list of values; a declared `params` schema still takes precedence.

feat(client): a constrained param is passed by its bare name, `api.users({ id: "42" }).get()`. Two
param routes at one position (`/users/:id{[0-9]+}` beside `/users/:slug`, or a param beside a
wildcard) are each callable, picked by the name of the key. The client does not check a value
against its constraint.

feat(cli): `nifra check` accepts a supported constraint and keeps reporting other text in braces
(`NF-C026`); `NF-C024` and `NF-C025` follow the router's reading of a constraint. `nifra routes` and
the generated client calls print the bare name. `nifra scaffold` refuses a page path that carries a
constraint.

feat(testing): `runAdversarialContract` builds a request path whose values satisfy each param's
constraint, and fills a part-literal segment (`/files/:name.json`) param by param.

feat(web): a route file name that would read as a param constraint (`[id]{a|b}.tsx`) is refused at
build time with a message that names the file. `llms.txt` prints client calls with the bare name.
