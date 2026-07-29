---
"@nifrajs/web": patch
---

`ServerFn`'s `context` parameter is optional, so the calls the docs teach actually compile.

`ServerFn` described the SERVER value, `(input, context)`. But the client imports a generated stub that
takes one argument, and `useServerFn` accepts `(input) => …` - so both documented calls were a
TypeScript error while the docs said otherwise:

```ts
await addTodo({ text })   // TS2554: Expected 2 arguments, but got 1
useServerFn(addTodo)      // TS2345: not assignable to (input) => …
```

One type has to describe both halves, so `context` is now optional. The server half always supplies it
(the mount passes `c`), and the declaration you write in `serverFn` still receives it as a required,
fully typed parameter. A `*.test-d.ts` covers both call shapes.
