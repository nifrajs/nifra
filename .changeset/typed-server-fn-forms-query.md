---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-vue": minor
---

Server functions, forms and the query cache no longer take a type on the caller's word. `serverFn` types its result as the `output` schema's output and requires what the function returns to fit the schema's input, so a field the schema drops is not in the type the browser gets; a function that returns data without an `output` schema, which the runtime already refused, is a compile error. `formFor<typeof backend>()(path, method?)` replaces `formFor<App, Path>()`: the path is inferred from the argument, the method must be one the route declares, and the handle carries the route's own `action` and `method`. `queryKey<T>(key)` types a query key with its data: `getQueryData` and `setQueryData` take only such a key, and a `useQuery` / `createQuery` given one must have a fetcher of that type; a plain key still takes the type of its fetcher.
