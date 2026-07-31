---
"@nifrajs/web": minor
"@nifrajs/web-react": patch
"@nifrajs/web-preact": patch
"@nifrajs/web-solid": patch
"@nifrajs/web-svelte": patch
"@nifrajs/web-vue": patch
---

A server function has one type per half, so both the server call and the hook argument are honest.

```ts
export type ClientServerFn<Input, Output> = (input: Input) => MaybePromise<Output>
export type ServerFnReference<Input, Output> = ServerFn<Input, Output> | ClientServerFn<Input, Output>
```

One type could not describe both halves. `ServerFn` is the SERVER declaration and takes `(input,
context)`; the client imports a generated stub that takes one argument. Widening the single type so a
one-argument call compiled made a direct server call type-check while handing the declaration
`undefined` for a context its implementation requires - a runtime failure the compiler had just been
told to allow.

Now the two are separate and `useServerFn` accepts either through `ServerFnReference`, which is the
one place the two halves legitimately meet. Calling a declaration from your own server code needs the
context, and omitting it is a compile error again.
