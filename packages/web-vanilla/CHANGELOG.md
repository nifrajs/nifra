# @nifrajs/web-vanilla

## 5.6.0

### Minor Changes

- db0bacd: A link or form can refresh one region of a vanilla page instead of loading the whole document. Mark the region `data-swap-slot="results"`, make `slot("results", content)` from `@nifrajs/web-vanilla` its only content, and add `data-swap="replace:results"` or `data-swap="append:results"` to the link or form:
  
  - `enableSwap(enhancers, { root })` from the new `@nifrajs/web/islands/swap` entry takes the place of `mountIslands`. It mounts the page's islands, and a `data-swap` link or form then makes its usual request with an `x-nifra-swap: <slot>` header and puts the answer in the slot. A page that does not import it pays nothing.
  - The server runs the page as usual and answers with that slot's HTML alone, `private, no-store` with `vary: x-nifra-swap`, echoing the header. A data request wins over a swap, and ISR never serves or stores a swap.
  - `replace` swaps the slot's content and, for a GET, pushes the URL; back and forward fetch the slots again. `append` adds to it, and a link or form inside the slot is removed when the next content arrives, so a "more" link gives way to the next page's own.
  - Islands in a slot mount with it and unmount when it is replaced. A loading slot carries `aria-busy="true"`, a newer swap of a slot cancels the older one, and a failed request sets `data-swap-error` on the link or form.
  - Any other answer, such as a redirect, another origin, a page without that slot or an error, loads the URL normally, as does a page whose Trusted Types policy refuses the HTML.
  
  A render adapter answers swaps through the new optional `renderSlot(chain, props, name)`. Only `@nifrajs/web-vanilla` implements it in this release.
- 8795369: `html` writes each interpolated value for the place it lands. An unquoted attribute value is quoted, so a space in it cannot start another attribute, and a `javascript:` or `vbscript:` URL that begins `href`, `src`, `action` or another URL attribute is written as `about:invalid`. A string or nested template now throws as a tag name, inside `<script>` or `<style>`, or in an `on*` handler or `srcdoc` value, where no escaping makes it safe; numbers, booleans and `raw()` still fill those places. An attribute name takes a plain name with no value, such as `checked`, or a suffix after `data-` or `aria-`. A nested template inside an attribute value is escaped as text. Rendering is no slower: each call site's positions are read once and cached.

### Patch Changes

- baaac3d: A swap answers only with a slot that survives in the final composed page, an append disposes the islands it removes, and swap requests bypass the browser cache. Links and GET forms swap; POST forms submit natively, so the browser applies the response's security policy and scripts. A swapped slot runs under the current page's Content-Security-Policy, which stays on the document response alone. Native action pages include their island entries.

## 5.5.1

No changes in this release.

## 5.5.0

No changes in this release.

## 5.4.0

No changes in this release.

## 5.3.0

No changes in this release.

## 5.2.1

No changes in this release.

## 5.2.0

### Patch Changes

- 9498cf8: The package ships its `CHANGELOG.md`, so the installed package has the notes for every version, as the GitHub release does. Before, the tarball held only the code, `README.md`, `LICENSE` and `package.json`.

## 5.1.0

No changes in this release.

## 5.0.0

### Patch Changes

- Updated dependencies [7169820]
- Updated dependencies [22e3df7]
- Updated dependencies [0aed425]
- Updated dependencies [7de0397]
- Updated dependencies [674c658]
- Updated dependencies [de27557]
- Updated dependencies [2173644]
- Updated dependencies [4d894b0]
- Updated dependencies [61901cd]
- Updated dependencies [5e366e2]
- Updated dependencies [2938a0d]
- Updated dependencies [dc8439c]
- Updated dependencies [b19cb37]
- Updated dependencies [4330e40]
- Updated dependencies [412a9ee]
- Updated dependencies [65883e5]
- Updated dependencies [0e20529]
- Updated dependencies [f7e36ec]
- Updated dependencies [262e46d]
- Updated dependencies [944623d]
- Updated dependencies [6d9869d]
- Updated dependencies [b9cc68c]
- Updated dependencies [de2cc1d]
- Updated dependencies [a5963cb]
- Updated dependencies [3db36b3]
- Updated dependencies [7775c2b]
- Updated dependencies [09c47c5]
- Updated dependencies [326caee]
- Updated dependencies [f8e0ed5]
- Updated dependencies [a588c18]
- Updated dependencies [1cdcfe5]
- Updated dependencies [e195fe8]
- Updated dependencies [7775c2b]
- Updated dependencies [d3e79c4]
- Updated dependencies [d922f65]
- Updated dependencies [a1eda0a]
- Updated dependencies [fc0284a]
- Updated dependencies [9f58295]
- Updated dependencies [2f7299a]
- Updated dependencies [29e62a0]
- Updated dependencies [c613e7d]
- Updated dependencies [5975163]
- Updated dependencies [7a165de]
- Updated dependencies [d8f11a5]
- Updated dependencies [e9e02cf]
- Updated dependencies [b70b18a]
- Updated dependencies [6f42b38]
- Updated dependencies [870227d]
- Updated dependencies [2fbb4f0]
- Updated dependencies [1d66252]
- Updated dependencies [a6a6834]
- Updated dependencies [166a6ff]
- Updated dependencies [79be5af]
- Updated dependencies [bf6eeb0]
- Updated dependencies [5a3c27a]
- Updated dependencies [15a3a66]
- Updated dependencies [9b971fc]
- Updated dependencies [2577fc7]
- Updated dependencies [9b1acc9]
- Updated dependencies [391ab3c]
- Updated dependencies [3bf7d6b]
- Updated dependencies [7775c2b]
- Updated dependencies [ab1935b]
  - @nifrajs/web@5.0.0

## 4.0.2

## 4.0.1

## 4.0.0

### Patch Changes

- Updated dependencies [22e2af8]
- Updated dependencies [963694f]
- Updated dependencies [86e2d0f]
- Updated dependencies [a0cfffa]
- Updated dependencies [93e5e7f]
- Updated dependencies [214d674]
- Updated dependencies [4936309]
- Updated dependencies [0e9b167]
- Updated dependencies [bbdc5a1]
- Updated dependencies [e8270d9]
- Updated dependencies [d942c33]
- Updated dependencies [ef28ef9]
- Updated dependencies [216fe27]
- Updated dependencies [8e30090]
- Updated dependencies [6d20355]
- Updated dependencies [08250bf]
- Updated dependencies [4b8d8de]
- Updated dependencies [ba5dd1c]
- Updated dependencies [d50f73e]
- Updated dependencies [8fa902c]
- Updated dependencies [085e852]
- Updated dependencies [0dac7ec]
- Updated dependencies [b64c3ee]
- Updated dependencies [dc2d4d3]
- Updated dependencies [81c720e]
- Updated dependencies [0150ed4]
- Updated dependencies [ae815ab]
- Updated dependencies [ea2ee87]
- Updated dependencies [3442e1c]
- Updated dependencies [85d636b]
- Updated dependencies [6c978a1]
- Updated dependencies [bfe29b6]
- Updated dependencies [8b99424]
- Updated dependencies [87783f0]
- Updated dependencies [135aba4]
- Updated dependencies [47b0d65]
- Updated dependencies [e32268d]
- Updated dependencies [432fec3]
- Updated dependencies [0e14068]
- Updated dependencies [8f1b780]
- Updated dependencies [dcc9ff6]
- Updated dependencies [5a63dd4]
- Updated dependencies [c49882f]
- Updated dependencies [dfd19d8]
- Updated dependencies [28e091f]
- Updated dependencies [046e79d]
- Updated dependencies [6393b1e]
- Updated dependencies [a158b74]
- Updated dependencies [ee19d29]
- Updated dependencies [293d3c8]
- Updated dependencies [7e1e1c3]
- Updated dependencies [0cd5f6e]
- Updated dependencies [2245bee]
- Updated dependencies [feeec4a]
- Updated dependencies [3eb6339]
- Updated dependencies [f784c32]
- Updated dependencies [e3b2b97]
- Updated dependencies [5934b5d]
- Updated dependencies [03a3729]
- Updated dependencies [bd11269]
- Updated dependencies [579d9a9]
- Updated dependencies [3554ad8]
- Updated dependencies [64e7a42]
- Updated dependencies [ee19d29]
- Updated dependencies [d6f806f]
- Updated dependencies [38cf032]
- Updated dependencies [b94e5cb]
- Updated dependencies [0f6babe]
- Updated dependencies [00f18bf]
- Updated dependencies [a84f546]
- Updated dependencies [669b6a2]
  - @nifrajs/web@4.0.0

## 3.5.0

## 3.4.0

## 3.3.0

## 3.2.0

## 3.1.0

## 3.0.0

### Patch Changes

- Updated dependencies [6e43c15]
- Updated dependencies [293a7fe]
- Updated dependencies [485ae60]
- Updated dependencies [627b0ba]
- Updated dependencies [004deee]
- Updated dependencies [f0fd370]
- Updated dependencies [36801ae]
  - @nifrajs/web@3.0.0

## 2.14.1

## 2.14.0

## 2.13.0

## 2.12.1

## 2.12.0

## 2.11.0

## 2.10.0

## 2.9.1

## 2.9.0

## 2.8.2

## 2.8.1

## 2.8.0

## 2.7.1

## 2.7.0

## 2.6.1

## 2.6.0

## 2.5.0

## 2.4.0

## 2.3.0

## 2.2.0

### Minor Changes

- 1394641: Layout loaders: request data in the component that wraps every page.

  `routes/_layout.tsx` rendered, but a `loader` it exported never ran, so nothing request-derived could
  reach a layout - host, session, locale, feature flags, tenant. An app hit this and moved its host guard
  out of the component tree into the server entry, where it could not be typechecked with the rest of the
  app. That is the real cost: the gap pushed security-relevant code to the one place nifra's typed-boundary
  promise does not reach. Remix, React Router and SvelteKit all support this; nifra was alone in not.

  ```tsx
  // routes/orgs/[org]/_layout.tsx
  export const gate = true                       // optional; see below
  export async function loader({ params, req }) {
    return { org: await findOrg(params.org) }    // params is { org } - nothing deeper
  }
  export default function Layout({ data, children }) { … }
  ```

  **Scoped, not global.** A layout owns the URL prefix it wraps, so it receives only the params inside
  that prefix and its loader is skipped on a navigation that did not change them. Navigating
  `/orgs/acme/a` → `/orgs/acme/b` does not re-run the org layout's loader. Scope is derived at build time
  per `(route, layout)` pair, because one layout can own different params on different expanded patterns:
  `[[lang]]/docs/_layout` owns nothing on `/docs/:slug` and `{lang}` on `/:lang/docs/:slug`. Layouts are
  not router nodes and did not become any - the router is untouched.

  **Execution order is declared, and this matters for security.** By default a layout loader runs in
  parallel with the page's, which is right for data and wrong for a guard: a page loader running
  concurrently with a guard has already queried by the time the guard says no. `export const gate = true`
  makes a layout blocking - nothing beneath it runs until it resolves, and nothing beneath a rejected gate
  runs at all. **A layout loader without `gate: true` is not an authorization boundary.** Gates also run on
  the data-only request, so a client navigation cannot bypass one by sending the data header, and a gate is
  never skipped by the retention hint.

  A layout may throw `notFound()` / `gone()` / `redirect()`. Its errors resolve to the `_error` boundary at
  or above its OWN segment, never one below it - rendering there would wrap the boundary in the very layout
  whose loader just failed.

  Every adapter passes each layout its own data. A layout with no loader receives `null`, and an app where
  no layout has a loader emits byte-identical HTML and unchanged props.

  The data-mode response becomes a versioned envelope when a chain carries layout data. It is recognised
  by structure, and the bare pre-envelope shape is still accepted - a prerendered `_data.json` is a static
  file that outlives the deploy that wrote it.

## 2.1.0

## 2.0.0

### Patch Changes

- Updated dependencies [ade0c7a]
- Updated dependencies [d91a45b]
- Updated dependencies [d91a45b]
- Updated dependencies [e97a92f]
- Updated dependencies [e8e49d1]
- Updated dependencies [a7d34e5]
  - @nifrajs/web@2.0.0

## 1.13.0

## 1.12.0

## 1.11.0

## 1.10.0

## 1.9.1

## 1.9.0

## 1.8.0

## 1.7.0

## 1.6.0

## 1.5.0

## 1.4.0

## 1.3.1

## 1.3.0

## 1.2.2

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.0

### Patch Changes

- Updated dependencies [f1f0e18]
  - @nifrajs/web@1.0.0

## 1.0.0-beta.4

### Patch Changes

- @nifrajs/web@1.0.0-beta.4

## 1.0.0-beta.3

### Patch Changes

- @nifrajs/web@1.0.0-beta.3

## 0.1.0-beta.2

### Patch Changes

- Updated dependencies [5018546]
  - @nifrajs/web@0.1.0-beta.2
