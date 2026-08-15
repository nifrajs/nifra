# @nifrajs/content

Typed, schema-validated content collections for nifra - Markdown + frontmatter, framework-agnostic.

Part of the **[nifra](https://nifra.dev)** full-stack TypeScript framework - one core, five UI libraries, every runtime. Scaffold a new app with `bun create nifra`.

## Install

```sh
bun add @nifrajs/content
```

## Docs

- Reference: <https://nifra.dev/docs>
- AI-readable: <https://nifra.dev/llms.txt>

## Typed indexes and joins

Build an equality lookup and deterministic query index from a baked collection. `where` is field
equality, `range` supports typed string/number comparisons, sorting is stable (slug is the tie-breaker),
and pages use an opaque cursor rather than an offset:

```ts
const posts = indexCollection(await bakeCollection(blog), {
  by: "section",
  sort: { field: "publishedAt", dir: "desc" },
})

const page = posts.query({ where: { section: "news" }, limit: 20 })
const next = page.nextCursor === undefined
  ? undefined
  : posts.query({ where: { section: "news" }, cursor: page.nextCursor, limit: 20 })
```

`posts.baked` is JSON-safe and can be serialized into an edge bundle; `fromBakedIndex` rehydrates it
without filesystem access. `joinCollections(left, right, "id")` gives one-to-many rows by default.
Pass `{ cardinality: "one-to-one" }` to require unique right-side keys; duplicate right keys fail the
build loudly. The join key must exist on both frontmatter types with the same TypeScript value type.
These APIs index only validated local/baked content; credentialed CMS ingestion and tenant data remain
outside this public package.

MIT

## For AI agents

Start with [`LLM.md`](./LLM.md) - this package's contract card (the exports you call + its footguns),
one cheap read instead of the whole corpus. For the wider framework: the repo's
[`AGENTS.md`](../../AGENTS.md) is the copy-paste quick reference, and
[`llms-full.txt`](../../llms-full.txt) is the full machine-readable corpus. Run `nifra check` as the
done-gate, or `nifra mcp` to give the agent live project tools.
