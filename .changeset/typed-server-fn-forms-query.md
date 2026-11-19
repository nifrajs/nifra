---
"@nifrajs/web": minor
"@nifrajs/web-react": minor
"@nifrajs/web-preact": minor
"@nifrajs/web-solid": minor
"@nifrajs/web-svelte": minor
"@nifrajs/web-vue": minor
---

Server functions, forms and the query cache no longer take a type on the caller's word. `serverFn` types its result as the `output` schema's output and requires what the function returns to fit the schema's input, so a field the schema drops is not in the type the browser gets; a function that returns data without an `output` schema, which the runtime already refused, is a compile error. A direct server call still returns what the function returned, and a redirect or an error `Response` may be returned with or without a schema. `formFor<typeof backend>()(path, method?)` replaces `formFor<App, Path>()`: the path is inferred from the argument, the method must be one the route declares (a route with no POST handler needs its method named), and the handle carries the route's own `action` and `method`. A path with params takes them, `formFor<typeof backend>()("/users/:id", { id })`, and `action` is the URL they fill. `queryKey<T>(key)` types a query key with its data: `getQueryData` and `setQueryData` take only such a key, and a `useQuery` / `createQuery` given one must have a fetcher of that type. A plain key still takes the type of its fetcher, with or without the data type named, and `queryKey<Todo[]>(["todos"])` stays an array.
