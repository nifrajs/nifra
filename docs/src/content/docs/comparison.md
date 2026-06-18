---
title: nifra vs. other frameworks
description: An honest comparison of nifra with the full-stack frameworks (Next.js, Nuxt, SvelteKit, Remix / React Router, TanStack Start) — and, as a standalone backend, with Hono and Elysia. What's the same, what's different, and where nifra draws the line.
---

nifra is a **full-stack framework first** — five UI libraries and five runtimes from one core, with loaders,
actions, streaming, and a typed data layer — and a **standalone typed backend** you can use on its own. This
page shows the feature map directly. nifra is young (alpha); Next.js, Nuxt, and SvelteKit are mature,
battle-tested, and backed by large ecosystems. Pick the tool that fits your stack and deployment target.

## nifra's lane

Every other full-stack framework on this page is **one UI library on a primarily-one-runtime story**.
nifra's bet is the opposite axis:

- **Five UI frameworks** from one core — React, Preact, Vue, Solid, Svelte — sharing the same router,
  loaders, actions, streaming, and data layer.
- **Five runtimes** from one `app.fetch` — Bun, Node, Deno, Cloudflare Workers, and edge (Vercel Edge /
  Deno Deploy) — because the handler is a Web-standard `Request → Response`.
- **A contract-first typed backend** in the same project: typed routes, schema validation, OpenAPI, and an
  end-to-end-typed RPC client (Eden/tRPC-style) — not a separate library you bolt on.

If you want to stay on one framework and one platform, the incumbents are excellent and more mature. If you
want framework/runtime freedom and a typed backend in one place, that's the gap nifra fills.

## Feature matrix

| | nifra | Next.js (App Router) | Nuxt 3 | SvelteKit | Remix / RR7 | TanStack Start |
|---|---|---|---|---|---|---|
| UI frameworks | **React · Preact · Vue · Solid · Svelte** | React | Vue | Svelte | React | React (Solid WIP) |
| Runtimes | **Bun · Node · Deno · Workers · Edge** | Node · Edge | Nitro (many) | adapters | adapters | Nitro |
| File routing (dynamic/catch-all/groups/optional) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Nested layouts | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| SSR · SSG · ISR | ✅ | ✅ | ✅ | ✅ (adapter) | partial | partial |
| Streaming SSR + Suspense | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Loaders + actions + progressive-enhancement forms | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Deferred/streaming data (`defer` / `<Await>`) | ✅ | ✅ | partial | partial | ✅ | ✅ |
| Query cache · optimistic UI · concurrent fetchers | ✅ | partial | ✅ | partial | ✅ | ✅ |
| Head/meta · prefetch · scroll restoration | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Content collections + MDX · fonts · draft mode | ✅ | partial | ✅ | community | community | community |
| First-party auth · i18n · image · uploads | ✅ | partial | modules | community | community | community |
| Typed RPC client + OpenAPI | ✅ | ❌ | ❌ | ❌ | ❌ | partial |
| WebSockets + pub/sub | ✅ | ❌ | partial | ❌ | ❌ | ❌ |
| **React Server Components** | **❌ (by design)** | ✅ | exp. | ❌ | ❌ | ❌ |
| Mature ecosystem · DevTools · community | ❌ (new) | ✅✅ | ✅ | ✅ | ✅ | growing |

nifra's data model (loaders, actions, `defer`/`<Await>`, progressive enhancement, fetchers, revalidation) is
closest to **Remix / React Router** — delivered across five UI libraries instead of one.

## The line nifra draws: no React Server Components

nifra is classic **SSR + hydration** (with streaming and islands-style boundaries), not RSC. There is no
`"use server"` / `"use client"`, no server-only zero-JS component tree, no inline server functions. This is
the headline thing **Next.js App Router** has that nifra doesn't — and it's a deliberate choice: RSC is
React-specific and would break a framework-agnostic core that also serves Vue, Solid, and Svelte. (Note that
Nuxt, SvelteKit, and Remix don't ship RSC either — this is really *nifra vs. Next App Router specifically*.)

nifra's answer to the same problems RSC solves: typed **loaders** keep data-fetching on the server, `defer()`
streams slow data without blocking the shell, and the route-level code-splitting only ships the JS a route
needs. Different mechanism, overlapping outcomes — but if RSC is a hard requirement, Next is the tool.

## Also a standalone backend (vs. Hono / Elysia)

nifra's core is a Bun-native, Web-standard server — so if you only want an API, it stands on its own against
the backend microframeworks, and graduates to full-stack later without a rewrite.

- **Throughput — the realistic case.** Router micro-benchmarks flatter Hono (a single compiled regex), but a
  router is **~1% of a real request** — the time goes to middleware, validation, context, and serialization.
  In the bare Bun HTTP matrix, nifra sits close to raw Bun and behind Elysia on most GET rows; in the current
  realistic preview (security headers + CORS + bearer auth + cookies + validated query/body + a ~3 KB JSON
  response, measured with `oha`), it edges Elysia. Treat benchmark rows as same-run evidence, not a permanent
  law of nature. Run it yourself: `bun run bench:realworld` and `bun run bench:http:compare`.
- **End-to-end types.** `client<typeof app>()` derives request inputs *and* `res.data` from the backend's
  route contracts — the compiler catches any frontend/backend drift, and a declared `response` schema locks
  the output shape. Hono's `hc` and Elysia's Eden give a typed RPC client too, but both are backend-only — no
  full-stack page/loader story.
- **Validation + OpenAPI.** nifra accepts any Standard Schema and ships `t` (TypeBox — free JSON Schema),
  emitting a real 3.1 doc with field-level request/response schemas (+ Scalar UI). Elysia and Hono have
  comparable OpenAPI; Next has none built in.
- **Batteries.** `@nifrajs/better-auth` + session guards, `@nifrajs/otel` (W3C `traceparent`, OTel semantic
  conventions), and `create-nifra` scaffolding (framework × deploy × CI × DB × auth, with an `AGENTS.md`).

## The AI-agent toolchain — nifra-only

No competitor — full-stack or backend — ships this. Every nifra app is built to be edited by AI agents
accurately:

- `nifra mcp` — an MCP server exposing `nifra_context` (the project's typed surface), `nifra_example`
  (snippets typechecked against the installed version — no hallucinated APIs), `nifra_scaffold`
  (URL → correct `routes/` file), `nifra_run` (verify via HTTP), and `nifra_check` (a drift gate that returns
  the fix).
- `llms.txt` + `llms-full.txt` served at the site root, an `AGENTS.md` in every scaffold, and a docs corpus
  that can't drift from the code.

## What nifra doesn't mirror

The conveniences an earlier draft of this page listed as "unshipped" now ship: **content collections + MDX**
(`@nifrajs/content`), **font optimization** (self-host + Google, with an SSRF guard), **draft / preview mode**,
and **`sitemap.xml` / `robots.txt`** generation. What remains deliberately out of scope is **Next App Router
specifics**:

- **Parallel / intercepting routes** (`@slot` / `(.)`) — nifra has route groups, catch-all, and optional
  segments, but not these.
- **A multi-layer framework cache** and **Partial Prerendering (PPR)** — nifra has no current plans to mirror
  them; the `defer()` + query-cache + ISR primitives cover most of the need.

## When to choose what

**Choose nifra if** you want one framework across React/Vue/Solid/Svelte/Preact; you deploy to Bun, the edge,
Deno, or Node and want that portability for free; you want a typed backend + RPC client in the same repo
without standing up tRPC separately; or you build with AI agents — and you're comfortable on a young
framework.

**Choose Next.js if** you want React Server Components, the deepest caching model, the largest ecosystem, and
first-class Vercel integration — and you're happy on React only.

**Choose Nuxt if** you're all-in on Vue and want its modules ecosystem, DevTools, and the mature Nitro
deployment story (Nuxt's multi-runtime deploy is the closest thing to nifra's portability).

**Choose SvelteKit if** you're Svelte-only and want a lean, well-supported framework with platform adapters.

**Choose Remix / React Router 7 if** you love the loader/action/progressive-enhancement model on React with a
mature, stable foundation. (nifra's data layer will feel familiar — that's where it took inspiration.)

**Choose TanStack Start if** you want maximum end-to-end React type-safety and the TanStack ecosystem, and
you're comfortable on a newer framework.

**Just want a backend?** Reach for **Hono** for a pure edge API on Cloudflare Workers, or **Elysia** for a
Bun-only backend chasing maximum bare-route throughput — though on a realistic API nifra matches or beats
both, and it graduates to full-stack without a rewrite if you later need pages.

The honest summary: nifra isn't trying to out-feature Next.js on Next's own turf. It's a different bet —
cross-framework, cross-runtime, contract-first, agent-native — and on *that* axis no incumbent competes. What
stands between nifra and the incumbents is ecosystem maturity and adoption, not core capability.
