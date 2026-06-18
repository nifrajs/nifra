# mdx-blog (Solid)

A nifra blog that combines **content collections**, an **MDX route**, and the **`<Content>`** helper —
on Solid (a compile-time framework, the trickiest MDX target).

- `content/posts/*.md` → a typed, schema-validated collection (`lib/content.ts`).
- `routes/index.tsx` — lists posts from `posts.all()` in a loader (server-only via dynamic `import()`).
- `routes/blog/[slug].tsx` — loads one post and renders its HTML with `<Content html={post.html} />`.
- `routes/about.mdx` — a page authored in MDX, compiled to a Solid component by `solidMdxBunPlugin`.

```sh
bun run examples/mdx-blog/build.ts
bun --preload examples/mdx-blog/ssr-preload.ts examples/mdx-blog/server.ts
# → http://localhost:3000  (/, /blog/hello-nifra, /about)
```

The same `.mdx` + collections + `<Content>` work identically on React, Preact, Vue, and Svelte. For a
Cloudflare Workers deploy (no request-time `fs`), bake the collection at build with
`bakeCollection(posts)` and read it at the edge with `fromBaked`.
