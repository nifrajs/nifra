---
"@nifrajs/web": minor
---

The zone rules now cover files a client build copies or inlines without importing them:

- New `viteAssetUrlGuard()` in `@nifrajs/web/plugins/vite-leak-guard`, which the Vite client build installs. It fails the build when a `new URL("...", import.meta.url)` in browser code names backend code, a route's backend half, a server function's source, or a file in no zone. It applies whatever the file's size, a `?inline` query, or a comment inside the call. Such a file is also never inlined from a stylesheet `url()`, so the output accounting names it.
- An asset emitted from a `*.fn.*` file is refused: a server function reaches the browser only as its call stub.
- A `.fn` file that is not a script module (`report.fn.vue`, `post.fn.mdx`) is a zone error that asks for a rename. Previously it was treated as a server function whose source the browser build would ship unchanged.
