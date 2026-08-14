# @nifrajs/mock

## 2.14.0

### Patch Changes

- Updated dependencies [701961a]
- Updated dependencies [62133bf]
- Updated dependencies [8dffdf4]
  - @nifrajs/core@2.14.0

## 2.13.0

### Patch Changes

- Updated dependencies [e0b2dd6]
- Updated dependencies [7535ce1]
- Updated dependencies [1704308]
  - @nifrajs/core@2.13.0

## 2.12.1

### Patch Changes

- Updated dependencies [fba30c7]
  - @nifrajs/core@2.12.1

## 2.12.0

### Patch Changes

- Updated dependencies [df100d3]
- Updated dependencies [0efacea]
- Updated dependencies [cd1732c]
- Updated dependencies [df100d3]
- Updated dependencies [9a9346e]
- Updated dependencies [b5f47c0]
- Updated dependencies [fc33c0f]
- Updated dependencies [c4e8bb0]
- Updated dependencies [11d1658]
- Updated dependencies [5f71c23]
- Updated dependencies [3788b36]
- Updated dependencies [ae5338f]
- Updated dependencies [8847825]
- Updated dependencies [9a9346e]
- Updated dependencies [5e4e31a]
- Updated dependencies [9a9346e]
- Updated dependencies [b045f9e]
- Updated dependencies [9a9346e]
- Updated dependencies [9a9346e]
- Updated dependencies [dbc0b79]
- Updated dependencies [bd5c624]
- Updated dependencies [a5d3f5b]
- Updated dependencies [00819c5]
- Updated dependencies [e2bdd4a]
- Updated dependencies [e2d1939]
- Updated dependencies [e83e6eb]
- Updated dependencies [f8b0097]
  - @nifrajs/core@2.12.0

## 2.11.0

### Patch Changes

- @nifrajs/core@2.11.0

## 2.10.0

### Patch Changes

- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
- Updated dependencies [15bffdd]
  - @nifrajs/core@2.10.0

## 2.9.1

### Patch Changes

- Updated dependencies [01e36fb]
  - @nifrajs/core@2.9.1

## 2.9.0

### Patch Changes

- Updated dependencies [e05e56d]
  - @nifrajs/core@2.9.0

## 2.8.2

### Patch Changes

- Updated dependencies [f7d68e8]
  - @nifrajs/core@2.8.2

## 2.8.1

### Patch Changes

- Updated dependencies [78d66a4]
- Updated dependencies [93fdc89]
  - @nifrajs/core@2.8.1

## 2.8.0

### Patch Changes

- @nifrajs/core@2.8.0

## 2.7.1

### Patch Changes

- Updated dependencies [52c89e0]
  - @nifrajs/core@2.7.1

## 2.7.0

### Patch Changes

- @nifrajs/core@2.7.0

## 2.6.1

### Patch Changes

- Updated dependencies [5840c98]
  - @nifrajs/core@2.6.1

## 2.6.0

### Patch Changes

- Updated dependencies [e6349e5]
  - @nifrajs/core@2.6.0

## 2.5.0

### Minor Changes

- 31ccc27: The adversarial laboratory and the mock server now recognize zod automatically - no wiring. Every Standard Schema carries a `"~standard".vendor` tag, so when a body/query/response validator says "zod" and zod (4+) is installed, the new `autoReflectJsonSchema` default (exported from `@nifrajs/mock`) converts it via `z.toJSONSchema` exactly as the `@nifrajs/testing/zod` bridge does. Out of the box, zod routes now get synthesized witnesses and constraint-driven mutations in `runAdversarialContract`/`assertAdversarialContract` instead of NO_WITNESS, and `createMockServer` returns real data instead of `{}`. zod stays an optional peer, loaded lazily and probed once; a project without zod (or with a schema zod cannot convert) keeps today's opaque behavior. An explicit `reflectJsonSchema` hook always overrides the default - pass `() => undefined` to force everything opaque.
- da7f2d5: `generateMockValue` now honors authored `examples` and `default` before synthesizing (`const` still wins). This is the escalation layer for constraints a generator cannot invert: an arbitrary `pattern` regex, or a refinement that never reaches the JSON Schema at all (zod `.refine()`). Annotate once, next to the constraint - zod: `.meta({ examples: ["AB-1234"] })`; TypeBox/raw JSON Schema: the `examples` or `default` keyword - and every consumer uses it: the adversarial laboratory's witness synthesis (closing NO_WITNESS on uninvertible regex leaves and INVALID_WITNESS on refinements, since the witness is still proven against the real validator) and the mock server's responses. The first example is used, deterministically; without an example, behavior is unchanged (uninvertible patterns still fail closed).

### Patch Changes

- @nifrajs/core@2.5.0

## 2.4.0

### Minor Changes

- 06f4aaa: Contract tooling works out of the box for validators that expose no JSON Schema (zod, valibot, arktype).

  `runAdversarialContract` / `assertAdversarialContract` and `createMockServer` accept a `reflectJsonSchema` hook that derives an inspectable JSON Schema from an opaque Standard Schema validator. With it, zod routes get synthesized witnesses and constraint-driven mutations (min/max, length, pattern, enum, format) instead of a `NO_WITNESS` gap, and mocked responses carry real data instead of `{}`. A ready-made zod bridge ships as `@nifrajs/testing/zod` (`zodJsonSchema`); `zod` is an optional peer, so only projects that import that subpath need it installed. The adversarial report also gains an `advisories` list that flags when `validateResponses` is on but no route declares a `response` schema, making silently-zero response coverage visible.

### Patch Changes

- Updated dependencies [138bfba]
  - @nifrajs/core@2.4.0

## 2.3.0

### Patch Changes

- Updated dependencies [6f5b3ad]
- Updated dependencies [85b354d]
- Updated dependencies [8514caa]
- Updated dependencies [ea0a27f]
- Updated dependencies [ea0a27f]
- Updated dependencies [b271164]
- Updated dependencies [8c77d47]
- Updated dependencies [ea0a27f]
- Updated dependencies [5fe332a]
- Updated dependencies [d2840ac]
  - @nifrajs/core@2.3.0

## 2.2.0

### Patch Changes

- Updated dependencies [5f460db]
- Updated dependencies [e713cab]
- Updated dependencies [a4645e2]
- Updated dependencies [6aa0aac]
  - @nifrajs/core@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [bd294bb]
- Updated dependencies [d3aac63]
  - @nifrajs/core@2.1.0

## 2.0.0

### Patch Changes

- Updated dependencies [a7b1d60]
- Updated dependencies [eaac3d7]
- Updated dependencies [ade0c7a]
- Updated dependencies [82676e0]
- Updated dependencies [1522d06]
- Updated dependencies [a7b1d60]
- Updated dependencies [a7b1d60]
  - @nifrajs/core@2.0.0

## 1.13.0

### Minor Changes

- 5b6127a: Make route batches atomic, seal server configuration after `listen()`, encode array query values as
  repeated keys, and align web route matching with the server.

  Three behavior changes to know about:

  - **Configuring a server after `listen()` now throws** instead of reaching some traffic and not the
    rest. Bun's native route table is compiled when you listen, so a hook added afterwards applied to
    `app.fetch()` but not to real HTTP requests: an `onRequest` guard installed late was silently
    skipped on the wire. Register routes, hooks, plugins, and context before listening.
  - **Array query values serialize as repeated keys** (`?tag=a&tag=b`), not `?tag=a%2Cb`, so a route
    whose `query` schema declares an array now receives one.
  - **The web matcher applies the server's trailing-slash rule.** `/users/7/` no longer matches
    `/users/:id` in the browser, matching the 404 the server already returns, and a malformed percent
    encoding reports no route instead of throwing.

  A route batch from `implement()` or `merge()` commits only once every route in it validates, so a
  collision partway through leaves matching and reflection untouched instead of stranding the routes
  registered before it.

  Each route now owns one immutable compiled execution plan shared by portable, Node-direct, and
  Bun-native dispatch. This also fixes validation recovery being skipped when a derive moved a route
  from a specialized lane to the generic lifecycle.

  Core, browser navigation, Bun-native parameter metadata, and mock routing now consume the same
  compiled pattern kernel. Static routes beat parameters and parameters beat wildcards regardless of
  manifest order, with one grammar, trailing-slash policy, and malformed-encoding rule.

### Patch Changes

- Updated dependencies [aae8614]
- Updated dependencies [5b6127a]
  - @nifrajs/core@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [63d3845]
- Updated dependencies [246f498]
  - @nifrajs/core@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [2dde7e5]
- Updated dependencies [279f80c]
- Updated dependencies [5638ada]
- Updated dependencies [279f80c]
  - @nifrajs/core@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [92181be]
- Updated dependencies [3773f0a]
- Updated dependencies [92181be]
  - @nifrajs/core@1.10.0

## 1.9.1

### Patch Changes

- @nifrajs/core@1.9.1

## 1.9.0

### Patch Changes

- Updated dependencies [03cd76f]
- Updated dependencies [03cd76f]
  - @nifrajs/core@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [e47c4c5]
  - @nifrajs/core@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [bd95181]
  - @nifrajs/core@1.7.0

## 1.6.0

### Patch Changes

- @nifrajs/core@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [1ac2fde]
- Updated dependencies [bd3433f]
- Updated dependencies [70aa836]
  - @nifrajs/core@1.5.0

## 1.4.0

### Minor Changes

- 4d25970: Add one fail-open request-observation lifecycle shared by tracing, agent telemetry, and DevTools; secured development tooling; contract-based mock responses; validator-neutral schema/route reflection; executable render and storage adapter conformance modules; optional storage pagination/signing/copy capabilities; and metadata-preserving local file storage.

### Patch Changes

- Updated dependencies [4d25970]
  - @nifrajs/core@1.4.0
