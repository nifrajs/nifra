# Contributing to Nifra

Thank you for your interest in contributing to Nifra! We are building a modern, full-stack, type-safe framework designed specifically for AI agents and the humans who build them.

By participating in this project, you agree to abide by our Code of Conduct and Security Policy.

---

## Table of Contents

- [Monorepo Overview](#monorepo-overview)
- [Development Setup](#development-setup)
- [Development Workflow](#development-workflow)
- [Code Style & Linting](#code-style--linting)
- [Testing](#testing)
- [Changesets & Releases](#changesets--releases)
- [Authoring Custom Middleware & Plugins](#authoring-custom-middleware--plugins)
  - [Custom Middleware](#custom-middleware)
  - [Typed Plugins (`definePlugin`)](#typed-plugins-defineplugin)
  - [Identity Plugins (`defineIdentityPlugin`)](#identity-plugins-defineidentityplugin)

---

## Monorepo Overview

Nifra is developed as a monorepo using Bun workspaces. A map of the primary directories:

- **`packages/core`**: The core HTTP router, server runtime, and WebSocket adapter.
- **`packages/client`**: The zero-codegen, type-safe client that infers types from the server.
- **`packages/schema`**: The type builder (`t`) and OpenAPI generators.
- **`packages/middleware`**: Curated, zero-dependency middleware (CORS, rate limiting, security headers, etc.).
- **`packages/web`** + **`packages/web-react|vue|solid|svelte|preact|vanilla`**: The full-stack layer (SSR, routing, server functions, islands) and its per-framework adapters.
- **`packages/cli`**: The `nifra` CLI (`dev`, `build`, `check`, `assure`, `doctor`) and the Model Context Protocol (MCP) server.
- **`packages/create-nifra`**: Project scaffolding and its templates.
- **`packages/node`** / **`packages/deno`** / **`packages/workers`**: Runtime adapters.
- **`site/`**: The nifra.dev docs site - built with nifra itself.
- **`bench/`**: The benchmark harnesses behind every published number.
- **`examples/`**: Runnable demo projects.
- **`internal/test-utils`**: Shared test helpers (not published).

---

## Development Setup

Nifra is built for **Bun** and is **ESM-only**.

### 1. Prerequisites

Ensure you have Bun installed (version `>=1.3.0` is required):

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Install Dependencies

Clone the repository and install dependencies from the root:

```bash
bun install
```

### 3. Build the Monorepo

Build all the packages to compile TypeScript and generate distributions:

```bash
bun run build
```

---

## Development Workflow

### 1. Create a Branch

Always work on a descriptive branch:

```bash
git checkout -b feat/my-new-feature
# or
git checkout -b fix/issue-description
```

### 2. Running Verification

Before submitting a Pull Request, run the full verification check to ensure your changes compile, pass tests, and conform to linting:

```bash
bun run check
```

This runs lint checks, TypeScript checks across all tsconfigs, test suites, and documentation/API schema verifications.

Note: `api-reference.md`, per-package `LLM.md` cards, and the `llms.txt`/`llms-full.txt` corpora are generated. Do not edit them by hand - change the source and run `bun run gen:api && bun run gen:cards` (or `bun run build && bun run gen:llms` when exported types changed); CI rejects stale copies.

### 3. Where to Start

Issues labeled [`good first issue`](https://github.com/nifrajs/nifra/labels/good%20first%20issue) are scoped to be approachable without deep framework knowledge, and issues labeled [`help wanted`](https://github.com/nifrajs/nifra/labels/help%20wanted) are larger pieces we would love a hand with. Commenting on an issue before starting saves duplicated work.

---

## Code Style & Linting

Nifra uses [Biome](https://biomejs.dev/) for linting and formatting. 

- Run lint checks: `bun run lint`
- Auto-format your code: `bun run format`

Make sure your code has no Biome warnings before pushing.

---

## Testing

Nifra uses Bun's built-in test runner. Tests are defined under `test/` subdirectories inside each package.

- Run package tests: `bun run test`
- Run all tests (including slow/smoke tests): `bun run test:all`
- Run Deno-specific tests: `bun run test:deno`
- Check the published `@nifrajs/deno` tarball installs and imports under Deno: `bun run check:deno-tarball`

Write unit tests for any new features or bug fixes you contribute.

---

## Changesets & Releases

We use [Changesets](https://github.com/changesets/changesets) to track versioning and release notes. 

If your PR contains user-facing changes (features or fixes), you **must** generate a changeset:

```bash
bun run changeset
```

Follow the interactive prompt to select the affected packages, choose a semver bump type (patch, minor, or major), and provide a brief description of the change. Commit the generated markdown file under `.changeset/`.

Name **every** package whose source you changed, not just the one you think of as the headline. `bun run check:changesets` fails a commit that changed a package's `src/` without declaring it, because the release notes are the only place a consumer learns a package moved at all.

### A type that stops compiling is a `major`

**If code that compiled against the previous version no longer compiles against yours, the bump is `major`** - whether or not anything changed at runtime.

TypeScript types are part of the public API surface. A consumer running `bun update` inside a caret range gets the new types, and a build that used to pass now fails; that the runtime behaves identically is no consolation to a broken CI. "Purely additive at runtime" is not the test. The test is: **can a call site that compiled yesterday stop compiling today?**

Concretely, these are `major`, not `minor`:

- Narrowing an exported type, or making an optional property required.
- Rejecting a previously accepted spelling, even when a working alternative exists and the error message names it (a compile error is still a compile error).
- Reserving a name the consumer might already be using - which is what a growing reserved set does. `@nifrajs/client`'s reserved proxy keys are frozen for exactly this reason; see `packages/client/src/reserved.ts`.

If you are shipping one of these anyway, ship a **codemod with it**. Hand-editing every broken call site is toil the framework caused, and the framework is the thing that knows the mechanical fix. Register it in `packages/cli/src/fix-recipes.ts` and point the diagnostic's `fix.command` at it, so `nifra fix` performs the migration the release note describes.

---

## Authoring Custom Middleware & Plugins

Nifra can be extended using context-agnostic **Middlewares** or type-threaded **Plugins**. If you are contributing middleware/plugins to `@nifrajs/middleware` or building third-party integrations, follow these APIs.

### Custom Middleware

A middleware is a flat object containing optional lifecycle hooks. It is ideal for side-effects (e.g., setting headers, telemetry, basic auth) that do not need to inject new typed properties into the handler's context.

```ts
import type { Middleware } from "@nifrajs/core"

export function simpleLogger(): Middleware {
  return {
    name: "simple-logger", // Deduplicates duplicate registrations
    
    onRequest(req) {
      console.log(`--> ${req.method} ${req.url}`)
    },
    
    onResponse(res, req) {
      console.log(`<-- ${res.status} ${req.method} ${req.url}`)
      return res
    }
  }
}
```

Apply it using `.use()`:
```ts
const app = server().use(simpleLogger())
```

#### Middleware Hooks Reference:
- **`onRequest(req)`**: Runs before routing. Returning a `Response` aborts early.
- **`around(ctx, next)`**: Wraps the route execution.
- **`beforeHandle(ctx)`**: Runs before the handler. Returning a value other than `undefined` bypasses the handler.
- **`afterHandle(result, ctx)`**: Transforms the handler return value.
- **`onResponse(res, req)`**: Runs on all outgoing responses (including 404s/errors). Must return a `Response`.
- **`onError(err, ctx)`**: Catch and map thrown errors.

---

### Typed Plugins (`definePlugin`)

If your plugin needs to extend the request context (`c`) with new properties (e.g., a database helper, a parsed session) so they are fully typed in downstream handlers, wrap it with `definePlugin`.

`definePlugin` maps the server type to carry the new type signatures:

```ts
import { definePlugin } from "@nifrajs/core"

export function databasePlugin(dbInstance: any) {
  // Named "db" for idempotency
  return definePlugin("db", (app) =>
    app
      .decorate("db", dbInstance) // Static addition
      .derive((c) => ({
        // Dynamic per-request addition
        user: async () => await dbInstance.getUserFromHeaders(c.req.headers)
      }))
  )
}
```

#### Usage:
```ts
const app = server()
  .use(databasePlugin(db))
  .get("/me", async (c) => {
    // Both c.db and c.user are fully typed!
    const user = await c.user()
    return { user }
  })
```

---

### Identity Plugins (`defineIdentityPlugin`)

If your plugin registers hooks, mounts runtime handlers, or performs other side effects but **does not** change the caller's typed context or typed route registry, wrap it with `defineIdentityPlugin`.

This is the right helper for side-effect integrations such as audit headers or auth catch-all handlers. It preserves the caller's specific server type so downstream route inference and client APIs remain intact. If your plugin's own routes must appear in `client<typeof app>()`, expose a transforming plugin that returns the typed result of `app.get(...)`, `app.post(...)`, and so on.

```ts
import { defineIdentityPlugin } from "@nifrajs/core"

export const auditHeaders = defineIdentityPlugin("audit-headers", (app) => {
  return app.onResponse((res) => {
    res.headers.set("x-audit", "enabled")
    return res
  })
})
```

#### Usage:
```ts
const app = server()
  .use(auditHeaders)
  .get("/users/:id", (c) => ({ id: c.params.id })) // /users remains typed!
```
