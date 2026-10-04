---
"@nifrajs/cli": patch
---

`nifra check`'s typed-client rewrite for a simple own-API `fetch` appends a path segment the client reserves (`get`, `post`, `options`, `index`, `then` and the rest) with a call, as in `api.blog("post").get()`, so the suggested code reaches the route. Previously it suggested `api.blog.post.get()`, which the client cannot resolve.
